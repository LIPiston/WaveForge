/**
 * 频响合并引擎移植（源：AudioControlForegroundService.m()）
 *
 * 原应用 的核心 DSP 流程：把"基线曲线 + 目标曲线"按 route（STANDARD/DAP）× scene
 * 在 20Hz-20kHz 对数频率轴上线性插值合并，得到最终频响修正。本模块移植了
 * m() 的对数插值算法（cn.d 线性插值 + Math.log10 归一化），并暴露纯函数
 * 供引擎的 Biquad 链设计使用（"频响合并跳过"日志语义一并保留）。
 */

import { logAxis128 } from './constants'
import { evaluateCurveAt, type EqPoint } from './curve'

/** 频响场景（对应反编译 x/sv 的场景枚举语义：标准 / 空间增强等） */
export type FrScene = 'standard' | 'spatial' | 'loudness'

/** 播放路由：STANDARD / DAP（数字音频处理接管） */
export type FrRoute = 'standard' | 'dap'

export interface FrMergeConfig {
  route: FrRoute
  scene: FrScene
  enabled: boolean
}

/** 从设备库取出的 128 点目标曲线（20Hz-20kHz 对数轴） */
export type DeviceResponseCurve = number[]

/**
 * 对数插值核心（AudioControlForegroundService.m() 原样移植）：
 * 把任意点数曲线（隐含 20Hz-20kHz 对数轴）线性插值到目标频点上。
 * 频率先钳制 20-20000Hz，再按 log10 归一化到 [0,1] 轴，取相邻点线性插值。
 */
export function interpolateResponse(curve: number[], frequencies: number[]): number[] {
  if (!curve || curve.length === 0) return frequencies.map(() => 0)
  const lo = Math.log10(20)
  const hi = Math.log10(20000)
  const span = hi - lo
  return frequencies.map(f => {
    const clamped = Math.max(20, Math.min(20000, f))
    const norm = (Math.log10(clamped) - lo) / span
    const scaled = norm * (curve.length - 1)
    const i0 = Math.max(0, Math.min(curve.length - 1, Math.floor(scaled)))
    const i1 = Math.min(curve.length - 1, i0 + 1)
    const frac = scaled - i0
    // cn.d：linear interpolation ((f - f2) * f3) + f4
    return curve[i0]! + (curve[i1]! - curve[i0]!) * frac
  })
}

/** 由 EQ 曲线点生成 128 点响应曲线（内部用 fp.q 高斯叠加求值） */
export function curveToResponse(points: EqPoint[]): number[] {
  return logAxis128().map(f => evaluateCurveAt(points, f))
}

/**
 * 频响合并（m() 语义移植）：
 *   1. 若 route/scene 未启用 → 原样返回（对应日志 "频响合并跳过 route=... scene=... enabled=false"）
 *   2. 取基线曲线（baseCurve，如设备档案/预设曲线）
 *   3. 取目标曲线（targetCurve，如设备库实测曲线或自定义目标）
 *   4. 在 20 段 EQ 频点上做对数插值合并，返回各频点最终增益（dB）
 * 合并公式（推断自 m() 的逐点加权结构，与 081402 频响补偿方法论一致）：
 *   final = base + blend * (target - base)，blend ∈ [0,1]
 */
export function mergeFrequencyResponse(
  baseCurve: number[] | null,
  targetCurve: number[] | null,
  bandFrequencies: number[],
  config: FrMergeConfig,
  blend = 0.5,
): number[] {
  if (!config.enabled) {
    // "频响合并跳过 route=... scene=... enabled=false"（对应原代码日志路径）
    return bandFrequencies.map(() => 0)
  }
  const base = baseCurve ? interpolateResponse(baseCurve, bandFrequencies) : bandFrequencies.map(() => 0)
  if (!targetCurve || targetCurve.length === 0) return base
  const target = interpolateResponse(targetCurve, bandFrequencies)
  // route=DAP 时目标曲线权重更高（接管式处理），scene 影响 blend
  const sceneBoost = config.scene === 'spatial' ? 0.2 : config.scene === 'loudness' ? -0.1 : 0
  const effectiveBlend = config.route === 'dap'
    ? Math.min(1, blend + 0.3 + sceneBoost)
    : Math.max(0, Math.min(1, blend + sceneBoost))
  return base.map((b, i) => b + effectiveBlend * (target[i]! - b))
}

/**
 * 把合并结果（各频点增益）转换为 Biquad 滤波器参数：
 * 20 段目标在 log 轴上的响应 → 用最小二乘意义上的分段峰值均衡近似。
 * 独立实现（v3 自研分段策略）：对合并结果中超过 ±0.5dB 的
 * 相邻频段取代表性峰值频点，生成 peaking 段；低频/高频端取 shelf。
 */
export interface FrFilterSegment {
  type: 'lowshelf' | 'peaking' | 'highshelf'
  frequency: number
  q: number
  gain: number // dB
}

export function mergeResultToSegments(
  bandFrequencies: number[],
  gains: number[],
  maxSegments = 8,
): FrFilterSegment[] {
  const segments: FrFilterSegment[] = []
  if (bandFrequencies.length === 0) return segments

  // 低频端 shelf：取前两个频段平均
  const lowAvg = (gains[0]! + (gains[1] ?? gains[0]!)) / 2
  if (Math.abs(lowAvg) >= 0.5) {
    segments.push({ type: 'lowshelf', frequency: bandFrequencies[0]!, q: 0.707, gain: lowAvg })
  }

  // 中间 peaking：在相邻频段间找局部极值，避免过密
  let lastPicked = -2
  for (let i = 0; i < bandFrequencies.length; i++) {
    const g = gains[i]!
    if (Math.abs(g) < 0.5 || i - lastPicked < 2) continue
    const prev = gains[i - 1] ?? g
    const next = gains[i + 1] ?? g
    if ((g >= prev && g >= next) || (g <= prev && g <= next)) {
      segments.push({ type: 'peaking', frequency: bandFrequencies[i]!, q: 1.1, gain: g })
      lastPicked = i
      if (segments.length >= maxSegments - 1) break
    }
  }

  // 高频端 shelf
  const last = gains.length - 1
  const highAvg = (gains[last]! + (gains[last - 1] ?? gains[last]!)) / 2
  if (Math.abs(highAvg) >= 0.5 && segments.length < maxSegments) {
    segments.push({ type: 'highshelf', frequency: bandFrequencies[last]!, q: 0.707, gain: highAvg })
  }
  return segments
}

// ============ 百分比索引采样（x/ht.o 移植） ============

/**
 * 按百分比在线性域索引曲线（x/ht.o 原样移植）：
 *   index = clamp(percent, 0, 100) / 100 * (len - 1)
 *   value = 相邻点线性插值（cn.d）
 * 用途：等响曲线 = "音量百分比 → 增益" 映射表，任一点按当前音量采样取值。
 */
export function sampleCurveAtPercent(curve: number[] | null | undefined, percent: number): number {
  if (!curve || curve.length === 0) return 0
  const pos = (Math.max(0, Math.min(100, percent)) / 100) * (curve.length - 1)
  const i0 = Math.floor(pos)
  const i1 = Math.min(curve.length - 1, i0 + 1)
  const frac = pos - i0
  return curve[i0]! + (curve[i1]! - curve[i0]!) * frac
}

/**
 * 生成默认等响曲线（20 档：音量 0%、5% … 100% 各档的补偿增益 dB）。
 * 语义：低音量时补偿低频/高频（等响度特性），音量越高补偿越小；
 * 曲线形状为简化 V 形（低频 +5dB、中频 0、高频 +3dB，随音量线性收窄），
 * 可在 UI 中编辑为自定义值。
 */
export function defaultLoudnessCurve(): number[] {
  const n = 20
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const volume = (i / (n - 1)) * 100
    // 低音量补偿大：低频 5dB、高频 3dB → 满音量归零
    const low = 5 * (1 - volume / 100)
    const high = 3 * (1 - volume / 100)
    out.push(+(low * 0.6 + high * 0.4).toFixed(2))
  }
  return out
}

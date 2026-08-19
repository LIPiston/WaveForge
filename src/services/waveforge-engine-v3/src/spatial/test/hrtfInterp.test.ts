/**
 * hrtfInterp.test.ts —— 球谐（SH）HRTF 插值（hrtfInterp.ts）单元测试
 *
 * 测试网格：真实 KEMAR 网格（hrtf-data/grid.bin 解码：72 az × 14 el × 256 样本，
 * 解码布局见 gridSource.ts 文件头注释——u32 头 + f32 数组）；缺失时整组跳过。
 *
 * 覆盖（规划书 §4.1）：
 *   ① 网格点还原：若干网格方向上 sphericalHrtf 输出与网格 HRIR 的差异。
 *     拟合非精确插值（最小二乘残差），断言取"量级"：
 *       - 平均绝对误差（对 t 取均值）< 0.10·网格峰值 —— 实测各方向 ≤ 3.0% 峰值；
 *       - 逐样本最大误差（对 t 取 max）< 1.20·网格峰值 —— 实测样本方向
 *         13.5%~89% 峰值，最坏方向（el=40° 高仰角附近）≈120% 峰值。
 *     拟合残差实测（L=3，KEMAR，48kHz）：全网格均值 1.65% 峰值、逐方向 max
 *     中位数 34% 峰值。残差来源：冲激型 HRIR 的起始沿随方位移动极快，L=3 截断
 *     产生吉布斯振铃——这是时间域 SH 拟合的固有物理残差。已实测 L=4（25 基）
 *     仅把全网格 max 120%→113%、mean 1.65%→1.56%，提阶收益可忽略，
 *     故保持规划书默认 L=3（求值预算 O(16·hrirLen)）。
 *   ② 平滑性：沿 az（el=0，基准 0°/-45°/90°）相邻角度输出的 L1 距离
 *     随角度差单调不减——实测 5°~30° 窗口严格递增；超过 ~45° 后因 ITD
 *     关于 0° 的对称性 L1 回落（如基准 -45°：60°=5.11 而 90°=4.62），
 *     故断言限定在 5°~30°。同时断言 L1(10°) < 8·√E（E = 基准方向 HRIR
 *     能量；实测 ≤ 3.1·√E，2.6× 余量）。
 *   ③ 确定性：同输入两次调用输出逐位相等。
 *   ④ wrap：az=185 ≡ -175（±180° 环绕等价；f64 三角参数约化差异容差 1e-6）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sphericalHrtf } from '../hrtfInterp'
import type { HrtfGrid } from '../types'

// ---------------------------------------------------------------------------
// 真实网格装载（hrtf-data/grid.bin 缺失 → 整组跳过并打印原因）
// ---------------------------------------------------------------------------
const GRID_PATH = fileURLToPath(new URL('../../../hrtf-data/grid.bin', import.meta.url))

function decodeGridBin(bytes: Uint8Array): HrtfGrid {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  const readU32 = (): number => {
    const v = view.getUint32(off, true)
    off += 4
    return v
  }
  const readF32 = (): number => {
    const v = view.getFloat32(off, true)
    off += 4
    return v
  }
  const sampleRate = readU32()
  const azCount = readU32()
  const elCount = readU32()
  const hrirLen = readU32()
  if (azCount < 1 || azCount > 10000 || elCount < 1 || elCount > 10000 || hrirLen < 1 || hrirLen > 100000) {
    throw new Error('invalid grid header')
  }
  const azimuths = new Array<number>(azCount)
  for (let i = 0; i < azCount; i++) azimuths[i] = readF32()
  const elevations = new Array<number>(elCount)
  for (let i = 0; i < elCount; i++) elevations[i] = readF32()
  const n = elCount * azCount * hrirLen
  const need = 16 + (azCount + elCount + 2 * n) * 4
  if (bytes.byteLength < need) throw new Error('truncated grid data')
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) left[i] = readF32()
  for (let i = 0; i < n; i++) right[i] = readF32()
  return { sampleRate, azimuths, elevations, hrirLength: hrirLen, left, right }
}

let grid: HrtfGrid | null = null
let gridReason = ''
try {
  grid = decodeGridBin(readFileSync(GRID_PATH))
} catch (err) {
  gridReason = `hrtf-data/grid.bin 缺失或损坏（${String(err)}）——球谐插值用例跳过`
}
if (!grid) {
  console.warn(`[hrtfInterp.test] 跳过：${gridReason}`)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 网格某方向（azIdx, elIdx）的原始 HRIR 段（ear=0 左耳 / 1 右耳） */
function rawHrirAt(g: HrtfGrid, azDeg: number, elDeg: number, ear: 0 | 1): Float32Array {
  const azIdx = g.azimuths.indexOf(azDeg)
  const elIdx = g.elevations.indexOf(elDeg)
  if (azIdx < 0 || elIdx < 0) throw new Error(`方向 (${azDeg},${elDeg}) 不在网格上`)
  const plane = ear === 0 ? g.left : g.right
  const base = (elIdx * g.azimuths.length + azIdx) * g.hrirLength
  return plane.subarray(base, base + g.hrirLength)
}

/** 网格 HRIR 峰值（left 耳） */
function gridPeak(g: HrtfGrid): number {
  let m = 0
  for (let i = 0; i < g.left.length; i++) {
    const v = Math.abs(g.left[i])
    if (v > m) m = v
  }
  return m
}

/** 逐样本最大差 / 平均绝对差（对 t） */
function errStats(a: Float32Array, b: Float32Array): { max: number; mean: number } {
  let m = 0
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > m) m = d
    sum += d
  }
  return { max: m, mean: sum / n }
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------
describe.skipIf(!grid)('sphericalHrtf 球谐插值', () => {
  const g = grid as HrtfGrid
  const peak = gridPeak(g)
  const hl = g.hrirLength

  it('① 网格点还原：平均误差 < 0.10·峰值、最大误差 < 1.20·峰值（拟合残差量级）', () => {
    // 代表性子集：水平环（el=0）各象限 + 高/低仰角 + 极角（含 -180° 环绕点）
    const dirs: Array<[number, number]> = [
      [0, 0], [30, 0], [-30, 0], [90, 0], [-90, 0], [135, 0], [-135, 0], [-180, 0],
      [0, 40], [30, 40], [-30, 40], [90, 40], [0, -40], [0, 90],
    ]
    const outL = new Float32Array(hl)
    const outR = new Float32Array(hl)
    for (const [daz, del] of dirs) {
      sphericalHrtf(g, daz, del, outL, outR)
      const rawL = rawHrirAt(g, daz, del, 0)
      const sL = errStats(outL, rawL)
      // 平均误差（整体量级）：实测 ≤ 3.0% 峰值（断言 10% 峰值，3× 余量）
      expect(sL.mean, `dir (${daz},${del}) left mean err`).toBeLessThan(0.1 * peak)
      // 最大误差（振铃上界）：实测左耳 ≤ 89% 峰值（断言 120% 峰值——全网格
      // 最坏方向 ≈120%，本子集留 35% 余量；拟合非精确插值的固有吉布斯振铃）
      expect(sL.max, `dir (${daz},${del}) left max err`).toBeLessThan(1.2 * peak)
      // 右耳对右耳网格数据（残差分布与左耳同源，断言同容差）
      const rawR = rawHrirAt(g, daz, del, 1)
      const sR = errStats(outR, rawR)
      expect(sR.mean, `dir (${daz},${del}) right mean err`).toBeLessThan(0.1 * peak)
      expect(sR.max, `dir (${daz},${del}) right max err`).toBeLessThan(1.2 * peak)
    }
  })

  it('② 平滑性：沿 az 的 L1 距离随角度差单调不减（5°~30° 窗口）+ 相邻 10° 输出差有界', () => {
    const outA = new Float32Array(hl)
    const outB = new Float32Array(hl)
    const l1 = (azA: number, azB: number): number => {
      sphericalHrtf(g, azA, 0, outA, outA)
      sphericalHrtf(g, azB, 0, outB, outB)
      let s = 0
      for (let t = 0; t < hl; t++) s += Math.abs(outA[t] - outB[t])
      return s
    }
    const energy = (azDeg: number): number => {
      sphericalHrtf(g, azDeg, 0, outA, outA)
      let s = 0
      for (let t = 0; t < hl; t++) s += outA[t] * outA[t]
      return s
    }
    // 三个基准方位（含左/右象限）：5°~30° 窗口 L1 单调不减
    // （实测：基准 0°：0.58<1.08<1.48<1.78<2.46；-45°：0.24<0.46<0.72<1.07<2.13；
    //   90°：0.57<1.33<2.24<3.25<5.38。超过 ~45° 因 ITD 对称性 L1 回落，故限定窗口）
    for (const base of [0, -45, 90]) {
      let prev = 0
      for (const dAz of [5, 10, 15, 20, 30]) {
        const cur = l1(base, base + dAz)
        expect(cur, `base ${base} L1(${dAz}°)`).toBeGreaterThan(prev)
        prev = cur
      }
    }
    // 相邻 10° 输出差 < 8·√E（E=基准方向能量；实测 ≤ 3.1·√E，2.6× 余量）
    for (const base of [0, -45, 90]) {
      const e = energy(base)
      const l = l1(base, base + 10)
      expect(l, `base ${base} L1(10°)`).toBeLessThan(8 * Math.sqrt(e))
    }
  })

  it('③ 确定性：同输入两次调用输出逐位相等', () => {
    const a1 = new Float32Array(hl)
    const b1 = new Float32Array(hl)
    const a2 = new Float32Array(hl)
    const b2 = new Float32Array(hl)
    // 一组混合方向（网格点 + 非网格点 + 负角）
    const dirs: Array<[number, number]> = [[0, 0], [17, 3], [-123, 45], [72, -40], [180, 90], [-5, -13]]
    for (const [daz, del] of dirs) {
      sphericalHrtf(g, daz, del, a1, b1)
      sphericalHrtf(g, daz, del, a2, b2)
      expect(Array.from(a1)).toEqual(Array.from(a2))
      expect(Array.from(b1)).toEqual(Array.from(b2))
    }
  })

  it('④ wrap：az=185 ≡ -175、az=-185 ≡ 175（±180° 环绕等价）', () => {
    const a1 = new Float32Array(hl)
    const b1 = new Float32Array(hl)
    const a2 = new Float32Array(hl)
    const b2 = new Float32Array(hl)
    // 基函数对 az 周期 360°：185° 与 -175° 同一方向。f64 三角函数对
    // 相差 360° 的参数做独立约化，结果差 ≤ 1 ULP 量级——容差 1e-6。
    sphericalHrtf(g, 185, 0, a1, b1)
    sphericalHrtf(g, -175, 0, a2, b2)
    for (let t = 0; t < hl; t++) {
      expect(Math.abs(a1[t] - a2[t])).toBeLessThan(1e-6)
      expect(Math.abs(b1[t] - b2[t])).toBeLessThan(1e-6)
    }
    sphericalHrtf(g, -185, 10, a1, b1)
    sphericalHrtf(g, 175, 10, a2, b2)
    for (let t = 0; t < hl; t++) {
      expect(Math.abs(a1[t] - a2[t])).toBeLessThan(1e-6)
      expect(Math.abs(b1[t] - b2[t])).toBeLessThan(1e-6)
    }
  })

  it('仰角越界钳制：el 超出网格范围不抛错且输出有限（clamp 语义）', () => {
    const a = new Float32Array(hl)
    const b = new Float32Array(hl)
    sphericalHrtf(g, 0, 120, a, b) // el=120 → clamp 到 90
    sphericalHrtf(g, 0, -120, a, b) // el=-120 → clamp 到 -40
    for (let t = 0; t < hl; t++) {
      expect(Number.isFinite(a[t])).toBe(true)
      expect(Number.isFinite(b[t])).toBe(true)
    }
  })

  it('输出长度校验：与 hrirLength 不一致抛中文错误', () => {
    const short = new Float32Array(hl - 1)
    const ok = new Float32Array(hl)
    expect(() => sphericalHrtf(g, 0, 0, short, ok)).toThrow(/hrirLength/)
    expect(() => sphericalHrtf(g, 0, 0, ok, short)).toThrow(/hrirLength/)
  })
})

// ---------------------------------------------------------------------------
// 退化网格防御（O1 审计 P1）：网格方向数 N < 基函数数 16 时 AᵀA 秩亏 →
// invertGaussJordan 主元近 0 → 抛错而非静默产出 NaN（原实现 0/0=NaN 污染全矩阵
// → SH 系数全 NaN → 卷积输出全 NaN 静音）。本组不依赖真实 KEMAR 网格（自构小网格）。
// ---------------------------------------------------------------------------
describe('sphericalHrtf 退化网格防御（O1 审计 P1：奇异矩阵 → 抛错防 NaN）', () => {
  it('1×1 网格（N=1 < 16）：sphericalHrtf 抛错（AᵀA 秩 1 < 16，主元近 0）', () => {
    const degenerate: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [0],
      elevations: [0],
      hrirLength: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    }
    const outL = new Float32Array(1)
    const outR = new Float32Array(1)
    // 1×1 → N=1：AᵀA = a·aᵀ（外积，秩 1）。首列消去后 15×15 余块全 0
    // → 第 2 主元 = 0 < 1e-12 → 抛错。f64 舍入下 ~1e-16 仍 < 阈值。
    expect(() => sphericalHrtf(degenerate, 0, 0, outL, outR)).toThrow(/退化|秩亏/)
  })

  it('3×3 网格（N=9 < 16）：sphericalHrtf 抛错（AᵀA 秩 ≤9 < 16，消去 9 步后余块全 0）', () => {
    const small: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [-90, 0, 90],
      elevations: [-30, 0, 30],
      hrirLength: 1,
      left: new Float32Array(9).fill(1),
      right: new Float32Array(9).fill(1),
    }
    const outL = new Float32Array(1)
    const outR = new Float32Array(1)
    // 3×3 → N=9 < 16：AᵀA 秩 ≤9。部分主元消去 9 步后 7×7 余块全 0
    // → 第 10 主元 ~1e-14 < 1e-12 → 抛错。
    expect(() => sphericalHrtf(small, 0, 0, outL, outR)).toThrow(/退化|秩亏/)
  })

  it('抛错后输出缓冲不被 NaN 污染（防御有效性：非静默产出 NaN）', () => {
    const degenerate: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [0],
      elevations: [0],
      hrirLength: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    }
    const outL = new Float32Array([0.5])
    const outR = new Float32Array([0.5])
    // 抛错 → 不写输出（调用方 catch 后缓冲保持原值 0.5，非 NaN）
    expect(() => sphericalHrtf(degenerate, 0, 0, outL, outR)).toThrow()
    expect(outL[0]).toBe(0.5) // 原值保留（未被 NaN 污染）
    expect(outR[0]).toBe(0.5)
  })
})

/**
 * 智能 Post —— 自动计算 Post 均衡（源：原应用 "auto_post_eq" 字符串）
 *
 * 原应用文案："自动计算 Post 均衡，使其调音更加简易。"
 *
 * 原理：对当前均衡曲线求 20 段响应，找出与平直线的显著偏差（峰值/谷值），
 * 生成少量（≤5）补偿型 peaking 频段（反向修正、增益受限），作为 Post 段
 * 叠加在动态处理之后，使整体听感更接近目标而无需手工逐段调整。
 */

import { EQ_BANDS_20 } from './constants'
import { evaluateCurveAt, type EqPoint } from './curve'
import { quantizeGain, quantizeQ, quantizeFreq } from './constants'
import type { PeqBand } from './iirPeq'

/** 自动 Post 均衡结果 */
export interface AutoPostEqResult {
  bands: PeqBand[]
  /** 被校正的偏差摘要（dB） */
  deviations: Array<{ freq: number; deviation: number }>
}

/** 阈值：偏差超过该值才生成补偿段（dB） */
const POST_EQ_THRESHOLD = 1.0
/** 补偿增益上限（dB）：克制，避免反向过冲 */
const POST_EQ_MAX_GAIN = 3
/** 最多生成的频段数 */
const POST_EQ_MAX_BANDS = 5
/** 相邻频段最小间隔（频点下标距离），避免补偿段扎堆 */
const POST_EQ_MIN_SPACING = 3

/**
 * 计算自动 Post 均衡频段：
 *   1. 在当前曲线上求 20 段响应，减去 0dB 平直得到偏差
 *   2. 找局部极值（峰/谷）且 |偏差| ≥ threshold
 *   3. 生成 peaking 补偿段：增益 = -deviation（受限 ±POST_EQ_MAX_GAIN），
 *      Q 按相邻频段间距估算（间距大 → Q 小，作用宽）
 *   4. 强度系数缩放（strength 0-1）
 */
export function computeAutoPostEq(curve: EqPoint[], strength = 0.6): AutoPostEqResult {
  const response = EQ_BANDS_20.map(f => evaluateCurveAt(curve, f))
  const deviations = EQ_BANDS_20.map((freq, i) => ({ freq, deviation: response[i]! }))
    .filter(d => Math.abs(d.deviation) >= POST_EQ_THRESHOLD)

  const bands: PeqBand[] = []
  let lastIdx = -POST_EQ_MIN_SPACING
  for (let i = 0; i < EQ_BANDS_20.length; i++) {
    const dev = response[i]!
    if (Math.abs(dev) < POST_EQ_THRESHOLD) continue
    // 局部极值判定（峰或谷）
    const prev = response[i - 1] ?? dev
    const next = response[i + 1] ?? dev
    const isExtremum = (dev >= prev && dev >= next) || (dev <= prev && dev <= next)
    if (!isExtremum) continue
    if (i - lastIdx < POST_EQ_MIN_SPACING) continue
    lastIdx = i
    // 补偿增益：反号、受限、乘强度
    const rawGain = -dev * strength
    const gain = quantizeGain(Math.max(-POST_EQ_MAX_GAIN, Math.min(POST_EQ_MAX_GAIN, rawGain)))
    // Q 估计：取相邻偏差零点之间的半宽（粗略）
    const freq = EQ_BANDS_20[i]!
    const freqLow = EQ_BANDS_20[Math.max(0, i - 1)]!
    const freqHigh = EQ_BANDS_20[Math.min(EQ_BANDS_20.length - 1, i + 1)]!
    const q = quantizeQ(1.2 / Math.max(0.6, freqHigh / freqLow))
    // 强度为 0 或增益量化后为 0 的补偿段无实际作用，跳过
    if (gain !== 0) {
      bands.push({ freq: quantizeFreq(freq), gain, q })
      if (bands.length >= POST_EQ_MAX_BANDS) break
    }
  }
  return { bands, deviations }
}

/** 智能 Post 参数 */
export interface AutoPostEqSettings {
  enabled: boolean
  /** 强度 0-1（默认 0.6） */
  strength: number
}

export function defaultAutoPostEq(): AutoPostEqSettings {
  return { enabled: false, strength: 0.6 }
}

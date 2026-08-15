/**
 * 原应用EQ 曲线模型移植（源：x/fp.java）
 *
 * 核心算法：在任意频率处求曲线响应 = 各频段高斯函数在对数频域上的叠加：
 *   response(f) = Σ gain_i * exp(-0.5 * (log2(f / f_i) / max(0.12, 1 / (Q_i * 1.35)))²)
 * 结果钳制 ±15dB。这是 原应用 全部分频响/均衡逻辑的基础（20 段 EQ、预设、
 * 设备档案、听感分析都构建在这个模型之上）。
 */

import {
  quantizeFreq,
  quantizeGain,
  quantizeQ,
  EQ_BANDS_10_ODD,
} from './constants'

/** 曲线点：频点(Hz) / 增益(dB) / Q（对应反编译类 x.ep 的字段 a/b/c） */
export interface EqPoint {
  freq: number
  gain: number
  q: number
}

/** fp 曲线默认 4 控制点：80 / 320 / 1200 / 6500 Hz（fp.h 平直 / fp.i 默认曲线） */
export const DEFAULT_CURVE_FREQS = [80, 320, 1200, 6500]

/** 平直曲线（fp.h 原样移植：4 点 0dB，Q=1） */
export function flatCurve(): EqPoint[] {
  return DEFAULT_CURVE_FREQS.map(freq => ({ freq, gain: 0, q: 1 }))
}

/** 默认起步曲线（fp.i 原样移植：增益 1/-0.5/0.5/1.5，Q 0.75/1.1/1.0/0.9） */
export function defaultCurve(): EqPoint[] {
  const gains = [1, -0.5, 0.5, 1.5]
  const qs = [0.75, 1.1, 1.0, 0.9]
  return DEFAULT_CURVE_FREQS.map((freq, i) => ({ freq, gain: gains[i]!, q: qs[i]! }))
}

/** 解析曲线字符串 "freq:gain:q;freq:gain:q;..."（fp.k 原样移植，最多 50 点） */
export function parseCurve(str: string | null | undefined, maxPoints = 30): EqPoint[] | null {
  if (!str || str.trim().length === 0) return null
  const parts = str.split(';')
  if (parts.length === 0) return null
  const count = Math.min(Math.max(1, Math.min(50, maxPoints)), parts.length)
  const points: EqPoint[] = []
  for (let i = 0; i < count; i++) {
    const seg = parts[i]!.split(':')
    if (seg.length !== 3) return null
    const freq = parseFloat(seg[0]!)
    const gain = parseFloat(seg[1]!)
    const q = parseFloat(seg[2]!)
    if (Number.isNaN(freq) || Number.isNaN(gain) || Number.isNaN(q)) return null
    points.push({ freq: quantizeFreq(freq), gain: quantizeGain(gain), q: quantizeQ(q) })
  }
  return points
}

/** 序列化曲线为 "freq:gain:q;..."（fp.m 原样移植：%.0f:%.2f:%.2f） */
export function serializeCurve(points: EqPoint[]): string {
  return points
    .map(p => `${Math.round(p.freq)}:${p.gain.toFixed(2)}:${p.q.toFixed(2)}`)
    .join(';')
}

/**
 * 求曲线在频率 f 处的响应值（fp.q 原样移植）。
 * 对数频域高斯叠加：Q 决定带宽，1/(Q*1.35) 为高斯 sigma 下限 0.12。
 */
export function evaluateCurveAt(points: EqPoint[], freq: number): number {
  const f = Math.max(20, Math.min(20000, freq))
  const ln2 = Math.LN2
  let sum = 0
  for (const p of points) {
    const octaves = Math.log(f / p.freq) / ln2
    const sigma = Math.max(0.12, 1 / (p.q * 1.35))
    sum += p.gain * Math.exp(-0.5 * (octaves * octaves) / (sigma * sigma))
  }
  return Math.max(-15, Math.min(15, sum))
}

/** 在一组频点上求曲线响应，逐点量化到 0.5dB（fp.r 原样移植） */
export function evaluateCurveAtFreqs(points: EqPoint[], freqs: readonly number[]): number[] {
  return freqs.map(f => quantizeGain(evaluateCurveAt(points, f)))
}

/** 由 10 段增益数组（作用于 EQ_BANDS_10_ODD）构造曲线点（对应 L0()：10 点、Q=1） */
export function curveFrom10BandGains(gains: number[]): EqPoint[] {
  return EQ_BANDS_10_ODD.map((freq, i) => ({
    freq,
    gain: quantizeGain(gains[i] ?? 0),
    q: 1,
  }))
}

/** 把曲线取中间插值点（fp.l 原样移植：相邻两点增益取平均，频点不变） */
export function interpolateMidpoints(points: EqPoint[]): EqPoint[] {
  const out: EqPoint[] = []
  for (let i = 0; i < points.length; i++) {
    const next = points[Math.min(i + 1, points.length - 1)]!
    out.push({
      freq: points[i]!.freq,
      gain: quantizeGain((points[i]!.gain + next.gain) / 2),
      q: points[i]!.q,
    })
  }
  return out
}

/** 新增频段：频点取相邻点几何平均（√(f·f_next)），不足则取 1.25×（fp.a 原样移植语义） */
export function addBandAt(points: EqPoint[], index: number): { points: EqPoint[]; index: number } {
  if (points.length <= 1) return { points: [...points, { freq: 1000, gain: 0, q: 1 }], index: points.length }
  const idx = Math.max(0, Math.min(points.length - 1, index))
  const cur = points[idx]!
  const nextFreq = idx + 1 < points.length ? points[idx + 1]!.freq : Math.min(20000, 1.8 * cur.freq)
  let f = Math.sqrt(nextFreq * cur.freq)
  if (f <= cur.freq + 1) f = Math.min(20000, cur.freq * 1.25)
  const point: EqPoint = { freq: quantizeFreq(f), gain: 0, q: 1 }
  const out = [...points]
  out.splice(idx + 1, 0, point)
  return { points: out, index: idx + 1 }
}

/** 删除频段（fp.p 原样移植） */
export function removeBandAt(points: EqPoint[], index: number): { points: EqPoint[]; index: number } {
  if (points.length <= 1) return { points, index: 0 }
  const idx = Math.max(0, Math.min(points.length - 1, index))
  const out = points.filter((_, i) => i !== idx)
  return { points: out, index: Math.max(0, Math.min(idx, out.length - 1)) }
}

/** 修改频段参数（fp.s 原样移植：频率/增益/Q 均按量化规则钳制） */
export function setBand(points: EqPoint[], index: number, patch: Partial<EqPoint>): EqPoint[] {
  const idx = Math.max(0, Math.min(points.length - 1, index))
  const cur = points[idx]!
  const next: EqPoint = {
    freq: patch.freq !== undefined ? quantizeFreq(patch.freq) : cur.freq,
    gain: patch.gain !== undefined ? quantizeGain(patch.gain) : cur.gain,
    q: patch.q !== undefined ? quantizeQ(patch.q) : cur.q,
  }
  const out = [...points]
  out[idx] = next
  return out
}

/** 保证曲线非空：空曲线时默认 1kHz 0dB 单点（fp.n 原样移植） */
export function ensureCurve(points: EqPoint[]): EqPoint[] {
  if (points.length === 0) return [{ freq: 1000, gain: 0, q: 1 }]
  return points
}

/** 按频率升序排序（fp.w 原样移植） */
export function sortCurve(points: EqPoint[]): EqPoint[] {
  return [...points].sort((a, b) => a.freq - b.freq)
}

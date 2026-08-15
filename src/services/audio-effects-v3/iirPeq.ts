/**
 * 64 阶 IIR 参数均衡器（源：原应用 高级音效处理 "64 阶 IIR 参数均衡器"）
 *
 * 原应用 的 AdvancedAudioProcessingService 提供 64 阶 IIR 参数均衡：可增删
 * 频段（PEQ 界面：F 对数频点 20-20k / G 增益 ±15dB 0.5 步进 / Q 0.2-12 0.05 步进），
 * 每个频段是一个 Biquad（peaking），级联后总阶数 = 2 × 频段数（≤ 32 段 → 64 阶）。
 *
 * 本模块移植：RBJ 音频 EQ 双二阶系数设计（与 Android AudioEffect 的
 * IIR 参数均衡器同为标准双二阶实现），并提供：
 *   - designBiquad：lowshelf / peaking / highshelf 系数计算
 *   - IirPeq：频段管理（增/删/改，量化规则与 fp 一致）+ 串行化 + 响应评估
 *   - 响应评估：任一频点处级联 Biquad 幅频响应（用于曲线预览与校验）
 */

import { quantizeFreq, quantizeGain, quantizeQ } from './constants'

/** 双二阶滤波器系数（Direct Form I） */
export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** PEQ 频段（对应 PEQ 界面 F/G/Q 三个旋钮） */
export interface PeqBand {
  freq: number // Hz，对数刻度 20-20000
  gain: number // dB，-15 ~ +15，0.5 步进
  q: number // 0.2 ~ 12，0.05 步进
}

/** 设计一个双二阶滤波器系数（RBJ Audio EQ Cookbook） */
export function designBiquad(
  type: 'peaking' | 'lowshelf' | 'highshelf',
  freq: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * Math.min(sampleRate / 2 - 1, Math.max(1, freq)) / sampleRate
  const cosW = Math.cos(w0)
  const sinW = Math.sin(w0)
  const alpha = sinW / (2 * q)

  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  if (type === 'peaking') {
    b0 = 1 + alpha * A
    b1 = -2 * cosW
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cosW
    a2 = 1 - alpha / A
  } else if (type === 'lowshelf') {
    const s = Math.sqrt(A)
    b0 = A * ((A + 1) - (A - 1) * cosW + 2 * s * alpha)
    b1 = 2 * A * ((A - 1) - (A + 1) * cosW)
    b2 = A * ((A + 1) - (A - 1) * cosW - 2 * s * alpha)
    a0 = (A + 1) + (A - 1) * cosW + 2 * s * alpha
    a1 = -2 * ((A - 1) + (A + 1) * cosW)
    a2 = (A + 1) + (A - 1) * cosW - 2 * s * alpha
  } else {
    // highshelf
    const s = Math.sqrt(A)
    b0 = A * ((A + 1) + (A - 1) * cosW + 2 * s * alpha)
    b1 = -2 * A * ((A - 1) + (A + 1) * cosW)
    b2 = A * ((A + 1) + (A - 1) * cosW - 2 * s * alpha)
    a0 = (A + 1) - (A - 1) * cosW + 2 * s * alpha
    a1 = 2 * ((A - 1) - (A + 1) * cosW)
    a2 = (A + 1) - (A - 1) * cosW - 2 * s * alpha
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** 级联 Biquad 在频率 f 处的幅频响应（dB），用于曲线预览与数值校验 */
export function cascadeResponse(coeffs: BiquadCoeffs[], freq: number, sampleRate: number): number {
  const w = 2 * Math.PI * freq / sampleRate
  const zr = Math.cos(w)
  const zi = Math.sin(w)
  let mag = 1
  for (const c of coeffs) {
    // H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)，z = e^{jw}
    const numRe = c.b0 + c.b1 * zr + c.b2 * Math.cos(2 * w)
    const numIm = -c.b1 * zi - c.b2 * Math.sin(2 * w)
    const denRe = 1 + c.a1 * zr + c.a2 * Math.cos(2 * w)
    const denIm = -c.a1 * zi - c.a2 * Math.sin(2 * w)
    const numMag = Math.sqrt(numRe * numRe + numIm * numIm)
    const denMag = Math.sqrt(denRe * denRe + denIm * denIm)
    mag *= denMag > 1e-12 ? numMag / denMag : numMag
  }
  return 20 * Math.log10(Math.max(1e-12, mag))
}

/**
 * IIR 参数均衡器模型（对应 原应用PEQ 状态）：
 * 频段可增删改，总阶数 = 2 × 频段数（上限 32 段 → 64 阶）
 */
export class IirPeq {
  bands: PeqBand[] = []
  enabled = false
  sampleRate: number

  constructor(sampleRate = 48000, initialBands?: PeqBand[]) {
    this.sampleRate = sampleRate
    if (initialBands && initialBands.length > 0) this.bands = initialBands.map(b => this.quantizeBand(b))
  }

  private quantizeBand(b: PeqBand): PeqBand {
    return { freq: quantizeFreq(b.freq), gain: quantizeGain(b.gain), q: quantizeQ(b.q) }
  }

  get order(): number {
    return this.bands.length * 2
  }

  /** 新增频段（默认频点取相邻几何平均，与 fp.a 语义一致） */
  addBand(index = this.bands.length - 1): number {
    if (this.bands.length >= 32) return this.bands.length - 1 // 64 阶上限
    if (this.bands.length === 0) {
      this.bands = [{ freq: 1000, gain: 0, q: 1 }]
      return 0
    }
    const idx = Math.max(0, Math.min(this.bands.length - 1, index))
    const cur = this.bands[idx]!
    const nextFreq = idx + 1 < this.bands.length ? this.bands[idx + 1]!.freq : Math.min(20000, 1.8 * cur.freq)
    let f = Math.sqrt(nextFreq * cur.freq)
    if (f <= cur.freq + 1) f = Math.min(20000, cur.freq * 1.25)
    const band: PeqBand = { freq: quantizeFreq(f), gain: 0, q: 1 }
    this.bands.splice(idx + 1, 0, band)
    return idx + 1
  }

  /** 删除频段；少于 1 段时不删 */
  removeBand(index: number): number {
    if (this.bands.length <= 1) return 0
    const idx = Math.max(0, Math.min(this.bands.length - 1, index))
    this.bands.splice(idx, 1)
    return Math.max(0, Math.min(idx, this.bands.length - 1))
  }

  /** 修改频段（F/G/Q 旋钮语义：量化规则与逆向 fp.s 一致） */
  setBand(index: number, patch: Partial<PeqBand>): void {
    const idx = Math.max(0, Math.min(this.bands.length - 1, index))
    const cur = this.bands[idx]!
    this.bands[idx] = {
      freq: patch.freq !== undefined ? quantizeFreq(patch.freq) : cur.freq,
      gain: patch.gain !== undefined ? quantizeGain(patch.gain) : cur.gain,
      q: patch.q !== undefined ? quantizeQ(patch.q) : cur.q,
    }
  }

  /** 生成全部 Biquad 系数（peaking 级联） */
  designAll(): BiquadCoeffs[] {
    return this.bands.map(b => designBiquad('peaking', b.freq, b.gain, b.q, this.sampleRate))
  }

  /** 级联响应曲线（用于预览/校验，128 点对数轴） */
  responseCurve(frequencies: number[]): number[] {
    const coeffs = this.enabled ? this.designAll() : []
    return frequencies.map(f => cascadeResponse(coeffs, f, this.sampleRate))
  }

  /** 序列化（fp.m 格式，与 原应用 存储格式兼容："freq:gain:q;..."） */
  serialize(): string {
    return this.bands
      .map(b => `${Math.round(b.freq)}:${b.gain.toFixed(2)}:${b.q.toFixed(2)}`)
      .join(';')
  }

  /** 反序列化（fp.k 兼容）；失败返回 null */
  static parse(str: string | null | undefined, sampleRate = 48000): IirPeq | null {
    if (!str || str.trim().length === 0) return null
    const parts = str.split(';')
    const bands: PeqBand[] = []
    for (const part of parts) {
      const seg = part.split(':')
      if (seg.length !== 3) return null
      const freq = parseFloat(seg[0]!)
      const gain = parseFloat(seg[1]!)
      const q = parseFloat(seg[2]!)
      if (Number.isNaN(freq) || Number.isNaN(gain) || Number.isNaN(q)) return null
      bands.push({ freq, gain, q })
    }
    if (bands.length === 0) return null
    return new IirPeq(sampleRate, bands)
  }
}

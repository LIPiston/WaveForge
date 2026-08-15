/**
 * 脉冲响应（卷积）管理（源：原应用"高级音效处理 - 卷积脉冲响应"）
 *
 * 原应用 文案："该操作启用后会临时关闭虚拟低频、IIR、频响曲线、齿音抑制和
 * 低频增强，避免与脉冲响应重复叠加。不会禁用这些开关，需要时仍可手动打开。
 * 关闭所有脉冲卷积后，只会恢复本次自动关闭前已经开启的项目。"
 *
 * 本模块实现：IR 加载（URL/ArrayBuffer → AudioBuffer）、干湿混合、
 * 以及"卷积互斥"状态机（启用时自动临时关闭互斥项，关闭后恢复原状态）。
 */

/** 与卷积互斥的效果键（原应用 文案列出的 5 项） */
export const CONVOLUTION_MUTEX_KEYS = [
  'virtualBass',
  'iirPeq',
  'frequencyResponse',
  'deesser',
  'bassEnhance',
] as const

export type ConvolutionMutexKey = (typeof CONVOLUTION_MUTEX_KEYS)[number]

/** 卷积参数 */
export interface ConvolutionSettings {
  enabled: boolean
  /** IR 资源地址（音频 URL / 本地路径 / data URL） */
  irUrl: string | null
  /** 干湿比 0-1 */
  mix: number
  /** 归一化：IR 峰值过大会爆音，按峰值归一化到目标 */
  normalize: boolean
}

export function defaultConvolution(): ConvolutionSettings {
  return { enabled: false, irUrl: null, mix: 0.35, normalize: true }
}

/** 解码 IR 资源为 AudioBuffer（URL / ArrayBuffer 两种输入） */
export async function decodeImpulseResponse(
  context: BaseAudioContext,
  source: string | ArrayBuffer,
): Promise<AudioBuffer> {
  let buffer: ArrayBuffer
  if (typeof source === 'string') {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`IR 加载失败：HTTP ${response.status}`)
    buffer = await response.arrayBuffer()
  } else {
    buffer = source
  }
  const decoded = await context.decodeAudioData(buffer)
  if (decoded.numberOfChannels === 0 || decoded.length === 0) {
    throw new Error('IR 解码结果为空')
  }
  return decoded
}

/** 峰值归一化：把 IR 峰值缩放到 targetPeak（默认 0.5），返回新 AudioBuffer */
export function normalizeImpulseResponse(
  context: BaseAudioContext,
  ir: AudioBuffer,
  targetPeak = 0.5,
): AudioBuffer {
  let peak = 0
  for (let ch = 0; ch < ir.numberOfChannels; ch++) {
    const data = ir.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]!)
      if (v > peak) peak = v
    }
  }
  if (peak < 1e-8) return ir
  const gain = targetPeak / peak
  const out = context.createBuffer(ir.numberOfChannels, ir.length, ir.sampleRate)
  for (let ch = 0; ch < ir.numberOfChannels; ch++) {
    const src = ir.getChannelData(ch)
    const dst = out.getChannelData(ch)
    for (let i = 0; i < src.length; i++) dst[i] = src[i]! * gain
  }
  return out
}

/** 卷积互斥状态机：记录被临时关闭的开关，供恢复 */
export class ConvolutionMutex {
  private suspended = new Set<ConvolutionMutexKey>()

  /** 启用卷积：把互斥项当前开启状态记录并标记关闭；返回需要关闭的键列表 */
  suspend(keys: Record<ConvolutionMutexKey, boolean>): ConvolutionMutexKey[] {
    const toClose: ConvolutionMutexKey[] = []
    for (const key of CONVOLUTION_MUTEX_KEYS) {
      if (keys[key]) {
        this.suspended.add(key)
        toClose.push(key)
      }
    }
    return toClose
  }

  /** 关闭卷积：恢复此前被临时关闭的互斥项；返回需要恢复的键列表 */
  restore(): ConvolutionMutexKey[] {
    const toRestore = [...this.suspended]
    this.suspended.clear()
    return toRestore
  }

  get suspendedKeys(): readonly ConvolutionMutexKey[] {
    return [...this.suspended]
  }
}

// ============ 内置混响 IR（v3 独立设计） ============
// 说明：卷积功能通常需要外部 IR 文件；v3 内置 5 种类型化混响 IR 生成器，
// 让"卷积"在无外部资源时也能直接可用。算法与参数均为 v3 独立设计：
//   - 早期反射：多抽头离散回声，幅度按类型指数衰减
//   - 晚期混响：每声道独立相位的高斯噪声 x 指数衰减包络 x 一阶低通（空气吸收）
//   - 立体声去相关：右声道噪声相位偏移 + 早期反射左右增益差

/** 内置混响类型 */
export type BuiltinReverbType = 'hall' | 'room' | 'plate' | 'spring' | 'stage'

export interface BuiltinReverbSpec {
  label: string
  /** 总时长（秒） */
  seconds: number
  /** 衰减速率（1/s，越大衰减越快） */
  decayRate: number
  /** 预延迟（秒） */
  preDelay: number
  /** 早期反射 [延迟(秒), 增益] */
  early: Array<[number, number]>
  /** 晚期低通系数（0-1，越小越暗） */
  lowpass: number
  /** 右声道去相关强度 */
  decorrelation: number
}

/** 内置混响规格（v3 独立参数，覆盖大厅/房间/板式/弹簧/舞台五种听感） */
export const BUILTIN_REVERB_SPECS: Record<BuiltinReverbType, BuiltinReverbSpec> = {
  hall: {
    label: '大厅', seconds: 3.4, decayRate: 2.0, preDelay: 0.022,
    early: [[0.012, 0.5], [0.024, 0.38], [0.039, 0.3], [0.056, 0.22], [0.075, 0.16]],
    lowpass: 0.14, decorrelation: 0.9,
  },
  room: {
    label: '房间', seconds: 1.1, decayRate: 3.8, preDelay: 0.008,
    early: [[0.005, 0.55], [0.011, 0.42], [0.018, 0.33], [0.027, 0.25]],
    lowpass: 0.3, decorrelation: 0.94,
  },
  plate: {
    label: '板式', seconds: 2.3, decayRate: 2.8, preDelay: 0.006,
    early: [[0.003, 0.4], [0.007, 0.3]],
    lowpass: 0.08, decorrelation: 0.82,
  },
  spring: {
    label: '弹簧', seconds: 1.8, decayRate: 3.2, preDelay: 0.004,
    early: [[0.002, 0.45], [0.006, 0.3], [0.011, 0.24], [0.017, 0.18]],
    lowpass: 0.22, decorrelation: 0.72,
  },
  stage: {
    label: '舞台', seconds: 2.6, decayRate: 2.3, preDelay: 0.025,
    early: [[0.009, 0.48], [0.021, 0.38], [0.036, 0.28], [0.053, 0.2], [0.073, 0.14]],
    lowpass: 0.12, decorrelation: 0.88,
  },
}

export const BUILTIN_REVERB_TYPES = Object.keys(BUILTIN_REVERB_SPECS) as BuiltinReverbType[]

/** 生成指定类型的立体声内置混响 IR（预延迟/时长可由用户参数覆盖） */
export function generateBuiltinImpulseResponse(
  context: BaseAudioContext,
  type: BuiltinReverbType,
  preDelayMs = 0,
  decaySec = 0,
): AudioBuffer {
  const spec = BUILTIN_REVERB_SPECS[type] ?? BUILTIN_REVERB_SPECS.hall
  const rate = context.sampleRate
  const preDelay = Math.max(0, Math.min(0.25, (Number.isFinite(preDelayMs) ? preDelayMs : 0) / 1000))
  const userDecay = Number.isFinite(decaySec) && decaySec > 0 ? decaySec : 0
  const totalSec = Math.min(6, spec.seconds + userDecay * 0.3)
  const length = Math.max(1, Math.floor(rate * totalSec))
  const buffer = context.createBuffer(2, length, rate)

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    const side = ch === 0 ? 1 : spec.decorrelation

    // 早期反射
    for (const [delay, gain] of spec.early) {
      const idx = Math.floor(rate * delay)
      if (idx < length) data[idx] = gain * side
    }

    // 晚期混响：相位偏移噪声 + 指数衰减 + 一阶低通
    const phaseOffset = ch === 0 ? 0 : 0.37
    const preSamples = Math.floor(rate * preDelay)
    const decayPerSample = Math.exp(-(spec.decayRate + userDecay * 0.8) / rate)
    let lp = 0
    let i = preSamples
    while (i < length) {
      const noise = (Math.random() + Math.random() - 1) * Math.sin(i * 0.13 + phaseOffset * 40 + 1) * 1.4
      lp += spec.lowpass * (noise - lp)
      data[i] += lp * Math.pow(decayPerSample, i - preSamples) * 0.65
      i++
    }
  }
  return buffer
}

/** 内置混响选项（UI 展示用） */
export function listBuiltinReverbs(): Array<{ type: BuiltinReverbType; label: string }> {
  return BUILTIN_REVERB_TYPES.map(type => ({ type, label: BUILTIN_REVERB_SPECS[type].label }))
}

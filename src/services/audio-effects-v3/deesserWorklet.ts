/**
 * 齿音抑制 - AudioWorklet 动态侧链（de-esser 精确版）
 *
 * 与 deesser.ts（固定衰减 + 快速 attack 的简化版）不同，本模块在
 * AudioWorklet 线程内实现完整动态 de-esser：
 *   - 侧链：6.5kHz 带通（RBJ bandpass，Q=1.4）检测齿音能量
 *   - 包络：attack/release 双时间常数平滑（attack 快、release 慢）
 *   - 增益：包络超阈值后按 amount 动态衰减，逐采样平滑
 * 处理器源码以内联字符串形式提供（Blob → addModule 注册），
 * 避免引入额外 .js 资源文件、兼容打包器。
 */

/** Worklet 处理器注册名 */
export const DEESSER_WORKLET_NAME = 'v3-deesser-processor'

/** 齿音检测带通频点（Hz，与 deesser.ts 的 DEESSER_DETECT_FREQ 一致） */
export const DEESSER_DETECT_FREQ = 6500

/**
 * 带通系数设计（RBJ bandpass，恒定 0dB 峰值增益）。
 * 独立导出以便单元测试；处理器源码内联相同公式。
 */
export function designBandpassCoeffs(
  f0: number,
  q: number,
  sampleRate: number,
): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w0 = (2 * Math.PI * Math.max(1, Math.min(sampleRate / 2 - 1, f0))) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosW = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** 处理器源码（纯 JS，AudioWorkletGlobalScope 环境；不要在此文件内直接执行） */
export function buildDeesserProcessorSource(): string {
  return [
    'class V3DeesserProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super()',
    '    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0',
    '    this.env = 0',
    '    this.gain = 1',
    '    // 6.5kHz 带通（RBJ bandpass，Q=1.4）——与 designBandpassCoeffs 同公式',
    '    const f0 = 6500, q = 1.4, rate = sampleRate',
    '    const w0 = 2 * Math.PI * Math.max(1, Math.min(rate / 2 - 1, f0)) / rate',
    '    const alpha = Math.sin(w0) / (2 * q)',
    '    const cosW = Math.cos(w0)',
    '    const a0 = 1 + alpha',
    '    this.b0 = alpha / a0; this.b1 = 0; this.b2 = -alpha / a0',
    '    this.a1 = -2 * cosW / a0; this.a2 = (1 - alpha) / a0',
    '  }',
    '  static get parameterDescriptors() {',
    '    return [',
    '      { name: "amount", defaultValue: 5, minValue: 0, maxValue: 10 },',
    '      { name: "threshold", defaultValue: 0.12, minValue: 0.02, maxValue: 0.8 },',
    '      { name: "attack", defaultValue: 0.005, minValue: 0.001, maxValue: 0.1 },',
    '      { name: "release", defaultValue: 0.15, minValue: 0.01, maxValue: 1 },',
    '    ]',
    '  }',
    '  process(inputs, outputs, parameters) {',
    '    const input = inputs[0]',
    '    const output = outputs[0]',
    '    if (!input || !input[0] || !output || !output[0]) return true',
    '    const amount = Math.max(0, Math.min(1, (parameters.amount[0] ?? 5) / 10))',
    '    const threshold = parameters.threshold[0] ?? 0.12',
    '    const attack = parameters.attack[0] ?? 0.005',
    '    const release = parameters.release[0] ?? 0.15',
    '    const atk = Math.exp(-1 / (Math.max(0.001, attack) * sampleRate))',
    '    const rel = Math.exp(-1 / (Math.max(0.01, release) * sampleRate))',
    '    const ch0 = input[0]',
    '    const frames = ch0.length',
    '    const nch = Math.min(output.length, input.length)',
    '    for (let i = 0; i < frames; i++) {',
    '      const x = ch0[i] ?? 0',
    '      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2',
    '      this.x2 = this.x1; this.x1 = x',
    '      this.y2 = this.y1; this.y1 = y',
    '      const abs = Math.abs(y)',
    '      // 包络：上升用 attack 系数、下降用 release 系数（快攻慢放）',
    '      this.env = abs > this.env',
    '        ? this.env + (abs - this.env) * (1 - atk)',
    '        : this.env * rel',
    '      // 超阈值部分 → 衰减（over 0..1 → 最多 amount * 0.6 线性衰减）',
    '      const over = Math.max(0, (this.env - threshold) / Math.max(0.05, (0.5 - threshold)))',
    '      const targetGain = 1 - Math.min(1, over) * amount * 0.6',
    '      // 增益平滑：压得快、恢复慢',
    '      this.gain += (targetGain - this.gain) * (targetGain < this.gain ? (1 - atk) : (1 - rel))',
    '      for (let ch = 0; ch < nch; ch++) {',
    '        output[ch][i] = (input[ch]?.[i] ?? 0) * this.gain',
    '      }',
    '    }',
    '    return true',
    '  }',
    '}',
    'registerProcessor(\'' + DEESSER_WORKLET_NAME + '\', V3DeesserProcessor)'
  ].join('\n')
}

/** 注册缓存：同一 context 只注册一次 */
const registrationCache = new WeakMap<BaseAudioContext, Promise<boolean>>()

/**
 * 确保 worklet 已注册（幂等）。源码内联注册（Blob → addModule），
 * 无需额外资源文件。注册失败返回 false（调用方回退静态 de-esser）。
 */
export function ensureDeesserWorkletRegistered(context: BaseAudioContext): Promise<boolean> {
  const cached = registrationCache.get(context)
  if (cached) return cached
  const task = (async () => {
    try {
      if (!context.audioWorklet) return false
      const source = buildDeesserProcessorSource()
      const blob = new Blob([source], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      try {
        await context.audioWorklet.addModule(url)
        return true
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch {
      return false
    }
  })()
  registrationCache.set(context, task)
  return task
}

/** 创建动态 de-esser 节点（需先注册成功） */
export function createDeesserWorkletNode(context: BaseAudioContext): AudioWorkletNode {
  const node = new AudioWorkletNode(context, DEESSER_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  })
  return node
}

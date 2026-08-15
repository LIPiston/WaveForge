/**
 * 音频能力检测（源：原应用 "查看设备音效能力" 入口，about_audio_inventory_button）
 *
 * 原 Android 应用提供"查看设备音效能力"界面，展示当前设备支持哪些音效处理。
 * Windows 桌面版（Electron/Chromium）需要等价能力检测：不同机器/音频后端支持的
 * Web Audio 能力不同（AudioWorklet 需 SecureContext、卷积 IR 依赖 ConvolverNode、
 * WAV 导出依赖 OfflineAudioContext 等）。本模块在运行时逐项探测各项能力，
 * 供 UI 展示"全能力可用 / 能力降级"并列出缺失的关键能力。
 *
 * 注意：模块顶层不创建 AudioContext 实例（可能被 vitest 在 jsdom 下 import，
 * jsdom 无 AudioContext 实现），只在 detectAudioCapabilities() 调用时惰性
 * 创建并复用；所有单项检测均 try/catch 包裹，任何单项失败都记为 false，
 * 检测永不抛异常。
 */

/** 单条输出设备信息（模块内部类型，不导出） */
interface OutputDeviceInfo {
  deviceId: string
  label: string
}

/** 音频能力检测报告（一次检测的完整结果，供 UI 直接展示） */
export interface AudioCapabilitiesReport {
  /** 音频上下文采样率（Hz） */
  sampleRate: number
  /** 输出声道数 */
  maxChannels: number
  /** 基础能力 */
  biquad: boolean      // BiquadFilterNode 可用
  convolver: boolean   // ConvolverNode 可用（卷积混响/IR 依赖）
  pannerHrtf: boolean  // PannerNode 的 HRTF 环绕可用
  waveShaper: boolean  // WaveShaperNode 可用（虚拟低频依赖）
  dynamics: boolean    // DynamicsCompressorNode 可用
  audioWorklet: boolean // AudioWorklet 可用（动态齿音抑制依赖）
  offline: boolean     // OfflineAudioContext 可用（WAV 导出依赖）
  /** 音频输出设备列表（navigator.mediaDevices.enumerateDevices 的 audiooutput，可能为空数组） */
  outputDevices: Array<{ deviceId: string; label: string }>
  /** 各能力检测的时间点（检测是异步的，记录结果时间用于 UI 显示"已检测"） */
  detectedAt: number
  /** 汇总：是否有任何关键能力缺失 */
  degraded: boolean
  /** 缺失的关键能力清单（degraded=true 时列出） */
  missing: string[]
}

/** 关键能力缺失时的中文名称（供 UI 与摘要直接展示） */
const MISSING_LABELS = {
  convolver: '卷积',
  offline: '离线渲染',
  audioWorklet: '动态齿音',
} as const

/**
 * 惰性共享 AudioContext：首次检测时创建、后续复用（避免重复创建上下文）。
 * 顶层不创建，仅在函数调用时执行，保证 jsdom 下 import 本模块不报错。
 */
let sharedContext: AudioContext | null = null

function getSharedContext(): AudioContext | null {
  if (sharedContext) return sharedContext
  // typeof 防护：无 AudioContext 的环境（jsdom/旧浏览器/SSR）不抛 ReferenceError
  if (typeof AudioContext === 'undefined') return null
  try {
    sharedContext = new AudioContext()
    return sharedContext
  } catch {
    return null
  }
}

/** 探测：在上下文中创建某类节点是否成功（创建失败记为 false，不抛错） */
function probeNode(ctx: AudioContext | null, create: (c: AudioContext) => unknown): boolean {
  if (!ctx) return false
  try {
    const node = create(ctx)
    return node != null
  } catch {
    return false
  }
}

/** 探测：PannerNode 是否支持 HRTF 环绕（panningModel 可设为 'HRTF'） */
function probePannerHrtf(ctx: AudioContext | null): boolean {
  if (!ctx) return false
  try {
    const panner = ctx.createPanner()
    if (!panner) return false
    panner.panningModel = 'HRTF'
    return panner.panningModel === 'HRTF'
  } catch {
    return false
  }
}

/** 探测：AudioWorklet 是否可用（audioWorklet 存在且 addModule 为函数） */
function probeAudioWorklet(ctx: AudioContext | null): boolean {
  if (!ctx) return false
  try {
    return typeof ctx.audioWorklet?.addModule === 'function'
  } catch {
    return false
  }
}

/** 探测：OfflineAudioContext 是否可用（WAV 导出依赖） */
function probeOffline(): boolean {
  try {
    const offline = new OfflineAudioContext(2, 128, 48000)
    return offline != null
  } catch {
    return false
  }
}

/** 枚举音频输出设备（整个枚举失败时返回空数组，label 为空字符串属正常） */
async function enumerateOutputDevices(): Promise<Array<{ deviceId: string; label: string }>> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.()
    if (!devices) return []
    return devices
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }))
  } catch {
    return []
  }
}

/**
 * 检测当前环境的音频能力，返回完整报告。
 * 检测永不抛异常：context 创建失败/任一节点创建失败均记为 false 或降级值。
 */
export async function detectAudioCapabilities(): Promise<AudioCapabilitiesReport> {
  const context = getSharedContext()

  // —— 基础节点能力（任一创建失败记为 false） ——
  const biquad = probeNode(context, (c) => c.createBiquadFilter())
  const convolver = probeNode(context, (c) => c.createConvolver())
  const waveShaper = probeNode(context, (c) => c.createWaveShaper())
  const dynamics = probeNode(context, (c) => c.createDynamicsCompressor())
  const pannerHrtf = probePannerHrtf(context)
  const audioWorklet = probeAudioWorklet(context)
  const offline = probeOffline()

  // —— 上下文属性（读取失败用降级值，不抛错） ——
  let sampleRate = 0
  let maxChannels = 2
  if (context) {
    try {
      sampleRate = context.sampleRate
    } catch {
      sampleRate = 0
    }
    try {
      maxChannels = context.destination.maxChannelCount || 2
    } catch {
      maxChannels = 2
    }
  }

  // —— 输出设备（异步枚举，失败返回 []） ——
  const outputDevices = await enumerateOutputDevices()

  // —— 关键能力汇总：v3 的导出（offline）/卷积（convolver）/动态齿音（audioWorklet） ——
  const missing: string[] = []
  if (!convolver) missing.push(MISSING_LABELS.convolver)
  if (!offline) missing.push(MISSING_LABELS.offline)
  if (!audioWorklet) missing.push(MISSING_LABELS.audioWorklet)
  const degraded = missing.length > 0

  return {
    sampleRate,
    maxChannels,
    biquad,
    convolver,
    pannerHrtf,
    waveShaper,
    dynamics,
    audioWorklet,
    offline,
    outputDevices,
    detectedAt: Date.now(),
    degraded,
    missing,
  }
}

/** 将检测报告汇总为一行中文摘要，供 UI 直接展示 */
export function summarizeCapabilities(report: AudioCapabilitiesReport): string {
  if (report.degraded) {
    return `能力降级：缺少 ${report.missing.join('/')}`
  }
  const parts: string[] = []
  if (report.sampleRate > 0) parts.push(report.sampleRate >= 1000 ? `${report.sampleRate / 1000}kHz` : `${report.sampleRate}Hz`)
  if (report.maxChannels === 1) parts.push('单声道')
  else if (report.maxChannels === 2) parts.push('双声道')
  else if (report.maxChannels > 2) parts.push(`${report.maxChannels}声道`)
  return `${parts.join(' ')}：全能力可用`
}

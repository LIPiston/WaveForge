/**
 * 音频引擎 v3 —— 基于 原应用 逆向代码重构的 Web Audio 音效引擎
 *
 * 独立开发声明（重要约束）：除"接口调用"（attach/dispose/updateSettings 等与 v1/v2
 * 保持同名的接入契约，供 App.tsx 版本切换机制调用）之外，本模块业务代码全部独立实现，
 * 不复制、不 import、不调用 v1/v2 模块的任何业务代码；功能重叠点均为独立设计与独立数值。
 * 接入方式与 App.tsx 现有 v1/v2 切换机制一致（见 MERGE_GUIDE.md）。
 *
 * v3 功能全部来自 原应用 逆向：
 *   1. 20 段均衡器（E8 频点 + F8/G8 预设 + fp 曲线模型）
 *   2. 设备档案（H8：外放/头戴/入耳/桌面音箱/舞台功放）
 *   3. 设备频响数据库（x/ht.java：128 点实测曲线，Xiaomi/Redmi/JBL 44 台）
 *   4. 频响合并引擎（AudioControlForegroundService.m()：route × scene 对数插值）
 *   5. 64 阶 IIR 参数均衡（PEQ：F/G/Q 旋钮语义 + 增删频段）
 *   6. 低频增强 + 虚拟低频（心理声学谐波合成）
 *   7. 齿音抑制（动态 de-esser）
 *   8. 卷积脉冲响应（启用时互斥自动关闭 5 项效果，关闭后恢复）
 *   9. 智能响度（smart loudness + 输出限幅）
 *   10. App 独立音效（per-source 档案）
 *   11. 听力分析（听感分析引导调校流程）
 *   12. 机型基础预设（Windows 端）：把设备库实测曲线一键切换为基础预设
 *   13. 输出设备自动适配（Windows 音频端点：外放/耳机/蓝牙 → 自动切换设备档案）
 *
 * 效果链（原应用 风格）：
 *   input → 人声/伴奏(M/S) → [20段EQ(曲线求值)] → [PEQ 64阶IIR] → [频响合并Biquad链]
 *     → 低频增强 → 虚拟低频 → 齿音抑制 → [卷积IR(干湿)] → 压缩 → 夜间 → 智能响度 → 限幅 → output
 */

import { debugLog } from '../../utils/debugLog'
import {
  EQ_BANDS_20,
  EQ_BANDS_10_ODD,
  EQ_PRESET_NAMES,
  EQ_PRESET_CURVES,
  DEVICE_PROFILES,
  DEFAULT_PEQ_CURVE_STRING,
  quantizeGain,
  type DeviceProfile,
  type AudioRoute,
} from './constants'
import {
  evaluateCurveAtFreqs,
  parseCurve,
  serializeCurve,
  setBand,
  addBandAt,
  removeBandAt,
  defaultCurve,
  flatCurve,
  sortCurve,
  ensureCurve,
  type EqPoint,
} from './curve'
import {
  mergeFrequencyResponse,
  mergeResultToSegments,
  interpolateResponse,
  curveToResponse,
  sampleCurveAtPercent,
  defaultLoudnessCurve,
  type FrRoute,
  type FrScene,
  type FrFilterSegment,
} from './frequencyResponse'
import { IirPeq, type PeqBand } from './iirPeq'
import {
  buildVirtualBassShaperCurve,
  virtualBassMix,
  bassEnhanceGain,
  VIRTUAL_BASS_CROSSOVER,
  BASS_PUNCH_FREQ,
} from './bassEnhancer'
import { DEESSER_DETECT_FREQ, deesserMaxCut, deesserThreshold, DEESSER_ATTACK, DEESSER_RELEASE } from './deesser'
import { ensureDeesserWorkletRegistered, createDeesserWorkletNode, DEESSER_WORKLET_NAME } from './deesserWorklet'
import { SMART_LOUDNESS_TARGET, SMART_LOUDNESS_TAU, loudnessGain, LIMITER_CONFIG } from './smartLoudness'
import {
  IEQ_STYLE_CURVES,
  IEQ_STYLE_NAMES,
  defaultIeqState,
  ieqTargetCurve,
  ieqAmountScaling,
  applyIeq,
  loadCustomIeq,
  type IeqState,
} from './ieq'
import { computeAutoPostEq, defaultAutoPostEq, type AutoPostEqSettings } from './autoPostEq'
import { exportShareString, importShareString, isShareString, type SharePayload } from './shareCodec'
import { findDevice, listDeviceModels, groupDeviceModels, type DeviceFreqEntry, type DeviceModelOption } from './deviceDb'
import {
  defaultConvolution,
  decodeImpulseResponse,
  normalizeImpulseResponse,
  ConvolutionMutex,
  generateBuiltinImpulseResponse,
  listBuiltinReverbs,
  type ConvolutionSettings,
  type ConvolutionMutexKey,
  type BuiltinReverbType,
} from './convolution'
import {
  loadAppProfiles,
  saveAppProfiles,
  findAppProfile,
  upsertAppProfile,
  deleteAppProfile,
  profileToCurve,
  type AppAudioProfile,
} from './appProfiles'
import {
  initialAnalysisState,
  startAnalysis,
  applyFeedback,
  finishAnalysis,
  currentGuidance,
  type HearingAnalysisState,
  type HearingFeedback,
} from './hearingAnalysis'

// ============ 设置类型（v3） ============

/** 均衡器模式：flat=平直 / preset=5 套预设 / curve=自由曲线 / device=设备档案曲线 */
export type V3EqMode = 'flat' | 'preset' | 'curve' | 'device'

export interface V3EqSettings {
  enabled: boolean
  mode: V3EqMode
  /** preset 模式：EQ_PRESET_NAMES 下标 0-4 */
  presetIndex: number
  /** curve 模式：自由曲线点（fp 模型，1-50 点） */
  curve: EqPoint[]
  /** device 模式：设备档案 id */
  deviceProfileId: string | null
}

export interface V3PeqSettings {
  enabled: boolean
  /** 64 阶 IIR 参数均衡：频段列表（F/G/Q 语义） */
  bands: PeqBand[]
}

export interface V3FrSettings {
  enabled: boolean
  route: AudioRoute
  scene: FrScene
  /** 设备库目标曲线（由 deviceCode 解析），null = 不合并目标 */
  deviceCode: string | null
  /** 自定义目标曲线（128 点，20Hz-20kHz 对数轴），优先级低于 deviceCode */
  targetCurve: number[] | null
  blend: number
}

export interface V3AdvancedSettings {
  /** 低频增强（bass_enhancer 语义：增强量/截止频率/作用宽度可调） */
  bassEnhance: { enabled: boolean; intensity: number; cutoff: number; width: number }
  /** 虚拟低频（DAP Spatializer 语义：基频/谐波/融合方式可调，对应 game_dap 字符串） */
  virtualBass: { enabled: boolean; amount: number; baseFreq: number; harmonics: number; blend: number }
  /** 齿音抑制：mode=static 简化动态（固定衰减+快 attack）/ dynamic=AudioWorklet 精确侧链 */
  deesser: { enabled: boolean; amount: number; mode: 'static' | 'dynamic' }
  /** 对白清晰度（对应 dolby_advanced 字符串："提升对白清晰度，并在不同音量段之间保持更稳定的听感"） */
  dialogueClarity: { enabled: boolean; amount: number }
  convolution: ConvolutionSettings
  compressor: { enabled: boolean; threshold: number; ratio: number; attack: number; release: number; outputGain: number }
  nightMode: { enabled: boolean; amount: number }
}

/** 智能均衡 IEQ（x/bb.java 移植：风格 0-2 内置 / 3 自定义 + 低中高三段强度） */
export interface V3IeqSettings {
  enabled: boolean
  style: number
  bassAmount: number
  presenceAmount: number
  trebleAmount: number
  customCurve: number[] | null
}

/** Post 均衡（智能 Post 自动计算的补偿段 + 手工 Post 曲线共用 Post 段） */
export interface V3PostEqSettings {
  /** 智能 Post：自动计算补偿频段（auto_post_eq 语义） */
  auto: AutoPostEqSettings
  /** 手工 Post 曲线（基础页 Pre/Post 均衡语义） */
  manual: { enabled: boolean; curve: EqPoint[] }
}

export interface V3MasterSettings {
  /** 人声/伴奏比例（M/S）：-1 仅伴奏 ~ +1 仅人声 */
  voiceBalance: number
  smartLoudness: { enabled: boolean; targetLufs: number }
  /** 等响曲线（speaker_response_custom_edit_loudness 语义）：20 档音量→增益映射 */
  loudnessCurve: { enabled: boolean; curve: number[] }
  /** 当前听音音量 0-100（UI/播放器告知，用于等响曲线采样） */
  listeningVolume: number
}

/** 机型基础预设与输出设备适配（Windows 端功能） */
export interface V3DeviceSettings {
  /** 机型基础预设：设备库型号代号（如 fuxi / alioth），null = 未选 */
  modelCode: string | null
  /** 机型基础预设：型号显示名（由 modelCode 解析缓存） */
  modelName: string | null
  /** 输出设备自动适配：按 Windows 输出设备类型自动切换设备档案 */
  autoDetect: boolean
  /** 当前输出设备类型（Windows 音频端点检测结果；unknown = 未检测） */
  outputKind: 'speaker' | 'headphones' | 'bluetooth' | 'unknown'
}

export interface V3Settings {
  /** 音效方案：standard=标准（兼容/回退）/ spatial=空间增强（对应 effect_switch_desc 字符串） */
  scheme: 'standard' | 'spatial'
  eq: V3EqSettings
  /** 主均衡是否被设备频响预设锁定（speaker_response_eq_locked_message 语义） */
  eqLocked: boolean
  peq: V3PeqSettings
  frequencyResponse: V3FrSettings
  /** 智能均衡 IEQ（频响设置，仅 spatial 方案生效） */
  ieq: V3IeqSettings
  /** Post 均衡（智能 Post 自动 + 手工曲线） */
  postEq: V3PostEqSettings
  advanced: V3AdvancedSettings
  master: V3MasterSettings
  /** 机型基础预设与输出设备适配（Windows 端） */
  device: V3DeviceSettings
  /** 当前场景方案 id */
  activeScene: string | null
  customized: boolean
  /** 归一化（与 v2 兼容：由播放器按曲目设置 LUFS 增益） */
  normalizationEnabled: boolean
}

/** 场景方案快照（v3：完整听感参数） */
export interface V3SceneSnapshot {
  id: string
  name: string
  description?: string
  builtin?: boolean
  settings: V3Settings
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ============ 常量 ============

const SETTINGS_KEY = 'waveforge:audio-effects-v3-settings'
const MY_SCENES_KEY = 'waveforge:audio-effects-v3-scenes'

/** 卷积启用时互斥的效果键（原应用 文案：虚拟低频、IIR、频响曲线、齿音抑制、低频增强） */
const CONV_MUTEX_EFFECTS: ConvolutionMutexKey[] = ['virtualBass', 'iirPeq', 'frequencyResponse', 'deesser', 'bassEnhance']

function defaultV3Settings(): V3Settings {
  return {
    scheme: 'standard',
    eq: {
      enabled: false,
      mode: 'flat',
      presetIndex: 1,
      curve: defaultCurve(),
      deviceProfileId: null,
    },
    eqLocked: false,
    peq: {
      enabled: false,
      bands: parseCurve(DEFAULT_PEQ_CURVE_STRING)!.map(p => ({ freq: p.freq, gain: p.gain, q: p.q })),
    },
    frequencyResponse: {
      enabled: false,
      route: 'standard',
      scene: 'standard',
      deviceCode: null,
      targetCurve: null,
      blend: 0.5,
    },
    ieq: {
      ...defaultIeqState(),
    },
    postEq: {
      auto: defaultAutoPostEq(),
      manual: { enabled: false, curve: flatCurve() },
    },
    advanced: {
      bassEnhance: { enabled: false, intensity: 6, cutoff: 120, width: 0.9 },
      virtualBass: { enabled: false, amount: 5, baseFreq: 55, harmonics: 3, blend: 0.6 },
      deesser: { enabled: false, amount: 5, mode: 'static' },
      dialogueClarity: { enabled: false, amount: 5 },
      convolution: defaultConvolution(),
      compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.02, release: 0.2, outputGain: 3 },
      nightMode: { enabled: false, amount: 6 },
    },
    master: {
      voiceBalance: 0,
      smartLoudness: { enabled: false, targetLufs: SMART_LOUDNESS_TARGET },
      loudnessCurve: { enabled: false, curve: defaultLoudnessCurve() },
      listeningVolume: 80,
    },
    device: {
      modelCode: null,
      modelName: null,
      autoDetect: false,
      outputKind: 'unknown',
    },
    activeScene: null,
    customized: false,
    normalizationEnabled: false,
  }
}

function loadV3Settings(): V3Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaultV3Settings()
    const parsed = JSON.parse(raw) as Partial<V3Settings>
    const base = defaultV3Settings()
    return {
      ...base,
      ...parsed,
      eq: { ...base.eq, ...(parsed.eq || {}) },
      peq: { ...base.peq, ...(parsed.peq || {}) },
      frequencyResponse: { ...base.frequencyResponse, ...(parsed.frequencyResponse || {}) },
      advanced: {
        bassEnhance: { ...base.advanced.bassEnhance, ...(parsed.advanced?.bassEnhance || {}) },
        virtualBass: { ...base.advanced.virtualBass, ...(parsed.advanced?.virtualBass || {}) },
        deesser: { ...base.advanced.deesser, ...(parsed.advanced?.deesser || {}) },
        dialogueClarity: { ...base.advanced.dialogueClarity, ...(parsed.advanced?.dialogueClarity || {}) },
        convolution: { ...base.advanced.convolution, ...(parsed.advanced?.convolution || {}) },
        compressor: { ...base.advanced.compressor, ...(parsed.advanced?.compressor || {}) },
        nightMode: { ...base.advanced.nightMode, ...(parsed.advanced?.nightMode || {}) },
      },
      master: {
        voiceBalance: parsed.master?.voiceBalance ?? 0,
        smartLoudness: { ...base.master.smartLoudness, ...(parsed.master?.smartLoudness || {}) },
        loudnessCurve: {
          enabled: !!parsed.master?.loudnessCurve?.enabled,
          curve: Array.isArray(parsed.master?.loudnessCurve?.curve) && (parsed.master!.loudnessCurve!.curve!.length > 0)
            ? parsed.master!.loudnessCurve!.curve!
            : base.master.loudnessCurve.curve,
        },
        listeningVolume: typeof parsed.master?.listeningVolume === 'number' ? parsed.master!.listeningVolume : 80,
      },
      device: { ...base.device, ...(parsed.device || {}) },
      scheme: parsed.scheme === 'spatial' ? 'spatial' : 'standard',
      eqLocked: !!parsed.eqLocked,
      ieq: { ...base.ieq, ...(parsed.ieq || {}) },
      postEq: {
        auto: { ...base.postEq.auto, ...(parsed.postEq?.auto || {}) },
        manual: { ...base.postEq.manual, ...(parsed.postEq?.manual || {}) },
      },
    }
  } catch {
    return defaultV3Settings()
  }
}

// ============ 内置场景（原应用 风格：设备档案场景 + 预设场景） ============

/** 由设备档案生成场景（档案曲线 + 高频收敛） */
function sceneFromDeviceProfile(profile: DeviceProfile, description: string): V3SceneSnapshot {
  const base = defaultV3Settings()
  // 档案 4 频点 + 前 4 参数构造起点曲线（与 hearingAnalysis.startAnalysis 一致）
  const curve: EqPoint[] = profile.curveFreqs.map((freq, i) => ({
    freq,
    gain: Math.max(-15, Math.min(15, profile.params[i]!)),
    q: [0.8, 1.1, 1.0, 0.9][i]!,
  }))
  return {
    id: `scene-${profile.id}`,
    name: profile.name,
    description,
    builtin: true,
    settings: {
      ...base,
      eq: { ...base.eq, enabled: true, mode: 'device', deviceProfileId: profile.id, curve: sortCurve(curve) },
    },
  }
}

function buildBuiltinScenes(): V3SceneSnapshot[] {
  const scenes: V3SceneSnapshot[] = DEVICE_PROFILES.map(p => sceneFromDeviceProfile(p, p.description))
  // 5 套 EQ 预设场景（F8 语义）
  EQ_PRESET_NAMES.forEach((name, i) => {
    if (i === 0) return // 自定义曲线不做场景
    const base = defaultV3Settings()
    scenes.push({
      id: `scene-preset-${i}`,
      name: `${name}（预设）`,
      description: `EQ 预设：${name}`,
      builtin: true,
      settings: {
        ...base,
        eq: {
          ...base.eq,
          enabled: true,
          mode: 'preset',
          presetIndex: i,
          curve: EQ_BANDS_10_ODD.map((freq, j) => ({
            freq,
            gain: quantizeGain(EQ_PRESET_CURVES[i]![j]!),
            q: 1,
          })),
        },
      },
    })
  })
  return scenes
}

// ============ 效果链构建（v3，原应用 风格） ============

interface BuiltV3Chain {
  input: GainNode
  output: GainNode
  // M/S 人声/伴奏
  voiceMatrix: { input: GainNode; output: GainNode; centerGain: GainNode; sideGain: GainNode }
  // EQ / PEQ / 频响合并 插入点（顺序动态重建）
  toneInput: GainNode
  toneOutput: GainNode
  // 低频增强（lowshelf + 55Hz punch）
  bassShelf: BiquadFilterNode
  bassPunch: BiquadFilterNode
  // 虚拟低频（谐波整形）
  vBassShaper: WaveShaperNode
  vBassFilter: BiquadFilterNode
  vBassDry: GainNode
  vBassWet: GainNode
  // 齿音抑制（检测 + 动态衰减；dynamic 模式用 AudioWorklet 节点）
  deesserDetect: BiquadFilterNode
  deesserGain: GainNode
  deesserDynamic: AudioWorkletNode | null
  // 卷积 IR（干湿）
  convolver: ConvolverNode
  convDry: GainNode
  convWet: GainNode
  // 动态处理
  compressor: DynamicsCompressorNode
  nightCompressor: DynamicsCompressorNode
  nightTreble: BiquadFilterNode
  nightGain: GainNode
  // 对白清晰度（2.2kHz 存在感提升）
  dialoguePeak: BiquadFilterNode
  // Post 均衡段（动态处理后插入）
  postToneInput: GainNode
  postToneOutput: GainNode
  // 智能响度 + 输出保护
  loudnessGain: GainNode
  limiter: DynamicsCompressorNode
}

function buildV3Chain(context: BaseAudioContext): BuiltV3Chain {
  const input = context.createGain()
  const output = context.createGain()
  input.gain.value = 1
  output.gain.value = 1

  // M/S 矩阵（独立实现的标准 mid/side 编解码：center=人声、side=伴奏）
  const mkMatrix = () => {
    const matInput = context.createGain()
    const left = context.createChannelSplitter(2)
    const mid = context.createGain()
    const side = context.createGain()
    const right = context.createChannelMerger(2)
    const lInv = context.createGain()
    lInv.gain.value = -1
    // L+R → mid；L-R → side
    matInput.connect(left)
    left.connect(mid, 0)
    left.connect(mid, 1)
    left.connect(side, 0)
    left.connect(lInv, 1)
    lInv.connect(side)
    // 混合输出
    const midToL = context.createGain()
    const midToR = context.createGain()
    const sideToL = context.createGain()
    const sideToR = context.createGain()
    const outGain = context.createGain()
    mid.connect(midToL)
    mid.connect(midToR)
    side.connect(sideToL)
    side.connect(sideToR)
    const sInv = context.createGain()
    sInv.gain.value = -1
    sideToR.connect(sInv)
    const sumL = context.createGain()
    const sumR = context.createGain()
    midToL.connect(sumL)
    sideToL.connect(sumL)
    midToR.connect(sumR)
    sInv.connect(sumR)
    sumL.connect(right, 0, 0)
    sumR.connect(right, 0, 1)
    right.connect(outGain)
    return { input: matInput, output: outGain, centerGain: mid, sideGain: side }
  }
  const voiceMatrix = mkMatrix()

  // 音色插入段（EQ/PEQ/频响合并动态重建）
  const toneInput = context.createGain()
  const toneOutput = context.createGain()

  // 低频增强
  const bassShelf = context.createBiquadFilter()
  bassShelf.type = 'lowshelf'
  bassShelf.frequency.value = 120
  bassShelf.gain.value = 0
  const bassPunch = context.createBiquadFilter()
  bassPunch.type = 'peaking'
  bassPunch.frequency.value = BASS_PUNCH_FREQ
  bassPunch.Q.value = 0.9
  bassPunch.gain.value = 0

  // 虚拟低频：低通 → 谐波整形 → 混合
  const vBassFilter = context.createBiquadFilter()
  vBassFilter.type = 'lowpass'
  vBassFilter.frequency.value = VIRTUAL_BASS_CROSSOVER
  const vBassShaper = context.createWaveShaper()
  vBassShaper.oversample = '2x'
  vBassShaper.curve = buildVirtualBassShaperCurve(5)
  const vBassDry = context.createGain()
  vBassDry.gain.value = 1
  const vBassWet = context.createGain()
  vBassWet.gain.value = 0

  // 齿音抑制：检测带通 → 增益（动态）→ 串回
  const deesserDetect = context.createBiquadFilter()
  deesserDetect.type = 'bandpass'
  deesserDetect.frequency.value = DEESSER_DETECT_FREQ
  deesserDetect.Q.value = 1.4
  const deesserGain = context.createGain()
  deesserGain.gain.value = 1

  // 卷积 IR（干湿）
  const convolver = context.createConvolver()
  const convDry = context.createGain()
  convDry.gain.value = 1
  const convWet = context.createGain()
  convWet.gain.value = 0

  // 动态处理
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = 0
  compressor.ratio.value = 1
  compressor.knee.value = 6
  compressor.attack.value = 0.02
  compressor.release.value = 0.2

  // 夜间模式（v3 独立设计）：温和动态压缩 + 高频衰减，深夜低音量舒适听感。
  // 参数为 v3 自行推导（阈值随强度 -20 到 -29、ratio 2.0 到 5.0、高频 -1 到 -6dB），
  // 与其他引擎无共享代码或参数来源。
  const nightCompressor = context.createDynamicsCompressor()
  nightCompressor.threshold.value = 0
  nightCompressor.ratio.value = 1
  nightCompressor.knee.value = 12
  nightCompressor.attack.value = 0.01
  nightCompressor.release.value = 0.35
  const nightTreble = context.createBiquadFilter()
  nightTreble.type = 'highshelf'
  nightTreble.frequency.value = 6500
  nightTreble.gain.value = 0
  const nightGain = context.createGain()
  nightGain.gain.value = 1

  // 对白清晰度（2.2kHz peaking，存在感提升）
  const dialoguePeak = context.createBiquadFilter()
  dialoguePeak.type = 'peaking'
  dialoguePeak.frequency.value = 2200
  dialoguePeak.Q.value = 1.2
  dialoguePeak.gain.value = 0

  // Post 均衡段（默认直连，动态重建时摘除）
  const postToneInput = context.createGain()
  const postToneOutput = context.createGain()

  // 智能响度 + 限幅
  const loudnessGain = context.createGain()
  loudnessGain.gain.value = 1
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = LIMITER_CONFIG.threshold
  limiter.knee.value = LIMITER_CONFIG.knee
  limiter.ratio.value = LIMITER_CONFIG.ratio
  limiter.attack.value = LIMITER_CONFIG.attack
  limiter.release.value = LIMITER_CONFIG.release

  // 骨架：
  // input → voiceMatrix → toneInput → [动态插入] → toneOutput
  //   → bassShelf → bassPunch → vBass(干/湿混合) → deesser → conv(干/湿)
  //   → compressor → night → loudnessGain → limiter → output
  input.connect(voiceMatrix.input)
  voiceMatrix.output.connect(toneInput)
  toneOutput.connect(bassShelf)
  bassShelf.connect(bassPunch)

  // 虚拟低频：干路直通 + 湿路（低通→shaper）
  bassPunch.connect(vBassDry)
  bassPunch.connect(vBassFilter)
  vBassFilter.connect(vBassShaper)
  vBassShaper.connect(vBassWet)
  const vBassMixOut = context.createGain()
  vBassDry.connect(vBassMixOut)
  vBassWet.connect(vBassMixOut)

  vBassMixOut.connect(deesserDetect)
  deesserDetect.connect(deesserGain)

  // 卷积：干湿并行
  deesserGain.connect(convDry)
  deesserGain.connect(convolver)
  convolver.connect(convWet)
  const convOut = context.createGain()
  convDry.connect(convOut)
  convWet.connect(convOut)

  convOut.connect(compressor)
  compressor.connect(nightCompressor)
  nightCompressor.connect(nightTreble)
  nightTreble.connect(nightGain)
  nightGain.connect(dialoguePeak)
  dialoguePeak.connect(postToneInput)
  postToneOutput.connect(loudnessGain)
  loudnessGain.connect(limiter)
  limiter.connect(output)

  // toneInput → toneOutput / postToneInput → postToneOutput 默认直连（动态重建时摘除）
  toneInput.connect(toneOutput)
  postToneInput.connect(postToneOutput)

  return {
    input, output,
    voiceMatrix,
    toneInput, toneOutput,
    bassShelf, bassPunch,
    vBassShaper, vBassFilter, vBassDry, vBassWet,
    deesserDetect, deesserGain,
    deesserDynamic: null,
    convolver, convDry, convWet,
    compressor, nightCompressor, nightTreble, nightGain,
    dialoguePeak,
    postToneInput, postToneOutput,
    loudnessGain, limiter,
  }
}

// 访问 Chrome 对 DynamicsCompressorNode 的扩展属性 makeupGain（TS lib 未收录）。
// 纯平台属性访问（无业务逻辑），独立封装。
function compressorMakeupGain(comp: DynamicsCompressorNode): AudioParam | null {
  return (comp as unknown as { makeupGain?: AudioParam }).makeupGain || null
}

// WAV 编码（独立实现）：把 AudioBuffer 编码为 16-bit PCM WAV。
// 标准 RIFF/WAVE 容器：头部按规范逐字段写入（44 字节），采样数据
// 用 Int16Array 视图批量转换（先钳制 -1..1 再映射到 16-bit 整数域）。
function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const rate = buffer.sampleRate
  const dataBytes = buffer.length * channels * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const head = new DataView(bytes.buffer)

  // RIFF 头（little-endian）
  const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))
  bytes.set(ascii('RIFF'), 0)
  head.setUint32(4, 36 + dataBytes, true)
  bytes.set(ascii('WAVE'), 8)
  bytes.set(ascii('fmt '), 12)
  head.setUint32(16, 16, true) // fmt 块大小
  head.setUint16(20, 1, true) // PCM
  head.setUint16(22, channels, true)
  head.setUint32(24, rate, true)
  head.setUint32(28, rate * channels * 2, true) // 字节率
  head.setUint16(32, channels * 2, true) // 块对齐
  head.setUint16(34, 16, true) // 位深
  bytes.set(ascii('data'), 36)
  head.setUint32(40, dataBytes, true)

  // 采样数据：交错写入（frame 内按声道序）
  const pcm = new Int16Array(bytes.buffer, 44, buffer.length * channels)
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]!))
      pcm[i * channels + ch] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
  }
  return new Blob([bytes.buffer], { type: 'audio/wav' })
}

// ============ 引擎 ============

export class AudioEffectsEngineV3 {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private input: GainNode | null = null
  private output: GainNode | null = null
  private chain: BuiltV3Chain | null = null

  /** 归一化增益（播放器按曲目设置，v2 兼容接口） */
  private normGain: GainNode | null = null

  /** 动态插入的音色段（EQ / PEQ / 频响合并） */
  private toneFilters: BiquadFilterNode[] = []
  private toneNodes: AudioNode[] = []
  /** Post 段节点（手工 Post 曲线 + 智能 Post 自动补偿） */
  private postToneNodes: AudioNode[] = []

  /** 卷积互斥状态机 */
  private convMutex = new ConvolutionMutex()
  /** 卷积 IR 指纹：irUrl|normalize 变化才重建 */
  private lastIrKey = ''

  /** 当前曲目 sourceKey（App 独立音效） */
  private activeSourceKey: string | null = null
  /** 当前曲目 LUFS（智能响度/归一化） */
  private measuredLufs: number | null = null
  /** 听力分析演示音频源（循环播放用；null = 由 UI 用当前曲目） */
  private analysisDemoSource: string | null = null
  /** 听力分析演示音（振荡器循环扫频，经效果链播放） */
  private analysisDemoNodes: { osc: OscillatorNode; gain: GainNode; timer: number } | null = null

  /** 听力分析状态 */
  analysis: HearingAnalysisState = initialAnalysisState()

  private settings: V3Settings = loadV3Settings()
  private myScenes: V3SceneSnapshot[] = loadMyScenes()

  // ============ 查询接口（v2 对齐） ============

  getSettings(): V3Settings { return this.settings }
  getMyScenes(): V3SceneSnapshot[] { return this.myScenes }
  getBuiltinScenes(): V3SceneSnapshot[] { return buildBuiltinScenes() }

  /** 设备档案列表（H8 原样） */
  getDeviceProfiles(): DeviceProfile[] { return DEVICE_PROFILES }

  /** 当前引导文案（听力分析用） */
  getAnalysisGuidance(): string { return currentGuidance(this.analysis) }

  private saveSettings(): void {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)) } catch { /* 忽略 */ }
  }

  // ============ 设置更新（v2 对齐 + 互斥语义） ============

  applySettings(next: V3Settings): void {
    this.settings = next
    this.saveSettings()
    this.rebuildFromSettings()
  }

  updateSettings(patch: DeepPartial<V3Settings>): void {
    const prev = this.settings
    // effects 是 advanced 的 v2 兼容别名（v2 UI 用 effects.xxx 传参）
    const aliasEffects = (patch as unknown as { effects?: Record<string, Record<string, unknown>> }).effects
    const pe = { ...(aliasEffects || {}), ...(patch.advanced || {}) } as Record<string, Record<string, unknown>>
    const se = prev.advanced
    // 旧值记录（互斥判定）
    const prevVirtualBass = se.virtualBass
    this.settings = {
      ...prev,
      eq: { ...prev.eq, ...(patch.eq || {}) } as V3EqSettings,
      peq: { ...prev.peq, ...(patch.peq || {}) } as V3PeqSettings,
      frequencyResponse: { ...prev.frequencyResponse, ...(patch.frequencyResponse || {}) } as V3FrSettings,
      advanced: {
        bassEnhance: { ...se.bassEnhance, ...((pe as { bassEnhance?: Partial<V3AdvancedSettings['bassEnhance']> }).bassEnhance || {}) },
        virtualBass: { ...se.virtualBass, ...((pe as { virtualBass?: Partial<V3AdvancedSettings['virtualBass']> }).virtualBass || {}) },
        deesser: { ...se.deesser, ...((pe as { deesser?: Partial<V3AdvancedSettings['deesser']> }).deesser || {}) },
        dialogueClarity: { ...se.dialogueClarity, ...((pe as { dialogueClarity?: Partial<V3AdvancedSettings['dialogueClarity']> }).dialogueClarity || {}) },
        convolution: { ...se.convolution, ...((pe as { convolution?: Partial<V3AdvancedSettings['convolution']> }).convolution || {}) },
        compressor: { ...se.compressor, ...((pe as { compressor?: Partial<V3AdvancedSettings['compressor']> }).compressor || {}) },
        nightMode: { ...se.nightMode, ...((pe as { nightMode?: Partial<V3AdvancedSettings['nightMode']> }).nightMode || {}) },
      } as V3AdvancedSettings,
      ...(patch.scheme !== undefined ? { scheme: patch.scheme } : {}),
      ...(patch.eqLocked !== undefined ? { eqLocked: patch.eqLocked } : {}),
      ...(patch.ieq !== undefined ? { ieq: { ...prev.ieq, ...(patch.ieq || {}) } } : {}),
      ...(patch.postEq !== undefined ? {
        postEq: {
          auto: { ...prev.postEq.auto, ...(patch.postEq.auto || {}) } as V3PostEqSettings['auto'],
          manual: { ...prev.postEq.manual, ...(patch.postEq.manual || {}) } as V3PostEqSettings['manual'],
        },
      } : {}),
      master: { ...prev.master, ...(patch.master || {}) } as V3MasterSettings,
      ...(patch.activeScene !== undefined ? { activeScene: patch.activeScene } : {}),
      ...(patch.customized !== undefined ? { customized: patch.customized } : {}),
      ...(patch.normalizationEnabled !== undefined ? { normalizationEnabled: patch.normalizationEnabled } : {}),
      ...(patch.device !== undefined ? { device: { ...prev.device, ...(patch.device || {}) } } : {}),
    }

    // 卷积互斥：启用卷积时临时关闭 5 项；关闭时恢复
    const conv = this.settings.advanced.convolution
    if (conv.enabled && !prev.advanced.convolution.enabled) {
      const keys: Record<ConvolutionMutexKey, boolean> = {
        virtualBass: this.settings.advanced.virtualBass.enabled,
        iirPeq: this.settings.peq.enabled,
        frequencyResponse: this.settings.frequencyResponse.enabled,
        deesser: this.settings.advanced.deesser.enabled,
        bassEnhance: this.settings.advanced.bassEnhance.enabled,
      }
      const toClose = this.convMutex.suspend(keys)
      for (const k of toClose) {
        if (k === 'virtualBass') this.settings.advanced.virtualBass.enabled = false
        else if (k === 'iirPeq') this.settings.peq.enabled = false
        else if (k === 'frequencyResponse') this.settings.frequencyResponse.enabled = false
        else if (k === 'deesser') this.settings.advanced.deesser.enabled = false
        else if (k === 'bassEnhance') this.settings.advanced.bassEnhance.enabled = false
      }
      debugLog(`[AudioEffectsV3] 卷积启用，临时关闭互斥项：${toClose.join(', ')}`)
    } else if (!conv.enabled && prev.advanced.convolution.enabled) {
      const toRestore = this.convMutex.restore()
      for (const k of toRestore) {
        if (k === 'virtualBass') this.settings.advanced.virtualBass.enabled = true
        else if (k === 'iirPeq') this.settings.peq.enabled = true
        else if (k === 'frequencyResponse') this.settings.frequencyResponse.enabled = true
        else if (k === 'deesser') this.settings.advanced.deesser.enabled = true
        else if (k === 'bassEnhance') this.settings.advanced.bassEnhance.enabled = true
      }
      debugLog(`[AudioEffectsV3] 卷积关闭，恢复互斥项：${toRestore.join(', ')}`)
    }

    if (patch.activeScene === undefined) this.settings.customized = true
    this.saveSettings()
    this.rebuildFromSettings()
  }

  /** v2 兼容：切换单个效果开关（v3 对应 advanced 子项） */
  toggleEffect(key: keyof V3AdvancedSettings | 'iirPeq' | 'frequencyResponse' | null): void {
    if (!key) return
    if (key === 'iirPeq') {
      this.updateSettings({ peq: { enabled: !this.settings.peq.enabled } })
      return
    }
    if (key === 'frequencyResponse') {
      this.updateSettings({ frequencyResponse: { enabled: !this.settings.frequencyResponse.enabled } })
      return
    }
    const current = this.settings.advanced[key]
    if (!current || typeof current !== 'object') return
    const enabled = !('enabled' in current ? current.enabled : false)
    this.updateSettings({ effects: { [key]: { ...current, enabled } } } as unknown as DeepPartial<V3Settings>)
  }

  // ============ 场景方案（v2 对齐） ============

  applyScene(scene: V3SceneSnapshot): void {
    this.settings = {
      ...JSON.parse(JSON.stringify(scene.settings)) as V3Settings,
      activeScene: scene.id,
      customized: false,
    }
    this.saveSettings()
    this.rebuildFromSettings()
  }

  saveAsMyScene(name: string): boolean {
    const trimmed = name.trim()
    if (!trimmed || this.myScenes.length >= 8) return false
    const scene: V3SceneSnapshot = {
      id: `my-${Date.now()}`,
      name: trimmed,
      settings: JSON.parse(JSON.stringify(this.settings)) as V3Settings,
    }
    this.myScenes = [...this.myScenes, scene]
    saveMyScenes(this.myScenes)
    return true
  }

  deleteMyScene(id: string): void {
    this.myScenes = this.myScenes.filter(s => s.id !== id)
    saveMyScenes(this.myScenes)
  }

  // ============ 响度 / 归一化（v2 对齐） ============

  setNormalizationGain(db: number | null): void {
    if (!this.normGain || !this.context) return
    if (db === null || !this.settings.normalizationEnabled) {
      this.normGain.gain.setTargetAtTime(1, this.context.currentTime, 0.02)
      return
    }
    const clamped = Math.max(-9, Math.min(9, db))
    this.normGain.gain.setTargetAtTime(Math.pow(10, clamped / 20), this.context.currentTime, 0.02)
  }

  /** 告知引擎系统音量（预留 v2 兼容；v3 智能响度不使用系统音量） */
  setSystemVolume(_volume: number): void { /* v3 无需 */ }

  /** 播放器告知当前曲目响度（LUFS）→ 智能响度增益 */
  setTrackLoudness(lufs: number | null): void {
    this.measuredLufs = lufs
    this.applySmartLoudness()
  }

  private applySmartLoudness(): void {
    if (!this.chain || !this.context) return
    const sl = this.settings.master.smartLoudness
    const lc = this.settings.master.loudnessCurve
    const t = this.context.currentTime
    // 等响曲线（x/ht.o 语义）：按当前听音音量从 20 档映射表采样增益（dB），
    // 与智能响度/归一化叠加（同为整体增益控制）
    const loudnessDb = lc.enabled ? sampleCurveAtPercent(lc.curve, this.settings.master.listeningVolume) : 0
    const loudnessLin = Math.pow(10, Math.max(-9, Math.min(9, loudnessDb)) / 20)
    if (!sl.enabled || this.measuredLufs === null) {
      this.chain.loudnessGain.gain.setTargetAtTime(loudnessLin, t, SMART_LOUDNESS_TAU)
      return
    }
    const g = loudnessGain(this.measuredLufs, sl.targetLufs)
    const totalDb = Math.max(-9, Math.min(9, g + loudnessDb))
    this.chain.loudnessGain.gain.setTargetAtTime(Math.pow(10, totalDb / 20), t, SMART_LOUDNESS_TAU)
  }

  /** 设置当前听音音量 0-100（等响曲线采样用；UI 音量条/播放器告知） */
  setListeningVolume(volume: number): void {
    const v = Math.max(0, Math.min(100, volume))
    this.settings.master.listeningVolume = v
    this.saveSettings()
    this.applySmartLoudness()
  }

  // ============ App 独立音效（per-source 档案） ============

  /** 播放器切换曲目时调用：自动加载该曲目档案（有则覆盖全局设置） */
  setActiveSource(sourceKey: string | null): void {
    this.activeSourceKey = sourceKey
    if (!sourceKey) return
    const profile = findAppProfile(loadAppProfiles(), sourceKey)
    if (!profile) return
    // 应用档案：EQ 曲线 / 设备档案 / PEQ / 效果开关
    const next: DeepPartial<V3Settings> = {}
    const curve = profileToCurve(profile)
    if (curve) next.eq = { ...this.settings.eq, mode: 'curve', curve: sortCurve(curve), enabled: true }
    if (profile.deviceProfileId) {
      next.eq = { ...(next.eq || this.settings.eq), mode: 'device', deviceProfileId: profile.deviceProfileId }
    }
    if (profile.peqCurve) {
      const parsed = parseCurve(profile.peqCurve)
      if (parsed) next.peq = { enabled: profile.enabledEffects.includes('iirPeq'), bands: parsed.map(p => ({ freq: p.freq, gain: p.gain, q: p.q })) }
    }
    const adv: DeepPartial<V3AdvancedSettings> = {}
    adv.bassEnhance = { enabled: profile.enabledEffects.includes('bassEnhance') }
    adv.virtualBass = { enabled: profile.enabledEffects.includes('virtualBass') }
    adv.deesser = { enabled: profile.enabledEffects.includes('deesser') }
    if (Object.keys(adv).length > 0) next.advanced = adv
    this.updateSettings(next)
    debugLog(`[AudioEffectsV3] 已加载曲目档案：${profile.name}`)
  }

  /** 保存当前设置到当前曲目档案（原应用"App 独立音效"语义） */
  saveCurrentAsAppProfile(name?: string): boolean {
    if (!this.activeSourceKey) return false
    const profiles = loadAppProfiles()
    const existing = findAppProfile(profiles, this.activeSourceKey)
    const profile: AppAudioProfile = {
      sourceKey: this.activeSourceKey,
      name: name || existing?.name || this.activeSourceKey,
      bandGains: evaluateCurveAtFreqs(this.currentEqCurve(), EQ_BANDS_20),
      deviceProfileId: this.settings.eq.deviceProfileId,
      peqCurve: this.settings.peq.enabled ? this.settings.peq.bands.map(b => `${Math.round(b.freq)}:${b.gain.toFixed(2)}:${b.q.toFixed(2)}`).join(';') : null,
      enabledEffects: [
        ...(this.settings.advanced.bassEnhance.enabled ? ['bassEnhance'] : []),
        ...(this.settings.advanced.virtualBass.enabled ? ['virtualBass'] : []),
        ...(this.settings.advanced.deesser.enabled ? ['deesser'] : []),
        ...(this.settings.peq.enabled ? ['iirPeq'] : []),
      ],
    }
    saveAppProfiles(upsertAppProfile(profiles, profile))
    return true
  }

  deleteAppProfileFor(sourceKey: string): void {
    saveAppProfiles(deleteAppProfile(loadAppProfiles(), sourceKey))
  }

  /** App 独立音效档案列表（UI 管理用） */
  getAppProfiles(): AppAudioProfile[] {
    return loadAppProfiles()
  }

  // ============ 全量设置 JSON 导出/导入（MainActivity V/W/M/P 的 JSON 语义） ============

  /** 导出全量设置为 JSON 字符串（备份/迁移用，含版本戳） */
  exportSettingsJson(): string {
    return JSON.stringify({ v3Settings: 1, savedAt: Date.now(), settings: this.settings }, null, 0)
  }

  /** 导入全量设置 JSON；结构或版本非法返回 false（不半途应用） */
  importSettingsJson(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as { v3Settings?: number; settings?: V3Settings }
      if (parsed.v3Settings !== 1 || !parsed.settings || typeof parsed.settings !== 'object') return false
      const next = loadV3Settings()
      this.settings = { ...next, ...parsed.settings }
      this.saveSettings()
      this.rebuildFromSettings()
      debugLog('[AudioEffectsV3] 全量设置已导入')
      return true
    } catch {
      return false
    }
  }

  // ============ 听力分析（听感分析） ============

  startHearingAnalysis(deviceProfileId: string): void {
    this.analysis = startAnalysis(this.analysis, deviceProfileId)
    // 分析期间把当前曲线切到分析曲线（实时反馈）
    this.updateSettings({ eq: { ...this.settings.eq, mode: 'curve', curve: this.analysis.curve, enabled: true } })
    debugLog(`[AudioEffectsV3] 听力分析开始：${deviceProfileId}`)
  }

  /** 分析中应用用户反馈（more/less/ok/muddy/harsh） */
  applyHearingFeedback(feedback: HearingFeedback): void {
    this.analysis = applyFeedback(this.analysis, feedback)
    this.updateSettings({ eq: { ...this.settings.eq, curve: this.analysis.curve } })
  }

  /** 完成分析：最终曲线写回 EQ */
  finishHearingAnalysis(): void {
    const { curve } = finishAnalysis(this.analysis)
    this.updateSettings({ eq: { ...this.settings.eq, curve, mode: 'curve', enabled: true } })
    debugLog('[AudioEffectsV3] 听力分析完成，曲线已应用')
  }

  // ============ 设备频响库（ht.java 移植） ============

  /** 应用设备库实测曲线（findDevice → 频响合并目标） */
  applyDeviceDbCode(code: string | null): void {
    const device = code ? findDevice(code) : null
    this.settings.frequencyResponse.deviceCode = code
    this.settings.frequencyResponse.targetCurve = device && device.curveA ? [...device.curveA] : null
    this.saveSettings()
    this.rebuildFromSettings()
    debugLog(device && device.curveA
      ? `[AudioEffectsV3] 已加载设备频响：${device.model}（${device.curveA.length} 点）`
      : '[AudioEffectsV3] 设备频响已清除')
  }

  /** 手动指定目标曲线（128 点对数轴） */
  setTargetCurve(curve: number[] | null): void {
    this.settings.frequencyResponse.targetCurve = curve ? [...curve] : null
    this.saveSettings()
    this.rebuildFromSettings()
  }

  // ============ 机型基础预设 + 输出设备适配（Windows 端） ============

  /** 机型选项列表（UI 展示用，已过滤无曲线占位设备） */
  getDeviceModelOptions(): DeviceModelOption[] {
    return listDeviceModels()
  }

  /** 机型选项（按品牌分组，UI 分组展示用） */
  getDeviceModelGroups(): Array<{ brand: string; items: DeviceModelOption[] }> {
    return groupDeviceModels()
  }

  /**
   * 应用机型基础预设：把该机型的实测频响曲线（128 点）经对数插值转换为
   * 20 段 EQ 曲线点并应用为基础预设，同时保存为频响合并的目标曲线
   * （不自动开启合并，由用户决定）。传 null 清除机型预设。
   */
  applyDeviceModel(code: string | null): void {
    const device = code ? findDevice(code) : null
    this.settings.device = { ...this.settings.device, modelCode: code, modelName: device?.model ?? null }
    if (device && device.curveA) {
      // 设备频响预设（speaker_response 语义）：完整频响预设启用时锁定均衡器，
      // 防止 EQ 叠加出现破音（speaker_response_eq_locked_message 文案），
      // 曲线仅作为频响目标与展示参考；清除机型预设后解锁。
      this.settings.eq = { ...this.settings.eq, enabled: false }
      this.settings.eqLocked = true
      // 实测曲线 → 20 段增益（log10 插值）→ 曲线点（Q=1，供展示/导出）
      const gains = interpolateResponse(device.curveA, [...EQ_BANDS_20])
      const curve: EqPoint[] = [...EQ_BANDS_20].map((freq, i) => ({
        freq,
        gain: quantizeGain(gains[i] ?? 0),
        q: 1,
      }))
      this.settings.eq = { ...this.settings.eq, mode: 'curve', curve: sortCurve(curve) }
      // 同步为频响合并的目标曲线（不自动开启合并）
      this.settings.frequencyResponse.targetCurve = [...device.curveA]
    } else {
      this.settings.frequencyResponse.targetCurve = null
      this.settings.eqLocked = false
    }
    this.saveSettings()
    this.rebuildFromSettings()
    debugLog(device
      ? `[AudioEffectsV3] 机型频响预设已应用：${device.model}（${device.curveA?.length ?? 0} 点），EQ 已锁定`
      : '[AudioEffectsV3] 机型预设已清除，EQ 已解锁')
  }

  /** 切换音效方案（standard=标准/兼容回退，spatial=空间增强） */
  setScheme(scheme: 'standard' | 'spatial'): void {
    this.settings.scheme = scheme
    this.saveSettings()
    this.rebuildFromSettings()
    debugLog(`[AudioEffectsV3] 方案切换：${scheme}`)
  }

  // ============ 调音分享（导出/导入，eq_export_button/eq_import_button 语义） ============

  /** 导出当前调音为分享串（v3|scheme|eqMode|eqCurve|peq|model|profile|ieqStyle） */
  exportShareString(): string {
    const s = this.settings
    return exportShareString({
      scheme: s.scheme,
      eqMode: s.eq.mode,
      eqCurve: s.eq.curve,
      peqBands: s.peq.bands.map(b => ({ freq: b.freq, gain: b.gain, q: b.q })),
      modelCode: s.device.modelCode,
      deviceProfileId: s.eq.deviceProfileId,
      ieqStyle: s.ieq.style,
    })
  }

  /** 导入分享串并应用；返回是否成功 */
  importShareString(raw: string): boolean {
    const payload = importShareString(raw)
    if (!payload) return false
    const s = this.settings
    this.settings = {
      ...s,
      scheme: payload.scheme,
      eq: { ...s.eq, mode: payload.eqMode as V3EqMode, curve: payload.eqCurve, deviceProfileId: payload.deviceProfileId },
      peq: { ...s.peq, bands: payload.peq.map(p => ({ freq: p.freq, gain: p.gain, q: p.q })) },
      ieq: { ...s.ieq, style: payload.ieqStyle },
    }
    // 机型字段同步（modelCode 决定 eqLocked 状态）
    this.settings.device = { ...s.device, modelCode: payload.modelCode, modelName: payload.modelCode ? (findDevice(payload.modelCode)?.model ?? null) : null }
    this.settings.eqLocked = !!payload.modelCode
    this.saveSettings()
    this.rebuildFromSettings()
    debugLog('[AudioEffectsV3] 分享串已导入')
    return true
  }

  /** 判断字符串是否为 v3 分享串 */
  isShareString(raw: string | null | undefined): boolean {
    return isShareString(raw)
  }

  /** 设置听力分析演示音频源（循环播放用；null = 由 UI 用当前曲目） */
  setAnalysisDemoSource(url: string | null): void {
    this.analysisDemoSource = url
  }

  getAnalysisDemoSource(): string | null {
    return this.analysisDemoSource
  }

  /**
   * 启动听力分析演示音：正弦波循环扫频（220Hz → 880Hz → 220Hz，每 2 秒一轮），
   * 经效果链播放（可听到实时调校效果）。无外部音频文件即可使用。
   * 返回是否启动成功（引擎未就绪或已在播放返回 false）。
   */
  startAnalysisDemoTone(): boolean {
    if (!this.context || !this.input) return false
    if (this.analysisDemoNodes) return false
    const ctx = this.context
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 220
    gain.gain.value = 0
    osc.connect(gain)
    gain.connect(this.input)
    osc.start()
    // 淡入
    gain.gain.setTargetAtTime(0.25, ctx.currentTime, 0.2)
    // 循环扫频（平滑过渡到目标频率）
    let up = true
    const timer = window.setInterval(() => {
      const target = up ? 880 : 220
      osc.frequency.setTargetAtTime(target, ctx.currentTime, 0.5)
      up = !up
    }, 2000) as unknown as number
    this.analysisDemoNodes = { osc, gain, timer }
    debugLog('[AudioEffectsV3] 听力分析演示音已启动（220-880Hz 循环扫频）')
    return true
  }

  /** 停止听力分析演示音（淡出后释放） */
  stopAnalysisDemoTone(): void {
    const demo = this.analysisDemoNodes
    if (!demo || !this.context) return
    this.analysisDemoNodes = null
    window.clearInterval(demo.timer)
    const t = this.context.currentTime
    demo.gain.gain.setTargetAtTime(0, t, 0.15)
    demo.osc.stop(t + 0.6)
    demo.osc.onended = () => {
      try { demo.osc.disconnect() } catch { /* noop */ }
      try { demo.gain.disconnect() } catch { /* noop */ }
    }
  }

  /**
   * 设置输出设备类型（Windows 音频端点检测结果，由主进程 IPC 提供）：
   * autoDetect 开启时按类型自动切换设备档案——
   *   speaker → 设备外放 / headphones → 耳机（头戴）/ bluetooth → 耳机（入耳）
   */
  setOutputDeviceKind(kind: V3DeviceSettings['outputKind']): void {
    this.settings.device = { ...this.settings.device, outputKind: kind }
    if (this.settings.device.autoDetect) {
      const map: Record<string, string> = {
        speaker: 'device-speaker',
        headphones: 'device-over-ear',
        bluetooth: 'device-in-ear',
      }
      const profileId = map[kind]
      if (profileId) {
        this.settings.eq = { ...this.settings.eq, mode: 'device', deviceProfileId: profileId }
        debugLog(`[AudioEffectsV3] 输出设备 ${kind} → 设备档案 ${profileId}`)
      }
    }
    this.saveSettings()
    this.rebuildFromSettings()
  }

  /** 开启/关闭输出设备自动适配（开启时立即按当前 outputKind 生效一次） */
  setAutoDetect(enabled: boolean): void {
    this.settings.device = { ...this.settings.device, autoDetect: enabled }
    this.saveSettings()
    if (enabled && this.settings.device.outputKind !== 'unknown') {
      this.setOutputDeviceKind(this.settings.device.outputKind)
    } else {
      this.rebuildFromSettings()
    }
  }

  // ============ 卷积 IR ============

  /** 加载并应用 IR（URL 或 ArrayBuffer）；失败回退并抛错由调用方处理 */
  async setImpulseResponse(source: string | ArrayBuffer): Promise<void> {
    if (!this.context || !this.chain) throw new Error('引擎未就绪')
    const buffer = await decodeImpulseResponse(this.context, source)
    const normalized = this.settings.advanced.convolution.normalize
      ? normalizeImpulseResponse(this.context, buffer)
      : buffer
    this.chain.convolver.buffer = normalized
    this.lastIrKey = typeof source === 'string' ? source : 'arraybuffer'
    debugLog(`[AudioEffectsV3] IR 已加载：${normalized.length} 样本 / ${normalized.sampleRate}Hz`)
  }

  /** 应用内置混响 IR（无需外部文件，卷积立即可用） */
  setBuiltinReverb(type: BuiltinReverbType): void {
    if (!this.context || !this.chain) return
    const ir = generateBuiltinImpulseResponse(this.context, type)
    this.chain.convolver.buffer = ir
    this.lastIrKey = 'builtin:' + type
    // 应用内置混响时若卷积未开启，自动开启（干湿比默认 0.35）
    if (!this.settings.advanced.convolution.enabled) {
      this.updateSettings({ advanced: { convolution: { enabled: true } } })
      return
    }
    debugLog(`[AudioEffectsV3] 内置混响已加载：${type}`)
  }

  /** 内置混响选项（UI 展示用） */
  getBuiltinReverbs(): Array<{ type: BuiltinReverbType; label: string }> {
    return listBuiltinReverbs()
  }

  // ============ 当前曲线计算 ============

  /** 当前生效的 EQ 曲线（按模式：flat / preset / curve / device） */
  currentEqCurve(): EqPoint[] {
    const eq = this.settings.eq
    if (eq.mode === 'flat') return flatCurve()
    if (eq.mode === 'curve') return ensureCurve(sortCurve(eq.curve))
    if (eq.mode === 'preset') {
      return EQ_BANDS_10_ODD.map((freq, j) => ({
        freq,
        gain: quantizeGain(EQ_PRESET_CURVES[eq.presetIndex]![j]!),
        q: 1,
      }))
    }
    if (eq.mode === 'device') {
      const profile = DEVICE_PROFILES.find(p => p.id === eq.deviceProfileId)
      if (profile) {
        return profile.curveFreqs.map((freq, i) => ({
          freq,
          gain: Math.max(-15, Math.min(15, profile.params[i]!)),
          q: [0.8, 1.1, 1.0, 0.9][i]!,
        }))
      }
    }
    return flatCurve()
  }

  /** 20 段增益（曲线求值，供 UI 与导出） */
  currentBandGains20(): number[] {
    return evaluateCurveAtFreqs(this.currentEqCurve(), EQ_BANDS_20)
  }

  // ============ 音频图 ============

  attach(handle: { audioContext: AudioContext; masterGain: GainNode; analyser: AnalyserNode }): void {
    if (this.context) return
    const { audioContext: context, masterGain, analyser } = handle
    this.context = context
    this.masterGain = masterGain
    this.analyser = analyser

    // 归一化增益（链首）
    const normGain = context.createGain()
    normGain.gain.value = 1
    this.normGain = normGain
    masterGain.disconnect()
    masterGain.connect(normGain)

    // 效果链
    const chain = buildV3Chain(context)
    this.chain = chain
    this.input = chain.input
    this.output = chain.output
    chain.output.connect(analyser)
    normGain.connect(this.input)

    this.rebuildFromSettings()

    // 已配置 IR 时加载（异步）
    const conv = this.settings.advanced.convolution
    if (conv.enabled && conv.irUrl) {
      void this.setImpulseResponse(conv.irUrl).catch(err => {
        console.warn('[AudioEffectsV3] IR 加载失败:', err)
        this.settings.advanced.convolution.enabled = false
        this.saveSettings()
      })
    }

    // 动态 de-esser（AudioWorklet）：dynamic 模式时异步注册并串入链
    if (this.settings.advanced.deesser.mode === 'dynamic') {
      void this.enableDynamicDeesser()
    }
    debugLog('[AudioEffectsV3] 效果链已插入 masterGain 与 analyser 之间')
  }

  /** 注册并串入 AudioWorklet 动态 de-esser；失败时保持静态实现（不阻断） */
  private async enableDynamicDeesser(): Promise<void> {
    if (!this.context || !this.chain) return
    const ok = await ensureDeesserWorkletRegistered(this.context)
    if (!ok || !this.context || !this.chain) {
      console.warn('[AudioEffectsV3] AudioWorklet 不可用，齿音抑制保持静态模式')
      return
    }
    try {
      const node = createDeesserWorkletNode(this.context)
      const chain = this.chain
      // 重连：deesserGain → worklet → convDry / convolver
      chain.deesserGain.disconnect()
      chain.deesserGain.connect(node)
      node.connect(chain.convDry)
      node.connect(chain.convolver)
      chain.deesserDynamic = node
      this.rebuildFromSettings()
      debugLog('[AudioEffectsV3] 动态齿音抑制已启用（AudioWorklet）')
    } catch (err) {
      console.warn('[AudioEffectsV3] 动态齿音抑制启用失败:', err)
    }
  }

  dispose(): void {
    this.stopAnalysisDemoTone()
    if (this.context && this.masterGain && this.analyser) {
      try {
        this.masterGain.disconnect()
        this.masterGain.connect(this.analyser)
      } catch { /* 忽略 */ }
    }
    this.context = null
    this.input = null
    this.output = null
    this.masterGain = null
    this.analyser = null
    this.normGain = null
    this.chain?.deesserDynamic?.disconnect()
    this.chain = null
    this.toneFilters = []
    this.toneNodes = []
    this.postToneNodes = []
    this.lastIrKey = ''
  }

  // ============ 参数重建 ============

  private rebuildFromSettings(): void {
    if (!this.context || !this.chain) return
    const t = this.context.currentTime
    const { eq, peq, frequencyResponse: fr, advanced: adv, master } = this.settings

    // M/S 人声/伴奏
    const v = Math.max(-1, Math.min(1, master.voiceBalance))
    this.chain.voiceMatrix.centerGain.gain.setTargetAtTime(v >= 0 ? 1 : 1 + v, t, 0.02)
    this.chain.voiceMatrix.sideGain.gain.setTargetAtTime(v <= 0 ? 1 : 1 - v, t, 0.02)

    // 低频增强（bass_enhancer 语义：增强量/截止频率/作用宽度；仅在空间增强方案下生效）
    const spatial = this.settings.scheme === 'spatial'
    const bassOn = adv.bassEnhance.enabled && spatial
    this.chain.bassShelf.frequency.setTargetAtTime(bassOn ? adv.bassEnhance.cutoff : 120, t, 0.02)
    this.chain.bassShelf.gain.setTargetAtTime(
      bassOn ? bassEnhanceGain(adv.bassEnhance.intensity) : 0, t, 0.02)
    this.chain.bassPunch.frequency.setTargetAtTime(bassOn ? adv.bassEnhance.cutoff * 0.45 : BASS_PUNCH_FREQ, t, 0.02)
    this.chain.bassPunch.Q.setTargetAtTime(bassOn ? Math.max(0.4, adv.bassEnhance.width) : 0.9, t, 0.02)
    this.chain.bassPunch.gain.setTargetAtTime(
      bassOn ? adv.bassEnhance.intensity * 0.55 : 0, t, 0.02)

    // 虚拟低频（DAP Spatializer 参数化：基频/谐波/融合；空间增强方案）
    const vb = adv.virtualBass.enabled && spatial
    this.chain.vBassShaper.curve = vb
      ? buildVirtualBassShaperCurve(adv.virtualBass.amount, adv.virtualBass.harmonics, adv.virtualBass.blend)
      : null
    this.chain.vBassFilter.frequency.setTargetAtTime(vb ? adv.virtualBass.baseFreq : VIRTUAL_BASS_CROSSOVER, t, 0.03)
    const mix = vb ? virtualBassMix(adv.virtualBass.amount) : { dry: 1, wet: 0 }
    this.chain.vBassDry.gain.setTargetAtTime(mix.dry, t, 0.03)
    this.chain.vBassWet.gain.setTargetAtTime(mix.wet, t, 0.03)

    // 齿音抑制：mode=static 简化动态（固定衰减+快 attack）；
    // mode=dynamic 由 AudioWorklet 精确侧链接管（此处增益保持 1，参数在 worklet 上）
    const de = adv.deesser.enabled
    const dynamicDeesser = de && adv.deesser.mode === 'dynamic' && this.chain.deesserDynamic !== null
    this.chain.deesserDetect.frequency.setTargetAtTime(DEESSER_DETECT_FREQ, t, 0.02)
    const cut = de && !dynamicDeesser ? deesserMaxCut(adv.deesser.amount) : 0
    this.chain.deesserGain.gain.setTargetAtTime(Math.pow(10, cut / 20), t, DEESSER_ATTACK)
    if (dynamicDeesser && this.chain.deesserDynamic) {
      const wl = this.chain.deesserDynamic.parameters
      wl.get('amount')?.setTargetAtTime(adv.deesser.amount, t, 0.02)
      wl.get('threshold')?.setTargetAtTime(deesserThreshold(adv.deesser.amount) > -40 ? 0.08 + adv.deesser.amount * 0.02 : 0.12, t, 0.02)
      wl.get('attack')?.setTargetAtTime(DEESSER_ATTACK, t, 0.02)
      wl.get('release')?.setTargetAtTime(DEESSER_RELEASE, t, 0.02)
    }

    // 卷积干湿
    const conv = adv.convolution.enabled && this.chain.convolver.buffer
    this.chain.convDry.gain.setTargetAtTime(conv ? 1 - adv.convolution.mix : 1, t, 0.03)
    this.chain.convWet.gain.setTargetAtTime(conv ? adv.convolution.mix : 0, t, 0.03)
    // IR 指纹：irUrl 变化时（由 setImpulseResponse 处理）重建

    // 压缩（含 makeup 增益：Chrome 扩展属性，独立封装访问）
    const comp = this.chain.compressor
    comp.threshold.setTargetAtTime(adv.compressor.enabled ? adv.compressor.threshold : 0, t, 0.02)
    comp.ratio.setTargetAtTime(adv.compressor.enabled ? adv.compressor.ratio : 1, t, 0.02)
    comp.attack.setTargetAtTime(adv.compressor.attack, t, 0.02)
    comp.release.setTargetAtTime(adv.compressor.release, t, 0.02)
    const makeup = adv.compressor.enabled ? adv.compressor.outputGain : 0
    compressorMakeupGain(comp)?.setTargetAtTime(Math.pow(10, makeup / 20), t, 0.02)

    // 夜间模式（温和压缩 + 高频衰减）
    const nightOn = adv.nightMode.enabled && adv.nightMode.amount > 0
    const amount = adv.nightMode.enabled ? adv.nightMode.amount : 0
    this.chain.nightCompressor.threshold.setTargetAtTime(nightOn ? -20 - amount * 0.9 : 0, t, 0.05)
    this.chain.nightCompressor.ratio.setTargetAtTime(nightOn ? 2.0 + amount * 0.3 : 1, t, 0.05)
    this.chain.nightTreble.gain.setTargetAtTime(nightOn ? -(1.0 + amount * 0.5) : 0, t, 0.05)
    this.chain.nightGain.gain.setTargetAtTime(nightOn ? 1 + amount * 0.015 : 1, t, 0.05)

    // 对白清晰度（dolby_advanced：2.2kHz 存在感提升，随 amount 0-8dB）
    const dc = adv.dialogueClarity.enabled ? adv.dialogueClarity.amount * 0.8 : 0
    this.chain.dialoguePeak.gain.setTargetAtTime(dc, t, 0.03)

    // 智能响度
    this.applySmartLoudness()

    // 归一化（仅关闭时回落）
    if (this.normGain && !this.settings.normalizationEnabled) {
      this.normGain.gain.setTargetAtTime(1, t, 0.02)
    }

    // 音色段重建（EQ → PEQ → 频响合并 → IEQ → 智能 Post 依次级联）
    this.rebuildToneSection()
    // Post 段重建（手工 Post 曲线 + 智能 Post 自动补偿）
    this.rebuildPostToneSection()
  }

  /** 重建音色段：EQ 曲线 Biquad 链 → PEQ（IIR）→ 频响合并段 */
  private rebuildToneSection(): void {
    if (!this.context || !this.chain) return
    const { eq, peq, frequencyResponse: fr } = this.settings

    // 摘除旧段
    for (const n of this.toneNodes) { try { n.disconnect() } catch { /* noop */ } }
    this.toneNodes = []
    this.toneFilters = []
    this.chain.toneInput.disconnect()

    let prev: AudioNode = this.chain.toneInput

    const connectNext = (node: AudioNode): void => {
      prev.connect(node)
      this.toneNodes.push(node)
      if (node instanceof BiquadFilterNode) this.toneFilters.push(node)
      prev = node
    }

    // 1) EQ（20 段曲线求值 → peaking 链；曲线上点直接转 Biquad）
    const curve = this.currentEqCurve()
    if (eq.enabled && curve.length > 0) {
      // 由曲线点直接生成 peaking 滤波器（fp 模型 → Web Audio）
      for (const p of sortCurve(curve)) {
        const f = this.context.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = p.freq
        f.gain.value = p.gain
        f.Q.value = Math.max(0.1, p.q)
        connectNext(f)
      }
    }

    // 2) PEQ（64 阶 IIR 参数均衡）
    if (peq.enabled && peq.bands.length > 0) {
      const iir = new IirPeq(this.context.sampleRate, peq.bands)
      for (const b of iir.bands) {
        const f = this.context.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = b.freq
        f.gain.value = b.gain
        f.Q.value = Math.max(0.1, b.q)
        connectNext(f)
      }
    }

    // 3) 频响合并（设备曲线/目标曲线 → 对数插值 → Biquad 段）
    if (fr.enabled) {
      const base = curveToResponse(this.currentEqCurve())
      const target = fr.targetCurve
      const merged = mergeFrequencyResponse(base, target, [...EQ_BANDS_20], {
        route: fr.route as FrRoute,
        scene: fr.scene,
        enabled: fr.enabled,
      }, fr.blend)
      const segments = mergeResultToSegments([...EQ_BANDS_20], merged)
      for (const seg of segments) {
        const f = this.context.createBiquadFilter()
        f.type = seg.type
        f.frequency.value = seg.frequency
        f.gain.value = seg.gain
        f.Q.value = seg.q
        connectNext(f)
      }
    }

    // 4) 智能均衡 IEQ（x/bb.java 移植：目标风格 × 三段强度，仅 spatial 方案生效）
    const ieq = this.settings.ieq
    if (ieq.enabled && this.settings.scheme === 'spatial') {
      const ieqGains = applyIeq(ieq)
      for (let i = 0; i < EQ_BANDS_20.length; i++) {
        if (Math.abs(ieqGains[i]!) < 0.1) continue
        const f = this.context.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = EQ_BANDS_20[i]!
        f.gain.value = ieqGains[i]!
        f.Q.value = 1.1
        connectNext(f)
      }
    }

    prev.connect(this.chain.toneOutput)
  }

  /** 重建 Post 段：手工 Post 曲线 + 智能 Post 自动补偿（动态处理后） */
  private rebuildPostToneSection(): void {
    if (!this.context || !this.chain) return
    const postEq = this.settings.postEq
    const autoBands = postEq.auto.enabled
      ? computeAutoPostEq(this.currentEqCurve(), postEq.auto.strength).bands
      : []
    const manualCurve = postEq.manual.enabled ? postEq.manual.curve : []

    // 摘除旧段
    this.chain.postToneInput.disconnect()
    for (const n of this.postToneNodes) { try { n.disconnect() } catch { /* noop */ } }
    this.postToneNodes = []

    let prev: AudioNode = this.chain.postToneInput
    // 手工 Post 曲线
    for (const p of sortCurve(manualCurve)) {
      const f = this.context.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = p.freq
      f.gain.value = p.gain
      f.Q.value = Math.max(0.1, p.q)
      prev.connect(f)
      this.postToneNodes.push(f)
      prev = f
    }
    // 智能 Post 自动补偿段
    for (const b of autoBands) {
      const f = this.context.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = b.freq
      f.gain.value = b.gain
      f.Q.value = b.q
      prev.connect(f)
      this.postToneNodes.push(f)
      prev = f
    }
    prev.connect(this.chain.postToneOutput)
  }

  // ============ 导出（v2 对齐：离线渲染 WAV） ============

  async exportToWav(sourceUrl: string, durationSeconds: number): Promise<void> {
    if (!this.context) throw new Error('音频引擎尚未就绪')
    const sampleRate = this.context.sampleRate
    const response = await fetch(sourceUrl)
    if (!response.ok) throw new Error(`拉取音频失败：${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const decoded = await this.context.decodeAudioData(arrayBuffer)
    const minLen = Math.min(sampleRate, decoded.length)
    const length = Math.max(minLen, Math.min(Math.floor(durationSeconds * sampleRate), decoded.length))

    const offline = new OfflineAudioContext(2, length, sampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded

    // 离线构建同一 v3 链（共享 buildV3Chain）
    const chain = buildV3Chain(offline)
    source.connect(chain.input)
    chain.output.connect(offline.destination)

    // 同步动态参数（与 rebuildFromSettings 对齐）
    const { eq, peq, frequencyResponse: fr, advanced: adv, master } = this.settings
    // EQ
    const curve = this.currentEqCurve()
    if (eq.enabled && curve.length > 0) {
      chain.toneInput.disconnect()
      let prev: AudioNode = chain.toneInput
      for (const p of sortCurve(curve)) {
        const f = offline.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = p.freq
        f.gain.value = p.gain
        f.Q.value = Math.max(0.1, p.q)
        prev.connect(f)
        prev = f
      }
      if (peq.enabled) {
        for (const b of peq.bands) {
          const f = offline.createBiquadFilter()
          f.type = 'peaking'
          f.frequency.value = b.freq
          f.gain.value = b.gain
          f.Q.value = Math.max(0.1, b.q)
          prev.connect(f)
          prev = f
        }
      }
      if (fr.enabled) {
        const base = curveToResponse(curve)
        const merged = mergeFrequencyResponse(base, fr.targetCurve, [...EQ_BANDS_20], {
          route: fr.route as FrRoute, scene: fr.scene, enabled: fr.enabled,
        }, fr.blend)
        for (const seg of mergeResultToSegments([...EQ_BANDS_20], merged)) {
          const f = offline.createBiquadFilter()
          f.type = seg.type
          f.frequency.value = seg.frequency
          f.gain.value = seg.gain
          f.Q.value = seg.q
          prev.connect(f)
          prev = f
        }
      }
      prev.connect(chain.toneOutput)
    }

    // 其余参数（与 rebuildFromSettings 对齐）
    const spatial = this.settings.scheme === 'spatial'
    const bassOn = adv.bassEnhance.enabled && spatial
    chain.bassShelf.frequency.value = bassOn ? adv.bassEnhance.cutoff : 120
    chain.bassShelf.gain.value = bassOn ? bassEnhanceGain(adv.bassEnhance.intensity) : 0
    chain.bassPunch.frequency.value = bassOn ? adv.bassEnhance.cutoff * 0.45 : BASS_PUNCH_FREQ
    chain.bassPunch.Q.value = bassOn ? Math.max(0.4, adv.bassEnhance.width) : 0.9
    chain.bassPunch.gain.value = bassOn ? adv.bassEnhance.intensity * 0.55 : 0
    if (adv.virtualBass.enabled && spatial) {
      chain.vBassShaper.curve = buildVirtualBassShaperCurve(adv.virtualBass.amount, adv.virtualBass.harmonics, adv.virtualBass.blend)
      chain.vBassFilter.frequency.value = adv.virtualBass.baseFreq
      const mix = virtualBassMix(adv.virtualBass.amount)
      chain.vBassDry.gain.value = mix.dry
      chain.vBassWet.gain.value = mix.wet
    }
    chain.deesserGain.gain.value = Math.pow(10, (adv.deesser.enabled ? deesserMaxCut(adv.deesser.amount) : 0) / 20)
    const conv = adv.convolution.enabled && chain.convolver.buffer
    chain.convDry.gain.value = conv ? 1 - adv.convolution.mix : 1
    chain.convWet.gain.value = conv ? adv.convolution.mix : 0
    chain.compressor.threshold.value = adv.compressor.enabled ? adv.compressor.threshold : 0
    chain.compressor.ratio.value = adv.compressor.enabled ? adv.compressor.ratio : 1
    const nightOn = adv.nightMode.enabled && adv.nightMode.amount > 0
    const amount = adv.nightMode.enabled ? adv.nightMode.amount : 0
    chain.nightCompressor.threshold.value = nightOn ? -20 - amount * 0.9 : 0
    chain.nightCompressor.ratio.value = nightOn ? 2.0 + amount * 0.3 : 1
    chain.nightTreble.gain.value = nightOn ? -(1.0 + amount * 0.5) : 0
    chain.nightGain.gain.value = nightOn ? 1 + amount * 0.015 : 1
    chain.dialoguePeak.gain.value = adv.dialogueClarity.enabled ? adv.dialogueClarity.amount * 0.8 : 0

    // Post 段（手工 Post 曲线 + 智能 Post 自动补偿）
    chain.postToneInput.disconnect()
    let postPrev: AudioNode = chain.postToneInput
    const postEq = this.settings.postEq
    if (postEq.manual.enabled) {
      for (const p of sortCurve(postEq.manual.curve)) {
        const f = offline.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = p.freq
        f.gain.value = p.gain
        f.Q.value = Math.max(0.1, p.q)
        postPrev.connect(f)
        postPrev = f
      }
    }
    if (postEq.auto.enabled) {
      for (const b of computeAutoPostEq(this.currentEqCurve(), postEq.auto.strength).bands) {
        const f = offline.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = b.freq
        f.gain.value = b.gain
        f.Q.value = b.q
        postPrev.connect(f)
        postPrev = f
      }
    }
    postPrev.connect(chain.postToneOutput)

    source.start(0)
    const rendered = await offline.startRendering()
    const wavBlob = encodeWav(rendered)
    const url = URL.createObjectURL(wavBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `waveforge-v3-mix-${Date.now()}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

function loadMyScenes(): V3SceneSnapshot[] {
  try {
    const raw = localStorage.getItem(MY_SCENES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as V3SceneSnapshot[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveMyScenes(scenes: V3SceneSnapshot[]): void {
  try {
    localStorage.setItem(MY_SCENES_KEY, JSON.stringify(scenes))
  } catch {
    // 忽略存储失败
  }
}

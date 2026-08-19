export type PlaybackMode = 'sequential' | 'shuffle' | 'repeat'

export type TransitionStrategy =
  | 'smart-rendered'
  | 'smart-rendered-v2'
  | 'beat-crossfade'
  | 'fixed-crossfade'
  | 'gapless'
  | 'none'

/** AutoMix 增强版（v2）特效强度档位 */
export type TransitionIntensity = 'subtle' | 'standard' | 'strong'

/** 调性检测结果（Krumhansl-Schmuckler，Camelot 记法） */
export interface KeyDetection {
  /** 主音（0-11，C=0） */
  tonic: number
  mode: 'major' | 'minor'
  /** 0-1 检测置信度 */
  confidence: number
  /** Camelot 编号（1-12） */
  camelot: number
}

/** AutoMix 增强版（v2）过渡特效编排计划 */
export interface V2Choreography {
  /** 过渡风格标签（UI 展示用） */
  style: 'energetic' | 'atmospheric' | 'clean'
  intensity: TransitionIntensity
  /** 特效开关 */
  riser: boolean
  noiseSweep: boolean
  drumFill: boolean
  tempoRampUp: boolean
  reverbDip: boolean
  echoOut: boolean
  bassSwap: boolean
  filterSweep: boolean
  /** 鼓点填充占用的拍数（落在过渡尾部，导向目标 downbeat） */
  drumFillBeats: number
  /** 0-1 调性兼容度（同调=1，相邻/关系调次之） */
  keyCompat: number
  /** 目标开头相对源结尾的能量差（绝对值，0-1） */
  energyDelta: number
}

/** 过渡调试信息（调试弹窗展示用，从过渡计划摘要而来） */
export interface TransitionDebugInfo {
  /** 引擎：v1 / v2 / 兜底计划 */
  engine: 'v1' | 'v2' | 'fallback'
  strategy: TransitionStrategy
  fallbackReason?: string
  sourceTrackKey: string
  targetTrackKey: string
  beatCount: number
  sourceBpm: number
  targetBpm: number
  confidence: number
  rendererVersion: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  /** v2 风格标签 */
  style?: V2Choreography['style']
  /** 强度档位 */
  intensity?: TransitionIntensity
  /** 实际编排的 DJ 效果清单（中文名，展示用） */
  effects?: string[]
  /** 调性兼容度 0-1 */
  keyCompat?: number
  /** 响度补偿 dB */
  gainOffsetDb?: number
  /** 分析来源（调试用：librosa / beat_this / browser / metadata） */
  sourceProvider?: string
  targetProvider?: string
}

export type TransitionState =
  | 'idle'
  | 'loading-current'
  | 'playing'
  | 'preparing-next'
  | 'armed'
  | 'running-transition'
  | 'committed'
  | 'cancelled'
  | 'failed'

export interface BeatTrackingResult {
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
}

export interface SectionMarker {
  time: number
  beatIndex: number
  type: 'intro' | 'verse' | 'chorus' | 'bridge' | 'drop' | 'break' | 'outro' | 'unknown'
  confidence: number
}

export interface BeatFeatureFrame {
  beatIndex: number
  time: number
  loudness: number
  rms: number
  chroma: number[]
  timbre: number[]
  vocalness: number
  energy: number
}

export interface DJEffectsPlan {
  enabled: boolean
  profile: 'smooth' | 'energetic'
  intensity: number
  bassSwap: boolean
  filterSweep: boolean
  echoOut: boolean
  sweepFx: boolean
  echoDelayBeats: number
  echoFeedback: number
}

export interface TrackAnalysis {
  schemaVersion: number
  trackKey: string
  duration: number
  provider: 'beat_this' | 'librosa-fallback' | 'browser-fallback' | 'electron-unavailable' | 'metadata-only' | 'tv-metadata-only'
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
  sections: SectionMarker[]
  beatFeatures: BeatFeatureFrame[]
  /** ITU-R BS.1770 积分响度（LUFS，Python 分析提供；响度归一化用） */
  integratedLufs?: number
  introSilence: number
  outroSilence: number
  sourceSignature?: string
  analysisVersion: string
  createdAt: number
  lastAccessAt: number
}

export interface TransitionPlan {
  id: string
  sourceTrackKey: string
  targetTrackKey: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  beatCount: number
  sourceBpm: number
  targetBpm: number
  tempoRamp: number[]
  sourceDownbeatIndex: number
  targetDownbeatIndex: number
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  targetBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  djEffects?: DJEffectsPlan
  /** AutoMix 增强版（v2）专用字段：v1 计划恒为 undefined，不参与 v1 的 plan.id 构造 */
  v2?: {
    key?: { source?: KeyDetection; target?: KeyDetection }
    choreography?: V2Choreography
    intensity?: TransitionIntensity
    aiMix?: boolean
  }
  gainCurve: { source: number[]; target: number[] }
  /** 响度补偿（dB）：作用于 target 侧，正数=抬高目标，负数=压低目标（clamp ±3.5dB） */
  gainOffsetDb?: number
  confidence: number
  strategy: TransitionStrategy
  fallbackReason?: string
  analysisVersion: string
  rendererVersion: string
}

export interface RenderedTransition {
  id: string
  url: string
  duration: number
  sourceTrackKey: string
  targetTrackKey: string
  createdAt: number
}

export interface TransitionCommit {
  sourceTrackKey: string
  targetTrackKey: string
  targetIndex?: number
  targetTime: number
  strategy: TransitionStrategy
  isVisualSwitch?: boolean  // true = 仅视觉切换，false/undefined = 真正的歌曲切换
}

export interface PreloadTrack {
  url: string
  trackKey?: string
  index?: number
  duration?: number
  albumId?: string
  albumCover?: string
}

export interface PlaybackEngineState {
  isPlaying?: boolean
  currentTime?: number
  duration?: number
  volume?: number
  buffered?: number
  ended?: boolean
  transitioning?: boolean
  seamlessTransition?: boolean
  transitionState?: TransitionState
  transitionStrategy?: TransitionStrategy
  fallbackReason?: string
  transitionCommit?: TransitionCommit
  visualSwitchCommit?: TransitionCommit
  transitionProgress?: number  // 过渡进度 0-1
  transitionDuration?: number  // 过渡总时长（秒）
  transitionStartTime?: number | null // 当前音轨进入计划过渡的时间点（秒）
  transitionFromTrackKey?: string  // 前一曲的 trackKey
  transitionToTrackKey?: string    // 下一曲的 trackKey
  transitionStyle?: 'energetic' | 'atmospheric' | 'clean' | undefined // v2 过渡风格标签（UI 提示用）
  transitionDebug?: TransitionDebugInfo // 过渡调试信息（过渡调试弹窗用）
}

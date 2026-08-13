import { debugLog } from '../../utils/debugLog'
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

// ============ 设置类型 ============

export type EqMode = 'simple' | 'pro'

export interface CloudEffectsSettings {
  hall: { enabled: boolean; level: number } // 全景声厅：全景幅度 1-6
  surround3d: { enabled: boolean; distance: number; speed: number } // 3D 环绕
  bassBoost: { enabled: boolean; depth: number; intensity: number } // 低音增强
  vocalBoost: { enabled: boolean; intensity: number } // 人声加强
  accompanimentBoost: { enabled: boolean; intensity: number } // 伴奏加强
}

export interface EqBand {
  frequency: number
  gain: number // dB
  q: number
}

export interface EqSettings {
  enabled: boolean
  mode: EqMode
  // 简约版 5 段：[低音, 中低, 中音, 中高, 高音] 增益 dB
  simpleBands: number[]
  // 专业版 10 段（octave）
  proBands: EqBand[]
}

export interface PitchSettings {
  enabled: boolean
  semitones: number // -10 ~ +10
  rate: number // 0.25 ~ 3.0
  voiceBalance: number // -1(仅伴奏) ~ 0(原声) ~ +1(仅人声)
}

export interface AudioEffectsSettings {
  effects: CloudEffectsSettings
  eq: EqSettings
  pitch: PitchSettings
}

// 深层的可选类型，用于局部更新设置
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ============ 常量 ============

export const SIMPLE_EQ_BANDS = [
  { label: '低音', frequency: 80, hint: '管鼓点/贝斯的厚度，往上更沉、往下更干净' },
  { label: '中低', frequency: 250, hint: '管温暖感和饱满度，过量会发闷' },
  { label: '中音', frequency: 1000, hint: '管人声和主乐器的主体，最影响清晰度' },
  { label: '中高', frequency: 4000, hint: '管人声齿音和乐器的通透/明亮' },
  { label: '高音', frequency: 12000, hint: '管空气感和细节，过量会刺耳' },
]

export const PRO_EQ_FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

const SETTINGS_KEY = 'waveforge:audio-effects-settings'

function defaultSettings(): AudioEffectsSettings {
  return {
    effects: {
      hall: { enabled: false, level: 3 },
      surround3d: { enabled: false, distance: 3, speed: 1 },
      bassBoost: { enabled: false, depth: 100, intensity: 6 },
      vocalBoost: { enabled: false, intensity: 4 },
      accompanimentBoost: { enabled: false, intensity: 4 },
    },
    eq: {
      enabled: false,
      mode: 'simple',
      simpleBands: [0, 0, 0, 0, 0],
      proBands: PRO_EQ_FREQUENCIES.map(frequency => ({ frequency, gain: 0, q: 1.1 })),
    },
    pitch: {
      enabled: false,
      semitones: 0,
      rate: 1,
      voiceBalance: 0,
    },
  }
}

function loadSettings(): AudioEffectsSettings {
  const defaults = defaultSettings()
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<AudioEffectsSettings>
    return {
      effects: { ...defaults.effects, ...(parsed.effects || {}) },
      eq: {
        ...defaults.eq,
        ...(parsed.eq || {}),
        simpleBands: Array.isArray(parsed.eq?.simpleBands) && parsed.eq!.simpleBands!.length === 5
          ? parsed.eq!.simpleBands!
          : defaults.eq.simpleBands,
        proBands: Array.isArray(parsed.eq?.proBands) && parsed.eq!.proBands!.length === PRO_EQ_FREQUENCIES.length
          ? parsed.eq!.proBands!
          : defaults.eq.proBands,
      },
      pitch: { ...defaults.pitch, ...(parsed.pitch || {}) },
    }
  } catch {
    return defaults
  }
}

// ============ 工具函数 ============

// 生成一个简单的立体声大厅脉冲响应（指数衰减噪声），用于卷积混响
function generateHallImpulseResponse(context: AudioContext, seconds = 2.8, decay = 3.2): AudioBuffer {
  const sampleRate = context.sampleRate
  const length = Math.max(1, Math.floor(sampleRate * seconds))
  const buffer = context.createBuffer(2, length, sampleRate)
  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate
      // 前几毫秒留出预延迟感，后面指数衰减
      const envelope = Math.exp(-decay * t)
      data[i] = (Math.random() * 2 - 1) * envelope * 0.6
    }
  }
  return buffer
}

interface MsMatrix {
  input: ChannelSplitterNode
  output: ChannelMergerNode
  centerGain: GainNode
  sideGain: GainNode
}

// 构建中/侧（M/S）矩阵：输入立体声 → [M, S] → 分别加增益 → 重组回立体声
// centerGain/sideGain 默认都为 1（完全透明，L'=L, R'=R）
function createMsMatrix(context: AudioContext): MsMatrix {
  const splitter = context.createChannelSplitter(2)

  const mL = context.createGain()
  const mR = context.createGain()
  const mSum = context.createGain()
  mL.gain.value = 0.5
  mR.gain.value = 0.5
  const sL = context.createGain()
  const sR = context.createGain()
  const sSum = context.createGain()
  sL.gain.value = 0.5
  sR.gain.value = -0.5

  splitter.connect(mL, 0)
  splitter.connect(mR, 1)
  mL.connect(mSum)
  mR.connect(mSum)
  splitter.connect(sL, 0)
  splitter.connect(sR, 1)
  sL.connect(sSum)
  sR.connect(sSum)

  const centerGain = context.createGain()
  const sideGain = context.createGain()
  centerGain.gain.value = 1
  sideGain.gain.value = 1
  mSum.connect(centerGain)
  sSum.connect(sideGain)

  const outL = context.createGain()
  const outR = context.createGain()
  const sideNeg = context.createGain()
  sideNeg.gain.value = -1
  centerGain.connect(outL)
  sideGain.connect(outL)
  centerGain.connect(outR)
  sideGain.connect(sideNeg)
  sideNeg.connect(outR)

  const merger = context.createChannelMerger(2)
  outL.connect(merger, 0, 0)
  outR.connect(merger, 0, 1)

  return { input: splitter, output: merger, centerGain, sideGain }
}

// ============ 引擎 ============

export class AudioEffectsEngine {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private input: GainNode | null = null
  private output: GainNode | null = null

  // 变调/变速（SoundTouch AudioWorklet，异步注册）
  private soundtouchNode: SoundTouchNode | null = null

  // 人声/伴奏比例（M/S 矩阵）
  private voiceMatrix: MsMatrix | null = null

  // 全景声厅：M/S 加宽 + 卷积混响
  private hallMatrix: MsMatrix | null = null
  private hallConvolver: ConvolverNode | null = null
  private hallWetGain: GainNode | null = null

  // 3D 环绕
  private panner: PannerNode | null = null
  private pannerWetGain: GainNode | null = null
  private pannerDryGain: GainNode | null = null
  private surroundAnimationFrame = 0
  private surroundAngle = 0
  private surroundLastTime = 0

  // 低音/人声/伴奏（滤波类，串行，关掉时增益归零即透明）
  private bassFilter: BiquadFilterNode | null = null
  private vocalFilter: BiquadFilterNode | null = null
  private accompFilter: BiquadFilterNode | null = null

  // 均衡器
  private eqFilters: BiquadFilterNode[] = []

  // 输出保护
  private limiter: DynamicsCompressorNode | null = null

  private settings: AudioEffectsSettings = loadSettings()

  getSettings(): AudioEffectsSettings {
    return this.settings
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch {
      // 忽略存储失败
    }
  }

  // 供 UI 一次性导入完整设置（预设导入/恢复）
  applySettings(next: AudioEffectsSettings): void {
    this.settings = next
    this.saveSettings()
    this.rebuildFromSettings()
  }

  updateSettings(patch: DeepPartial<AudioEffectsSettings>): void {
    this.settings = {
      ...this.settings,
      effects: { ...this.settings.effects, ...(patch.effects || {}) } as CloudEffectsSettings,
      eq: { ...this.settings.eq, ...(patch.eq || {}) } as EqSettings,
      pitch: { ...this.settings.pitch, ...(patch.pitch || {}) } as PitchSettings,
    }
    this.saveSettings()
    this.rebuildFromSettings()
  }

  // 音频图就绪后由 useAudioPlayer 调用：在 masterGain 与 analyser 之间插入效果链
  attach(handle: { audioContext: AudioContext; masterGain: GainNode; analyser: AnalyserNode }): void {
    if (this.context) return // 已附加
    const { audioContext: context, masterGain, analyser } = handle
    this.context = context
    this.masterGain = masterGain
    this.analyser = analyser

    const input = context.createGain()
    const output = context.createGain()
    input.gain.value = 1
    output.gain.value = 1
    this.input = input
    this.output = output

    // 人声/伴奏比例 M/S 矩阵
    this.voiceMatrix = createMsMatrix(context)

    // 全景声厅
    this.hallMatrix = createMsMatrix(context)
    this.hallConvolver = context.createConvolver()
    this.hallConvolver.buffer = generateHallImpulseResponse(context)
    this.hallWetGain = context.createGain()
    this.hallWetGain.gain.value = 0

    // 3D 环绕
    this.panner = context.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.pannerWetGain = context.createGain()
    this.pannerWetGain.gain.value = 0
    this.pannerDryGain = context.createGain()
    this.pannerDryGain.gain.value = 1

    // 音色类效果
    this.bassFilter = context.createBiquadFilter()
    this.bassFilter.type = 'lowshelf'
    this.bassFilter.gain.value = 0
    this.vocalFilter = context.createBiquadFilter()
    this.vocalFilter.type = 'peaking'
    this.vocalFilter.frequency.value = 2500
    this.vocalFilter.Q.value = 1.1
    this.vocalFilter.gain.value = 0
    this.accompFilter = context.createBiquadFilter()
    this.accompFilter.type = 'peaking'
    this.accompFilter.frequency.value = 2500
    this.accompFilter.Q.value = 1.4
    this.accompFilter.gain.value = 0

    // 均衡器：简约 5 段 / 专业 10 段都基于同一组 biquad，按 mode 重建
    this.eqFilters = []

    // 输出保护
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 12
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25

    // 串起固定骨架：
    // input → voiceMatrix → bass → vocal → accomp → hallDry(hallMatrix) → 3D dry → output
    //                                     → hallWet(convolver) ─┐
    //                                     → 3D wet(panner) ─────┴→ output
    input.connect(this.voiceMatrix.input)
    this.voiceMatrix.output.connect(this.bassFilter)
    this.bassFilter.connect(this.vocalFilter)
    this.vocalFilter.connect(this.accompFilter)

    // 全景声厅干湿两路（从 accompFilter 之后分叉）
    this.accompFilter.connect(this.hallMatrix.input) // 干路（内部做加宽）
    this.hallMatrix.output.connect(this.pannerDryGain)
    this.accompFilter.connect(this.hallConvolver) // 湿路（混响）
    this.hallConvolver.connect(this.hallWetGain)
    this.hallWetGain.connect(this.pannerDryGain)

    // 3D 环绕干湿
    this.pannerDryGain.connect(output)
    this.pannerDryGain.connect(this.panner) // 湿路（HRTF 环绕）
    this.panner.connect(this.pannerWetGain)
    this.pannerWetGain.connect(output)

    output.connect(this.limiter)
    this.limiter.connect(analyser)

    // 重连：masterGain → 引擎 input（analyser 已由引擎 output 接入）
    masterGain.disconnect(analyser)
    masterGain.connect(input)

    // 异步注册 SoundTouch（变调/变速），成功后插入到 masterGain 与 input 之间
    void this.initSoundtouch(context, masterGain, input)

    // 应用当前设置
    this.rebuildFromSettings()

    debugLog('[AudioEffects] 效果链已插入 masterGain 与 analyser 之间')
  }

  private async initSoundtouch(context: AudioContext, masterGain: GainNode, input: GainNode): Promise<void> {
    try {
      await SoundTouchNode.register(context, processorUrl)
      const node = new SoundTouchNode({ context, outputChannelCount: 2 })
      this.soundtouchNode = node
      masterGain.disconnect(input)
      masterGain.connect(node)
      node.connect(input)
      this.applyPitchSettings()
      debugLog('[AudioEffects] SoundTouch 已就绪（变调/变速可用）')
    } catch (error) {
      console.warn('[AudioEffects] SoundTouch 注册失败，变调/变速不可用:', error)
      this.soundtouchNode = null
    }
  }

  private applyPitchSettings(): void {
    if (!this.soundtouchNode || !this.context) return
    const t = this.context.currentTime
    this.soundtouchNode.pitchSemitones.setTargetAtTime(this.settings.pitch.semitones, t, 0.02)
    this.soundtouchNode.playbackRate.setTargetAtTime(this.settings.pitch.rate, t, 0.02)
  }

  dispose(): void {
    this.stopSurroundRotation()
    if (this.context && this.input && this.masterGain && this.analyser) {
      try {
        this.masterGain.disconnect(this.input)
        this.masterGain.connect(this.analyser)
      } catch {
        // 忽略重连失败
      }
    }
    this.context = null
    this.input = null
    this.output = null
    this.masterGain = null
    this.analyser = null
  }

  // 依据 settings 重建所有可调参数（幂等，安全重复调用）
  private rebuildFromSettings(): void {
    if (!this.context) return
    const t = this.context.currentTime
    const { effects, eq, pitch } = this.settings

    // 人声/伴奏比例：center=人声(中)，side=伴奏(侧)
    if (this.voiceMatrix) {
      const v = Math.max(-1, Math.min(1, pitch.voiceBalance))
      const center = v >= 0 ? 1 : 1 + v // v<0 时削弱人声
      const side = v <= 0 ? 1 : 1 - v // v>0 时削弱伴奏
      this.voiceMatrix.centerGain.gain.setTargetAtTime(center, t, 0.02)
      this.voiceMatrix.sideGain.gain.setTargetAtTime(side, t, 0.02)
    }

    // 低音增强
    if (this.bassFilter) {
      this.bassFilter.frequency.setTargetAtTime(effects.bassBoost.depth, t, 0.02)
      this.bassFilter.gain.setTargetAtTime(effects.bassBoost.enabled ? effects.bassBoost.intensity : 0, t, 0.02)
    }

    // 人声加强
    if (this.vocalFilter) {
      this.vocalFilter.gain.setTargetAtTime(effects.vocalBoost.enabled ? effects.vocalBoost.intensity : 0, t, 0.02)
    }

    // 伴奏加强（削减人声频段，突出伴奏）
    if (this.accompFilter) {
      this.accompFilter.gain.setTargetAtTime(effects.accompanimentBoost.enabled ? -effects.accompanimentBoost.intensity : 0, t, 0.02)
    }

    // 全景声厅：M/S 加宽 + 混响湿电平
    if (this.hallMatrix && this.hallWetGain) {
      const level = effects.hall.enabled ? effects.hall.level : 0 // 0-6
      // 加宽：侧声道增益随级别增加（1 级≈轻微，6 级≈强烈）
      const sideGain = 1 + (level / 6) * 1.2
      const centerGain = 1 - (level / 6) * 0.25
      this.hallMatrix.sideGain.gain.setTargetAtTime(sideGain, t, 0.03)
      this.hallMatrix.centerGain.gain.setTargetAtTime(Math.max(0.5, centerGain), t, 0.03)
      // 混响湿电平
      this.hallWetGain.gain.setTargetAtTime(effects.hall.enabled ? Math.min(1, level / 6) * 0.9 : 0, t, 0.05)
    }

    // 3D 环绕
    if (this.panner && this.pannerWetGain && this.pannerDryGain) {
      this.pannerWetGain.gain.setTargetAtTime(effects.surround3d.enabled ? 1 : 0, t, 0.03)
      this.pannerDryGain.gain.setTargetAtTime(effects.surround3d.enabled ? 0 : 1, t, 0.03)
    }
    this.syncSurroundRotation()

    // 变调/变速
    this.applyPitchSettings()

    // 均衡器
    this.rebuildEq()
  }

  private rebuildEq(): void {
    if (!this.context || !this.input || !this.voiceMatrix) return
    const { eq } = this.settings

    // 清理旧滤波器
    for (const f of this.eqFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.eqFilters = []

    if (!eq.enabled) {
      // EQ 关闭：voiceMatrix 直接接到 bassFilter
      this.voiceMatrix.output.disconnect()
      this.voiceMatrix.output.connect(this.bassFilter!)
      return
    }

    const bands = eq.mode === 'simple'
      ? SIMPLE_EQ_BANDS.map((band, i) => ({ frequency: band.frequency, gain: eq.simpleBands[i] || 0, q: 1.0 }))
      : eq.proBands

    this.voiceMatrix.output.disconnect()
    let prev: AudioNode = this.voiceMatrix.output
    for (const band of bands) {
      const filter = this.context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = band.frequency
      filter.gain.value = band.gain
      filter.Q.value = band.q
      prev.connect(filter)
      this.eqFilters.push(filter)
      prev = filter
    }
    prev.connect(this.bassFilter!)
  }

  private syncSurroundRotation(): void {
    const enabled = this.settings.effects.surround3d.enabled
    if (enabled) {
      this.startSurroundRotation()
    } else {
      this.stopSurroundRotation()
    }
  }

  private startSurroundRotation(): void {
    if (this.surroundAnimationFrame) return
    this.surroundLastTime = performance.now()
    const tick = (now: number) => {
      if (!this.panner || !this.settings.effects.surround3d.enabled) {
        this.surroundAnimationFrame = 0
        return
      }
      const dt = Math.min(0.1, (now - this.surroundLastTime) / 1000)
      this.surroundLastTime = now
      const speed = this.settings.effects.surround3d.speed // 速度
      const distance = 0.5 + this.settings.effects.surround3d.distance * 0.5 // 近远（距离）
      this.surroundAngle += dt * speed * 1.6 // 旋转角速度
      const radius = distance
      const x = Math.sin(this.surroundAngle) * radius
      const z = Math.cos(this.surroundAngle) * radius
      const p = this.panner
      if (p.positionX) {
        p.positionX.setTargetAtTime(x, this.context!.currentTime, 0.03)
        p.positionZ.setTargetAtTime(z, this.context!.currentTime, 0.03)
        p.positionY.setTargetAtTime(0, this.context!.currentTime, 0.03)
      }
      this.surroundAnimationFrame = requestAnimationFrame(tick)
    }
    this.surroundAnimationFrame = requestAnimationFrame(tick)
  }

  private stopSurroundRotation(): void {
    if (this.surroundAnimationFrame) {
      cancelAnimationFrame(this.surroundAnimationFrame)
      this.surroundAnimationFrame = 0
    }
  }
}

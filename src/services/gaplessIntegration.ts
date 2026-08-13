/**
 * Gapless Integration - 集成 Cuefield AutoMix 和 Album Gapless
 * 这个模块在"无缝衔接"模式下提供 DJ 级智能混音
 */

import { debugLog } from '../utils/debugLog'
import { CuefieldAutoMix, type CuefieldSong, type CuefieldPendingTransition, type CuefieldTransitionPlan } from '../services/cuefieldAutoMix'
import { AlbumGaplessService, type AlbumGaplessSong } from '../services/albumGapless'
import { ensureBeatMap } from '../api/cuefieldApi'
import { CuefieldTimelineExecutor, buildCuefieldTimelineExecution } from '../services/cuefieldTimelineExecutor'
import { planTransition } from '../audio/transitionPlanner'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'

/**
 * 本地转场规划 - 使用本地节拍分析而不是远程 API
 */
async function planLocalTransition(
  fromKey: string,
  toKey: string,
  fromSong: CuefieldSong,
  toSong: CuefieldSong
): Promise<CuefieldTransitionPlan> {
  try {
    debugLog('[LocalPlanner] 开始本地转场规划...')
    
    // 1. 分析两首歌曲
    const [sourceAnalysis, targetAnalysis] = await Promise.all([
      autoMixAnalysisService.analyze({ 
        trackKey: fromKey, 
        url: fromSong.url, 
        duration: fromSong.duration 
      }),
      autoMixAnalysisService.analyze({ 
        trackKey: toKey, 
        url: toSong.url, 
        duration: toSong.duration 
      }),
    ])

    if (!sourceAnalysis || !targetAnalysis) {
      console.warn('[LocalPlanner] 分析失败')
      return { ok: false }
    }

    debugLog('[LocalPlanner] 分析完成:', {
      sourceBpm: sourceAnalysis.estimatedBpm,
      targetBpm: targetAnalysis.estimatedBpm,
      sourceBeats: sourceAnalysis.beats.length,
      targetBeats: targetAnalysis.beats.length,
    })

    // 2. 生成转场计划
    const plan = planTransition(sourceAnalysis, targetAnalysis, {
      beatMatching: true,
      skipSilence: true,
    }, 'beat-crossfade')

    // 使用 planTransition 计算的实际时长（已包含智能计算）
    const fadeSec = plan.sourceEndTime - plan.sourceStartTime

    debugLog('[LocalPlanner] 计划生成:', {
      strategy: plan.strategy,
      confidence: plan.confidence,
      fadeSec: fadeSec.toFixed(2),
      beatCount: plan.beatCount,
      sourceBpm: plan.sourceBpm,
      targetBpm: plan.targetBpm,
    })
    
    // 3. 转换为 Cuefield 格式
    return {
      ok: true,
      chosen: {
        transitionRecipe: 'beat-aligned-crossfade',
        recipeCandidate: {
          recipe: 'anchor-aligned-beatmix',
          mixType: 'beat-crossfade',
          confidence: plan.confidence,
          fadeSec,
          anchorLead: fadeSec * 0.5,
          warmupSec: fadeSec * 0.25,
          fadeStartA: plan.sourceStartTime,
          bFadeStart: plan.targetStartTime,
        },
        evaluation: {
          tier: plan.confidence >= 0.7 ? 'magic' : plan.confidence >= 0.5 ? 'usable' : 'weak',
          score: plan.confidence,
          risks: plan.fallbackReason ? [plan.fallbackReason] : [],
        },
        timeline: [
          { t: -fadeSec, deck: 'B', op: 'play', at: plan.targetStartTime },
          { t: -fadeSec, deck: 'A', op: 'volume', value: 1 },
          { t: -fadeSec, deck: 'B', op: 'volume', value: 0 },
          { t: -fadeSec, deck: 'AB', op: 'crossfade', durationMs: fadeSec * 1000 },
          { t: 0, deck: 'B', op: 'handoff' },
        ],
        exit: { time: plan.sourceEndTime },
        entry: { time: plan.targetStartTime },
        mixType: 'beat-crossfade',
        mixConfidence: plan.confidence,
        score: plan.confidence,
      },
    }
  } catch (error) {
    console.error('[LocalPlanner] 规划失败:', error)
    return { ok: false }
  }
}

export interface GaplessIntegrationOptions {
  enabled: boolean
  albumGaplessEnabled: boolean
  getCurrentAudio: () => HTMLAudioElement | null
  getCurrentTime: () => number
  getCurrentIndex: () => number
  getCurrentTrackKey: () => string
  getTargetVolume: () => number
  setOutputGain: (gain: number) => void
  getOutputGain: () => number
  getPlayQueue: () => any[]
  canAdvance: (index: number) => boolean
  playAt: (index: number, options: any) => Promise<boolean>
  prepareAudioUrl: (song: CuefieldSong) => Promise<string>
  onStateChange?: (state: any) => void
}

export class GaplessIntegration {
  private cuefieldAutoMix: CuefieldAutoMix
  private albumGapless: AlbumGaplessService
  private timelineExecutor: CuefieldTimelineExecutor
  private monitorTimer: number = 0
  private currentToken: number = 0
  private cuefieldExecutionSerial = 0
  private activeCuefieldTransition: {
    audio: HTMLAudioElement
    pending: CuefieldPendingTransition
    handoffStarted: boolean
    adopted: boolean
  } | null = null
  private transitionProgressFrame = 0

  constructor(private options: GaplessIntegrationOptions) {
    this.cuefieldAutoMix = new CuefieldAutoMix({
      ensureBeatMap,
      planTransition: planLocalTransition,  // 使用本地规划而不是远程 API
      prepareAudioUrl: options.prepareAudioUrl,
    })

    this.albumGapless = new AlbumGaplessService({
      getCurrentAudio: options.getCurrentAudio,
      getCurrentTime: options.getCurrentTime,
      getCurrentIndex: options.getCurrentIndex,
      getCurrentTrackKey: options.getCurrentTrackKey,
      getTargetVolume: options.getTargetVolume,
      setOutputGain: options.setOutputGain,
      getOutputGain: options.getOutputGain,
      getPlayQueue: options.getPlayQueue,
      canAdvance: options.canAdvance,
      playAt: options.playAt,
      onTransitionStart: (targetTrackKey, duration) => {
        this.beginVisualTransition(options.getCurrentTrackKey(), targetTrackKey, duration, false)
      },
      onTransitionProgress: progress => this.emitTransitionProgress(progress),
      onTransitionCancel: () => this.cancelVisualTransition(true),
    })

    this.timelineExecutor = new CuefieldTimelineExecutor()
  }

  private beginVisualTransition(
    sourceTrackKey: string,
    targetTrackKey: string,
    duration: number,
    trackProgress: boolean
  ): void {
    this.cancelVisualTransition()
    const safeDuration = Math.max(0.1, duration)
    const startedAt = performance.now()
    this.options.onStateChange?.({
      transitionState: 'running-transition',
      transitioning: true,
      seamlessTransition: true,
      transitionStrategy: 'gapless',
      transitionProgress: 0,
      transitionDuration: safeDuration,
      transitionFromTrackKey: sourceTrackKey,
      transitionToTrackKey: targetTrackKey,
    })

    if (!trackProgress) return
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / (safeDuration * 1000))
      this.emitTransitionProgress(progress)
      if (progress < 1) this.transitionProgressFrame = requestAnimationFrame(tick)
      else this.transitionProgressFrame = 0
    }
    this.transitionProgressFrame = requestAnimationFrame(tick)
  }

  private emitTransitionProgress(progress: number): void {
    this.options.onStateChange?.({ transitionProgress: Math.max(0, Math.min(1, progress)) })
  }

  private cancelVisualTransition(announce = false): void {
    if (this.transitionProgressFrame) cancelAnimationFrame(this.transitionProgressFrame)
    this.transitionProgressFrame = 0
    if (announce) {
      this.options.onStateChange?.({
        transitionState: 'playing',
        transitioning: false,
        transitionProgress: 0,
      })
    }
  }

  initAudioContext(audioContext: AudioContext, analyser: AnalyserNode): void {
    this.albumGapless.initAudioContext(audioContext, analyser)
  }

  setEnabled(enabled: boolean): void {
    this.cuefieldAutoMix.setEnabled(enabled)
    
    if (!enabled) {
      this.stopMonitoring()
      this.albumGapless.setEnabled(false)
    }
  }

  setAlbumGaplessEnabled(enabled: boolean): void {
    // Album Gapless 的启用状态会在需要时动态设置
  }

  updateSettings(settings: { enabled: boolean; albumGapless: boolean }): void {
    this.options.enabled = settings.enabled
    this.options.albumGaplessEnabled = settings.albumGapless
    this.setEnabled(settings.enabled)
  }

  async prepareTransition(ctx: {
    token: number
    currentIndex: number
    nextIndex: number
    currentSong: CuefieldSong
    nextSong: CuefieldSong
  }): Promise<{ success: boolean; mode: 'cuefield' | 'album-gapless' | 'disabled' }> {
    if (!this.options.enabled) {
      return { success: false, mode: 'disabled' }
    }

    this.currentToken = ctx.token

    // 检查是否是同专辑（且启用了专辑融合）
    const queue = this.options.getPlayQueue()
    const currentSongData = queue[ctx.currentIndex]
    const nextSongData = queue[ctx.nextIndex]
    
    const currentAlbumId = ctx.currentSong.albumId || currentSongData?.albumId
    const nextAlbumId = ctx.nextSong.albumId || nextSongData?.albumId
    const currentAlbumCover = ctx.currentSong.album || currentSongData?.albumCover
    const nextAlbumCover = ctx.nextSong.album || nextSongData?.albumCover
    const sameAlbum = currentAlbumId &&
                     currentAlbumId === nextAlbumId &&
                     this.options.albumGaplessEnabled

    debugLog('[Gapless] album match:', {
      currentAlbumId: currentAlbumId || null,
      nextAlbumId: nextAlbumId || null,
      albumGaplessEnabled: this.options.albumGaplessEnabled,
      sameAlbum: Boolean(sameAlbum),
    })

    if (sameAlbum) {
      // 使用 Album Gapless
      debugLog('[Gapless] 使用 Album Gapless 模式（同专辑）')
      
      const albumKey = this.albumGapless.getSongAlbumKey({
        key: ctx.currentSong.key,
        url: ctx.currentSong.url,
        albumId: currentAlbumId,
        albumCover: currentAlbumCover,
        duration: ctx.currentSong.duration,
      })

      this.albumGapless.setEnabled(true, null, albumKey)
      
      const scheduled = await this.albumGapless.schedulePreload(
        ctx.token,
        ctx.nextIndex,
        {
          key: ctx.nextSong.key,
          url: ctx.nextSong.url,
          albumId: nextAlbumId,
          albumCover: nextAlbumCover,
          duration: ctx.nextSong.duration,
        }
      )

      return { success: scheduled, mode: 'album-gapless' }
    }

    // Gapless 与 AutoMix 是两套独立系统。跨专辑时只保留普通边界
    // 无缝切换；BPM、节拍和能量规划只由 useAudioPlayer 的 AutoMix 路径负责。
    debugLog('[Gapless] 跨专辑歌曲使用普通无缝边界切换')
    this.albumGapless.setEnabled(false)
    this.stopMonitoring()
    this.cuefieldAutoMix.reset()
    return { success: false, mode: 'disabled' }
  }

  private startMonitoring(pending: CuefieldPendingTransition): void {
    this.stopMonitoring()

    this.monitorTimer = window.setInterval(() => {
      const currentTime = this.options.getCurrentTime()
      const currentIndex = this.options.getCurrentIndex()

      if (this.cuefieldAutoMix.shouldTrigger({
        token: this.currentToken,
        currentIndex,
        currentTime,
      })) {
        this.stopMonitoring()
        void this.executeCuefieldTransition()
      }
    }, 100)
  }

  private stopMonitoring(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = 0
    }
  }

  executeTransition(): { success: boolean; mode: 'cuefield' | 'album-gapless' | 'none' } {
    const albumState = this.albumGapless.snapshot()
    const albumTransitionActive = albumState.handoff
      || Boolean(albumState.preload?.mixPending)
      || Boolean(albumState.preload?.mixStarted)

    // The outgoing managed deck can emit `ended` a few frames before the
    // album crossfade finishes. Treat that mix as authoritative so the hook
    // does not start a second standby deck for the same target track.
    if (albumTransitionActive) {
      return { success: true, mode: 'album-gapless' }
    }

    // If the outgoing deck ends first, force the in-flight handoff now.
    const active = this.activeCuefieldTransition
    if (!active) return { success: false, mode: 'none' }

    // The outgoing deck can end before a remote timeline reaches its handoff.
    // Adopt the already-playing incoming deck instead of starting another copy.
    if (!active.handoffStarted) void this.handoffCuefieldTransition(active)
    return { success: true, mode: 'cuefield' }
  }

  hasActiveTransition(): boolean {
    const albumState = this.albumGapless.snapshot()
    return this.activeCuefieldTransition !== null
      || albumState.handoff
      || Boolean(albumState.preload?.mixPending)
      || Boolean(albumState.preload?.mixStarted)
  }

  private stopCuefieldAudio(audio: HTMLAudioElement): void {
    try {
      audio.pause()
      // Only pausing leaves the element's internal media buffer (tens of MB)
      // pinned until GC. Drop the source so the buffer can be released.
      audio.removeAttribute('src')
      audio.load()
    } catch {
      // The media element may already have been released by the browser.
    }
  }

  private async handoffCuefieldTransition(
    active: NonNullable<GaplessIntegration['activeCuefieldTransition']>
  ): Promise<boolean> {
    if (active.handoffStarted) return active.adopted
    active.handoffStarted = true

    try {
      const success = await this.options.playAt(active.pending.nextIndex, {
        cuefieldHandoff: true,
        preloadedAudio: active.audio,
        preloadedAudioUrl: active.pending.audioUrl,
      })
      active.adopted = success
      if (!success) {
        this.stopCuefieldAudio(active.audio)
        this.cancelVisualTransition(true)
      }
      return success
    } catch (error) {
      console.warn('[Cuefield] handoff failed:', error)
      this.stopCuefieldAudio(active.audio)
      this.cancelVisualTransition(true)
      return false
    } finally {
      if (this.activeCuefieldTransition === active) this.activeCuefieldTransition = null
    }
  }

  private async executeCuefieldTransition(): Promise<void> {
    const pending = this.cuefieldAutoMix.consumePending()
    if (!pending) return

    debugLog('[Cuefield] 执行过渡:', pending.executionMode)

    const execution = buildCuefieldTimelineExecution({
      timeline: pending.timeline,
      entryTime: pending.entryTime,
      executionMode: pending.executionMode,
      targetVolume: this.options.getTargetVolume(),
    })

    // 创建下一首的 Audio 元素
    const nextAudio = new Audio()
    nextAudio.src = pending.audioUrl
    nextAudio.preload = 'auto'
    nextAudio.volume = 0
    const executionSerial = ++this.cuefieldExecutionSerial
    const active = {
      audio: nextAudio,
      pending,
      handoffStarted: false,
      adopted: false,
    }
    this.activeCuefieldTransition = active

    // 等待加载
    await new Promise<void>((resolve) => {
      let timeoutId = 0
      const finish = () => {
        nextAudio.removeEventListener('canplay', finish)
        if (timeoutId) window.clearTimeout(timeoutId)
        resolve()
      }
      nextAudio.addEventListener('canplay', finish, { once: true })
      timeoutId = window.setTimeout(finish, 2000) // 超时保护
    })
    if (executionSerial !== this.cuefieldExecutionSerial) {
      // 过渡已被新的执行取代，释放本次创建的音频元素，避免缓冲区残留
      this.stopCuefieldAudio(nextAudio)
      return
    }

    // 执行时间轴
    const currentAudio = this.options.getCurrentAudio()
    if (!currentAudio) {
      this.stopCuefieldAudio(nextAudio)
      return
    }

    const startedAt = performance.now()
    for (const action of execution.actions) {
      const elapsedMs = performance.now() - startedAt
      const ready = await this.timelineExecutor.delay(Math.max(0, action.delayMs - elapsedMs))
      if (!ready || executionSerial !== this.cuefieldExecutionSerial) {
        // 执行被取消或被新的过渡取代，释放本次的音频元素（stopCuefieldAudio 幂等）
        this.stopCuefieldAudio(nextAudio)
        return
      }

      if (action.op === 'play' && action.deck === 'B') {
        nextAudio.currentTime = action.at || 0
        await nextAudio.play()
        const visualDuration = Math.max(0.35, (execution.handoffDelayMs - action.delayMs) / 1000)
        this.beginVisualTransition(pending.fromKey, pending.toKey, visualDuration, true)
      } else if (action.op === 'volume') {
        if (action.deck === 'A') {
          void this.timelineExecutor.runGainRamp(
            this.options.getOutputGain,
            this.options.setOutputGain,
            action.target ?? 0,
            action.durationMs
          )
        } else if (action.deck === 'B') {
          void this.timelineExecutor.runGainRamp(
            () => nextAudio.volume,
            gain => { nextAudio.volume = gain },
            action.target ?? 0,
            action.durationMs
          )
        }
      } else if (action.op === 'crossfade') {
        // 执行 Equal Power Crossfade
        await this.timelineExecutor.runEqualPowerCrossfade(
          currentAudio,
          nextAudio,
          action.durationMs || 2000,
          this.options.getTargetVolume(),
          pending.fadeStartA,
          this.options.setOutputGain,
          (gain) => { nextAudio.volume = gain },
          this.options.getOutputGain,
          pending.mixType
        )
      } else if (action.op === 'handoff') {
        await this.handoffCuefieldTransition(active)
        return
      }
    }

    // Server timelines do not always include an explicit handoff action.
    if (executionSerial === this.cuefieldExecutionSerial) {
      const remainingMs = Math.max(0, execution.handoffDelayMs - (performance.now() - startedAt))
      const ready = await this.timelineExecutor.delay(remainingMs)
      if (ready && executionSerial === this.cuefieldExecutionSerial) {
        await this.handoffCuefieldTransition(active)
      }
    }
  }

  reset(preserveAudio?: HTMLAudioElement): void {
    this.cuefieldExecutionSerial++
    this.stopMonitoring()
    this.cuefieldAutoMix.reset()
    this.albumGapless.clearPreload('reset')
    this.timelineExecutor.reset()
    this.cancelVisualTransition()
    this.options.setOutputGain(this.options.getTargetVolume())
    const active = this.activeCuefieldTransition
    this.activeCuefieldTransition = null
    if (active && active.audio === preserveAudio) active.adopted = true
    if (active && !active.adopted) this.stopCuefieldAudio(active.audio)
  }

  dispose(): void {
    this.reset()
  }
}

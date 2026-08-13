import { debugLog } from '../utils/debugLog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'
import { planTransition } from '../audio/transitionPlanner'
import { TransitionRenderer } from '../audio/TransitionRenderer'
import { createPlaybackTimeStore } from '../audio/playbackTimeStore'
import { GaplessIntegration } from '../services/gaplessIntegration'
import type {
  PlaybackEngineState,
  PreloadTrack,
  TrackAnalysis,
  TransitionCommit,
  TransitionPlan,
  TransitionState,
  TransitionStrategy,
} from '../audio/types'

export type AudioPlayerState = PlaybackEngineState

export interface CrossfadeSettings {
  enabled: boolean
  duration: number
}

export interface GaplessSettings {
  enabled: boolean
  albumGapless: boolean
}

export interface AutoMixSettings {
  enabled: boolean
  mode: 'auto' | 'manual'
  enableBeatMatching: boolean
  skipSilence: boolean
  minDuration?: number
  maxDuration?: number
}

// 音频图就绪后交给外部（音效引擎）的句柄
export interface AudioGraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
}

interface DeckMetadata extends PreloadTrack {
  analysis?: TrackAnalysis
}

const DEFAULT_VOLUME = 0.7
const CURVE_POINTS = 64
const EXTERNAL_HANDOFF_FADE_MS = 72
const EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS = 0.025
const CURRENT_MEDIA_LOAD_TIMEOUT_MS = 18_000
const PRELOAD_MEDIA_LOAD_TIMEOUT_MS = 15_000
// 跨专辑无缝衔接：在歌曲尾部做一次短交叉淡化的时长（秒）
const GAPLESS_BOUNDARY_CROSSFADE_SECONDS = 0.8

function asPreloadTrack(input: string | PreloadTrack): PreloadTrack {
  return typeof input === 'string' ? { url: input } : input
}

function equalPowerCurve(fadeIn: boolean): Float32Array {
  const curve = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const progress = i / (CURVE_POINTS - 1)
    curve[i] = fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  }
  return curve
}

// 构造一个跨专辑无缝用的短交叉淡化计划，复用已验证的 fixed-crossfade 路径
function buildGaplessCrossfadePlan(options: {
  sourceTrackKey: string
  targetTrackKey: string
  sourceStartTime: number
  sourceEndTime: number
}): TransitionPlan {
  const crossfadeDuration = Math.max(0.25, options.sourceEndTime - options.sourceStartTime)
  return {
    id: `gapless-boundary-${Date.now()}`,
    sourceTrackKey: options.sourceTrackKey,
    targetTrackKey: options.targetTrackKey,
    sourceStartTime: options.sourceStartTime,
    sourceEndTime: options.sourceEndTime,
    targetStartTime: 0,
    targetEndTime: crossfadeDuration,
    beatCount: 0,
    sourceBpm: 0,
    targetBpm: 0,
    tempoRamp: [],
    sourceDownbeatIndex: 0,
    targetDownbeatIndex: 0,
    gainCurve: {
      source: Array.from(equalPowerCurve(false)),
      target: Array.from(equalPowerCurve(true)),
    },
    confidence: 0,
    strategy: 'fixed-crossfade',
    fallbackReason: 'cross-album gapless crossfade',
    analysisVersion: 'gapless-boundary',
    rendererVersion: 'browser-crossfade-v1',
  }
}

function waitForSeek(audio: HTMLAudioElement, timeoutMs = 120): Promise<void> {
  if (!audio.seeking) return Promise.resolve()

  return new Promise(resolve => {
    let timeoutId = 0
    const finish = () => {
      audio.removeEventListener('seeked', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
      resolve()
    }

    audio.addEventListener('seeked', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}

export function useAudioPlayer(
  onStateChange: (state: Partial<AudioPlayerState>) => void,
  crossfadeSettings: CrossfadeSettings = { enabled: false, duration: 4 },
  gaplessSettings: GaplessSettings = { enabled: false, albumGapless: false },
  autoMixSettings: AutoMixSettings = {
    enabled: false,
    mode: 'auto',
    enableBeatMatching: true,
    skipSilence: true,
  },
  onAudioGraphReady?: (handle: AudioGraphHandle) => void
) {
  const primaryRef = useRef<HTMLAudioElement | null>(null)
  const secondaryRef = useRef<HTMLAudioElement | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const activePrimaryRef = useRef(true)
  const onStateChangeRef = useRef(onStateChange)
  const crossfadeRef = useRef(crossfadeSettings)
  const gaplessRef = useRef(gaplessSettings)
  const autoMixRef = useRef(autoMixSettings)
  const onAudioGraphReadyRef = useRef(onAudioGraphReady)
  const volumeRef = useRef(DEFAULT_VOLUME)
  const transitionStateRef = useRef<TransitionState>('idle')
  const transitionPlanRef = useRef<TransitionPlan | null>(null)
  const transitionTimerRef = useRef<number | null>(null)
  const gaplessBoundaryScheduledRef = useRef(false)
  const fallbackAnimationRef = useRef<number | null>(null)
  const transitionProgressAnimationRef = useRef<number | null>(null)  // 过渡进度动画帧
  const transitionStartTimeRef = useRef<number | null>(null)  // 过渡开始时间
  const retiredDeckCleanupTimerRef = useRef<number | null>(null)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const autoMixPreparationKeyRef = useRef<string | null>(null)
  const preparationRevisionRef = useRef(0)
  const transitionExecutionRevisionRef = useRef(0)
  const visualSwitchTimerRef = useRef<number | null>(null)
  const preloadReadyCleanupRef = useRef<(() => void) | null>(null)
  const currentLoadWaitCancelRef = useRef<(() => void) | null>(null)
  const transitionStartingRef = useRef(false)
  const isLoadingRef = useRef(false)
  const currentLoadRevisionRef = useRef(0)
  const currentMetadataRef = useRef<DeckMetadata | null>(null)
  const nextMetadataRef = useRef<DeckMetadata | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodesRef = useRef<[GainNode | null, GainNode | null]>([null, null])
  const masterGainRef = useRef<GainNode | null>(null)
  const analyserNodeRef = useRef<AnalyserNode | null>(null)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const transitionRendererRef = useRef<TransitionRenderer | null>(null)
  const gaplessIntegrationRef = useRef<GaplessIntegration | null>(null)
  const playAtCallbackRef = useRef<((index: number, options: any) => Promise<boolean>) | null>(null)
  const [playbackTimeStore] = useState(createPlaybackTimeStore)

  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  useEffect(() => { crossfadeRef.current = crossfadeSettings }, [crossfadeSettings])
  useEffect(() => { gaplessRef.current = gaplessSettings }, [gaplessSettings])
  useEffect(() => { autoMixRef.current = autoMixSettings }, [autoMixSettings])
  useEffect(() => { onAudioGraphReadyRef.current = onAudioGraphReady }, [onAudioGraphReady])

  const emit = useCallback((state: Partial<AudioPlayerState>) => {
    if (state.currentTime !== undefined || state.duration !== undefined || state.isPlaying !== undefined) {
      playbackTimeStore.publish({
        ...(state.currentTime !== undefined ? { currentTime: state.currentTime } : {}),
        ...(state.duration !== undefined ? { duration: state.duration } : {}),
        ...(state.isPlaying !== undefined ? { isPlaying: state.isPlaying } : {}),
      })
    }
    onStateChangeRef.current(state)
  }, [])

  const setTransitionState = useCallback((state: TransitionState, extra: Partial<AudioPlayerState> = {}) => {
    transitionStateRef.current = state
    emit({ transitionState: state, ...extra })
  }, [emit])

  const getActiveAudio = useCallback(() => activePrimaryRef.current ? primaryRef.current : secondaryRef.current, [])
  const getStandbyAudio = useCallback(() => activePrimaryRef.current ? secondaryRef.current : primaryRef.current, [])
  const getActiveGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 0 : 1], [])
  const getStandbyGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 1 : 0], [])

  const setDeckGain = useCallback((gain: GainNode | null, audio: HTMLAudioElement | null, value: number) => {
    const next = Math.max(0, Math.min(1, value))
    if (gain && audioContextRef.current) {
      gain.gain.cancelScheduledValues(audioContextRef.current.currentTime)
      gain.gain.setValueAtTime(next, audioContextRef.current.currentTime)
      if (audio) audio.volume = 1
    } else if (audio) {
      audio.volume = next * volumeRef.current
    }
  }, [])

  const ensureAudioGraph = useCallback(async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume().catch(() => undefined)
      return
    }
    const first = primaryRef.current
    const second = secondaryRef.current
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!first || !second || !AudioContextCtor) return
    let context: AudioContext | null = null
    try {
      context = new AudioContextCtor()
      const master = context.createGain()
      const firstGain = context.createGain()
      const secondGain = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.72
      context.createMediaElementSource(first).connect(firstGain).connect(master)
      context.createMediaElementSource(second).connect(secondGain).connect(master)
      master.connect(analyser).connect(context.destination)
      master.gain.value = volumeRef.current
      firstGain.gain.value = activePrimaryRef.current ? 1 : 0
      secondGain.gain.value = activePrimaryRef.current ? 0 : 1
      first.volume = 1
      second.volume = 1
      audioContextRef.current = context
      gainNodesRef.current = [firstGain, secondGain]
      masterGainRef.current = master
      analyserNodeRef.current = analyser
      setAnalyserNode(analyser)
      transitionRendererRef.current = new TransitionRenderer(context, master)
      
      // 初始化 Gapless Integration
      if (gaplessIntegrationRef.current) {
        gaplessIntegrationRef.current.initAudioContext(context, analyser)
      }
      
      // 通知外部音效引擎：音频图已就绪（在 masterGain 与 analyser 之间插入效果链）
      onAudioGraphReadyRef.current?.({ audioContext: context, masterGain: master, analyser })
      
      if (context.state === 'suspended') await context.resume().catch(() => undefined)
    } catch (error) {
      console.warn('[PlaybackEngine] Web Audio gain graph unavailable, using media volume fallback', error)
      if (context && context.state !== 'closed') void context.close()
      audioContextRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
      analyserNodeRef.current = null
      setAnalyserNode(null)
    }
  }, [])

  const cancelScheduledTransition = useCallback((reason = 'playback intent changed', preserveNext = true, announceCancellation = true) => {
    preparationRevisionRef.current += 1
    transitionExecutionRevisionRef.current += 1
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    autoMixPreparationKeyRef.current = null
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
    visualSwitchTimerRef.current = null
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = null
    gaplessBoundaryScheduledRef.current = false
    transitionRendererRef.current?.stopPlayback()
    if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
    fallbackAnimationRef.current = null
    if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
    transitionProgressAnimationRef.current = null
    transitionStartTimeRef.current = null
    if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
    retiredDeckCleanupTimerRef.current = null
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    setDeckGain(getActiveGain(), active, 1)
    setDeckGain(getStandbyGain(), standby, 0)
    if (standby && !standby.paused) standby.pause()
    transitionPlanRef.current = null
    if (!preserveNext) {
      if (standby) {
        standby.removeAttribute('src')
        standby.load()
      }
      nextMetadataRef.current = null
    }
    if (announceCancellation && transitionStateRef.current !== 'idle' && transitionStateRef.current !== 'playing') {
      setTransitionState('cancelled', { transitioning: false, fallbackReason: reason, transitionStartTime: null })
      setTransitionState(active?.src ? 'playing' : 'idle', { transitioning: false, transitionStartTime: null })
    }
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const runFallbackGainAnimation = useCallback((source: HTMLAudioElement, target: HTMLAudioElement, duration: number, onDone: () => void) => {
    const startedAt = performance.now()
    const animate = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / Math.max(1, duration * 1000))
      source.volume = Math.cos(progress * Math.PI / 2) * volumeRef.current
      target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
      if (progress < 1) fallbackAnimationRef.current = requestAnimationFrame(animate)
      else {
        fallbackAnimationRef.current = null
        onDone()
      }
    }
    animate()
  }, [])

  const commitTransition = useCallback((strategy: TransitionStrategy, targetTime: number, executionRevision = transitionExecutionRevisionRef.current) => {
    debugLog('✅ [Transition] commitTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   目标时间:', targetTime.toFixed(2), 's')
    debugLog('   执行版本:', executionRevision)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
      debugLog('⚠️ [Transition] 执行版本不匹配或状态已变更，跳过提交')
      return
    }
    
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const sourceMetadata = currentMetadataRef.current
    const targetMetadata = nextMetadataRef.current
    if (!target || !targetMetadata) {
      debugLog('❌ [Transition] 缺少目标音频或元数据，取消提交')
      return
    }

    debugLog('🔄 [Transition] 切换音频轨道...')
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    
    // 清理过渡进度追踪动画
    if (transitionProgressAnimationRef.current !== null) {
      cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
    }
    transitionStartTimeRef.current = null
    
    // 在 gapless 模式下，source 已经在 startTransition 中被停止了
    // 避免再次调用 load()，这会导致音频上下文短暂中断造成卡顿
    if (strategy !== 'gapless') {
      source?.pause()
      if (source) {
        source.currentTime = 0
        source.removeAttribute('src')
        source.load()
      }
    } else {
      // Gapless 模式需要给解码器留出极短的尾帧时间，再释放已经退出的媒体管线。
      // 定时器使用 deck 身份和 URL 双重校验，避免误清理随后预载到该 deck 的下一首。
      if (source) {
        const retiredSource = source.currentSrc || source.src
        source.currentTime = 0
        if (retiredDeckCleanupTimerRef.current !== null) {
          window.clearTimeout(retiredDeckCleanupTimerRef.current)
        }
        retiredDeckCleanupTimerRef.current = window.setTimeout(() => {
          retiredDeckCleanupTimerRef.current = null
          const stillStandby = getStandbyAudio() === source
          const sourceUnchanged = (source.currentSrc || source.src) === retiredSource
          if (stillStandby && sourceUnchanged && source.paused) {
            source.removeAttribute('src')
            source.load()
          }
        }, 350)
      }
    }
    setDeckGain(getActiveGain(), source, 0)
    setDeckGain(getStandbyGain(), target, 1)
    activePrimaryRef.current = !activePrimaryRef.current
    currentMetadataRef.current = targetMetadata
    nextMetadataRef.current = null
    transitionPlanRef.current = null
    setAudioElement(target)
    debugLog('✅ [Transition] 过渡提交完成，现在播放下一首')
    debugLog('   新的当前歌曲:', targetMetadata.trackKey)
    
    // 构造 TransitionCommit 对象，触发 UI 更新
    const transitionCommit: TransitionCommit = {
      sourceTrackKey: sourceMetadata?.trackKey || '',
      targetTrackKey: targetMetadata.trackKey || '',
      targetIndex: targetMetadata.index,
      targetTime: targetTime,
      strategy: strategy,
      isVisualSwitch: false,
    }
    
    // 使用单次状态更新，避免多次渲染导致的卡顿
    setTransitionState('playing', {
      isPlaying: !target.paused,
      currentTime: target.currentTime,
      duration: target.duration || targetMetadata.duration || 0,
      ended: false,
      transitioning: false,
      transitionCommit: transitionCommit,
      transitionStrategy: strategy,
      transitionStartTime: null,
    })
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const startTransition = useCallback(async (strategy: TransitionStrategy, plan?: TransitionPlan) => {
    debugLog('🚀 [Transition] startTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   计划:', plan)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (transitionStateRef.current === 'running-transition' || transitionStartingRef.current) {
      debugLog('⚠️ [Transition] 已经在进行过渡中，跳过')
      return
    }
    
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const targetMetadata = nextMetadataRef.current
    
    debugLog('🔍 [Transition] 检查音频元素:')
    debugLog('   source:', source ? '存在' : '不存在')
    debugLog('   target:', target ? '存在' : '不存在')
    debugLog('   target.src:', target?.src || '无')
    debugLog('   targetMetadata:', targetMetadata ? '存在' : '不存在')
    
    if (!source || !target || !target.src || !targetMetadata) {
      debugLog('❌ [Transition] 缺少必要的音频元素或元数据，取消过渡')
      return
    }

    // 音频过渡时长（gapless 为 0，即音频立即切换）
    const audioDuration = strategy === 'gapless' ? 0 : Math.max(0.25,
      plan ? plan.sourceEndTime - plan.sourceStartTime :
      strategy === 'fixed-crossfade' ? crossfadeRef.current.duration :
      4) // 默认 4 秒作为 fallback
    
    // 视觉过渡时长（gapless 模式下仍需要视觉动画）
    const visualDuration = strategy === 'gapless' ? 0.4 : audioDuration
    
    const targetTime = Math.max(0, Math.min(plan?.targetStartTime || 0, Math.max(0, (target.duration || targetMetadata.duration || 0) - 0.1)))

    debugLog('⏱️ [Transition] 过渡参数:')
    debugLog('   音频过渡时长:', audioDuration.toFixed(2), 's')
    debugLog('   视觉过渡时长:', visualDuration.toFixed(2), 's')
    debugLog('   目标开始时间:', targetTime.toFixed(2), 's')

    const executionRevision = ++transitionExecutionRevisionRef.current
    transitionStartingRef.current = true
    try {
      debugLog('🎨 [Transition] 确保音频图已初始化...')
      await ensureAudioGraph()
      
      // Check if we have a smart-rendered transition ready
      if (strategy === 'smart-rendered' && plan && transitionRendererRef.current) {
        debugLog('🎨 [Transition] 检查智能渲染的过渡音频...')
        const rendered = await transitionRendererRef.current.getRendered(plan.id)
        if (rendered) {
          debugLog('✅ [Transition] 找到预渲染的过渡音频，开始播放')
          
          // Get the transition duration from the rendered buffer
          const playbackOffset = Math.max(0, Math.min(
            Math.max(0, (source.currentTime || 0) - plan.sourceStartTime),
            Math.max(0, rendered.duration - 0.05),
          ))
          const transitionAudioDuration = Math.max(0.05, rendered.duration - playbackOffset)
          debugLog('   过渡音频时长:', transitionAudioDuration.toFixed(2), 's')
          
          // Start transition progress tracking
          const transitionStartTime = performance.now()
          transitionStartTimeRef.current = transitionStartTime
          
          // Set transition state with progress tracking
          setTransitionState('running-transition', {
            transitioning: true,
            seamlessTransition: true,
            transitionStrategy: strategy,
            fallbackReason: plan?.fallbackReason,
            transitionProgress: 0,
            transitionDuration: transitionAudioDuration,
            transitionFromTrackKey: currentMetadataRef.current?.trackKey || '',
            transitionToTrackKey: targetMetadata.trackKey || '',
          })
          
          // Start progress animation for visual feedback
          let visualSwitchSent = false
          const updateTransitionProgress = () => {
            if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
              return
            }
            
            const elapsed = (performance.now() - transitionStartTime) / 1000
            const progress = Math.min(elapsed / transitionAudioDuration, 1)
            
            // When progress reaches 90%, send visualSwitchCommit to update UI early
            // This prevents visual glitch when commitTransition is called
            if (!visualSwitchSent && progress >= 0.9) {
              visualSwitchSent = true
              const visualCommit: TransitionCommit = {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: plan?.targetStartTime || 0,
                strategy: strategy,
                isVisualSwitch: true, // Mark this as visual-only update
              }
              debugLog('🎨 [Transition] 发送 visualSwitchCommit (进度 90%)')
              debugLog('   目标歌曲:', targetMetadata.trackKey)
              debugLog('   目标时间:', visualCommit.targetTime.toFixed(2), 's')
              emit({
                transitionProgress: progress,
                transitionDuration: transitionAudioDuration,
                visualSwitchCommit: visualCommit,
              })
            } else {
              emit({
                transitionProgress: progress,
                transitionDuration: transitionAudioDuration,
              })
            }
            
            if (progress < 1) {
              transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
            }
          }
          
          transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
          
          // Play the pre-rendered transition buffer
          const result = await transitionRendererRef.current.playTransition(plan.id, source?.currentTime || 0)
          if (result) {
            debugLog('✅ [Transition] 智能渲染过渡播放完成')
            debugLog('   目标起始时间:', targetTime.toFixed(2), 's')
            debugLog('   目标恢复时间:', result.targetResumeTime.toFixed(2), 's')
            debugLog('   过渡时长:', transitionAudioDuration.toFixed(2), 's')
            
            // CRITICAL: Stop source immediately to avoid double-play
            // The transition audio already contains the source ending
            if (source) {
              source.pause()
              debugLog('⏸️ [Transition] 停止第一首播放，避免双重奏')
            }
            
            debugLog('🎵 [Transition] 目标轨道将在过渡完成后从', result.targetResumeTime.toFixed(2), 's 开始')
            
            // Wait for the transition audio to complete, then start target immediately
            // Subtract a small buffer (50ms) to account for play() startup latency
            const bufferTime = 50
            const waitTime = Math.max(0, result.remainingDuration * 1000 - bufferTime)
            
            transitionTimerRef.current = window.setTimeout(async () => {
              debugLog('✅ [Transition] 过渡音频即将结束，准备启动目标轨道')
              
              try {
                // CRITICAL: Set currentTime JUST BEFORE play() to avoid reset
                target.currentTime = result.targetResumeTime
                setDeckGain(getStandbyGain(), target, 1) // Set the incoming deck to full volume
                
                await target.play()
                debugLog('   目标轨道开始播放，位置:', target.currentTime.toFixed(2), 's')
              } catch (err) {
                console.error('❌ [Transition] 目标轨道启动失败:', err)
                setTransitionState('failed', {
                  isPlaying: false,
                  ended: true,
                  transitioning: false,
                  transitionStrategy: strategy,
                  fallbackReason: err instanceof Error ? err.message : 'target deck failed to start',
                })
                return
              }
              
              // Commit the transition slightly after play() to ensure it's running
              setTimeout(() => {
                commitTransition(strategy, result.targetResumeTime, executionRevision)
              }, 50)
            }, waitTime)
            
            return
          }
        }
        // Fall through to regular crossfade if rendering not available
        console.warn('⚠️ [Transition] 智能渲染音频未准备好，回退到普通交叉淡化')
        strategy = 'fixed-crossfade'
        plan.strategy = 'fixed-crossfade'
        plan.fallbackReason = 'Rendered transition was not ready at playback time'
      }
      
      debugLog('🎵 [Transition] 开始标准交叉淡化过渡')
      target.currentTime = targetTime
      setDeckGain(getStandbyGain(), target, strategy === 'gapless' ? 1 : 0)
      debugLog('▶️ [Transition] 开始播放下一首歌曲...')
      await target.play()
      debugLog('✅ [Transition] 下一首歌曲开始播放')
      
      // 开始过渡进度追踪
      const transitionStartTime = performance.now()
      transitionStartTimeRef.current = transitionStartTime
      
      setTransitionState('running-transition', {
        transitioning: true,
        seamlessTransition: true,
        transitionStrategy: strategy,
        fallbackReason: plan?.fallbackReason,
        transitionProgress: 0,
        transitionDuration: visualDuration,
        transitionFromTrackKey: currentMetadataRef.current?.trackKey || '',
        transitionToTrackKey: targetMetadata.trackKey || '',
      })

      // Gapless 模式：音频立即切换，但仍需视觉过渡动画
      if (strategy === 'gapless') {
        debugLog('⚡ [Transition] Gapless 模式：音频已切换，开始视觉过渡动画')
        source.pause()
        source.currentTime = 0
        
        // 启动视觉过渡进度追踪
        let visualSwitchSent = false
        const updateVisualProgress = () => {
          if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
            return
          }
          
          const elapsed = (performance.now() - transitionStartTime) / 1000
          const progress = Math.min(elapsed / visualDuration, 1)
          
          // When progress reaches 90%, send visualSwitchCommit to update UI early
          if (!visualSwitchSent && progress >= 0.9) {
            visualSwitchSent = true
            const visualCommit: TransitionCommit = {
              sourceTrackKey: currentMetadataRef.current?.trackKey || '',
              targetTrackKey: targetMetadata.trackKey || '',
              targetIndex: targetMetadata.index,
              targetTime: targetTime,
              strategy: strategy,
              isVisualSwitch: true,
            }
            emit({
              transitionProgress: progress,
              transitionDuration: visualDuration,
              visualSwitchCommit: visualCommit,
            })
          } else {
            emit({
              transitionProgress: progress,
              transitionDuration: visualDuration,
            })
          }
          
          if (progress < 1) {
            transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
          }
        }
        
        transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
        
        // 视觉过渡完成后提交
        transitionTimerRef.current = window.setTimeout(() => {
          commitTransition(strategy, targetTime, executionRevision)
        }, visualDuration * 1000)
        
        return
      }
      
      if (audioDuration <= 0.05) {
        debugLog('⚡ [Transition] 过渡时长过短，立即提交')
        commitTransition(strategy, targetTime, executionRevision)
        return
      }
      
      // 启动进度追踪动画
      let visualSwitchSent = false
      const updateTransitionProgress = () => {
        if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
          return
        }
        
        const elapsed = (performance.now() - transitionStartTime) / 1000
        const progress = Math.min(elapsed / audioDuration, 1)
        
        // When progress reaches 90%, send visualSwitchCommit to update UI early
        if (!visualSwitchSent && progress >= 0.9) {
          visualSwitchSent = true
          const visualCommit: TransitionCommit = {
            sourceTrackKey: currentMetadataRef.current?.trackKey || '',
            targetTrackKey: targetMetadata.trackKey || '',
            targetIndex: targetMetadata.index,
            targetTime: targetTime,
            strategy: strategy,
            isVisualSwitch: true,
          }
          emit({
            transitionProgress: progress,
            transitionDuration: audioDuration,
            visualSwitchCommit: visualCommit,
          })
        } else {
          emit({
            transitionProgress: progress,
            transitionDuration: audioDuration,
          })
        }
        
        if (progress < 1) {
          transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
        }
      }
      
      transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)

      const context = audioContextRef.current
      const sourceGain = getActiveGain()
      const targetGain = getStandbyGain()
      if (context && sourceGain && targetGain) {
        debugLog('🎚️ [Transition] 使用 Web Audio API 进行增益曲线过渡')
        const now = context.currentTime
        sourceGain.gain.cancelScheduledValues(now)
        targetGain.gain.cancelScheduledValues(now)
        sourceGain.gain.setValueAtTime(Math.max(0.0001, sourceGain.gain.value), now)
        targetGain.gain.setValueAtTime(0.0001, now)
        sourceGain.gain.setValueCurveAtTime(equalPowerCurve(false), now, audioDuration)
        targetGain.gain.setValueCurveAtTime(equalPowerCurve(true), now, audioDuration)
        
        // 在过渡中点（50%）切换视觉信息
        const midTransitionDelay = (audioDuration * 1000) / 2
        debugLog('⏰ [Transition] 设置视觉切换定时器，', (audioDuration / 2).toFixed(2), '秒后切换显示信息')
        visualSwitchTimerRef.current = window.setTimeout(() => {
          visualSwitchTimerRef.current = null
          if (executionRevision === transitionExecutionRevisionRef.current && transitionStateRef.current === 'running-transition') {
            debugLog('🎨 [Transition] 在过渡中点切换视觉信息到下一首')
            setTransitionState('running-transition', {
              transitioning: true,
              seamlessTransition: true,
              transitionStrategy: strategy,
              fallbackReason: plan?.fallbackReason,
              visualSwitchCommit: {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: targetTime + (audioDuration / 2),
                strategy,
                isVisualSwitch: true,  // 标记为视觉切换
              },
            })
          }
        }, midTransitionDelay)
        
        debugLog('⏰ [Transition] 设置过渡完成定时器，', audioDuration.toFixed(2), '秒后提交')
        transitionTimerRef.current = window.setTimeout(() => commitTransition(strategy, targetTime + audioDuration, executionRevision), audioDuration * 1000)
      } else {
        debugLog('🎚️ [Transition] Web Audio API 不可用，使用回退动画')
        runFallbackGainAnimation(source, target, audioDuration, () => commitTransition(strategy, targetTime + audioDuration, executionRevision))
      }
    } catch (error) {
      console.error('❌ [Transition] 过渡失败:', error)
      target.pause()
      setDeckGain(getStandbyGain(), target, 0)
      setDeckGain(getActiveGain(), source, 1)
      setTransitionState('failed', {
        transitioning: false,
        transitionStrategy: strategy,
        fallbackReason: error instanceof Error ? error.message : 'next deck failed to start',
      })
    } finally {
      transitionStartingRef.current = false
    }
  }, [commitTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, runFallbackGainAnimation, setDeckGain, setTransitionState])

  const prepareAutoMix = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    
    debugLog('🔍 [AutoMix] prepareAutoMix 被调用')
    debugLog('🔍 [AutoMix] autoMix 设置:', autoMixRef.current)
    debugLog('🔍 [AutoMix] 当前歌曲:', current)
    debugLog('🔍 [AutoMix] 下一首歌曲:', next)
    
    if (!autoMixRef.current.enabled) {
      debugLog('⚠️ [AutoMix] 智能混音功能未启用，退出')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('⚠️ [AutoMix] 当前歌曲信息不完整，退出')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('⚠️ [AutoMix] 下一首歌曲信息不完整，退出')
      return
    }

    const settings = autoMixRef.current
    const preparationKey = [
      current.trackKey,
      next.trackKey,
      settings.enableBeatMatching,
      settings.skipSilence,
      settings.minDuration,
      settings.maxDuration,
    ].join(':')
    if (autoMixPreparationKeyRef.current === preparationKey) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合已在准备或已就绪，跳过重复分析')
      return
    }
    autoMixPreparationKeyRef.current = preparationKey
    
    debugLog('✅ [AutoMix] 开始准备智能混音过渡')
    const revision = ++preparationRevisionRef.current
    preparationAbortRef.current?.abort()
    const controller = new AbortController()
    preparationAbortRef.current = controller
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    try {
      debugLog('🎵 [AutoMix] 开始分析歌曲节拍和 BPM...')
      const [sourceAnalysis, targetAnalysis] = await Promise.all([
        current.analysis || autoMixAnalysisService.analyze({ trackKey: current.trackKey, url: current.url, duration: current.duration, signal: controller.signal }),
        next.analysis || autoMixAnalysisService.analyze({ trackKey: next.trackKey, url: next.url, duration: next.duration, signal: controller.signal }),
      ])
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      
      // 检查分析结果是否有效
      if (!sourceAnalysis || !targetAnalysis) {
        console.error('❌ [AutoMix] 分析结果无效，使用回退方案')
        debugLog('   sourceAnalysis:', sourceAnalysis)
        debugLog('   targetAnalysis:', targetAnalysis)
        throw new Error('Analysis failed: invalid results')
      }
      
      debugLog('✅ [AutoMix] 歌曲分析完成:')
      debugLog('   当前歌曲 BPM:', sourceAnalysis.estimatedBpm, 'provider:', sourceAnalysis.provider)
      debugLog('   下一首 BPM:', targetAnalysis.estimatedBpm, 'provider:', targetAnalysis.provider)
      
      current.analysis = sourceAnalysis
      next.analysis = targetAnalysis
      const plan = planTransition(sourceAnalysis, targetAnalysis, {
        beatMatching: autoMixRef.current.enableBeatMatching,
        skipSilence: autoMixRef.current.skipSilence,
        minDuration: autoMixRef.current.minDuration,
        maxDuration: autoMixRef.current.maxDuration,
      }, 'smart-rendered')
      
      debugLog('📋 [AutoMix] 过渡计划生成:')
      debugLog('   计划ID:', plan.id)
      debugLog('   策略:', plan.strategy)
      debugLog('   置信度:', plan.confidence)
      debugLog('   过渡开始时间:', plan.sourceStartTime, 's')
      debugLog('   过渡结束时间:', plan.sourceEndTime, 's')
      debugLog('   节拍数:', plan.beatCount)
      if (plan.djEffects?.enabled) {
        debugLog('   DJ FX:', plan.djEffects)
      }
      
      // Try smart rendering if confidence is high and renderer available
      if (plan.strategy === 'smart-rendered' && plan.confidence >= 0.5 && transitionRendererRef.current) {
        debugLog('🎨 [AutoMix] 尝试智能渲染（置信度 >= 0.5）...')
        try {
          await transitionRendererRef.current.preRender({
            sourceUrl: current.url,
            targetUrl: next.url,
            plan,
          })
          debugLog('✅ [AutoMix] 智能渲染完成，过渡音频已缓存:', plan.id)
        } catch (renderError) {
          console.warn('⚠️ [AutoMix] 智能渲染失败，回退到普通交叉淡化:', renderError)
          plan.strategy = 'fixed-crossfade'
          plan.fallbackReason = 'Smart rendering failed; using fixed crossfade without beat stretching'
        }
      } else if (plan.strategy === 'smart-rendered' && plan.confidence < 0.5) {
        debugLog('⚠️ [AutoMix] 置信度不足（< 0.5），回退到节拍交叉淡化')
        plan.strategy = 'beat-crossfade'
        plan.fallbackReason = 'Confidence below smart-render threshold; using beat-aligned crossfade'
      }
      
      debugLog('🎯 [AutoMix] 最终过渡策略:', plan.strategy)
      if (plan.fallbackReason) {
        debugLog('   回退原因:', plan.fallbackReason)
      }
      
      transitionPlanRef.current = plan
      setTransitionState('armed', {
        transitionStrategy: plan.strategy,
        fallbackReason: plan.fallbackReason,
        transitioning: false,
        transitionStartTime: plan.sourceStartTime,
      })
      debugLog('✅ [AutoMix] 过渡已准备就绪（armed），等待播放到过渡点...')
    } catch (error) {
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      console.error('❌ [AutoMix] 准备过渡失败:', error)
      const active = getActiveAudio()
      const fallbackDuration = 4 // 固定 4 秒作为 fallback
      transitionPlanRef.current = {
        id: `${current.trackKey}->${next.trackKey}:fallback`,
        sourceTrackKey: current.trackKey,
        targetTrackKey: next.trackKey,
        sourceStartTime: Math.max(0, (active?.duration || current.duration || 0) - fallbackDuration),
        sourceEndTime: active?.duration || current.duration || 0,
        targetStartTime: 0,
        targetEndTime: fallbackDuration,
        beatCount: 0,
        sourceBpm: 120,
        targetBpm: 120,
        tempoRamp: [],
        sourceDownbeatIndex: 0,
        targetDownbeatIndex: 0,
        gainCurve: { source: [], target: [] },
        confidence: 0,
        strategy: 'fixed-crossfade',
        fallbackReason: error instanceof Error ? error.message : 'analysis failed',
        analysisVersion: 'unavailable',
        rendererVersion: 'browser-crossfade-v1',
      }
      debugLog('🔄 [AutoMix] 使用回退方案: fixed-crossfade')
      setTransitionState('armed', {
        transitionStrategy: 'fixed-crossfade',
        fallbackReason: transitionPlanRef.current.fallbackReason,
        transitionStartTime: transitionPlanRef.current.sourceStartTime,
      })
    }
  }, [getActiveAudio, setTransitionState])

  const prepareGaplessTransition = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    
    debugLog('[Gapless] prepareGaplessTransition 被调用')
    debugLog('[Gapless] 当前歌曲:', current)
    debugLog('[Gapless] 下一首歌曲:', next)
    
    if (!gaplessRef.current.enabled || !gaplessIntegrationRef.current) {
      debugLog('[Gapless] 无缝衔接未启用或未初始化')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('[Gapless] 当前歌曲信息不完整')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('[Gapless] 下一首歌曲信息不完整')
      return
    }
    
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    
    try {
      const result = await gaplessIntegrationRef.current.prepareTransition({
        token: Date.now(),
        currentIndex: current.index || 0,
        nextIndex: next.index || 1,
        currentSong: {
          key: current.trackKey,
          url: current.url,
          duration: current.duration || 0,
          albumId: current.albumId,
          album: current.albumCover,
        },
        nextSong: {
          key: next.trackKey,
          url: next.url,
          duration: next.duration || 0,
          albumId: next.albumId,
          album: next.albumCover,
        },
      })
      
      if (result.success) {
        debugLog(`[Gapless] 过渡准备成功，模式: ${result.mode}`)
        setTransitionState('armed', {
          transitionStrategy: 'gapless',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: Math.max(0, (current.duration || 0) - (result.mode === 'album-gapless' ? 1.8 : 0)),
        })
      } else {
        debugLog('[Gapless] 当前歌曲不使用专辑融合，使用普通 gapless')
        setTransitionState('armed', {
          transitionStrategy: 'fixed-crossfade',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: Math.max(0, (current.duration || 0) - GAPLESS_BOUNDARY_CROSSFADE_SECONDS),
        })
      }
    } catch (error) {
      console.error('[Gapless] 准备过渡失败:', error)
      setTransitionState('armed', {
        transitionStrategy: 'fixed-crossfade',
        fallbackReason: error instanceof Error ? error.message : 'preparation failed',
        transitioning: false,
        transitionStartTime: Math.max(0, (current.duration || 0) - GAPLESS_BOUNDARY_CROSSFADE_SECONDS),
      })
    }
  }, [setTransitionState])

  useEffect(() => {
    const primary = new Audio()
    const secondary = new Audio()
    for (const audio of [primary, secondary]) {
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      audio.volume = 0
    }
    primary.volume = volumeRef.current
    primaryRef.current = primary
    secondaryRef.current = secondary
    setAudioElement(primary)
    
    // 初始化 Gapless Integration
    gaplessIntegrationRef.current = new GaplessIntegration({
      enabled: gaplessSettings.enabled,
      albumGaplessEnabled: gaplessSettings.albumGapless,
      getCurrentAudio: getActiveAudio,
      getCurrentTime: () => getActiveAudio()?.currentTime || 0,
      getCurrentIndex: () => currentMetadataRef.current?.index || 0,
      getCurrentTrackKey: () => currentMetadataRef.current?.trackKey || '',
      getTargetVolume: () => volumeRef.current,
      setOutputGain: (gain) => {
        if (masterGainRef.current) {
          masterGainRef.current.gain.value = gain
        }
      },
      getOutputGain: () => masterGainRef.current?.gain.value || volumeRef.current,
      getPlayQueue: () => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        const queue: DeckMetadata[] = []
        if (current && Number.isInteger(current.index) && current.index! >= 0) queue[current.index!] = current
        if (next && Number.isInteger(next.index) && next.index! >= 0) queue[next.index!] = next
        return queue
      },
      canAdvance: (index) => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        return Boolean(current && next && current.index === index && next.url && next.trackKey)
      },
      playAt: async (index: number, options: any) => {
        // 调用外部传入的 playAt 回调
        if (playAtCallbackRef.current) {
          return await playAtCallbackRef.current(index, options)
        }
        return false
      },
      prepareAudioUrl: async (song) => song.url,
      onStateChange: state => {
        const { transitionState, ...extra } = state
        if (transitionState) setTransitionState(transitionState, extra)
        else emit(extra)
      },
    })

    const handleTimeUpdate = (event: Event) => {
      const active = getActiveAudio()
      if (event.currentTarget !== active || !active) return
      const remaining = (active.duration || 0) - active.currentTime
      const standby = getStandbyAudio()
      const plan = transitionPlanRef.current
      if (standby?.src && transitionStateRef.current !== 'running-transition') {
        if (autoMixRef.current.enabled && plan && (transitionStateRef.current === 'armed' || transitionStateRef.current === 'playing')) {
          if (active.currentTime >= plan.sourceStartTime) {
            debugLog('🎬 [AutoMix] 到达过渡点！')
            debugLog('   当前时间:', active.currentTime.toFixed(2), 's')
            debugLog('   过渡开始时间:', plan.sourceStartTime.toFixed(2), 's')
            debugLog('   过渡策略:', plan.strategy)
            debugLog('   过渡状态:', transitionStateRef.current)
            void startTransition(plan.strategy, plan)
          }
        } else if (crossfadeRef.current.enabled && remaining <= Math.max(0.25, crossfadeRef.current.duration)) {
          debugLog('🎬 [Crossfade] 到达交叉淡化点，剩余时间:', remaining.toFixed(2), 's')
          void startTransition('fixed-crossfade')
        } else if (
          gaplessRef.current.enabled
          && Number.isFinite(remaining)
          && remaining > 0
          && remaining <= GAPLESS_BOUNDARY_CROSSFADE_SECONDS
          && !gaplessBoundaryScheduledRef.current
          && !gaplessIntegrationRef.current?.hasActiveTransition()
        ) {
          // 跨专辑无缝：在歌曲尾部做一次短交叉淡化（复用 fixed-crossfade 路径），
          // 消除「播到最后一秒才硬切」以及可能的空档。仅触发一次。
          gaplessBoundaryScheduledRef.current = true
          if (
            getStandbyAudio()?.src
            && !gaplessIntegrationRef.current?.hasActiveTransition()
          ) {
            const current = currentMetadataRef.current
            const next = nextMetadataRef.current
            if (current?.trackKey && next?.trackKey && active.duration > 0) {
              const plan = buildGaplessCrossfadePlan({
                sourceTrackKey: current.trackKey,
                targetTrackKey: next.trackKey,
                sourceStartTime: active.currentTime,
                sourceEndTime: active.duration,
              })
              transitionPlanRef.current = plan
              debugLog(`🎬 [Gapless] 跨专辑无缝交叉淡化，剩余 ${remaining.toFixed(2)}s`)
              void startTransition('fixed-crossfade', plan)
            }
          }
        }
      }
      let buffered = 0
      if (active.buffered.length) buffered = active.buffered.end(active.buffered.length - 1)
      // 量化播放时间到 ~250ms，避免高频 timeupdate 触发多个大组件重渲染；
      // 进度条/歌词内部已有各自的平滑插值，视觉无变化。
      const quantizedTime = Math.round(active.currentTime * 4) / 4
      emit({ currentTime: quantizedTime, duration: active.duration || 0, buffered })
    }

    const handlePlay = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ isPlaying: true, ended: false })
    }
    const handlePause = (event: Event) => {
      if (
        event.currentTarget === getActiveAudio()
        && transitionStateRef.current !== 'committed'
        && transitionStateRef.current !== 'running-transition'
      ) {
        const active = getActiveAudio()
        emit({
          isPlaying: false,
          currentTime: active?.currentTime || 0,
          duration: active?.duration || 0,
        })
      }
    }
    const handleMetadata = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ duration: getActiveAudio()?.duration || 0 })
    }
    const handleEnded = (event: Event) => {
      debugLog('🏁 [Event] handleEnded 被触发')
      debugLog('   当前加载状态:', isLoadingRef.current)
      debugLog('   事件目标是活动音频?', event.currentTarget === getActiveAudio())
      
      if (isLoadingRef.current || event.currentTarget !== getActiveAudio()) return

      // A timer normally performs the boundary handoff. If `ended` wins the race, cancel the
      // timer and execute immediately so a delayed callback cannot start the same deck twice.
      if (gaplessBoundaryScheduledRef.current && transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
        transitionTimerRef.current = null
        gaplessBoundaryScheduledRef.current = false
      }
      
      const standby = getStandbyAudio()
      debugLog('🔍 [Event] 检查过渡状态:', transitionStateRef.current)
      debugLog('   待机音频:', standby ? '存在' : '不存在')
      debugLog('   待机音频暂停?', standby?.paused)
      debugLog('   待机音频 src:', standby?.src || '无')
      
      if (transitionStateRef.current === 'running-transition' && standby && !standby.paused) {
        debugLog('✅ [Event] 过渡正在进行中，提交过渡')
        const strategy = transitionPlanRef.current?.strategy || (crossfadeRef.current.enabled ? 'fixed-crossfade' : 'gapless')
        commitTransition(strategy, standby.currentTime, transitionExecutionRevisionRef.current)
      } else if (standby?.src && gaplessRef.current.enabled) {
        debugLog('⏭️ [Event] 待机音频就绪且无缝衔接已启用')
        if (gaplessIntegrationRef.current) {
          // 使用 Cuefield/Album Gapless 执行过渡
          const result = gaplessIntegrationRef.current.executeTransition()
          if (result.success) {
            debugLog(`[Gapless] 使用 ${result.mode} 模式执行过渡`)
            // 如果成功执行了无缝，这里不要再调用 startTransition，避免双音轨同时播放
          } else {
            debugLog('[Gapless] 使用简单模式执行过渡')
            void startTransition('gapless')
          }
        } else {
          void startTransition('gapless')
        }
      } else {
        debugLog('⏸️ [Event] 无过渡计划，歌曲结束')
        setTransitionState('idle', { isPlaying: false, ended: true, seamlessTransition: false, transitioning: false })
      }
    }
    const handleError = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) {
        setTransitionState('failed', { isPlaying: false, fallbackReason: getActiveAudio()?.error?.message || 'media decode failed' })
      }
    }

    for (const audio of [primary, secondary]) {
      audio.addEventListener('timeupdate', handleTimeUpdate)
      audio.addEventListener('play', handlePlay)
      audio.addEventListener('pause', handlePause)
      audio.addEventListener('loadedmetadata', handleMetadata)
      audio.addEventListener('ended', handleEnded)
      audio.addEventListener('error', handleError)
    }

    return () => {
      preparationAbortRef.current?.abort()
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
      if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
      preloadReadyCleanupRef.current?.()
      preloadReadyCleanupRef.current = null
      currentLoadRevisionRef.current += 1
      currentLoadWaitCancelRef.current?.()
      currentLoadWaitCancelRef.current = null
      gaplessBoundaryScheduledRef.current = false
      if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
      if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
      transitionStartTimeRef.current = null
      if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
      retiredDeckCleanupTimerRef.current = null
      transitionRendererRef.current?.dispose()
      transitionRendererRef.current = null
      gaplessIntegrationRef.current?.dispose()
      gaplessIntegrationRef.current = null
      for (const audio of [primary, secondary]) {
        audio.removeEventListener('timeupdate', handleTimeUpdate)
        audio.removeEventListener('play', handlePlay)
        audio.removeEventListener('pause', handlePause)
        audio.removeEventListener('loadedmetadata', handleMetadata)
        audio.removeEventListener('ended', handleEnded)
        audio.removeEventListener('error', handleError)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      void audioContextRef.current?.close()
      audioContextRef.current = null
      analyserNodeRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
    }
  }, [commitTransition, emit, getActiveAudio, getStandbyAudio, setTransitionState, startTransition])

  useEffect(() => {
    if (gaplessIntegrationRef.current) {
      gaplessIntegrationRef.current.updateSettings({
        enabled: gaplessSettings.enabled,
        albumGapless: gaplessSettings.albumGapless,
      })
    }
  }, [gaplessSettings.enabled, gaplessSettings.albumGapless])

  useEffect(() => {
    if (!nextMetadataRef.current?.url) return
    cancelScheduledTransition('transition settings changed')
    if (autoMixSettings.enabled) {
      void prepareAutoMix()
      return
    }
    setTransitionState('armed', {
      transitioning: false,
      fallbackReason: undefined,
      transitionStrategy: crossfadeSettings.enabled
        ? 'fixed-crossfade'
        : gaplessSettings.enabled
          ? 'gapless'
          : 'none',
    })
  }, [
    autoMixSettings.enabled,
    autoMixSettings.enableBeatMatching,
    autoMixSettings.skipSilence,
    autoMixSettings.minDuration,
    autoMixSettings.maxDuration,
    crossfadeSettings.enabled,
    crossfadeSettings.duration,
    gaplessSettings.enabled,
    gaplessSettings.albumGapless,
    cancelScheduledTransition,
    prepareAutoMix,
    setTransitionState,
  ])

  const preloadNext = useCallback((input: string | PreloadTrack) => {
    const track = asPreloadTrack(input)
    debugLog('📥 [Preload] preloadNext 被调用')
    debugLog('   下一首歌曲:', track)
    const standby = getStandbyAudio()
    if (!standby || !track.url) {
      debugLog('❌ [Preload] 缺少待机音频元素或 URL')
      return
    }
    const existingNext = nextMetadataRef.current
    const sameTrackAlreadyAttached = Boolean(
      existingNext
      && existingNext.url === track.url
      && existingNext.trackKey === track.trackKey
      && existingNext.index === track.index
      && (standby.currentSrc || standby.getAttribute('src'))
      && standby.networkState !== HTMLMediaElement.NETWORK_EMPTY
      && !standby.error
    )
    if (sameTrackAlreadyAttached) {
      // Queue-related effects can run more than once for the same next track. Keep the
      // existing media pipeline and any in-flight canplay/AutoMix preparation intact.
      nextMetadataRef.current = { ...existingNext, ...track }
      debugLog('♻️ [Preload] 下一首未变化，复用现有待机媒体管线')
      return
    }

    // Preserve the old standby source until assigning the replacement below. Clearing
    // it first would make Chromium tear down one pipeline and immediately create another.
    cancelScheduledTransition('next track changed', true)
    nextMetadataRef.current = { ...track }
    standby.pause()
    standby.currentTime = 0
    standby.src = track.url
    standby.preload = 'auto'
    setDeckGain(getStandbyGain(), standby, 0)
    debugLog('⏳ [Preload] 开始加载下一首歌曲...')
    setTransitionState('preparing-next', { transitioning: false, transitionStartTime: null })
    const isCurrentPreload = () => Boolean(
      nextMetadataRef.current?.url === track.url
      && nextMetadataRef.current?.trackKey === track.trackKey
      && nextMetadataRef.current?.index === track.index
    )
    let timeoutId = 0
    const cleanupReady = () => {
      standby.removeEventListener('canplay', ready)
      standby.removeEventListener('error', failed)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    const ready = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!isCurrentPreload()) return
      debugLog('? [Preload] ???????????')
      if (autoMixRef.current.enabled) {
        debugLog('?? [Preload] autoMix ?????? prepareAutoMix()')
        void prepareAutoMix()
      }
      else if (gaplessRef.current.enabled && gaplessIntegrationRef.current) {
        debugLog('?? [Preload] ?????????? GaplessIntegration')
        void prepareGaplessTransition()
      }
      else {
        debugLog('?? [Preload] ????????? armed ??')
        setTransitionState('armed', {
          transitionStrategy: crossfadeRef.current.enabled ? 'fixed-crossfade' : 'none',
        })
      }
    }
    const failed = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!isCurrentPreload()) return
      console.warn('[Preload] Next track media failed to load or timed out; normal end-of-track loading will be used')
      nextMetadataRef.current = null
      standby.pause()
      standby.removeAttribute('src')
      standby.load()
      const active = getActiveAudio()
      setTransitionState(active?.src ? 'playing' : 'idle', {
        transitioning: false,
        transitionStartTime: null,
        fallbackReason: 'next track preload failed',
      })
    }
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = cleanupReady
    standby.addEventListener('canplay', ready, { once: true })
    standby.addEventListener('error', failed, { once: true })
    timeoutId = window.setTimeout(failed, PRELOAD_MEDIA_LOAD_TIMEOUT_MS)
    standby.load()
  }, [cancelScheduledTransition, getActiveAudio, getStandbyAudio, getStandbyGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState])

  const loadAndPlay = useCallback(async (
    url: string,
    startVolume = DEFAULT_VOLUME,
    track?: Omit<PreloadTrack, 'url'>
  ) => {
    debugLog('🎵 [LoadAndPlay] loadAndPlay 被调用')
    debugLog('   URL:', url)
    debugLog('   音量:', startVolume)
    debugLog('   歌曲信息:', track)
    const loadRevision = ++currentLoadRevisionRef.current
    currentLoadWaitCancelRef.current?.()
    currentLoadWaitCancelRef.current = null
    
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    if (!active) throw new Error('Audio deck is not initialized')
    isLoadingRef.current = true
    cancelScheduledTransition('new current track loaded', false)
    setTransitionState('loading-current', { currentTime: 0, duration: 0, ended: false, transitioning: false, transitionStartTime: null })
    volumeRef.current = Math.max(0, Math.min(1, startVolume))
    try {
      // 停止所有音频
      if (standby && !standby.paused) {
        debugLog('⏸️ [LoadAndPlay] 停止 standby 音频')
        standby.pause()
        standby.currentTime = 0
      }
      standby?.pause()
      active.pause()
      active.currentTime = 0
      // 先显式卸载旧资源。仅覆盖 src 会让 Chromium 的旧媒体管线等待 GC，
      // 快速切歌时会形成明显的阶梯式内存增长。
      active.removeAttribute('src')
      active.load()
      // 重置 GaplessIntegration，停止所有预加载的音频
      if (gaplessIntegrationRef.current) {
        debugLog('🧹 [LoadAndPlay] 重置 GaplessIntegration')
        gaplessIntegrationRef.current.reset()
      }
      active.src = url
      active.preload = 'auto'
      currentMetadataRef.current = { url, ...track }
      setAudioElement(active)
      await ensureAudioGraph()
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      setDeckGain(getActiveGain(), active, 1)
      setDeckGain(getStandbyGain(), standby, 0)
      debugLog('⏳ [LoadAndPlay] 加载音频文件...')
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timeoutId = 0
        const cleanup = () => {
          active.removeEventListener('canplay', canPlay)
          active.removeEventListener('error', failed)
          if (timeoutId) window.clearTimeout(timeoutId)
          if (currentLoadWaitCancelRef.current === cancelled) currentLoadWaitCancelRef.current = null
        }
        const settle = (callback: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          callback()
        }
        const canPlay = () => settle(resolve)
        const failed = () => settle(() => reject(active.error || new Error('media load failed')))
        const cancelled = () => settle(resolve)
        currentLoadWaitCancelRef.current = cancelled
        active.addEventListener('canplay', canPlay, { once: true })
        active.addEventListener('error', failed, { once: true })
        timeoutId = window.setTimeout(
          () => settle(() => reject(new Error('media load timed out'))),
          CURRENT_MEDIA_LOAD_TIMEOUT_MS,
        )
        active.load()
      })
      if (loadRevision !== currentLoadRevisionRef.current) return false
      debugLog('▶️ [LoadAndPlay] 开始播放...')
      await active.play()
      if (loadRevision !== currentLoadRevisionRef.current) return false
      isLoadingRef.current = false
      debugLog('✅ [LoadAndPlay] 播放成功')
      setTransitionState('playing', { isPlaying: true, duration: active.duration || track?.duration || 0, ended: false })
      
      // Prepare auto mix for next track if available
      if (nextMetadataRef.current?.url && autoMixRef.current.enabled) {
        debugLog('🎵 [LoadAndPlay] 检测到下一首歌曲且 autoMix 已启用，调用 prepareAutoMix()')
        void prepareAutoMix()
      } else {
        debugLog('⏭️ [LoadAndPlay] 下一首:', nextMetadataRef.current ? '存在' : '不存在', ', autoMix:', autoMixRef.current.enabled ? '启用' : '禁用')
      }
      return true
    } catch (error) {
      if (loadRevision !== currentLoadRevisionRef.current) return false
      console.error('❌ [LoadAndPlay] 播放失败:', error)
      isLoadingRef.current = false
      setTransitionState('failed', { isPlaying: false, fallbackReason: error instanceof Error ? error.message : 'playback failed' })
      throw error
    }
  }, [cancelScheduledTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState, prepareAutoMix])

  const togglePlay = useCallback(async () => {
    const active = getActiveAudio()
    if (!active?.src) return
    try {
      await ensureAudioGraph()
      if (gaplessIntegrationRef.current?.hasActiveTransition()) {
        cancelScheduledTransition('paused during gapless transition')
        active.pause()
        gaplessIntegrationRef.current.reset()
        emit({ isPlaying: false })
        return
      }
      if (active.paused) {
        await active.play()
        setTransitionState('playing', { isPlaying: true })
        if (nextMetadataRef.current?.url) {
          if (autoMixRef.current.enabled) void prepareAutoMix()
          else if (gaplessRef.current.enabled) void prepareGaplessTransition()
          else setTransitionState('armed', {
            isPlaying: true,
            transitionStrategy: crossfadeRef.current.enabled
              ? 'fixed-crossfade'
              : gaplessRef.current.enabled
                ? 'gapless'
                : 'none',
          })
        }
      } else {
        cancelScheduledTransition('paused during transition')
        active.pause()
        // 同时暂停 standby 音频
        const standby = getStandbyAudio()
        if (standby && !standby.paused) {
          standby.pause()
        }
        // 重置 GaplessIntegration，停止所有预加载的音频
        if (gaplessIntegrationRef.current) {
          gaplessIntegrationRef.current.reset()
        }
        emit({ isPlaying: false })
      }
    } catch (error) {
      console.error('[PlaybackEngine] play/pause failed', error)
    }
  }, [cancelScheduledTransition, emit, ensureAudioGraph, getActiveAudio, prepareAutoMix, prepareGaplessTransition, setTransitionState])

  const seek = useCallback((time: number) => {
    const active = getActiveAudio()
    if (!active) return
    cancelScheduledTransition('seek changed transition timing')
    active.currentTime = Math.max(0, Math.min(time, active.duration || 0))
    emit({ currentTime: active.currentTime, duration: active.duration || 0 })
    if (nextMetadataRef.current?.url && autoMixRef.current.enabled) void prepareAutoMix()
  }, [cancelScheduledTransition, emit, getActiveAudio, prepareAutoMix])

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    volumeRef.current = clamped
    const context = audioContextRef.current
    const master = masterGainRef.current
    if (context && master) master.gain.setValueAtTime(clamped, context.currentTime)
    else {
      const active = getActiveAudio()
      if (active) active.volume = clamped
    }
    emit({ volume: clamped })
  }, [emit, getActiveAudio])

  const setPlayAtCallback = useCallback((callback: (index: number, options: any) => Promise<boolean>) => {
    playAtCallbackRef.current = callback
  }, [])

  const resetGaplessIntegration = useCallback(() => {
    if (gaplessIntegrationRef.current) {
      debugLog('[Gapless] 重置 GaplessIntegration')
      gaplessIntegrationRef.current.reset()
    }
  }, [])

  const adoptExternalAudio = useCallback(async (externalAudio: HTMLAudioElement, metadata: DeckMetadata) => {
    debugLog('[AdoptAudio] 接管外部音频元素')
    debugLog('   URL:', metadata.url)
    debugLog('   当前时间:', externalAudio.currentTime.toFixed(2))
    debugLog('   是否暂停:', externalAudio.paused)

    const active = getActiveAudio()
    const target = getStandbyAudio()
    if (!active || !target) throw new Error('Audio deck is not initialized')
    const initialResumeTime = Math.max(0, externalAudio.currentTime || 0)

    isLoadingRef.current = false
    cancelScheduledTransition('external audio adopted', true, false)
    // Keep the already-audible transition deck alive until the managed deck
    // has started at the same position, otherwise handoff creates a gap.
    gaplessIntegrationRef.current?.reset(externalAudio)

    try {
      // Move playback back onto a managed deck so pause, seek and ended events
      // keep controlling the same audio after the seamless handoff.
      active.pause()
      if (target.src !== metadata.url) {
        target.src = metadata.url
        target.preload = 'auto'
        target.load()
        await new Promise<void>((resolve, reject) => {
          const ready = () => { cleanup(); resolve() }
          const failed = () => { cleanup(); reject(target.error || new Error('media load failed')) }
          const cleanup = () => {
            target.removeEventListener('canplay', ready)
            target.removeEventListener('error', failed)
          }
          target.addEventListener('canplay', ready, { once: true })
          target.addEventListener('error', failed, { once: true })
        })
      }

      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }

      const getLiveHandoffTime = () => {
        const liveExternalTime = Math.max(initialResumeTime, externalAudio.currentTime || 0)
        const latestAllowedTime = Math.max(0, (target.duration || metadata.duration || liveExternalTime + 0.1) - 0.1)
        return Math.min(liveExternalTime, latestAllowedTime)
      }

      setDeckGain(getActiveGain(), active, 0)
      setDeckGain(getStandbyGain(), target, 0)
      target.currentTime = getLiveHandoffTime()
      await target.play()

      // The external deck keeps advancing while the managed deck starts. Align
      // again after play() resolves so the handoff does not replay or skip the
      // last decoder frames at the exact moment the visual transition ends.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const liveHandoffTime = getLiveHandoffTime()
        if (Math.abs(target.currentTime - liveHandoffTime) <= EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS) break
        target.currentTime = liveHandoffTime
        await waitForSeek(target)
      }

      const standbyGain = getStandbyGain()
      const context = audioContextRef.current
      const externalStartVolume = externalAudio.muted ? 0 : externalAudio.volume
      if (standbyGain && context) {
        const now = context.currentTime
        standbyGain.gain.cancelScheduledValues(now)
        standbyGain.gain.setValueAtTime(0, now)
        standbyGain.gain.setValueCurveAtTime(
          equalPowerCurve(true),
          now,
          EXTERNAL_HANDOFF_FADE_MS / 1000
        )
      }

      // Keep the already-audible external deck alive for a few frames while the
      // managed deck fades in. This removes the hard element-to-element cut.
      await new Promise<void>(resolve => {
        const startedAt = performance.now()
        const tick = () => {
          const progress = Math.min(1, (performance.now() - startedAt) / EXTERNAL_HANDOFF_FADE_MS)
          externalAudio.volume = externalStartVolume * Math.cos(progress * Math.PI / 2)
          if (!standbyGain || !context) {
            target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
          }

          if (progress < 1) requestAnimationFrame(tick)
          else resolve()
        }
        tick()
      })

      setDeckGain(standbyGain, target, 1)

      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      active.currentTime = 0
      active.removeAttribute('src')
      active.load()
      activePrimaryRef.current = !activePrimaryRef.current
      currentMetadataRef.current = { ...metadata }
      nextMetadataRef.current = null
      setAudioElement(target)

      setTransitionState('committed', {
        isPlaying: true,
        currentTime: target.currentTime,
        duration: target.duration || metadata.duration || 0,
        ended: false,
        transitioning: false,
        seamlessTransition: true,
        transitionStrategy: 'gapless',
      })
      setTransitionState('playing', {
        isPlaying: true,
        transitioning: false,
        transitionStrategy: 'gapless',
      })

      debugLog('[AdoptAudio] 接管完成，当前播放位置:', target.currentTime.toFixed(2))
      return true
    } catch (error) {
      console.error('[AdoptAudio] 接管失败:', error)
      target.pause()
      setDeckGain(getStandbyGain(), target, 0)
      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      return false
    }
  }, [cancelScheduledTransition, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  return {
    loadAndPlay,
    togglePlay,
    seek,
    setVolume,
    preloadNext,
    cancelTransition: cancelScheduledTransition,
    getAudioElement: getActiveAudio,
    audioElement,
    playbackTimeStore,
    analyserNode,
    nextAudioElement: getStandbyAudio(),
    setPlayAtCallback,
    resetGaplessIntegration,
    adoptExternalAudio,
  }
}

import { debugLog } from '../utils/debugLog'
import type { TransitionPlan } from './types'

interface RenderProgress {
  stage: 'analyzing' | 'stretching' | 'mixing' | 'finalizing'
  progress: number
}

interface RenderResult {
  audioBuffer: AudioBuffer
  plan: TransitionPlan
  renderTime: number
}

interface RenderCache {
  buffer: AudioBuffer
  timestamp: number
  plan: TransitionPlan
  bytes: number
}

export class TransitionRenderer {
  private audioContext: AudioContext
  private masterGain: GainNode | null = null
  private cache: Map<string, RenderCache> = new Map()
  private activeSource: AudioBufferSourceNode | null = null
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null
  private cacheBytes = 0
  private readonly MAX_CACHE_SIZE = 10
  private readonly MAX_CACHE_BYTES = 128 * 1024 * 1024
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(audioContext: AudioContext, masterGain?: GainNode) {
    this.audioContext = audioContext
    this.masterGain = masterGain || null
    this.startCacheCleanup()
  }
  
  setMasterGain(masterGain: GainNode): void {
    this.masterGain = masterGain
  }

  async preRender(params: { sourceUrl: string; targetUrl: string; plan: TransitionPlan }): Promise<void> {
    const { sourceUrl, targetUrl, plan } = params
    
    // Check if already cached
    const cached = this.cache.get(plan.id)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      debugLog(`[TransitionRenderer] Pre-render: already cached ${plan.id}`)
      return
    }
    if (cached) this.deleteCacheEntry(plan.id)
    
    debugLog(`[TransitionRenderer] Pre-rendering transition ${plan.id}`)
    
    // Trigger the render without waiting for the AudioBuffer
    // This will download files and render to backend cache
    await this.renderTransition(plan, sourceUrl, targetUrl)
  }

  async renderTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    sourceBuffer?: AudioBuffer,
    targetBuffer?: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void
  ): Promise<RenderResult> {
    const startTime = performance.now()
    if (!plan.id?.trim()) throw new Error('Transition plan requires a non-empty ID')
    if (!plan.sourceTrackKey?.trim() || !plan.targetTrackKey?.trim()) {
      throw new Error('Transition plan requires non-empty track keys')
    }

    // Check cache first
    const cached = this.cache.get(plan.id)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      debugLog(`[TransitionRenderer] Cache hit for ${plan.id}`)
      return {
        audioBuffer: cached.buffer,
        plan: cached.plan,
        renderTime: performance.now() - startTime,
      }
    }
    if (cached) this.deleteCacheEntry(plan.id)

    debugLog(`[TransitionRenderer] Rendering transition with strategy: ${plan.strategy}`)

    // Route to appropriate renderer
    let audioBuffer: AudioBuffer
    if (plan.strategy === 'smart-rendered') {
      audioBuffer = await this.renderSmartTransition(plan, sourceUrl, targetUrl, onProgress)
    } else {
      // Fallback to browser crossfade if buffers are provided
      if (!sourceBuffer || !targetBuffer) {
        throw new Error('AudioBuffers required for crossfade strategy')
      }
      audioBuffer = await this.renderCrossfade(plan, sourceBuffer, targetBuffer, onProgress)
    }

    const renderTime = performance.now() - startTime
    debugLog(`[TransitionRenderer] Rendered in ${renderTime.toFixed(2)}ms`)

    // Cache the result
    this.addToCache(plan, audioBuffer)

    return { audioBuffer, plan, renderTime }
  }

  private async renderSmartTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    onProgress?: (progress: RenderProgress) => void
  ): Promise<AudioBuffer> {
    onProgress?.({ stage: 'analyzing', progress: 0.1 })

    // Step 1: Download audio files to local disk
    debugLog('[TransitionRenderer] Downloading source audio...')
    const sourceAudioPath = await window.electron!.audioDownload.prepare(
      sourceUrl,
      plan.sourceTrackKey
    )
    
    onProgress?.({ stage: 'analyzing', progress: 0.2 })
    
    debugLog('[TransitionRenderer] Downloading target audio...')
    const targetAudioPath = await window.electron!.audioDownload.prepare(
      targetUrl,
      plan.targetTrackKey
    )
    
    onProgress?.({ stage: 'stretching', progress: 0.3 })

    // Step 2: Call Python backend to render with time-stretching
    debugLog('[TransitionRenderer] Calling Python render worker...')
    const result = await window.electron!.render.transition(
      plan,
      sourceAudioPath,
      targetAudioPath
    )

    if (!result.success || !result.outputPath || result.stretchApplied !== true) {
      throw new Error(result.error || 'Render failed')
    }
    if (plan.djEffects?.enabled && result.djEffectsApplied !== true) {
      throw new Error('DJ effects were planned but not applied')
    }
    if (typeof result.targetResumeTime === 'number' && Number.isFinite(result.targetResumeTime)) {
      plan.targetEndTime = result.targetResumeTime
    }

    onProgress?.({ stage: 'finalizing', progress: 0.9 })

    // Step 3: Load the rendered audio file into AudioBuffer
    debugLog('[TransitionRenderer] Loading rendered audio from:', result.outputPath)
    const renderApi = window.electron!.render
    let arrayBuffer: ArrayBuffer
    if (renderApi.getAudioUrl) {
      try {
        const audioUrl = await renderApi.getAudioUrl(result.outputPath)
        const response = await fetch(audioUrl)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        arrayBuffer = await response.arrayBuffer()
      } catch (error) {
        // Keep the legacy IPC path as a compatibility/recovery fallback.
        debugLog('[TransitionRenderer] Streaming read failed, falling back to IPC:', error)
        arrayBuffer = await renderApi.readAudioFile(result.outputPath)
      }
    } else {
      arrayBuffer = await renderApi.readAudioFile(result.outputPath)
    }
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)

    onProgress?.({ stage: 'finalizing', progress: 1 })
    return audioBuffer
  }

  private async renderCrossfade(
    plan: TransitionPlan,
    sourceBuffer: AudioBuffer,
    targetBuffer: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void
  ): Promise<AudioBuffer> {
    onProgress?.({ stage: 'mixing', progress: 0 })

    const duration = plan.sourceEndTime - plan.sourceStartTime
    const sampleRate = sourceBuffer.sampleRate
    const samples = Math.floor(duration * sampleRate)
    const channels = Math.max(sourceBuffer.numberOfChannels, targetBuffer.numberOfChannels)

    const outputBuffer = this.audioContext.createBuffer(channels, samples, sampleRate)

    const sourceStart = Math.floor(plan.sourceStartTime * sampleRate)
    const targetStart = Math.floor(plan.targetStartTime * sampleRate)

    // Apply gain curves
    const sourceGain = plan.gainCurve.source
    const targetGain = plan.gainCurve.target
    const curveLength = sourceGain.length

    for (let ch = 0; ch < channels; ch++) {
      const output = outputBuffer.getChannelData(ch)
      const sourceData = ch < sourceBuffer.numberOfChannels ? sourceBuffer.getChannelData(ch) : null
      const targetData = ch < targetBuffer.numberOfChannels ? targetBuffer.getChannelData(ch) : null

      for (let i = 0; i < samples; i++) {
        const progress = i / samples
        const curveIndex = Math.min(curveLength - 1, Math.floor(progress * curveLength))
        const sourceGainValue = sourceGain[curveIndex]
        const targetGainValue = targetGain[curveIndex]

        const sourceSample = sourceData ? (sourceData[sourceStart + i] || 0) : 0
        const targetSample = targetData ? (targetData[targetStart + i] || 0) : 0

        output[i] = sourceSample * sourceGainValue + targetSample * targetGainValue
      }

      onProgress?.({ stage: 'mixing', progress: (ch + 1) / channels })
    }

    return outputBuffer
  }

  private getBufferBytes(buffer: AudioBuffer): number {
    return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
  }

  private deleteCacheEntry(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    this.cache.delete(key)
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes)
    return true
  }

  private evictOldestCacheEntry(): boolean {
    let oldestKey: string | null = null
    let oldestTime = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp
        oldestKey = key
      }
    }
    return oldestKey !== null && this.deleteCacheEntry(oldestKey)
  }

  private addToCache(plan: TransitionPlan, buffer: AudioBuffer): void {
    const bytes = this.getBufferBytes(buffer)
    this.deleteCacheEntry(plan.id)

    // A single unusually long transition must not pin more than the entire
    // decoded PCM budget. It can still be returned and played by the caller.
    if (bytes > this.MAX_CACHE_BYTES) return

    while (
      this.cache.size >= this.MAX_CACHE_SIZE
      || this.cacheBytes + bytes > this.MAX_CACHE_BYTES
    ) {
      if (!this.evictOldestCacheEntry()) break
    }

    this.cache.set(plan.id, {
      buffer,
      timestamp: Date.now(),
      plan,
      bytes,
    })
    this.cacheBytes += bytes
  }

  private startCacheCleanup(): void {
    this.cacheCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.timestamp + this.CACHE_TTL < now) {
          this.deleteCacheEntry(key)
        }
      }
    }, 60000) // Cleanup every minute
  }

  getRendered(planId: string): AudioBuffer | null {
    const cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      return cached.buffer
    }
    if (cached) this.deleteCacheEntry(planId)
    return null
  }

  async playTransition(planId: string, sourceCurrentTime: number): Promise<{
    targetResumeTime: number
    playbackOffset: number
    remainingDuration: number
  } | null> {
    const cached = this.cache.get(planId)
    if (!cached || cached.timestamp + this.CACHE_TTL <= Date.now()) {
      if (cached) this.deleteCacheEntry(planId)
      return null
    }

    const plan = cached.plan
    const buffer = cached.buffer

    // Transition is one-shot: remove from cache immediately to release the
    // decoded AudioBuffer as soon as the source node finishes with it.
    this.deleteCacheEntry(planId)

    // Create a buffer source to play the transition
    this.stopPlayback()
    const source = this.audioContext.createBufferSource()
    this.activeSource = source
    source.buffer = buffer
    
    // Connect through master gain if available, otherwise directly to destination
    if (this.masterGain) {
      source.connect(this.masterGain)
    } else {
      source.connect(this.audioContext.destination)
    }
    
    source.addEventListener('ended', () => {
      if (this.activeSource === source) this.activeSource = null
      // Release the buffer reference from the source node so GC can reclaim it
      source.buffer = null
      source.disconnect()
    }, { once: true })
    const playbackOffset = Math.max(0, Math.min(
      Math.max(0, sourceCurrentTime - plan.sourceStartTime),
      Math.max(0, buffer.duration - 0.05),
    ))
    source.start(0, playbackOffset)

    // The rendered audio contains both tracks mixed together:
    // - Source: from sourceStartTime to sourceEndTime
    // - Target: from targetStartTime to targetEndTime
    // After playing the rendered transition, we should resume from targetEndTime
    const targetResumeTime = plan.targetEndTime
    const remainingDuration = Math.max(0.05, buffer.duration - playbackOffset)

    debugLog(`[TransitionRenderer] Playing cached transition ${planId}`)
    debugLog(`  - Transition buffer duration: ${buffer.duration.toFixed(2)}s`)
    debugLog(`  - Late-trigger offset: ${playbackOffset.toFixed(3)}s`)
    debugLog(`  - Target was mixed from ${plan.targetStartTime.toFixed(2)}s to ${plan.targetEndTime.toFixed(2)}s`)
    debugLog(`  - Will resume target at ${targetResumeTime.toFixed(2)}s`)

    return { targetResumeTime, playbackOffset, remainingDuration }
  }

  stopPlayback(): void {
    const source = this.activeSource
    this.activeSource = null
    if (!source) return
    try {
      source.stop()
    } catch {
      // The transition buffer may already have ended.
    }
    // Drop the buffer reference before disconnecting so the decoded audio
    // can be garbage collected when a transition is cancelled or replaced.
    source.buffer = null
    source.disconnect()
  }

  clearCache(): void {
    this.cache.clear()
    this.cacheBytes = 0
  }

  getCacheSize(): number {
    return this.cache.size
  }

  dispose(): void {
    this.stopPlayback()
    if (this.cacheCleanupTimer !== null) {
      clearInterval(this.cacheCleanupTimer)
      this.cacheCleanupTimer = null
    }
    this.clearCache()
  }
}

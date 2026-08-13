import { useEffect, useRef, useSyncExternalStore } from 'react'

export interface AudioAnalyzerData {
  bass: number
  mid: number
  high: number
  overall: number
  beat: number
  accent: number
  flux: number
}

export interface AudioAnalyzerStore {
  getSnapshot: () => AudioAnalyzerData
  subscribe: (listener: () => void) => () => void
}

const EMPTY_ANALYSIS: AudioAnalyzerData = Object.freeze({
  bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
})
const clamp = (value: number) => Math.min(1, Math.max(0, value))
const logCompress = (value: number, amount = 6) => Math.log1p(amount * clamp(value)) / Math.log1p(amount)

function createAnalyzerStore(): AudioAnalyzerStore & { publish: (value: AudioAnalyzerData) => void } {
  let snapshot = EMPTY_ANALYSIS
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: value => {
      snapshot = value
      listeners.forEach(listener => listener())
    },
  }
}

/**
 * Samples the playback analyser without putting the 30 FPS stream in the parent
 * React state. Only visual components that explicitly subscribe are reconciled.
 */
export function useAudioAnalyzer(analyser: AnalyserNode | null, enabled = true): AudioAnalyzerStore {
  const storeRef = useRef<ReturnType<typeof createAnalyzerStore> | null>(null)
  if (!storeRef.current) storeRef.current = createAnalyzerStore()

  useEffect(() => {
    const store = storeRef.current!
    if (!enabled || !analyser) {
      if (store.getSnapshot() !== EMPTY_ANALYSIS) store.publish(EMPTY_ANALYSIS)
      return
    }

    const data = new Uint8Array(analyser.frequencyBinCount)
    const updateInterval = 1000 / 30
    let animationFrame = 0
    let lastUpdateTime = 0
    let disposed = false
    let bassBaseline = 0
    let overallBaseline = 0
    let beatPulse = 0
    let accentPulse = 0
    let lastBeatTime = -1000
    let lastAccentTime = -1000
    let analyzedFrames = 0
    let previousBass = 0
    let previousOverall = 0
    let fluxBaseline = 0
    const previousSpectrum = new Float32Array(data.length)

    const measureBand = (minimumFrequency: number, maximumFrequency: number) => {
      const nyquist = analyser.context.sampleRate / 2
      const start = Math.max(1, Math.floor(minimumFrequency / nyquist * data.length))
      const end = Math.min(data.length, Math.max(start + 1, Math.ceil(maximumFrequency / nyquist * data.length)))
      let sum = 0
      let squares = 0
      let peak = 0
      for (let index = start; index < end; index += 1) {
        const value = data[index] / 255
        sum += value
        squares += value * value
        peak = Math.max(peak, value)
      }
      const count = Math.max(1, end - start)
      return (sum / count) * 0.42 + Math.sqrt(squares / count) * 0.43 + peak * 0.15
    }

    const analyze = (now: number) => {
      if (disposed) return
      if (now - lastUpdateTime >= updateInterval) {
        lastUpdateTime = now
        analyser.getByteFrequencyData(data)

        const rawBass = measureBand(45, 190)
        const rawMid = measureBand(190, 2600)
        const rawHigh = measureBand(2600, 12000)
        const rawOverall = rawBass * 0.38 + rawMid * 0.42 + rawHigh * 0.2
        const nyquist = analyser.context.sampleRate / 2
        const fluxStart = Math.max(1, Math.floor(45 / nyquist * data.length))
        const fluxEnd = Math.min(data.length, Math.ceil(10000 / nyquist * data.length))
        let positiveFlux = 0
        for (let index = fluxStart; index < fluxEnd; index += 1) {
          const magnitude = data[index] / 255
          positiveFlux += Math.max(0, magnitude - previousSpectrum[index])
          previousSpectrum[index] = magnitude
        }
        const rawFlux = positiveFlux / Math.max(1, fluxEnd - fluxStart)

        if (analyzedFrames === 0) {
          bassBaseline = rawBass
          overallBaseline = rawOverall
        }
        const bassDelta = Math.max(0, rawBass - bassBaseline)
        const overallDelta = Math.max(0, rawOverall - overallBaseline)
        const bassOnset = Math.max(0, rawBass - previousBass)
        const overallOnset = Math.max(0, rawOverall - previousOverall)
        const fluxOnset = Math.max(0, rawFlux - fluxBaseline)
        const beatThreshold = 0.022 + bassBaseline * 0.09
        const accentThreshold = 0.018 + overallBaseline * 0.075
        const beatDetected = analyzedFrames > 5
          && (bassDelta > beatThreshold || bassOnset > 0.035)
          && now - lastBeatTime > 115
        const accentDetected = analyzedFrames > 5
          && (overallDelta > accentThreshold || overallOnset > 0.025 || fluxOnset > 0.008
            || (rawMid - overallBaseline) > accentThreshold * 1.45)
          && now - lastAccentTime > 90

        if (beatDetected) {
          const onsetStrength = Math.max(bassDelta, bassOnset * 1.65)
          beatPulse = Math.max(beatPulse, Math.min(1, 0.42 + onsetStrength / Math.max(0.065, beatThreshold * 1.8)))
          lastBeatTime = now
        } else beatPulse *= 0.72

        if (accentDetected) {
          const onsetStrength = Math.max(overallDelta, overallOnset * 1.7, fluxOnset * 5.5)
          accentPulse = Math.max(accentPulse, Math.min(1, 0.34 + onsetStrength / Math.max(0.055, accentThreshold * 1.9)))
          lastAccentTime = now
        } else accentPulse *= 0.78

        bassBaseline += (rawBass - bassBaseline) * (rawBass > bassBaseline ? 0.035 : 0.012)
        overallBaseline += (rawOverall - overallBaseline) * (rawOverall > overallBaseline ? 0.04 : 0.014)
        fluxBaseline += (rawFlux - fluxBaseline) * (rawFlux > fluxBaseline ? 0.05 : 0.018)
        previousBass = rawBass
        previousOverall = rawOverall
        analyzedFrames += 1

        store.publish({
          bass: logCompress(rawBass * 1.14),
          mid: logCompress(rawMid * 1.08),
          high: logCompress(rawHigh * 1.12),
          overall: logCompress(rawOverall * 1.1),
          beat: beatPulse,
          accent: accentPulse,
          flux: logCompress(fluxOnset * 12, 4),
        })
      }
      animationFrame = requestAnimationFrame(analyze)
    }

    animationFrame = requestAnimationFrame(analyze)
    return () => {
      disposed = true
      cancelAnimationFrame(animationFrame)
      store.publish(EMPTY_ANALYSIS)
    }
  }, [analyser, enabled])

  return storeRef.current
}

export function useAudioAnalyzerSnapshot(store: AudioAnalyzerStore): AudioAnalyzerData {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

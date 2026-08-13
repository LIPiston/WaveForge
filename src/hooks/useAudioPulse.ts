import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AudioAnalyzerStore } from './useAudioAnalyzer'

export type AudioPulseMode = 'dynamic' | 'soft' | 'restless'

export interface AudioPulseSnapshot {
  scale: number
  brightness: number
  saturation: number
  restless: number
}

export interface AudioPulseStore {
  getSnapshot: () => AudioPulseSnapshot
  subscribe: (listener: () => void) => () => void
}

const EMPTY_PULSE: AudioPulseSnapshot = Object.freeze({ scale: 0, brightness: 0, saturation: 0, restless: 0 })
export const EMPTY_AUDIO_PULSE_STORE: AudioPulseStore = Object.freeze({
  getSnapshot: () => EMPTY_PULSE,
  subscribe: () => () => undefined,
})

function createPulseStore(): AudioPulseStore & { publish: (snapshot: AudioPulseSnapshot) => void } {
  let snapshot = EMPTY_PULSE
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: next => {
      snapshot = next
      listeners.forEach(listener => listener())
    },
  }
}

/**
 * Builds the original cover pulse envelope in a small external store. The rAF
 * continues to drive the same visual cadence, but no longer reconciles App.tsx.
 */
export function useAudioPulseStore(
  analyzer: AudioAnalyzerStore,
  active: boolean,
  mode: AudioPulseMode,
): AudioPulseStore {
  const storeRef = useRef<ReturnType<typeof createPulseStore> | null>(null)
  if (!storeRef.current) storeRef.current = createPulseStore()

  const envelopeRef = useRef({
    displayedValue: 0,
    amplitudeEnvelope: 0,
    phase: 0,
    previousOnset: 0,
    punchValue: 0,
    punchTarget: 0,
    punchAge: Number.POSITIVE_INFINITY,
    previousBeat: 0,
    strongTriggerTime: -1,
    strongAmplitude: 0,
  })

  useEffect(() => {
    const store = storeRef.current!
    const envelope = envelopeRef.current
    let frame = 0
    let previousTime = performance.now()
    let disposed = false

    const update = (now: number) => {
      if (disposed) return
      const delta = Math.min(50, Math.max(1, now - previousTime))
      previousTime = now
      const analysis = analyzer.getSnapshot()
      const beatEnergy = active ? analysis.beat : 0
      const accentEnergy = active ? analysis.accent : 0
      const overallCurve = Math.pow(Math.max(0, Math.min(1, analysis.overall)), 0.58)
      const bassCurve = Math.pow(Math.max(0, Math.min(1, analysis.bass)), 0.62)
      const midCurve = Math.pow(Math.max(0, Math.min(1, analysis.mid)), 0.66)
      const highCurve = Math.pow(Math.max(0, Math.min(1, analysis.high)), 0.7)
      const continuousEnergy = overallCurve * 0.58 + bassCurve * 0.22 + midCurve * 0.14 + highCurve * 0.06
      const originalContinuous = Math.min(0.14, continuousEnergy * 0.14)
      const originalOnset = Math.min(0.11, beatEnergy * 0.075 + accentEnergy * 0.035)
      const currentTarget = !active
        ? 0
        : mode === 'soft'
          ? Math.min(0.15, continuousEnergy * 0.155)
          : mode === 'restless'
            ? originalContinuous
            : originalContinuous * 0.95
      const currentOnset = !active
        ? 0
        : mode === 'soft'
          ? Math.min(0.028, beatEnergy * 0.018 + accentEnergy * 0.01)
          : mode === 'restless'
            ? originalOnset
            : originalOnset * 0.95

      const isRising = currentTarget > envelope.amplitudeEnvelope
      const attackTime = mode === 'soft' ? 420 : mode === 'restless' ? 180 : 240
      const releaseTime = mode === 'soft' ? 920 : mode === 'restless' ? 470 : 650
      const amplitudeBlend = 1 - Math.exp(-delta / (isRising ? attackTime : releaseTime))
      envelope.amplitudeEnvelope += (currentTarget - envelope.amplitudeEnvelope) * amplitudeBlend
      if (envelope.amplitudeEnvelope < 0.0001) envelope.amplitudeEnvelope = 0

      const duration = mode === 'soft' ? 5600 : mode === 'restless' ? 4200 : 4800
      envelope.phase = (envelope.phase + delta / duration) % 1
      const breathWave = 0.5 - 0.5 * Math.cos(envelope.phase * Math.PI * 2)
      const baseMotion = envelope.amplitudeEnvelope * (0.34 + breathWave * 0.34)

      const onsetRise = currentOnset - envelope.previousOnset
      if (currentOnset > 0.012 && onsetRise > 0.007) {
        envelope.punchTarget = Math.max(envelope.punchValue, currentOnset)
        envelope.punchAge = 0
      }
      envelope.previousOnset = currentOnset

      const punchAttack = mode === 'soft' ? 90 : mode === 'restless' ? 32 : 46
      const punchDecay = mode === 'soft' ? 560 : mode === 'restless' ? 245 : 390
      envelope.punchAge += delta
      if (envelope.punchAge <= punchAttack * 1.8) {
        envelope.punchValue += (envelope.punchTarget - envelope.punchValue) * (1 - Math.exp(-delta / punchAttack))
      } else {
        envelope.punchValue *= Math.exp(-delta / punchDecay)
        envelope.punchTarget *= Math.exp(-delta / punchDecay)
      }
      if (!active) {
        envelope.punchValue *= Math.exp(-delta / 120)
        envelope.punchTarget = 0
      }
      if (envelope.punchValue < 0.0001) envelope.punchValue = 0
      envelope.displayedValue = baseMotion + envelope.punchValue

      const strongThreshold = 0.86
      if (mode === 'restless' && active && beatEnergy >= strongThreshold && envelope.previousBeat < strongThreshold) {
        envelope.strongTriggerTime = now
        envelope.strongAmplitude = Math.min(1, 0.72 + (beatEnergy - strongThreshold) / (1 - strongThreshold) * 0.28)
      }
      envelope.previousBeat = beatEnergy
      let restless = 0
      if (envelope.strongTriggerTime >= 0) {
        const progress = Math.min(1, Math.max(0, (now - envelope.strongTriggerTime) / 340))
        const attackRatio = 0.22
        const curve = progress < attackRatio
          ? 0.5 - 0.5 * Math.cos(Math.PI * progress / attackRatio)
          : 0.5 + 0.5 * Math.cos(Math.PI * (progress - attackRatio) / (1 - attackRatio))
        restless = envelope.strongAmplitude * curve
        if (progress >= 1) {
          envelope.strongTriggerTime = -1
          envelope.strongAmplitude = 0
        }
      }

      const scale = active || envelope.displayedValue > 0.00008 ? envelope.displayedValue : 0
      const next = {
        scale,
        brightness: scale * (mode === 'restless' ? 1.05 : mode === 'dynamic' ? 0.78 : 0.62),
        saturation: scale * (mode === 'restless' ? 1.7 : mode === 'dynamic' ? 1.25 : 0.95),
        restless: mode === 'restless' ? restless : 0,
      }
      const previous = store.getSnapshot()
      if (
        Math.abs(previous.scale - next.scale) > 0.00008
        || Math.abs(previous.restless - next.restless) > 0.0001
        || (next.scale === 0 && previous.scale !== 0)
      ) store.publish(next)

      if (active || next.scale > 0 || envelope.strongTriggerTime >= 0) frame = requestAnimationFrame(update)
      else if (store.getSnapshot() !== EMPTY_PULSE) store.publish(EMPTY_PULSE)
    }

    frame = requestAnimationFrame(update)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      if (!active) store.publish(EMPTY_PULSE)
    }
  }, [analyzer, active, mode])

  return storeRef.current
}

export function useAudioPulseSnapshot(store: AudioPulseStore): AudioPulseSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}


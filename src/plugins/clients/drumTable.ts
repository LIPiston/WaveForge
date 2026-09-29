/**
 * 本地鼓点事件表 → DG-LAB（郊狼）驱动适配器。
 *
 * 数据来源：automix-lab 的 `automix_lab/haptic_events.py`（离线生成，等价于 QQ音乐
 * 「4D震动」云端下发的那张表：`MHOnSetItem{time,type,amplitude}`）。本模块把这张表
 * 变成两类可直接下发的东西：
 *
 *   1. `eventsToWaveFrames()` → 波形帧 [{freq,strength}]，喂 `client.sendWaveFrames()`
 *      （自定义波形，每帧一段脉动频率 + 强度）；
 *   2. `createDrumTablePlayer()` → 按 30fps 把事件表合成为**现有特征流**
 *      （DGLabAudioFrame：kick/mid/hats/flux/left/right…）并 `pushAudio()`，
 *      这样现成的 7 种体感风格（敲击/心跳/立体声…）会跟着鼓点动，无需改中继协议。
 *
 * 类型映射（与 Python 侧 DGLAB_TYPE_PARAMS 保持一致）：
 *   kick  → A 通道，低频大强度；snare → B 通道，中频中强度；hihat → A 通道，高频小强度。
 */

import type { DGLabAudioFrame } from './DGLabClient'

export type DrumEventType = 'kick' | 'snare' | 'hihat' | 'custom'

export interface DrumEvent {
  time: number
  type: DrumEventType
  amplitude: number
}

export interface DrumWaveFrame {
  freq: number
  strength: number
}

/** 与 Python 侧 DGLAB_TYPE_PARAMS 对齐（freq 0-255、strength 0-200）。 */
const TYPE_PARAMS: Record<DrumEventType, { freq: number; strength: number; decayFrames: number; channel: 'A' | 'B' }> = {
  kick: { freq: 12, strength: 200, decayFrames: 3, channel: 'A' },
  snare: { freq: 38, strength: 145, decayFrames: 2, channel: 'B' },
  hihat: { freq: 96, strength: 78, decayFrames: 1, channel: 'A' },
  custom: { freq: 60, strength: 110, decayFrames: 2, channel: 'B' },
}

const STRENGTH_MAX = 200
const FREQ_MAX = 255

function coerceType(v: unknown): DrumEventType {
  const s = String(v ?? '').toLowerCase()
  if (s === 'kick' || s === 'snare' || s === 'hihat') return s
  // 官方 typeString 里还有 tom / percussion / rain，无对应鼓件时归 custom
  return 'custom'
}

/**
 * 解析事件表 JSON。兼容三种形状：
 *   · automix-lab 输出的 QQ 兼容形状 {MHTracksInfo:[{jsonString}]}
 *   · {events:[...]} / {MHOnSetItems:[...]}
 *   · 裸数组 [{time,type,amplitude}]
 */
export function parseDrumTable(input: unknown): DrumEvent[] {
  const collect = (arr: unknown[]): DrumEvent[] =>
    arr
      .map((raw) => {
        const o = raw as Record<string, unknown>
        const time = Number(o?.time)
        const amplitude = Number(o?.amplitude)
        if (!Number.isFinite(time)) return null
        return {
          time,
          type: coerceType(o?.type ?? o?.typeString),
          amplitude: Number.isFinite(amplitude) ? Math.min(1, Math.max(0, amplitude)) : 0.5,
        } as DrumEvent
      })
      .filter((e): e is DrumEvent => e !== null)
      .sort((a, b) => a.time - b.time)

  if (Array.isArray(input)) return collect(input)
  const root = input as Record<string, unknown> | null
  if (!root || typeof root !== 'object') return []

  const tracks = root.MHTracksInfo
  if (Array.isArray(tracks) && tracks.length > 0) {
    const first = tracks[0] as Record<string, unknown>
    const inner = first?.jsonString
    if (typeof inner === 'string') {
      try {
        const parsed = JSON.parse(inner) as Record<string, unknown>
        const items = (parsed.MHOnSetItems ?? parsed.events) as unknown
        if (Array.isArray(items)) return collect(items)
      } catch {
        /* 落到下面的通用分支 */
      }
    }
  }
  for (const key of ['MHOnSetItems', 'events'] as const) {
    const arr = root[key]
    if (Array.isArray(arr)) return collect(arr)
  }
  return []
}

/** 事件表 → 波形帧序列（A/B 分通道；喂 client.sendWaveFrames 用单通道时取 A）。 */
export function eventsToWaveFrames(
  events: DrumEvent[],
  durationS: number,
  frameMs = 100,
): { frameMs: number; A: DrumWaveFrame[]; B: DrumWaveFrame[] } {
  const step = Math.max(1, Math.round(frameMs))
  const n = Math.max(1, Math.ceil((durationS * 1000) / step))
  const freq: Record<'A' | 'B', number[]> = { A: new Array(n).fill(0), B: new Array(n).fill(0) }
  const strength: Record<'A' | 'B', number[]> = { A: new Array(n).fill(0), B: new Array(n).fill(0) }

  for (const ev of events) {
    const p = TYPE_PARAMS[ev.type] ?? TYPE_PARAMS.custom
    const f0 = Math.round((ev.time * 1000) / step)
    const amp = Math.min(1, Math.max(0, ev.amplitude))
    for (let k = 0; k <= p.decayFrames; k++) {
      const idx = f0 + k
      if (idx < 0 || idx >= n) continue
      const val = Math.round(p.strength * amp * 0.5 ** k)
      if (val >= strength[p.channel][idx]) {
        strength[p.channel][idx] = Math.min(STRENGTH_MAX, val)
        freq[p.channel][idx] = Math.min(FREQ_MAX, p.freq)
      }
    }
  }
  const toFrames = (c: 'A' | 'B'): DrumWaveFrame[] =>
    Array.from({ length: n }, (_, i) => ({ freq: freq[c][i], strength: strength[c][i] }))
  return { frameMs: step, A: toFrames('A'), B: toFrames('B') }
}

/** 事件表 → 30fps 特征流（形状与 DGLabAudioFrame 一致，值域 [0,1]）。 */
export function drumEventsToAudioFrames(
  events: DrumEvent[],
  durationS: number,
  fps = 30,
  decayS = 0.18,
): DGLabAudioFrame[] {
  const step = 1 / Math.max(1, fps)
  const n = Math.max(1, Math.ceil(durationS / step))
  const kick = new Float32Array(n)
  const mid = new Float32Array(n)
  const hats = new Float32Array(n)

  for (const ev of events) {
    const i0 = Math.round(ev.time / step)
    const amp = Math.min(1, Math.max(0, ev.amplitude))
    const decayFrames = Math.max(1, Math.round(decayS / step))
    for (let k = 0; k < decayFrames; k++) {
      const idx = i0 + k
      if (idx < 0 || idx >= n) continue
      const v = amp * 0.5 ** (k / Math.max(1, decayFrames / 3))
      if (ev.type === 'kick') kick[idx] = Math.max(kick[idx], v)
      else if (ev.type === 'snare') mid[idx] = Math.max(mid[idx], 0.85 * v)
      else if (ev.type === 'hihat') hats[idx] = Math.max(hats[idx], 0.6 * v)
      else mid[idx] = Math.max(mid[idx], 0.5 * v)
    }
  }

  const out: DGLabAudioFrame[] = []
  for (let i = 0; i < n; i++) {
    const overall = Math.min(1, 0.5 * kick[i] + 0.35 * mid[i] + 0.25 * hats[i])
    const flux = i > 0 ? Math.max(0, Math.min(1, (kick[i] + mid[i] + hats[i]) * 4)) : 0
    out.push({
      kick: kick[i],
      bass: kick[i],
      mid: mid[i],
      lead: 0.7 * mid[i],
      hats: hats[i],
      high: hats[i],
      overall,
      beat: kick[i] > 0.5 ? 1 : 0,
      accent: kick[i],
      flux,
      left: { bass: kick[i], mid: mid[i], high: hats[i], overall },
      right: { bass: 0.6 * kick[i], mid: mid[i], high: hats[i], overall },
    })
  }
  return out
}

export interface DrumTablePlayer {
  start(): void
  stop(): void
  readonly playing: boolean
}

/**
 * 把事件表按实时节奏推给客户端（走现有 pushAudio 特征流，风格照旧生效）。
 * 仅依赖注入进来的 pushAudio，不直接耦合 client 单例，便于测试。
 */
export function createDrumTablePlayer(
  pushAudio: (frame: DGLabAudioFrame) => void,
  events: DrumEvent[],
  durationS: number,
  opts: { fps?: number; loop?: boolean } = {},
): DrumTablePlayer {
  const fps = Math.max(1, opts.fps ?? 30)
  const frames = drumEventsToAudioFrames(events, durationS, fps)
  let timer: number | null = null
  let idx = 0
  return {
    get playing() {
      return timer !== null
    },
    start() {
      if (timer !== null) return
      timer = window.setInterval(() => {
        if (idx >= frames.length) {
          if (opts.loop) idx = 0
          else {
            this.stop()
            return
          }
        }
        pushAudio(frames[idx])
        idx += 1
      }, 1000 / fps)
    },
    stop() {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    },
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransitionRenderer } from '../src/audio/TransitionRenderer.ts'
import type { TransitionPlan } from '../src/audio/types'

/**
 * 交接（handoff）连续性契约：
 *
 * 旧实现里「无 overlap」的渲染过渡（QQ Enhanced / 旧版智能渲染）在缓冲**结束之后**
 * 才 seek + play 目标 deck —— 中间是一路静音（seek ≤400ms + 等待可播 ≤3000ms），
 * 用户听感就是"过渡播完那一下像跳过去"。
 *
 * 现在两端都走"提前起播 + 交叉窗口"：
 *   - 渲染器保证缓冲尾段渐出（handoffFadeSeconds），并把缓冲结束时刻（AudioContext 时钟，
 *     bufferEndCtxTime）返回给调用方；
 *   - 播放引擎把目标 deck 的增益渐入**锚在同一条时钟上**（不再依赖 play() 返回时机）。
 *
 * 这里锁定渲染器侧的契约：尾段渐出曲线的锚点、默认关闭（不传就不加 gain 节点）、
 * overlap 曲线保持原样（AI 长混音的速度同步窗口）。
 */

function makeFakeAudioBuffer(length: number, channels = 2, sampleRate = 44100) {
  return {
    length,
    numberOfChannels: channels,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  } as unknown as AudioBuffer
}

function makePlan(id: string): TransitionPlan {
  return {
    id,
    sourceTrackKey: 'src',
    targetTrackKey: 'tgt',
    sourceStartTime: 0,
    sourceEndTime: 20,
    targetStartTime: 0,
    targetEndTime: 20,
    beatCount: 16,
    sourceBpm: 120,
    targetBpm: 120,
    tempoRamp: [],
    sourceDownbeatIndex: 0,
    targetDownbeatIndex: 0,
    gainCurve: { source: [], target: [] },
    confidence: 0.9,
    strategy: 'smart-rendered-qq',
    analysisVersion: 'v1',
    rendererVersion: 'qq-automix-extreme-r1',
  }
}

function makeFakeContext() {
  const gains: Array<{
    gain: {
      value: number
      setValueAtTime: ReturnType<typeof vi.fn>
      linearRampToValueAtTime: ReturnType<typeof vi.fn>
      cancelScheduledValues: ReturnType<typeof vi.fn>
    }
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }> = []
  const sources: Array<Record<string, unknown>> = []
  const context = {
    gains,
    sources,
    destination: {},
    currentTime: 0,
    createBuffer: () => makeFakeAudioBuffer(44100),
    createGain: () => {
      const gain = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.push(gain)
      return gain
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        stop: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(),
        start: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      sources.push(source)
      return source
    },
  }
  return context
}

describe('渲染过渡交接（handoff）契约', () => {
  let context: ReturnType<typeof makeFakeContext>
  let renderer: TransitionRenderer

  beforeEach(() => {
    context = makeFakeContext()
    renderer = new TransitionRenderer(context as unknown as AudioContext)
  })

  afterEach(() => {
    renderer.dispose()
  })

  const cache = (id: string, seconds: number) => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan(id), makeFakeAudioBuffer(Math.round(44100 * seconds)))
  }

  it('无 overlap：按 handoffFadeSeconds 在缓冲尾段渐出，并回传缓冲结束的 AudioContext 时刻', async () => {
    cache('hf-1', 20)
    const result = await renderer.playTransition('hf-1', 0, () => {}, { handoffFadeSeconds: 0.35 })
    expect(result).not.toBeNull()
    expect(result!.overlap).toBe(0)
    expect(result!.handoffFadeSeconds).toBeCloseTo(0.35, 5)
    // 缓冲 20s、起点 ctx=0 → 结束时刻 20s
    expect(result!.bufferEndCtxTime).toBeCloseTo(20, 5)
    // 只创建一个 gain（过渡缓冲总线）
    expect(context.gains).toHaveLength(1)
    const gain = context.gains[0].gain
    // 头段满增益 → 尾段 0.35s 渐出 → 缓冲结束归零
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 0)
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 20 - 0.35)
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.0001, 20)
  })

  it('尾段渐出窗口不超过缓冲的 20%（短缓冲时的钳制）', async () => {
    cache('hf-short', 1)
    const result = await renderer.playTransition('hf-short', 0, () => {}, { handoffFadeSeconds: 0.35 })
    expect(result!.handoffFadeSeconds).toBeCloseTo(0.2, 5)
    expect(result!.bufferEndCtxTime).toBeCloseTo(1, 5)
  })

  it('overlap 路径（AI 长混音）曲线保持原样：同速期 → 减速窗口 0.12 → 收尾静音', async () => {
    cache('hf-overlap', 20)
    const result = await renderer.playTransition('hf-overlap', 0, () => {}, { overlap: 5 })
    expect(result!.overlap).toBeCloseTo(5, 5)
    expect(result!.handoffFadeSeconds).toBeCloseTo(5, 5)
    const gain = context.gains[0].gain
    // 入场 400ms 渐入
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 0.4)
    // 减速窗口起点压到 0.12（避免变速期二重奏）
    const rampToTwelve = gain.linearRampToValueAtTime.mock.calls.find(call => call[0] === 0.12)
    expect(rampToTwelve).toBeTruthy()
    // 收尾归零
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.0001, 20)
  })

  it('未传 handoffFadeSeconds 且无 overlap：不插入 gain 节点（老调用方行为不变）', async () => {
    cache('hf-none', 20)
    const result = await renderer.playTransition('hf-none', 0, () => {})
    expect(result!.handoffFadeSeconds).toBe(0)
    expect(context.gains).toHaveLength(0)
  })
})

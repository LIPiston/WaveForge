import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransitionRenderer } from '../src/audio/TransitionRenderer.ts'
import type { TransitionPlan } from '../src/audio/types'

/**
 * TransitionRenderer 内存安全契约测试：
 * - 渲染产物缓存有硬上限（条目数 / 总字节 / TTL）
 * - 超限按最旧逐出，字节计数同步扣减
 * - 播放即删（one-shot）：playTransition 取出后立即释放缓存引用
 * - 取消/替换路径 stopPlayback 显式释放 buffer 引用
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

function makePlan(id: string, bytes: number): TransitionPlan {
  // bytes 仅用于估算；此处构造一个最小的合法 plan
  void bytes
  return {
    id,
    sourceTrackKey: 'src',
    targetTrackKey: 'tgt',
    sourceStartTime: 0,
    sourceEndTime: 10,
    targetStartTime: 0,
    targetEndTime: 10,
    beatCount: 16,
    sourceBpm: 120,
    targetBpm: 120,
    tempoRamp: [],
    sourceDownbeatIndex: 0,
    targetDownbeatIndex: 0,
    gainCurve: { source: [], target: [] },
    confidence: 0.9,
    strategy: 'smart-rendered-v2',
    analysisVersion: 'v1',
    rendererVersion: 'automix-v2-dsp-r1',
  }
}

function makeFakeContext() {
  const sources = new Set<{
    buffer: AudioBuffer | null
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }>()
  return {
    sources,
    destination: {},
    currentTime: 0,
    createBuffer: () => makeFakeAudioBuffer(44100),
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
      sources.add(source)
      return source
    },
  } as unknown as AudioContext
}

describe('TransitionRenderer 渲染产物缓存内存安全', () => {
  let context: ReturnType<typeof makeFakeContext>
  let renderer: TransitionRenderer
  let clock: ReturnType<typeof vi.useFakeTimers>

  beforeEach(() => {
    clock = vi.useFakeTimers()
    context = makeFakeContext()
    renderer = new TransitionRenderer(context as unknown as AudioContext)
  })

  afterEach(() => {
    renderer.dispose()
    vi.useRealTimers()
  })

  it('缓存条目数上限（10）：超限逐出最旧，字节计数同步', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void; getCacheSize: () => number }
    for (let i = 0; i < 12; i += 1) {
      const buffer = makeFakeAudioBuffer(44100) // 1s stereo ≈ 352KB
      rendererAny.addToCache(makePlan(`plan-${i}`, 0), buffer)
    }
    expect(renderer.getCacheSize()).toBe(10)
    // 最旧的 2 条（plan-0、plan-1）已被逐出
    expect(renderer.getRendered('plan-0')).toBeNull()
    expect(renderer.getRendered('plan-1')).toBeNull()
    expect(renderer.getRendered('plan-11')).not.toBeNull()
  })

  it('缓存总字节上限（128MB）：单条超限不缓存，累计超限逐出', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    // 每条 40MB 立体声 buffer（~8 分钟时长等价）
    const big = makeFakeAudioBuffer(40 * 1024 * 1024 / 2 / 4, 2, 44100)
    rendererAny.addToCache(makePlan('huge-1', 0), big)
    rendererAny.addToCache(makePlan('huge-2', 0), big)
    rendererAny.addToCache(makePlan('huge-3', 0), big)
    rendererAny.addToCache(makePlan('huge-4', 0), big)
    // 3 条 = 120MB < 128MB；第 4 条加入前逐出最旧
    expect(renderer.getCacheSize()).toBe(3)
    expect(renderer.getRendered('huge-1')).toBeNull()
  })

  it('TTL 5 分钟到期后自动清理', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('ttl-plan', 0), makeFakeAudioBuffer(44100))
    expect(renderer.getRendered('ttl-plan')).not.toBeNull()
    vi.advanceTimersByTime(6 * 60 * 1000)
    expect(renderer.getRendered('ttl-plan')).toBeNull()
  })

  it('playTransition 一次性消费：取出后缓存立即删除，buffer 引用释放', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    const buffer = makeFakeAudioBuffer(44100)
    rendererAny.addToCache(makePlan('one-shot', 0), buffer)
    expect(renderer.getRendered('one-shot')).not.toBeNull()

    const result = await renderer.playTransition('one-shot', 0)
    expect(result).not.toBeNull()
    // 播放后缓存条目已删除，buffer 不再被缓存引用
    expect(renderer.getRendered('one-shot')).toBeNull()
    // 活跃 source 持有 buffer 引用；stopPlayback 时释放
    const source = [...context.sources][0]
    expect(source).toBeDefined()
    expect(source.buffer).not.toBeNull()
    renderer.stopPlayback()
    expect(source.buffer).toBeNull()
    expect(source.disconnect).toHaveBeenCalled()
  })

  it('clearCache / dispose 释放全部缓存与活跃播放', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('a', 0), makeFakeAudioBuffer(44100))
    rendererAny.addToCache(makePlan('b', 0), makeFakeAudioBuffer(44100))
    expect(renderer.getCacheSize()).toBe(2)
    renderer.dispose()
    expect(renderer.getCacheSize()).toBe(0)
  })
})

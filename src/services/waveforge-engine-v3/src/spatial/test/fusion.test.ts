/**
 * 空间音频融合层 / 持久化单元测试
 *
 * 覆盖：patch 嵌套深合并、store restore 容错（坏 JSON / 缺字段）、
 * instantSpeakers 边界钳位、spatialConfigFromParams 推导、订阅通知、
 * createExportBackend 冒烟（生成模块 + 网格管线）、内存 storage mock 往返、
 * resampleGrid（采样率不匹配重采样：长度换算/确定性/原样返回）、
 * restoreHrtfDataset（跨重启恢复：无记录 false / localStorage+hrtfStore mock 正路径 /
 * 清除活动记录 / 不匹配 false）、
 * 输出设备选择（listOutputDevices 枚举/降级、setOutputDevice 持久化 + setSinkId 应用、
 * applySinkId attach 恢复）。
 * 注：fusion 模块状态为模块级，beforeEach 重置为默认参数隔离用例。
 * hrtfStore 部分 mock（getLatestDataset → vi.fn()）：Node 环境无 IndexedDB，
 * 恢复流程用 mock 注入；saveHrtfDataset 保持真实（Node 下 reject，被 fire-and-forget 吞掉）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getSpatialParams,
  setSpatialParams,
  patchSpatialParams,
  subscribeSpatialParams,
  isSpatialActive,
  getSpatialStats,
  estimateCpuPercent,
  spatialConfigFromParams,
  createExportBackend,
  setHrtfDataset,
  resampleGrid,
  restoreHrtfDataset,
  HRTF_ACTIVE_DATASET_KEY,
  multichannelLayout,
  syncSpatialChain,
  listOutputDevices,
  setOutputDevice,
  applySinkId,
  setBuiltinDataset,
  getBuiltinDataset,
  BUILTIN_HRTF_DATASET_KEY,
} from '../fusion'
import { createSpatialStore, SPATIAL_PARAMS_KEY } from '../persistence'
import { createDefaultSpatialParams, instantSpeakers } from '../types'
import { createLayoutSpeakers } from '../layouts'
import { STAGE_SCENES } from '../scenes'
import { rotateListener, moveListener } from '../controller'
import { getLatestDataset } from '../hrtfStore'
import { BUILTIN_HRTF_DATASETS } from '../data/datasets'
import type { HrtfGrid, SpatialParams } from '../types'

// hrtfStore 部分 mock：restoreHrtfDataset 的 getLatestDataset 注入（Node 无 IndexedDB）；
// 其余函数保持真实实现（setHrtfDataset 的 saveHrtfDataset 在 Node 下 reject，被吞掉）
vi.mock('../hrtfStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hrtfStore')>()
  return { ...actual, getLatestDataset: vi.fn() }
})

// SpatialNode mock（多声道输出节点重建路径测试）：记录实例的 outputChannels /
// onStats（供 stats 注入 inputChannels）/ postConfig / node 连接桩。
// 既有测试不依赖真实 SpatialNode（AudioWorklet 在 Node 环境不可用），mock 全文件生效。
const { mockSpatial } = vi.hoisted(() => {
  interface MockSpatialNodeInstance {
    outputChannels: number
    onStats: ((s: { latencySamples: number; backend: string; inputChannels?: number }) => void) | null
    postConfig: ReturnType<typeof vi.fn>
    postGrid: ReturnType<typeof vi.fn>
    node: {
      disconnect: ReturnType<typeof vi.fn>
      connect: ReturnType<typeof vi.fn>
      port: { postMessage: ReturnType<typeof vi.fn> }
    }
  }
  return { mockSpatial: { instances: [] as MockSpatialNodeInstance[] } }
})

vi.mock('../SpatialNode', () => {
  class MockSpatialNode {
    static register = vi.fn(async () => true)
    node = { disconnect: vi.fn(), connect: vi.fn(), port: { postMessage: vi.fn() } }
    onStats: ((s: { latencySamples: number; backend: string; inputChannels?: number }) => void) | null = null
    outputChannels: number
    postConfig = vi.fn()
    postGrid = vi.fn()
    constructor(_ctx: AudioContext, outputChannels = 2) {
      this.outputChannels = outputChannels
      mockSpatial.instances.push(this)
    }
  }
  return { SpatialNode: MockSpatialNode }
})

/** 多声道节点重建测试的音频图桩（Node 环境无 AudioWorklet，需声明全局符号） */
function audioGraphStub(): {
  ctx: AudioContext
  analyser: AnalyserNode
  v3: { disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }
} {
  ;(globalThis as Record<string, unknown>).AudioWorkletNode = class AudioWorkletNode {}
  const ctx = { sampleRate: 48000, audioWorklet: {} } as unknown as AudioContext
  const analyser = {} as AnalyserNode
  const v3 = { disconnect: vi.fn(), connect: vi.fn() }
  return { ctx, analyser, v3 }
}

/** 冲刷微任务（setSpatialParams 内部 fire-and-forget 的 syncSpatialChain await 链） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 内存 storage mock（Pick<Storage,'getItem'|'setItem'|'removeItem'>） */
function memoryStorage() {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v)
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    peek: (k: string) => mem.get(k) ?? null,
  }
}

describe('fusion：参数快照与订阅', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('patch 嵌套合并：局部修改不丢其余字段（数组/原始值整段替换）', () => {
    patchSpatialParams({ instant: { spreadDeg: 80 } })
    const p = getSpatialParams()
    expect(p.instant.spreadDeg).toBe(80)
    expect(p.instant.amount).toBe(0.7) // 默认保留
    expect(p.instant.room).toBe('studio')
    expect(p.masterGain).toBe(0.9)
    expect(p.mode).toBe('off')
  })

  it('setSpatialParams 快照替换 + 订阅通知 + 退订', () => {
    const seen: SpatialParams[] = []
    const unsub = subscribeSpatialParams((p) => seen.push(p))
    setSpatialParams({ ...getSpatialParams(), masterGain: 0.8 })
    expect(seen).toHaveLength(1)
    expect(seen[0].masterGain).toBe(0.8)
    expect(getSpatialParams().masterGain).toBe(0.8)
    unsub()
    setSpatialParams({ ...getSpatialParams(), masterGain: 0.7 })
    expect(seen).toHaveLength(1) // 退订后不再通知
  })

  it('isSpatialActive / getSpatialStats', () => {
    expect(isSpatialActive()).toBe(false)
    expect(getSpatialStats()).toBeNull() // 未接线未回传
    patchSpatialParams({ mode: 'instant' })
    expect(isSpatialActive()).toBe(true)
    setSpatialParams(createDefaultSpatialParams())
    expect(isSpatialActive()).toBe(false)
  })

  it('instantSpeakers 边界钳位：spread 20/60/120 → 半角 10/30/60', () => {
    const base = createDefaultSpatialParams().instant
    const s20 = instantSpeakers({ ...base, spreadDeg: 20 })
    expect(s20[0].azimuthDeg).toBe(-10)
    expect(s20[1].azimuthDeg).toBe(10)
    const s60 = instantSpeakers({ ...base, spreadDeg: 60 })
    expect(s60[0].azimuthDeg).toBe(-30)
    expect(s60[1].azimuthDeg).toBe(30)
    const s120 = instantSpeakers({ ...base, spreadDeg: 120 })
    expect(s120[0].azimuthDeg).toBe(-60)
    expect(s120[1].azimuthDeg).toBe(60)
    // 固定字段：距离 1.5m、增益 1、仰角 0
    for (const s of [...s20, ...s60, ...s120]) {
      expect(s.distance).toBe(1.5)
      expect(s.gain).toBe(1)
      expect(s.elevationDeg).toBe(0)
    }
    expect(s20[0].channel).toBe(0)
    expect(s20[1].channel).toBe(1)
  })

  it('spatialConfigFromParams：instant → 两扬声器 + 固定字段；off → 空扬声器；world → 4 演示源', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(2)
    expect(c.distanceModel).toBe('inverse')
    expect(c.hrtfInterp).toBe('nearest')
    expect(c.convolution).toBe('partitioned')
    expect(c.masterGain).toBe(0.9)
    expect(c.room).toBe('studio')
    expect(c.roomAmount).toBe(0.15)
    expect(c.amount).toBe(0.7)

    p.mode = 'off'
    expect(spatialConfigFromParams(p).speakers).toEqual([])
    // world 模式自波 3 起有扬声器（默认 4 个演示源），见「模式 C」用例组
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(4)
    // stage 模式自波 2 起有扬声器（默认舞台预设 7 只），见「模式 D」用例组
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(7)
  })

  it('createExportBackend：返回可用后端（网格管线冒烟：真实扬声器配置可渲染）', () => {
    const b = createExportBackend(48000)
    expect(b).not.toBeNull()
    // 用 instant 配置（2 只虚拟扬声器）验证网格装载 + 渲染管线完整可用
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    const cfg = spatialConfigFromParams(p)
    expect(cfg.speakers.length).toBeGreaterThan(0)
    b!.setConfig(cfg)
    const N = 2048
    const inL = new Float32Array(N)
    const inR = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      inL[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000)
      inR[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / 48000)
    }
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b!.processStereo(inL, inR, outL, outR)
    // 输出必须有限且非全零（后端实际产生双耳渲染）
    let finite = true
    let energy = 0
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) finite = false
      energy += Math.abs(outL[i]) + Math.abs(outR[i])
    }
    expect(finite).toBe(true)
    expect(energy).toBeGreaterThan(0)
  })
})

describe('persistence：store restore 容错与往返', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restore：坏 JSON 回默认', () => {
    const mem = new Map<string, string>([[SPATIAL_PARAMS_KEY, '{bad json']])
    const store = createSpatialStore({ getItem: (k) => mem.get(k) ?? null, setItem: () => {} })
    expect(store.restore()).toEqual(createDefaultSpatialParams())
  })

  it('restore：缺字段补默认（深合并）', () => {
    const mem = new Map<string, string>([[SPATIAL_PARAMS_KEY, JSON.stringify({ mode: 'instant' })]])
    const store = createSpatialStore({ getItem: (k) => mem.get(k) ?? null, setItem: () => {} })
    const p = store.restore()
    expect(p.mode).toBe('instant')
    expect(p.masterGain).toBe(0.9) // 缺字段用默认
    expect(p.instant.spreadDeg).toBe(60)
    expect(p.instant.room).toBe('studio')
    // 旧版本持久化数据（无 ambience 字段）→ 补默认（环境声关闭，行为不回归）
    expect(p.ambience).toEqual({ enabled: false, amount: 0.3 })
  })

  it('restore：非对象 / 空值回默认', () => {
    const store = createSpatialStore({ getItem: () => '42', setItem: () => {} })
    expect(store.restore()).toEqual(createDefaultSpatialParams())
    const empty = createSpatialStore({ getItem: () => null, setItem: () => {} })
    expect(empty.restore()).toEqual(createDefaultSpatialParams())
  })

  it('save → restore 往返（400ms 防抖，内存 storage mock）', () => {
    vi.useFakeTimers()
    const mem = memoryStorage()
    const store = createSpatialStore(mem)
    const p = createDefaultSpatialParams()
    p.instant.spreadDeg = 90
    p.mode = 'instant'
    store.save(p)
    expect(mem.peek(SPATIAL_PARAMS_KEY)).toBeNull() // 防抖窗口内未落盘
    vi.advanceTimersByTime(400)
    expect(mem.peek(SPATIAL_PARAMS_KEY)).not.toBeNull()
    // 新 store（同存储）恢复
    const store2 = createSpatialStore(mem)
    const restored = store2.restore()
    expect(restored.instant.spreadDeg).toBe(90)
    expect(restored.mode).toBe('instant')
    expect(restored.masterGain).toBe(0.9)
  })

  it('防抖窗口内多次 save 只落最后一份', () => {
    vi.useFakeTimers()
    const mem = memoryStorage()
    const store = createSpatialStore(mem)
    store.save({ ...createDefaultSpatialParams(), masterGain: 0.6 })
    store.save({ ...createDefaultSpatialParams(), masterGain: 0.7 })
    vi.advanceTimersByTime(400)
    const restored = createSpatialStore(mem).restore()
    expect(restored.masterGain).toBe(0.7)
  })
})

describe('fusion：模式 B 头锁定环绕 → 虚拟扬声器映射', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('51 布局（默认）：5 扬声器，channel 按方位角符号路由', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked' // 默认 headLocked = 51 布局
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(5)
    const byAz = (az: number) => c.speakers.find((s) => s.azimuthDeg === az)!
    expect(byAz(0).channel).toBe(0) // C：正前方取 L 源
    expect(byAz(-30).channel).toBe(0) // FL：左 → L
    expect(byAz(30).channel).toBe(1) // FR：右 → R
    expect(byAz(-110).channel).toBe(0) // SL
    expect(byAz(110).channel).toBe(1) // SR
    // 字段透传：仰角/距离/增益/扩散度
    expect(byAz(0).elevationDeg).toBe(0)
    expect(byAz(0).distance).toBe(1.5)
    expect(byAz(0).gain).toBe(1)
    expect(byAz(0).size).toBe(0)
  })

  it('stereo 布局：L→0、R→1（立体声直通左右）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked = { layout: 'stereo', speakers: createLayoutSpeakers('stereo'), heightLayer: true, bottomLayer: true, routes: [] }
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(2)
    expect(c.speakers[0].azimuthDeg).toBe(-30)
    expect(c.speakers[0].channel).toBe(0)
    expect(c.speakers[1].azimuthDeg).toBe(30)
    expect(c.speakers[1].channel).toBe(1)
  })

  it('714 布局：默认（heightLayer+bottomLayer=true）→ 13 只（顶置/底部也路由）；关顶置 → 9 只；全关 → 7 地面', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked = { layout: '714', speakers: createLayoutSpeakers('714'), heightLayer: true, bottomLayer: true, routes: [] }
    const c13 = spatialConfigFromParams(p)
    expect(c13.speakers).toHaveLength(13)
    const top = c13.speakers.filter((s) => s.elevationDeg === 45)
    expect(top).toHaveLength(4)
    expect(top.find((s) => s.azimuthDeg === -45)!.channel).toBe(0) // TFL
    expect(top.find((s) => s.azimuthDeg === 45)!.channel).toBe(1) // TFR
    expect(top.find((s) => s.azimuthDeg === -135)!.channel).toBe(0) // TRL
    expect(top.find((s) => s.azimuthDeg === 135)!.channel).toBe(1) // TRR
    const bottom = c13.speakers.filter((s) => s.elevationDeg === -20)
    expect(bottom).toHaveLength(2)
    expect(bottom.find((s) => s.azimuthDeg === -120)!.channel).toBe(0) // BL
    expect(bottom.find((s) => s.azimuthDeg === 120)!.channel).toBe(1) // BR
    expect(c13.speakers.filter((s) => s.elevationDeg === 0)).toHaveLength(7)

    p.headLocked.heightLayer = false
    const c9 = spatialConfigFromParams(p)
    expect(c9.speakers).toHaveLength(9) // 7 地面 + 2 底部
    expect(c9.speakers.some((s) => s.elevationDeg === 45)).toBe(false)

    p.headLocked.bottomLayer = false
    const c7 = spatialConfigFromParams(p)
    expect(c7.speakers).toHaveLength(7)
    expect(c7.speakers.every((s) => s.elevationDeg === 0)).toBe(true)
  })

  it('custom 空列表：回退 51 预设（5 扬声器）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked = { layout: 'custom', speakers: [], heightLayer: true, bottomLayer: true, routes: [] }
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(5)
    expect(c.speakers.map((s) => s.azimuthDeg).sort((a, b) => a - b)).toEqual([-110, -30, 0, 30, 110])
  })

  it('headLocked 模式固定字段与 instant 一致（room/amount/masterGain/模型）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    const c = spatialConfigFromParams(p)
    expect(c.distanceModel).toBe('inverse')
    expect(c.hrtfInterp).toBe('nearest')
    expect(c.convolution).toBe('partitioned')
    expect(c.masterGain).toBe(0.9)
    expect(c.room).toBe('studio')
    expect(c.roomAmount).toBe(0.15)
    expect(c.amount).toBe(0.7)
  })

  it('声源路由：routes 空（默认）→ 按方位角就近路由（回归：与现状逐位一致）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked' // 默认 headLocked = 51 布局
    expect(p.headLocked.routes).toEqual([]) // 默认空数组 = 全按方位角默认
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(5)
    const byAz = (az: number) => c.speakers.find((s) => s.azimuthDeg === az)!
    expect(byAz(0).channel).toBe(0) // C：正前方取 L 源
    expect(byAz(-30).channel).toBe(0) // FL：左 → L
    expect(byAz(30).channel).toBe(1) // FR：右 → R
    expect(byAz(-110).channel).toBe(0) // SL
    expect(byAz(110).channel).toBe(1) // SR
  })

  it('声源路由：routes 显式 l/r → 逐扬声器覆盖方位角就近（channel 0/1，可反向）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    // 51 布局顺序 C/FL/FR/SL/SR：全显式覆盖（含与方位角相反的路由）
    p.headLocked.routes = ['l', 'r', 'l', 'r', 'l']
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(5)
    const byAz = (az: number) => c.speakers.find((s) => s.azimuthDeg === az)!
    expect(byAz(0).channel).toBe(0) // C 'l' → 0
    expect(byAz(-30).channel).toBe(1) // FL 'r' → 1（覆盖方位角默认 0）
    expect(byAz(30).channel).toBe(0) // FR 'l' → 0（覆盖方位角默认 1）
    expect(byAz(-110).channel).toBe(1) // SL 'r' → 1
    expect(byAz(110).channel).toBe(0) // SR 'l' → 0
    // 其余字段透传不受路由影响
    for (const s of c.speakers) {
      expect(s.gain).toBe(1)
      expect(s.distance).toBe(1.5)
      expect(s.size).toBe(0)
    }
  })

  it("声源路由：routes 'both' → 两只半增益扬声器（channel 0/1，gain 各 ×0.5，其余参数一致）", () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked.layout = 'stereo' // 2 只：L(-30)/R(+30)
    p.headLocked.routes = ['both', 'both']
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(4) // 每只 both → 2 只
    for (const az of [-30, 30]) {
      const pair = c.speakers.filter((s) => s.azimuthDeg === az)
      expect(pair).toHaveLength(2)
      expect(pair.map((s) => s.channel).sort()).toEqual([0, 1]) // L 源 + R 源各一只
      for (const s of pair) {
        expect(s.gain).toBeCloseTo(0.5) // 双路等功率（0.5/0.5）
        expect(s.elevationDeg).toBe(0)
        expect(s.distance).toBe(1.5)
        expect(s.size).toBe(0)
      }
    }
    // 非 1 增益同样折半（custom 布局验证：1.2 → 0.6）
    p.headLocked.layout = 'custom'
    p.headLocked.speakers = [{ azimuthDeg: 20, elevationDeg: 30, distance: 3, gain: 1.2, size: 0.5 }]
    p.headLocked.routes = ['both']
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers).toHaveLength(2)
    for (const s of c2.speakers) {
      expect(s.gain).toBeCloseTo(0.6)
      expect(s.elevationDeg).toBe(30)
      expect(s.distance).toBe(3)
      expect(s.size).toBe(0.5)
    }
  })

  it('声源路由：长度不足 → 剩余按方位角默认；超长 → 截断', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    // 长度不足：只给前 2 只（C both、FL r），其余 3 只走方位角默认
    p.headLocked.routes = ['both', 'r']
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(6) // C both×2 + FL 1 + FR 1 + SL 1 + SR 1
    expect(c.speakers.filter((s) => s.azimuthDeg === 0)).toHaveLength(2) // both 展开 2 只
    expect(c.speakers.find((s) => s.azimuthDeg === -30)!.channel).toBe(1) // 'r' 覆盖
    expect(c.speakers.find((s) => s.azimuthDeg === 30)!.channel).toBe(1) // 缺省 az>0 → 1
    expect(c.speakers.find((s) => s.azimuthDeg === -110)!.channel).toBe(0) // 缺省 az<0 → 0
    expect(c.speakers.find((s) => s.azimuthDeg === 110)!.channel).toBe(1)

    // 超长截断：7 条路由只作用于 5 只扬声器（第 6/7 条忽略）
    p.headLocked.routes = ['l', 'l', 'l', 'l', 'l', 'r', 'both']
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers).toHaveLength(5)
    expect(c2.speakers.every((s) => s.channel === 0)).toBe(true)
  })
})

describe('fusion：模式 B 静音/Solo（muted 扬声器增益 0）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('muted 扬声器 → 渲染配置 gain 0（后端渲染层以增益 0 表达静音）；非 muted 不变（回归）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked.layout = 'custom'
    p.headLocked.speakers = [
      { azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0, muted: true },
    ]
    p.headLocked.routes = []
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(2)
    expect(c.speakers[0].gain).toBe(1) // 非 muted 不变（回归）
    expect(c.speakers[1].gain).toBe(0) // muted → 增益 0
    // 其余字段透传不受 muted 影响（方位/仰角/距离/尺寸/声道）
    expect(c.speakers[1].azimuthDeg).toBe(30)
    expect(c.speakers[1].elevationDeg).toBe(0)
    expect(c.speakers[1].distance).toBe(1.5)
    expect(c.speakers[1].size).toBe(0)
    expect(c.speakers[1].channel).toBe(1) // 路由照常（az>0 → 右源）
  })

  it('muted 与路由展开组合：both 路由的 muted 扬声器两只半增益均置 0', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked.layout = 'custom'
    p.headLocked.speakers = [
      { azimuthDeg: 20, elevationDeg: 0, distance: 2, gain: 1, size: 0, muted: true },
    ]
    p.headLocked.routes = ['both']
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(2) // both 展开 2 只
    expect(c.speakers.every((s) => s.gain === 0)).toBe(true)
    // 非 muted 的 both 路由不受影响（回归：0.5/0.5 等功率）
    p.headLocked.speakers = [{ azimuthDeg: 20, elevationDeg: 0, distance: 2, gain: 1, size: 0 }]
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers.every((s) => s.gain === 0.5)).toBe(true)
  })

  it('muted 缺省（undefined）= 未静音（回归：预设布局与无 muted 字段的旧数据）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    // 预设布局（默认 51）：预设表副本无 muted 字段 → 全部正常增益
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(5)
    expect(c.speakers.every((s) => s.gain === 1)).toBe(true)
    // custom 无 muted 字段同样不静音（旧持久化数据兼容）
    p.headLocked.layout = 'custom'
    p.headLocked.speakers = [{ azimuthDeg: -45, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }]
    expect(spatialConfigFromParams(p).speakers[0].gain).toBe(1)
  })

  it('714 预设 + muted 字段显式 false：正常渲染（bottomLayer=true 默认 13 只，全部 gain 1）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked'
    p.headLocked = { layout: '714', speakers: createLayoutSpeakers('714'), heightLayer: true, bottomLayer: true, routes: [] }
    // 预设渲染走预设表（与 headLocked.speakers 无关）：显式 false 仅存于 custom
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(13)
    expect(c.speakers.every((s) => s.gain === 1)).toBe(true)
  })
})

describe('fusion：模式 D 舞台影院 → 虚拟扬声器映射', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('stage 默认预设（音乐舞台）：7 只，channel 按方位角符号路由', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'stage' // 默认 stage = { preset:'stage', seat:'middle', roomSize:1, reverbAmount:0.35 }
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(7)
    const byAz = (az: number) => c.speakers.find((s) => s.azimuthDeg === az)!
    expect(byAz(0).channel).toBe(0) // 主唱：正前方取 L 源（az<=0 → 0）
    expect(byAz(-30).channel).toBe(0) // 吉他：左
    expect(byAz(30).channel).toBe(1) // 贝斯：右
    expect(byAz(10).channel).toBe(1) // 鼓：+10 → 右
    expect(byAz(-20).channel).toBe(0) // 键盘
    expect(byAz(-110).channel).toBe(0) // 环境左
    expect(byAz(110).channel).toBe(1) // 环境右
    // 座位 middle × roomSize 1 → 距离等于预设基准值
    expect(byAz(0).distance).toBe(2.5)
    expect(byAz(-110).distance).toBe(8)
    // 字段透传：仰角/增益/扩散度
    expect(c.speakers.every((s) => s.gain === 1 && s.size === 0)).toBe(true)
  })

  it('stage room/roomAmount 覆盖：room 取场景预设、roomAmount 取 reverbAmount（与 instant 解耦）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'stage'
    const c = spatialConfigFromParams(p)
    expect(c.room).toBe('stage') // 默认舞台预设房间
    expect(c.roomAmount).toBe(0.35) // 默认氛围混响

    p.stage = { preset: 'cinema', seat: 'back', roomSize: 2, reverbAmount: 0.8, customSources: [] }
    const c2 = spatialConfigFromParams(p)
    expect(c2.room).toBe('hall')
    expect(c2.roomAmount).toBe(0.8)
    // 模式 A 全局房间语义不受影响（stage 的 room/roomAmount 独立于 instant）
    expect(p.instant.room).toBe('studio')
    expect(p.instant.roomAmount).toBe(0.15)
  })

  it('stage 座位/房间缩放生效：后排 ×1.35、房间 ×2 距离钳位 10m、仰角透传', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'stage'
    p.stage = { preset: 'piano', seat: 'back', roomSize: 2, reverbAmount: 0.35, customSources: [] }
    const c = spatialConfigFromParams(p)
    // 钢琴 2m × 1.35 × 2 = 5.4（钳位内）
    expect(c.speakers.find((s) => s.azimuthDeg === 0)!.distance).toBeCloseTo(2 * 1.35 * 2)
    // 环境 9m × 1.35 × 2 = 24.3 → 钳位 10
    expect(c.speakers.find((s) => s.azimuthDeg === -90)!.distance).toBe(10)
    expect(c.speakers.find((s) => s.azimuthDeg === 180)!.distance).toBe(10)

    // nature 仰角字段透传（雨 el50）
    p.stage = { preset: 'nature', seat: 'middle', roomSize: 1, reverbAmount: 0.35, customSources: [] }
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers.find((s) => s.elevationDeg === 50)!.azimuthDeg).toBe(0)
    expect(c2.speakers).toHaveLength(4)
  })

  it('customSources 空（默认）→ speakers 数回归（各预设场景扬声器数，不附加）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'stage'
    // 默认自定义声源为空数组（规划书「可替换/添加个别声源」未启用时行为不回归）
    expect(p.stage.customSources).toEqual([])
    // 各预设回归：stage 7 / cinema 11 / piano 4 / nature 4（与 STAGE_SCENES 单事实源一致）
    for (const scene of STAGE_SCENES) {
      p.stage = { ...p.stage, preset: scene.id, customSources: [] }
      expect(spatialConfigFromParams(p).speakers).toHaveLength(scene.speakers.length)
    }
  })

  it('customSources 非空 → 附加扬声器数/方位正确（预设扬声器之后，与预设同一坐标系）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'stage'
    p.stage.customSources = [
      { id: 'custom-1', position: { x: 0, y: 1.6, z: 4 }, gain: 1, size: 0 }, // 正前 4m
      { id: 'custom-2', position: { x: -3, y: 1.6, z: 4 }, gain: 0.7, size: 0.2 }, // 左前
      { id: 'custom-3', position: { x: 0, y: 3.6, z: 4 }, gain: 0.5, size: 0 }, // 正前抬升 2m → 仰角
      { id: 'custom-4', position: { x: 3, y: 1.6, z: 4 }, gain: 1, size: 0 }, // 右前 → channel 1
    ]
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(7 + 4) // 预设 7 + 附加 4（附加排在预设之后）
    const custom = c.speakers.slice(7)
    // custom-1 (0,1.6,4)：相对默认听者 (0,1.6,0) → az 0、dist 4、el 0（正前，与预设同一坐标系）
    expect(custom[0]).toMatchObject({ azimuthDeg: 0, elevationDeg: 0, distance: 4, gain: 1, size: 0 })
    expect(custom[0].channel).toBe(0) // az<=0 → 左源
    // custom-2 (-3,1.6,4)：az = atan2(-3,4) ≈ -36.87°、dist = 5、el 0
    expect(custom[1].azimuthDeg).toBeCloseTo((Math.atan2(-3, 4) * 180) / Math.PI, 5)
    expect(custom[1].distance).toBeCloseTo(5, 5)
    expect(custom[1].elevationDeg).toBeCloseTo(0, 5)
    expect(custom[1].channel).toBe(0)
    expect(custom[1].gain).toBe(0.7)
    expect(custom[1].size).toBe(0.2)
    // custom-3 (0,3.6,4)：dy = 2 → el = asin(2/√20) ≈ 26.57°、dist = √20 ≈ 4.472、az 0
    expect(custom[2].azimuthDeg).toBeCloseTo(0, 5)
    expect(custom[2].elevationDeg).toBeCloseTo((Math.asin(2 / Math.sqrt(20)) * 180) / Math.PI, 5)
    expect(custom[2].distance).toBeCloseTo(Math.sqrt(20), 5)
    // custom-4 (3,1.6,4)：az = atan2(3,4) ≈ +36.87° → az>0 → 右源 channel 1
    expect(custom[3].azimuthDeg).toBeCloseTo((Math.atan2(3, 4) * 180) / Math.PI, 5)
    expect(custom[3].distance).toBeCloseTo(5, 5)
    expect(custom[3].channel).toBe(1)
    // 预设扬声器字段不受附加影响（回归：首只主唱 az 0 / dist 2.5）
    expect(c.speakers[0]).toMatchObject({ azimuthDeg: 0, distance: 2.5, gain: 1 })
  })
})

describe('fusion：模式 C 世界漫游 → 虚拟扬声器映射', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('默认 4 演示源 → 4 只虚拟扬声器：方位/距离/仰角/增益/尺寸按听者相对方向映射', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(4)
    const byId = (id: string) => c.speakers[p.world.sources.findIndex((s) => s.id === id)]!
    // 听者默认 (0,1.6,0) 朝 +Z（yaw=0）：各源方位 = atan2(dx, dz)
    // 人声 (-2,1.6,4)：az = atan2(-2,4) ≈ -26.57°、dist = √20 ≈ 4.472
    expect(byId('vocal').azimuthDeg).toBeCloseTo((Math.atan2(-2, 4) * 180) / Math.PI, 5)
    expect(byId('vocal').distance).toBeCloseTo(Math.sqrt(20), 5)
    expect(byId('vocal').elevationDeg).toBeCloseTo(0, 5)
    // 吉他 (-5,1.6,6)：az ≈ -39.81°、dist = √61
    expect(byId('guitar').azimuthDeg).toBeCloseTo((Math.atan2(-5, 6) * 180) / Math.PI, 5)
    expect(byId('guitar').distance).toBeCloseTo(Math.sqrt(61), 5)
    // 鼓组 (3,1.6,7)：az ≈ +23.20°、dist = √58
    expect(byId('drums').azimuthDeg).toBeCloseTo((Math.atan2(3, 7) * 180) / Math.PI, 5)
    expect(byId('drums').distance).toBeCloseTo(Math.sqrt(58), 5)
    // 环境声 (0,2.5,10)：az = 0、dist = √100.81、el = asin(0.9/dist) ≈ 5.14°
    expect(byId('ambience').azimuthDeg).toBeCloseTo(0, 5)
    expect(byId('ambience').distance).toBeCloseTo(Math.sqrt(100.81), 5)
    expect(byId('ambience').elevationDeg).toBeCloseTo((Math.asin(0.9 / Math.sqrt(100.81)) * 180) / Math.PI, 5)
    // 增益/尺寸透传：人声/吉他/鼓组 (1,0)，环境声 (0.6, 0.5)
    expect(byId('vocal').gain).toBe(1)
    expect(byId('vocal').size).toBe(0)
    expect(byId('ambience').gain).toBe(0.6)
    expect(byId('ambience').size).toBe(0.5)
  })

  it('channel 按方位角符号就近路由（az≤0 → L 源 0；az>0 → R 源 1，与模式 B 同语义）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    const c = spatialConfigFromParams(p)
    const byId = (id: string) => c.speakers[p.world.sources.findIndex((s) => s.id === id)]!
    expect(byId('vocal').azimuthDeg).toBeLessThan(0)
    expect(byId('vocal').channel).toBe(0) // 左半场 → 0
    expect(byId('guitar').azimuthDeg).toBeLessThan(0)
    expect(byId('guitar').channel).toBe(0)
    expect(byId('drums').azimuthDeg).toBeGreaterThan(0)
    expect(byId('drums').channel).toBe(1) // 右半场 → 1
    expect(byId('ambience').azimuthDeg).toBe(0)
    expect(byId('ambience').channel).toBe(0) // 正前方 az=0 → 0
  })

  it('听者移动 → 方位角/距离变化（随参数快照重发 config 即完成空间更新）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    // 听者后退 2m：人声 (-2,1.6,4) 相对 (0,1.6,-2) → az = atan2(-2,6) ≈ -18.43°、dist = √40
    p.world.listener = moveListener(p.world.listener, { x: 0, y: 0, z: -2 })
    const c = spatialConfigFromParams(p)
    const vocal = c.speakers[0]
    expect(vocal.azimuthDeg).toBeCloseTo((Math.atan2(-2, 6) * 180) / Math.PI, 5)
    expect(vocal.distance).toBeCloseTo(Math.sqrt(40), 5)
    // 听者右转 90°：所有方位角整体 −90（computeRelativeDirection 已扣除 yaw）
    p.world.listener = rotateListener(p.world.listener, 90)
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(-2, 6) * 180) / Math.PI - 90, 5)
    expect(c2.speakers[2].azimuthDeg).toBeCloseTo((Math.atan2(3, 9) * 180) / Math.PI - 90, 5)
  })

  it('sources 为空 → 无扬声器（world 无源即静音空间化）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    p.world.sources = []
    expect(spatialConfigFromParams(p).speakers).toEqual([])
  })

  it('dopplerVelocity：world 模式填默认 {0,0,0}（引擎侧接口），其余模式缺省', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    const c = spatialConfigFromParams(p)
    expect(c.dopplerVelocity).toEqual({ x: 0, y: 0, z: 0 })
    // 非 world 模式：undefined（后端不启用多普勒）
    p.mode = 'instant'
    expect(spatialConfigFromParams(p).dopplerVelocity).toBeUndefined()
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).dopplerVelocity).toBeUndefined()
    p.mode = 'headLocked'
    expect(spatialConfigFromParams(p).dopplerVelocity).toBeUndefined()
    p.mode = 'off'
    expect(spatialConfigFromParams(p).dopplerVelocity).toBeUndefined()
  })

  it('world 固定字段与其余模式一致（room/amount/masterGain/模型）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    const c = spatialConfigFromParams(p)
    expect(c.distanceModel).toBe('inverse')
    expect(c.hrtfInterp).toBe('nearest')
    expect(c.convolution).toBe('partitioned')
    expect(c.masterGain).toBe(0.9)
    expect(c.room).toBe('studio')
    expect(c.roomAmount).toBe(0.15)
    expect(c.amount).toBe(0.7)
  })
})

describe('fusion：环境声 Ambisonics 上混（ambience）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('ambience 关闭（默认）→ 各模式 speakers 数与现状一致（回归）', () => {
    const p = createDefaultSpatialParams()
    expect(p.ambience).toEqual({ enabled: false, amount: 0.3 }) // 默认关闭、混合 30%
    // 默认关闭下各模式扬声器数量与既有行为一致（不附加环境扬声器）
    p.mode = 'instant'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(2)
    p.mode = 'headLocked'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(5)
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(4)
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(7)
    // mode=off 时即使 ambience 开启也不附加（空间化整体关闭）
    p.mode = 'off'
    p.ambience.enabled = true
    expect(spatialConfigFromParams(p).speakers).toEqual([])
  })

  it('开启 → instant 模式 speakers = 2+4=6 只：前 2 只主渲染、后 4 只环境（45/135/225/315）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    p.ambience.enabled = true
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(6)
    // 前 2 只主渲染扬声器不变（instant ±30°），不带 ambience 标记（普通渲染）
    expect(c.speakers[0].azimuthDeg).toBe(-30)
    expect(c.speakers[1].azimuthDeg).toBe(30)
    expect(c.speakers[0].channel).toBe(0)
    expect(c.speakers[1].channel).toBe(1)
    expect(c.speakers[0].gain).toBe(1)
    expect(c.speakers[0].ambience).toBeUndefined()
    // 后 4 只环境扬声器：方位 45/135/225/315，channel 0（L 源环境输入）、
    // 距离 6、增益 0 占位（真实增益由处理器每块按 FOA 解码调制，FOA 编解码渲染
    // 路径——ambience:true 标记使处理器走环境混合器，不进后端卷积）、size 0.8（扩散）
    const amb = c.speakers.slice(2)
    expect(amb.map((s) => s.azimuthDeg)).toEqual([45, 135, 225, 315])
    for (const s of amb) {
      expect(s.channel).toBe(0)
      expect(s.elevationDeg).toBe(0)
      expect(s.distance).toBe(6)
      expect(s.gain).toBe(0) // 占位：处理器每块按 FOA 解码调制
      expect(s.size).toBe(0.8)
      expect(s.ambience).toBe(true) // 环境声扬声器标记
    }
    // ambienceAmount 透传（处理器环境混合量的缩放系数）
    expect(c.ambienceAmount).toBe(0.3)
    // 其余模式同样附加（world 4 演示源 + 4 环境）
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(8)
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(11)
  })

  it('amount=0 → 环境 gain 0（enabled 仍附加 4 只带标记扬声器；ambienceAmount 透传 0）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    p.ambience = { enabled: true, amount: 0 }
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(6)
    expect(c.speakers.slice(2).every((s) => s.gain === 0)).toBe(true)
    expect(c.speakers.slice(2).every((s) => s.ambience === true)).toBe(true)
    expect(c.ambienceAmount).toBe(0) // 处理器环境混合器按 0 缩放 → 无环境输出
  })

  it('ambience 关闭 → 无环境扬声器，ambienceAmount 缺省（undefined，处理器环境混合器关闭）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toHaveLength(2)
    expect(c.speakers.every((s) => s.ambience === undefined)).toBe(true)
    expect(c.ambienceAmount).toBeUndefined()
  })
})

describe('fusion：输出模式（output：binaural/stereo/multichannel）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('默认 output=binaural：各模式 speakers 与既有行为一致（回归）', () => {
    const p = createDefaultSpatialParams()
    expect(p.output).toBe('binaural')
    p.mode = 'instant'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(2)
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(4)
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(7)
    p.mode = 'headLocked'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(5)
  })

  it('output=stereo → speakers=[]（干声直通，不经过 HRTF）；ambience 开启同样旁路', () => {
    const p = createDefaultSpatialParams()
    p.output = 'stereo'
    p.mode = 'instant'
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toEqual([])
    // 常规字段形状保留（直通下由处理器忽略，仅保持一致）
    expect(c.masterGain).toBe(0.9)
    expect(c.distanceModel).toBe('inverse')
    expect(c.room).toBe('studio')
    // ambience 开启：stereo 下环境附加一并旁路（早退于附加逻辑之前）
    p.ambience.enabled = true
    expect(spatialConfigFromParams(p).speakers).toEqual([])
    // 其余模式同：world/stage/headLocked/off 一律 speakers=[]
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toEqual([])
    expect(spatialConfigFromParams(p).dopplerVelocity).toEqual({ x: 0, y: 0, z: 0 }) // 与常规分支同形状
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toEqual([])
    p.mode = 'headLocked'
    expect(spatialConfigFromParams(p).speakers).toEqual([])
    p.mode = 'off'
    expect(spatialConfigFromParams(p).speakers).toEqual([])
  })

  it('output=multichannel 本轮与 binaural 同处理（真实物理多声道映射后续 wave）', () => {
    const p = createDefaultSpatialParams()
    p.output = 'multichannel'
    p.mode = 'instant'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(2)
    p.mode = 'world'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(4)
    p.mode = 'stage'
    expect(spatialConfigFromParams(p).speakers).toHaveLength(7)
  })
})

describe('fusion：模式 C 声源轨迹关键帧（world.trajectories + playhead）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('默认无轨迹：speaker 用 src.position（回归：playhead=0、trajectories=[]）', () => {
    const p = createDefaultSpatialParams()
    expect(p.world.playhead).toBe(0)
    expect(p.world.trajectories).toEqual([])
    p.mode = 'world'
    const c = spatialConfigFromParams(p)
    // 人声 (-2,1.6,4)：az = atan2(-2,4) ≈ -26.57°、dist = √20（与无轨迹时完全一致）
    expect(c.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(-2, 4) * 180) / Math.PI, 5)
    expect(c.speakers[0].distance).toBeCloseTo(Math.sqrt(20), 5)
  })

  it('playhead 在关键帧之间 → 方位角/距离随插值位置变化（线性插值中点/3/4 点）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    p.world.trajectories = [
      {
        sourceId: 'vocal',
        keyframes: [
          { t: 0, position: { x: -2, y: 1.6, z: 4 } },
          { t: 2, position: { x: 2, y: 1.6, z: 4 } },
        ],
      },
    ]
    // playhead=1（中点）：vocal 位置 (0,1.6,4) → az=0、dist=4
    p.world.playhead = 1
    const c1 = spatialConfigFromParams(p)
    expect(c1.speakers[0].azimuthDeg).toBeCloseTo(0, 5)
    expect(c1.speakers[0].distance).toBeCloseTo(4, 5)
    // playhead=1.5（3/4 点）：x = -2 + 4×0.75 = 1 → az = atan2(1,4)、dist = √17
    p.world.playhead = 1.5
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(1, 4) * 180) / Math.PI, 5)
    expect(c2.speakers[0].distance).toBeCloseTo(Math.sqrt(17), 5)
    // 其余无轨迹源不受影响（吉他默认 (-5,1.6,6) 回归）
    expect(c2.speakers[1].azimuthDeg).toBeCloseTo((Math.atan2(-5, 6) * 180) / Math.PI, 5)
    expect(c2.speakers[1].distance).toBeCloseTo(Math.sqrt(61), 5)
  })

  it('playhead 越界夹取：< 首帧用首位置、> 末帧用末位置', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    p.world.trajectories = [
      {
        sourceId: 'vocal',
        keyframes: [
          { t: 0, position: { x: -2, y: 1.6, z: 4 } },
          { t: 2, position: { x: 2, y: 1.6, z: 4 } },
        ],
      },
    ]
    // t=-1 < 首帧 0 → 首位置 (-2,1.6,4)
    p.world.playhead = -1
    const c1 = spatialConfigFromParams(p)
    expect(c1.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(-2, 4) * 180) / Math.PI, 5)
    expect(c1.speakers[0].distance).toBeCloseTo(Math.sqrt(20), 5)
    // t=10 > 末帧 2 → 末位置 (2,1.6,4)：az = atan2(2,4) ≈ +26.57°、dist = √20
    p.world.playhead = 10
    const c2 = spatialConfigFromParams(p)
    expect(c2.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(2, 4) * 180) / Math.PI, 5)
    expect(c2.speakers[0].distance).toBeCloseTo(Math.sqrt(20), 5)
  })

  it('轨迹按 sourceId 精确匹配：无匹配轨迹的声源回退 src.position', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'world'
    // 只为吉他（sources[1]）配轨迹，人声（sources[0]）无轨迹
    p.world.playhead = 1
    p.world.trajectories = [
      {
        sourceId: 'guitar',
        keyframes: [
          { t: 0, position: { x: -5, y: 1.6, z: 6 } },
          { t: 2, position: { x: 5, y: 1.6, z: 6 } },
        ],
      },
    ]
    const c = spatialConfigFromParams(p)
    // 人声：无轨迹 → 静态 (-2,1.6,4)（回归）
    expect(c.speakers[0].azimuthDeg).toBeCloseTo((Math.atan2(-2, 4) * 180) / Math.PI, 5)
    // 吉他：playhead=1 中点 → (0,1.6,6) → az=0、dist=6
    expect(c.speakers[1].azimuthDeg).toBeCloseTo(0, 5)
    expect(c.speakers[1].distance).toBeCloseTo(6, 5)
  })
})

describe('fusion：HRTF 数据集（setHrtfDataset）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  /** 最小合法网格（未接线场景下仅走校验/持久化路径） */
  function tinyGrid(): HrtfGrid {
    return {
      sampleRate: 48000,
      azimuths: [-30, 30],
      elevations: [0],
      hrirLength: 4,
      left: new Float32Array(8).fill(0.1),
      right: new Float32Array(8).fill(-0.1),
    }
  }

  it('setHrtfDataset 导出存在且为函数', () => {
    expect(typeof setHrtfDataset).toBe('function')
  })

  it('node 环境未接线：导入非 null 网格静默不抛（IDB 持久化失败被 fire-and-forget 吞掉）', () => {
    expect(() => setHrtfDataset(tinyGrid())).not.toThrow()
  })

  it('node 环境未接线：null（恢复内置）静默不抛', () => {
    expect(() => setHrtfDataset(null)).not.toThrow()
  })

  it('非法网格（无方位角）抛中文错误', () => {
    const bad: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [],
      elevations: [0],
      hrirLength: 4,
      left: new Float32Array(0),
      right: new Float32Array(0),
    }
    expect(() => setHrtfDataset(bad)).toThrow(/HRTF 数据集网格为空/)
  })

  it('网格尺寸不一致（left/right 长度与方位·仰角·样本数不匹配）抛中文错误', () => {
    const bad: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [-30, 30],
      elevations: [0],
      hrirLength: 4,
      left: new Float32Array(2), // 应为 2·1·4 = 8
      right: new Float32Array(8),
    }
    expect(() => setHrtfDataset(bad)).toThrow(/网格尺寸不一致/)
  })
})

describe('fusion：HRTF 数据集重采样（resampleGrid）', () => {
  /** 44.1kHz 合成网格（确定性信号：衰减正弦，非全零便于数值断言） */
  function grid44k(): HrtfGrid {
    const azimuths = [-30, 0, 30]
    const elevations = [-20, 0, 20]
    const hrirLength = 128
    const cells = azimuths.length * elevations.length
    const left = new Float32Array(cells * hrirLength)
    const right = new Float32Array(cells * hrirLength)
    for (let c = 0; c < cells; c++) {
      for (let t = 0; t < hrirLength; t++) {
        left[c * hrirLength + t] = Math.sin((2 * Math.PI * 1000 * t) / 44100) * Math.exp(-t / 40)
        right[c * hrirLength + t] = Math.cos((2 * Math.PI * 500 * t) / 44100) * Math.exp(-t / 60)
      }
    }
    return { sampleRate: 44100, azimuths, elevations, hrirLength, left, right }
  }

  it('44.1k → 48k：HRIR 长度换算 round(128·48000/44100)，全部值有限', () => {
    const out = resampleGrid(grid44k(), 48000)
    expect(out.sampleRate).toBe(48000)
    expect(out.hrirLength).toBe(Math.round((128 * 48000) / 44100)) // round(139.32) = 139
    expect(out.azimuths).toEqual([-30, 0, 30]) // 方位/仰角列表不变
    expect(out.elevations).toEqual([-20, 0, 20])
    expect(out.left.length).toBe(3 * 3 * out.hrirLength)
    expect(out.right.length).toBe(3 * 3 * out.hrirLength)
    for (let i = 0; i < out.left.length; i++) {
      expect(Number.isFinite(out.left[i])).toBe(true)
      expect(Number.isFinite(out.right[i])).toBe(true)
    }
  })

  it('确定性：同输入两次重采样逐样本一致', () => {
    const g = grid44k()
    const a = resampleGrid(g, 48000)
    const b = resampleGrid(g, 48000)
    expect(a.left).toEqual(b.left)
    expect(a.right).toEqual(b.right)
  })

  it('采样率一致 → 原样返回（零成本，不复制）', () => {
    const g = grid44k()
    expect(resampleGrid(g, 44100)).toBe(g)
  })

  it('非法目标采样率 / 非法源采样率 → 抛中文错误', () => {
    expect(() => resampleGrid(grid44k(), 0)).toThrow(/非法目标采样率/)
    const bad: HrtfGrid = { ...grid44k(), sampleRate: 0 }
    expect(() => resampleGrid(bad, 48000)).toThrow(/采样率非法/)
  })
})

describe('fusion：HRTF 数据集跨重启自动恢复（restoreHrtfDataset）', () => {
  /** 最小合法网格（未接线场景下仅走校验/持久化路径） */
  function tinyGrid(): HrtfGrid {
    return {
      sampleRate: 48000,
      azimuths: [-30, 30],
      elevations: [0],
      hrirLength: 4,
      left: new Float32Array(8).fill(0.1),
      right: new Float32Array(8).fill(-0.1),
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals() // 清理 window localStorage stub，避免污染后续用例
    vi.mocked(getLatestDataset).mockReset() // 重置 hrtfStore mock 返回值
  })

  it('无活动记录（Node 无 localStorage）→ 返回 false，不抛', async () => {
    await expect(restoreHrtfDataset()).resolves.toBe(false)
    expect(vi.mocked(getLatestDataset)).not.toHaveBeenCalled()
  })

  it('setHrtfDataset 写活动 id → restoreHrtfDataset 读回同一数据集 → true', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    const store = window.localStorage
    setHrtfDataset(tinyGrid())
    const id = store.getItem(HRTF_ACTIVE_DATASET_KEY)
    expect(id).not.toBeNull() // 导入成功 → 活动记录已写
    vi.mocked(getLatestDataset).mockResolvedValue({ id: id!, grid: tinyGrid() })
    await expect(restoreHrtfDataset()).resolves.toBe(true)
    expect(vi.mocked(getLatestDataset)).toHaveBeenCalledTimes(1)
  })

  it('setHrtfDataset(null)（恢复内置网格）清除活动记录', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    const store = window.localStorage
    setHrtfDataset(tinyGrid())
    expect(store.getItem(HRTF_ACTIVE_DATASET_KEY)).not.toBeNull()
    setHrtfDataset(null)
    expect(store.getItem(HRTF_ACTIVE_DATASET_KEY)).toBeNull()
  })

  it('活动 id 存在但 hrtfStore 无数据（getLatestDataset → null）→ false', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    window.localStorage.setItem(HRTF_ACTIVE_DATASET_KEY, '2026-01-01T00:00:00.000Z')
    vi.mocked(getLatestDataset).mockResolvedValue(null)
    await expect(restoreHrtfDataset()).resolves.toBe(false)
  })

  it('活动 id 与最新数据集 id 不匹配（记录被删/被覆盖）→ false', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    window.localStorage.setItem(HRTF_ACTIVE_DATASET_KEY, 'old-id')
    vi.mocked(getLatestDataset).mockResolvedValue({ id: 'newer-id', grid: tinyGrid() })
    await expect(restoreHrtfDataset()).resolves.toBe(false)
  })

  it('hrtfStore 读取异常（reject）→ false，不抛', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    window.localStorage.setItem(HRTF_ACTIVE_DATASET_KEY, '2026-01-01T00:00:00.000Z')
    vi.mocked(getLatestDataset).mockRejectedValue(new Error('IndexedDB 不可用'))
    await expect(restoreHrtfDataset()).resolves.toBe(false)
  })

  it('活动数据集损坏（校验失败）→ false', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    window.localStorage.setItem(HRTF_ACTIVE_DATASET_KEY, '2026-01-01T00:00:00.000Z')
    const bad: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [], // 无方位角 → 校验失败
      elevations: [0],
      hrirLength: 4,
      left: new Float32Array(0),
      right: new Float32Array(0),
    }
    vi.mocked(getLatestDataset).mockResolvedValue({ id: '2026-01-01T00:00:00.000Z', grid: bad })
    await expect(restoreHrtfDataset()).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 内置 HRTF 数据集切换（规划书 §4.1：KEMAR / CIPIC 两套内置）：
// setBuiltinDataset 解码内嵌网格 → 已接线 postGrid 热更新 + 写 localStorage 锚点
// （BUILTIN_HRTF_DATASET_KEY，跨重启自动恢复）；未打包（datasets.ts base64 null）
// → 静默 false（不抛、不写锚点）；getBuiltinDataset 读回（无记录/非法值 → null）。
// ---------------------------------------------------------------------------
describe('fusion：内置 HRTF 数据集切换（setBuiltinDataset / getBuiltinDataset）', () => {
  afterEach(() => {
    vi.unstubAllGlobals() // 清理 window localStorage stub，避免污染后续用例
  })

  it('setBuiltinDataset("kemar")：解码成功 → true + 写内置选择锚点（getBuiltinDataset 读回）', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    expect(setBuiltinDataset('kemar')).toBe(true)
    expect(window.localStorage.getItem(BUILTIN_HRTF_DATASET_KEY)).toBe('kemar')
    expect(getBuiltinDataset()).toBe('kemar')
  })

  it('setBuiltinDataset("cipic")：按打包状态分支——已打包 → true + 锚点；未打包 → false 静默（不写锚点）', () => {
    const packaged = BUILTIN_HRTF_DATASETS.find((d) => d.id === 'cipic')?.base64 !== null
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    expect(setBuiltinDataset('cipic')).toBe(packaged)
    expect(window.localStorage.getItem(BUILTIN_HRTF_DATASET_KEY)).toBe(packaged ? 'cipic' : null)
  })

  it('getBuiltinDataset：无记录 → null；非法存储值（防御）→ null；存储不可用（Node 无 window）→ null 不抛', () => {
    expect(getBuiltinDataset()).toBeNull() // 未 stub window：模块惰性读取 → null
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    expect(getBuiltinDataset()).toBeNull()
    window.localStorage.setItem(BUILTIN_HRTF_DATASET_KEY, 'kemar')
    expect(getBuiltinDataset()).toBe('kemar')
    window.localStorage.setItem(BUILTIN_HRTF_DATASET_KEY, 'sadie-ii')
    expect(getBuiltinDataset()).toBeNull() // 非法值 → null（防御，不抛）
  })

  it('切换内置数据集不触碰 SOFA 导入锚点（HRTF_ACTIVE_DATASET_KEY 独立，互不覆盖）', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    window.localStorage.setItem(HRTF_ACTIVE_DATASET_KEY, '2026-01-01T00:00:00.000Z')
    setBuiltinDataset('kemar')
    expect(window.localStorage.getItem(BUILTIN_HRTF_DATASET_KEY)).toBe('kemar')
    // SOFA 锚点保留：attach 恢复顺序（先内置后 SOFA）保证显式导入优先
    expect(window.localStorage.getItem(HRTF_ACTIVE_DATASET_KEY)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('setBuiltinDataset 未接线（模块无 SpatialNode）→ 不抛，仅写锚点（下次 attach 恢复）', () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() })
    expect(() => setBuiltinDataset('kemar')).not.toThrow()
    expect(window.localStorage.getItem(BUILTIN_HRTF_DATASET_KEY)).toBe('kemar')
  })
})

// ---------------------------------------------------------------------------
// ② 多声道输入自动映射（模式 A 补全）：multichannelLayout + multichannelAuto
//   multichannelLayout(channels)：5.1（6 声道）→ 6 只、7.1（8 声道）→ 8 只、
//   ≤2 声道回退 instantSpeakers；输入声道数由处理器 stats 回传（inputChannels）。
// ---------------------------------------------------------------------------
describe('fusion：多声道输入自动映射（② multichannelAuto + multichannelLayout）', () => {
  beforeEach(() => {
    mockSpatial.instances.length = 0
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('multichannelLayout：6 声道（5.1）→ 6 只（FL/FR/C/LFE 占位/SL/SR，channel 0..5）', () => {
    const s = multichannelLayout(6)
    expect(s).toHaveLength(6)
    expect(s.map((x) => x.channel)).toEqual([0, 1, 2, 3, 4, 5])
    expect(s.map((x) => x.azimuthDeg)).toEqual([-30, 30, 0, 0, -110, 110]) // FL/FR/C/LFE/SL/SR
    expect(s[3].gain).toBe(0) // LFE 静音占位（信号忽略）
    expect(s.filter((x) => x.gain === 1)).toHaveLength(5) // 五只主扬声器
    // 字段：距离 1.5m、仰角 0、size 0（与 instantSpeakers/layouts 预设一致）
    for (const x of s) {
      expect(x.distance).toBe(1.5)
      expect(x.elevationDeg).toBe(0)
      expect(x.size).toBe(0)
    }
  })

  it('multichannelLayout：8 声道（7.1）→ 8 只（+RL/RR channel 6/7，±140°）', () => {
    const s = multichannelLayout(8)
    expect(s).toHaveLength(8)
    expect(s.map((x) => x.channel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(s[6].azimuthDeg).toBe(-140) // RL
    expect(s[7].azimuthDeg).toBe(140) // RR
    expect(s.slice(0, 6)).toEqual(multichannelLayout(6)) // 7.1 = 5.1 + RL/RR
  })

  it('multichannelLayout：≤2 声道回退 instantSpeakers（±spread/2 立体声对）', () => {
    const base = createDefaultSpatialParams().instant
    expect(multichannelLayout(2, { ...base, spreadDeg: 80 })).toEqual(instantSpeakers({ ...base, spreadDeg: 80 }))
    expect(multichannelLayout(1)).toEqual(instantSpeakers(base)) // 单声道同样回退
    expect(multichannelLayout(0)).toEqual(instantSpeakers(base))
    expect(multichannelLayout(2)[0].azimuthDeg).toBe(-30) // 默认 spread 60 → ±30
  })

  it('multichannelAuto=false（默认）：instant 布局不变（回归），config 透传 false', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    expect(p.instant.multichannelAuto).toBe(false)
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toEqual(instantSpeakers(p.instant))
    expect(c.multichannelAuto).toBe(false)
  })

  it('multichannelAuto=true 且无 stats 回传（inputChannels 未知）→ 按 2 声道 instantSpeakers', () => {
    expect(getSpatialStats()).toBeNull() // 未接线未回传
    const p = createDefaultSpatialParams()
    p.mode = 'instant'
    p.instant.multichannelAuto = true
    const c = spatialConfigFromParams(p)
    expect(c.speakers).toEqual(instantSpeakers(p.instant)) // 未知输入 → 立体声布局（行为与现状一致）
    expect(c.multichannelAuto).toBe(true)
  })

  it('multichannelAuto=true 且 stats.inputChannels=6 → 5.1 布局 speakers（6 只，channel 0..5）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    setSpatialParams({
      ...createDefaultSpatialParams(),
      mode: 'instant',
      instant: { ...createDefaultSpatialParams().instant, multichannelAuto: true },
    })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    expect(mockSpatial.instances).toHaveLength(1)
    // 注入处理器 stats 回传（inputChannels=6 → 多声道检测生效）
    mockSpatial.instances[0].onStats?.({ latencySamples: 512, backend: 'ts', inputChannels: 6 })
    const c = spatialConfigFromParams(getSpatialParams())
    expect(c.speakers).toHaveLength(6)
    expect(c.speakers.map((x) => x.channel)).toEqual([0, 1, 2, 3, 4, 5])
    expect(c.speakers[3].gain).toBe(0) // LFE 静音占位
    expect(c.speakers.map((x) => x.azimuthDeg)).toEqual([-30, 30, 0, 0, -110, 110])
  })

  it('multichannelAuto=true 且 stats.inputChannels=8 → 7.1 布局 speakers（8 只）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    setSpatialParams({
      ...createDefaultSpatialParams(),
      mode: 'instant',
      instant: { ...createDefaultSpatialParams().instant, multichannelAuto: true },
    })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    mockSpatial.instances[0].onStats?.({ latencySamples: 512, backend: 'ts', inputChannels: 8 })
    const c = spatialConfigFromParams(getSpatialParams())
    expect(c.speakers).toHaveLength(8)
    expect(c.speakers[6].channel).toBe(6) // RL
    expect(c.speakers[7].channel).toBe(7) // RR
  })
})

// ---------------------------------------------------------------------------
// ① 多声道物理输出（output=multichannel）：渲染配置与 binaural 相同（物理映射由
//   processor 承接）；SpatialNode 按目标输出声道数重建（6/8，mock 下验证节点重建路径）。
// ---------------------------------------------------------------------------
describe('fusion：多声道物理输出（① output=multichannel 节点重建）', () => {
  beforeEach(() => {
    mockSpatial.instances.length = 0
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级状态
  })

  it('output=multichannel 时 config 不变（speakers 与 binaural 相同——渲染由 processor 物理映射承接，注释）', () => {
    const p = createDefaultSpatialParams()
    p.mode = 'headLocked' // 默认 5.1 布局
    const binaural = spatialConfigFromParams(p)
    p.output = 'multichannel'
    const mc = spatialConfigFromParams(p)
    expect(mc.speakers).toEqual(binaural.speakers) // 扬声器布局完全一致
    expect(mc).toEqual(binaural) // 输出模式不改变渲染配置（节点重建在 syncSpatialChain）
    // 其余模式同样：instant/world/stage 的 speakers 与 binaural 一致
    const q = createDefaultSpatialParams()
    q.mode = 'stage'
    const qb = spatialConfigFromParams(q)
    q.output = 'multichannel'
    expect(spatialConfigFromParams(q).speakers).toEqual(qb.speakers)
  })

  it('syncSpatialChain：output 切到 multichannel → 重建节点 outputChannels=6（默认），切回 binaural → 2', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    const getV3 = () => v3 as unknown as AudioNode
    // 1) binaural 接线（outputChannels=2）
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant' })
    await syncSpatialChain(getV3, { audioContext: ctx, analyser })
    expect(mockSpatial.instances).toHaveLength(1)
    expect(mockSpatial.instances[0].outputChannels).toBe(2)
    // 2) 切到 multichannel（instant → 其它 → 6）→ 重建
    patchSpatialParams({ output: 'multichannel' })
    await flush()
    expect(mockSpatial.instances).toHaveLength(2)
    expect(mockSpatial.instances[1].outputChannels).toBe(6)
    // 3) 切回 binaural → 重建回 2
    patchSpatialParams({ output: 'binaural' })
    await flush()
    expect(mockSpatial.instances).toHaveLength(3)
    expect(mockSpatial.instances[2].outputChannels).toBe(2)
    // 4) 再切 multichannel → 重建回 6
    patchSpatialParams({ output: 'multichannel' })
    await flush()
    expect(mockSpatial.instances).toHaveLength(4)
    expect(mockSpatial.instances[3].outputChannels).toBe(6)
    // 5) 声道数不变 → 仅重发 config，不重建
    patchSpatialParams({ masterGain: 0.7 })
    await flush()
    expect(mockSpatial.instances).toHaveLength(4) // 无新节点
    expect(mockSpatial.instances[3].postConfig).toHaveBeenCalled()
  })

  it('syncSpatialChain：headLocked 714 + multichannel → 重建 outputChannels=8（7.1.4）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    setSpatialParams({
      ...createDefaultSpatialParams(),
      mode: 'headLocked',
      output: 'multichannel',
      headLocked: { layout: '714', speakers: createLayoutSpeakers('714'), heightLayer: true, bottomLayer: true, routes: [] },
    })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    expect(mockSpatial.instances).toHaveLength(1)
    expect(mockSpatial.instances[0].outputChannels).toBe(8)
  })

  it('syncSpatialChain：headLocked 51 + multichannel → 6（5.1），714 切 51 → 重建回 6', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    const getV3 = () => v3 as unknown as AudioNode
    setSpatialParams({
      ...createDefaultSpatialParams(),
      mode: 'headLocked',
      output: 'multichannel',
      headLocked: { layout: '714', speakers: createLayoutSpeakers('714'), heightLayer: true, bottomLayer: true, routes: [] },
    })
    await syncSpatialChain(getV3, { audioContext: ctx, analyser })
    expect(mockSpatial.instances[0].outputChannels).toBe(8)
    // 714 → 51（布局类型变化 → 目标声道数 8 → 6 → 重建）
    patchSpatialParams({
      headLocked: { layout: '51', speakers: createLayoutSpeakers('51'), heightLayer: true, bottomLayer: true, routes: [] },
    })
    await flush()
    expect(mockSpatial.instances).toHaveLength(2)
    expect(mockSpatial.instances[1].outputChannels).toBe(6)
  })

  it('multichannelChannels=8 显式覆盖：instant + multichannel → 8（优先于布局推导的 6）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    setSpatialParams({
      ...createDefaultSpatialParams(),
      mode: 'instant',
      output: 'multichannel',
      multichannelChannels: 8,
    })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    expect(mockSpatial.instances).toHaveLength(1)
    expect(mockSpatial.instances[0].outputChannels).toBe(8)
  })

  it('mode=off（未激活）→ 不接线（无节点）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub()
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'off', output: 'multichannel' })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    expect(mockSpatial.instances).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 输出设备选择（§5.6）：listOutputDevices（enumerateDevices 枚举/降级）+
// setOutputDevice（持久化 + setSinkId 应用）+ applySinkId（attach 恢复）。
// 注：fusion 模块态 spatialCtx/lastHandle 跨用例保留（既有范式），需要「未接线」
// 干净态的用例用 vi.resetModules + 动态 import 重建模块实例（放在本块末尾）。
// ---------------------------------------------------------------------------
describe('fusion：输出设备选择（listOutputDevices / setOutputDevice / applySinkId）', () => {
  beforeEach(() => {
    setSpatialParams(createDefaultSpatialParams()) // 隔离模块级参数状态
  })

  afterEach(() => {
    vi.unstubAllGlobals() // 清理 navigator/window stub，避免污染后续用例
  })

  it('listOutputDevices：无 navigator.mediaDevices → []（不抛）', async () => {
    vi.stubGlobal('navigator', {}) // Node 环境无 mediaDevices 的最简形态
    await expect(listOutputDevices()).resolves.toEqual([])
  })

  it('listOutputDevices：过滤 audiooutput，空 label 回退「输出设备 N」', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: '麦克风' },
          { kind: 'audiooutput', deviceId: 'out-1', label: '扬声器 A' },
          { kind: 'audiooutput', deviceId: 'out-2', label: '' }, // 无权限 → 空 label
        ]),
      },
    })
    await expect(listOutputDevices()).resolves.toEqual([
      { deviceId: 'out-1', label: '扬声器 A' },
      { deviceId: 'out-2', label: '输出设备 2' }, // 占位名按 audiooutput 序号
    ])
  })

  it('listOutputDevices：enumerateDevices 抛错（权限拒绝）→ []（不抛）', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => {
          throw new Error('permission denied')
        }),
      },
    })
    await expect(listOutputDevices()).resolves.toEqual([])
  })

  it('setOutputDevice：已接线且上下文支持 setSinkId → 应用并返回 true', async () => {
    const setSinkId = vi.fn(async () => undefined)
    const ctx = { sampleRate: 48000, audioWorklet: {}, setSinkId } as unknown as AudioContext
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant' })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(setOutputDevice('dev-9')).resolves.toBe(true)
    expect(setSinkId).toHaveBeenCalledWith('dev-9') // 热切换目标设备
    expect(getSpatialParams().sinkId).toBe('dev-9') // 快照已写入（随空间参数持久化）
  })

  it('setOutputDevice(null)：已接线 → setSinkId("") 恢复系统默认并清除快照', async () => {
    const setSinkId = vi.fn(async () => undefined)
    const ctx = { sampleRate: 48000, audioWorklet: {}, setSinkId } as unknown as AudioContext
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant', sinkId: 'dev-9' })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(setOutputDevice(null)).resolves.toBe(true)
    expect(setSinkId).toHaveBeenCalledWith('') // 规范语义：空串 = 复位默认设备
    expect(getSpatialParams().sinkId).toBeUndefined() // 快照清除（JSON 序列化丢弃）
  })

  it('setOutputDevice：上下文不支持 setSinkId → false（持久化仍生效，下次 attach 重试）', async () => {
    const { ctx, analyser, v3 } = audioGraphStub() // 该桩无 setSinkId（旧 Chromium/Electron）
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant' })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(setOutputDevice('dev-x')).resolves.toBe(false)
    expect(getSpatialParams().sinkId).toBe('dev-x') // 持久化不受影响
  })

  it('applySinkId：无已保存 sinkId → true（系统默认，无需应用）', async () => {
    await expect(applySinkId()).resolves.toBe(true)
  })

  it('applySinkId：有已保存 sinkId 且已接线 → setSinkId 应用并返回 true', async () => {
    const setSinkId = vi.fn(async () => undefined)
    const ctx = { sampleRate: 48000, audioWorklet: {}, setSinkId } as unknown as AudioContext
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant', sinkId: 'dev-abc' })
    await syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(applySinkId()).resolves.toBe(true)
    expect(setSinkId).toHaveBeenCalledWith('dev-abc') // attach 恢复已保存设备
  })

  // —— 未接线（无上下文可应用）语义：vi.resetModules 重建干净模块态（本块最后）——
  it('setOutputDevice：无 ctx（未接线）→ 仅持久化并返回 true（下次 attach 由 applySinkId 恢复）', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    await expect(f.setOutputDevice('dev-123')).resolves.toBe(true)
    expect(f.getSpatialParams().sinkId).toBe('dev-123') // 仅快照生效，无 setSinkId 调用
  })

  it('applySinkId：有已保存 sinkId 但无 ctx → false（不抛，下次 attach 重试）', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    f.patchSpatialParams({ sinkId: 'dev-xyz' }) // 干净模块：默认参数 + sinkId
    await expect(f.applySinkId()).resolves.toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 播放/暂停（规划书「空格 | 播放/暂停」+ §5.6 工具栏播放控制）：togglePlayback =
// 暂停/恢复整个音频上下文（AudioContext.suspend/resume，音乐与调音室同步暂停）。
// 无 ctx（未接线）→ false 不抛；suspend/resume 抛错 → false 不抛。
// 模块态 spatialCtx/lastHandle 跨用例保留（既有范式），干净态用 vi.resetModules 重建。
// ---------------------------------------------------------------------------
describe('fusion：播放/暂停（togglePlayback）', () => {
  it('无 ctx（未接线，Node 环境天然无 AudioContext 接线）→ 返回 false，不抛', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    await expect(f.togglePlayback()).resolves.toBe(false)
  })

  it('ctx running → suspend（暂停）；suspended → resume（恢复）——上下文级切换', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    const suspend = vi.fn(async () => undefined)
    const resume = vi.fn(async () => undefined)
    const ctx = { state: 'running', suspend, resume, sampleRate: 48000, audioWorklet: {} } as unknown as AudioContext
    ;(globalThis as Record<string, unknown>).AudioWorkletNode = class AudioWorkletNode {}
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    f.setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant' })
    await f.syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    // running → suspend（暂停整个音频上下文）
    await expect(f.togglePlayback()).resolves.toBe(true)
    expect(suspend).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    // suspended → resume（恢复播放）
    ;(ctx as { state: string }).state = 'suspended'
    await expect(f.togglePlayback()).resolves.toBe(true)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('suspend 抛错（上下文异常）→ 返回 false，不抛', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    const suspend = vi.fn(async () => {
      throw new Error('context closed')
    })
    const ctx = { state: 'running', suspend, resume: vi.fn(), sampleRate: 48000, audioWorklet: {} } as unknown as AudioContext
    ;(globalThis as Record<string, unknown>).AudioWorkletNode = class AudioWorkletNode {}
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    f.setSpatialParams({ ...createDefaultSpatialParams(), mode: 'instant' })
    await f.syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(f.togglePlayback()).resolves.toBe(false)
    expect(suspend).toHaveBeenCalledTimes(1)
  })

  it('lastHandle 兜底：空间模式未开启（mode=off 不接线）但 attach 记录过句柄 → 同样生效', async () => {
    vi.resetModules()
    const f = await import('../fusion')
    const suspend = vi.fn(async () => undefined)
    const ctx = { state: 'running', suspend, resume: vi.fn(), sampleRate: 48000, audioWorklet: {} } as unknown as AudioContext
    const analyser = {} as AnalyserNode
    const v3 = { disconnect: vi.fn(), connect: vi.fn() }
    // mode=off：syncSpatialChain 不接线（spatialCtx 不记录），但 lastHandle 仍保存
    f.setSpatialParams({ ...createDefaultSpatialParams(), mode: 'off' })
    await f.syncSpatialChain(() => v3 as unknown as AudioNode, { audioContext: ctx, analyser })
    await expect(f.togglePlayback()).resolves.toBe(true)
    expect(suspend).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 状态栏 CPU% 估算（规划书 §5.6）：estimateCpuPercent = avgProcessMs / 块墙钟时长
//   - 块长按 256 样本 @48kHz 约定（墙钟 ≈5.33ms）：avgProcessMs=1.2 → 22.5%；
//   - null stats / 未回传 avgProcessMs / 非有限值 → null（UI 显示「—」）；
//   - 结果钳制 0..100。
// ---------------------------------------------------------------------------
describe('fusion：estimateCpuPercent（worklet avgProcessMs → CPU%）', () => {
  it('avgProcessMs=1.2 → ~22.5%（256 样本块 @48kHz：1.2ms / (256/48000·1000)ms = 22.5%）', () => {
    expect(estimateCpuPercent({ latencySamples: 512, backend: 'ts', avgProcessMs: 1.2 })).toBeCloseTo(22.5, 5)
  })

  it('null stats / 未回传 avgProcessMs / 非有限值 → null（UI 显示「—」）', () => {
    expect(estimateCpuPercent(null)).toBeNull()
    expect(estimateCpuPercent({ latencySamples: 512, backend: 'ts' })).toBeNull()
    expect(estimateCpuPercent({ latencySamples: 512, backend: 'ts', avgProcessMs: Number.NaN })).toBeNull()
  })

  it('钳制 0..100（超大耗时 → 100；零耗时 → 0）', () => {
    expect(estimateCpuPercent({ latencySamples: 0, backend: 'ts', avgProcessMs: 9999 })).toBe(100)
    expect(estimateCpuPercent({ latencySamples: 0, backend: 'ts', avgProcessMs: 0 })).toBe(0)
  })
})

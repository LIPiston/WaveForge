/**
 * SpatialProcessor 纯函数测试（① 多声道物理输出映射）
 *
 * 覆盖：mapSpeakersToPhysical / physicalChannelIndex —— 5.1/7.1 布局方位角分类、
 * 标准声道序（0=FL 1=FR 2=FC 3=LFE 4=SL 5=SR 6=RL 7=RR）、LFE 静音占位、
 * 输出声道数截断。处理器类本身依赖 AudioWorklet 全局作用域（Node 不可实例化），
 * 物理渲染路径的方位角分类由本文件的纯函数与融合层测试共同覆盖。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { VirtualSpeaker } from '../types'

// SpatialProcessor.ts 的类定义在模块求值时执行 extends AudioWorkletProcessor——
// Node 环境无该全局符号：先 stub 空基类，再**动态导入**（静态 import 会先于
// beforeAll 求值导致 ReferenceError）。registerProcessor 守卫在 Node 下跳过注册。
let mapSpeakersToPhysical: ((speakers: VirtualSpeaker[], outChannels: number) => number[]) | null = null
let physicalChannelIndex: ((azimuthDeg: number) => number) | null = null
let PHYSICAL_CHANNEL_ORDER: readonly string[] | null = null

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).AudioWorkletProcessor = class AudioWorkletProcessor {}
  const mod = await import('../SpatialProcessor')
  mapSpeakersToPhysical = mod.mapSpeakersToPhysical
  physicalChannelIndex = mod.physicalChannelIndex
  PHYSICAL_CHANNEL_ORDER = mod.PHYSICAL_CHANNEL_ORDER
})
afterAll(() => {
  delete (globalThis as Record<string, unknown>).AudioWorkletProcessor
})

describe('physicalChannelIndex：方位角 → 物理声道分类', () => {
  it('标准声道顺序常量：0=FL、1=FR、2=FC、3=LFE、4=SL、5=SR、6=RL、7=RR', () => {
    expect(PHYSICAL_CHANNEL_ORDER).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'RL', 'RR'])
  })

  it('az≈0（|az|<30°）→ FC（2）', () => {
    expect(physicalChannelIndex!(0)).toBe(2)
    expect(physicalChannelIndex!(10)).toBe(2)
    expect(physicalChannelIndex!(-29)).toBe(2)
    expect(physicalChannelIndex!(29)).toBe(2)
  })

  it('az<0：|az|<60°→FL（0）、60..140°→SL（4）、≥140°→RL（6）', () => {
    expect(physicalChannelIndex!(-30)).toBe(0) // FL
    expect(physicalChannelIndex!(-45)).toBe(0)
    expect(physicalChannelIndex!(-59)).toBe(0)
    expect(physicalChannelIndex!(-60)).toBe(4) // SL（60° 边界入 SL）
    expect(physicalChannelIndex!(-90)).toBe(4)
    expect(physicalChannelIndex!(-110)).toBe(4)
    expect(physicalChannelIndex!(-139)).toBe(4)
    expect(physicalChannelIndex!(-140)).toBe(6) // RL（≥140°）
    expect(physicalChannelIndex!(-170)).toBe(6)
    expect(physicalChannelIndex!(-180)).toBe(6)
  })

  it('az>0 对称：→FR（1）/SR（5）/RR（7）', () => {
    expect(physicalChannelIndex!(30)).toBe(1) // FR
    expect(physicalChannelIndex!(59)).toBe(1)
    expect(physicalChannelIndex!(60)).toBe(5) // SR
    expect(physicalChannelIndex!(110)).toBe(5)
    expect(physicalChannelIndex!(139)).toBe(5)
    expect(physicalChannelIndex!(140)).toBe(7) // RR
    expect(physicalChannelIndex!(180)).toBe(7)
  })
})

describe('mapSpeakersToPhysical：speakers → 每物理声道增益', () => {
  const spk = (channel: number, azimuthDeg: number, gain = 1): VirtualSpeaker => ({
    channel,
    azimuthDeg,
    elevationDeg: 0,
    distance: 1.5,
    gain,
    size: 0,
  })

  it('5.1 布局（multichannelLayout）：FL/FR/C/SL/SR → 0/1/2/4/5，LFE（channel 3）静音占位、LFE 物理声道恒 0', () => {
    const speakers = [
      spk(0, -30), // FL
      spk(1, 30), // FR
      spk(2, 0), // C
      spk(3, 0, 0), // LFE 静音占位（gain 0）
      spk(4, -110), // SL
      spk(5, 110), // SR
    ]
    const gains = mapSpeakersToPhysical!(speakers, 6)
    expect(gains).toEqual([1, 1, 1, 0, 1, 1]) // FL FR FC LFE SL SR
  })

  it('7.1 布局：+RL/RR（channel 6/7，±140°）→ 物理 6/7', () => {
    const speakers = [
      spk(0, -30),
      spk(1, 30),
      spk(2, 0),
      spk(3, 0, 0),
      spk(4, -110),
      spk(5, 110),
      spk(6, -140), // RL
      spk(7, 140), // RR
    ]
    expect(mapSpeakersToPhysical!(speakers, 8)).toEqual([1, 1, 1, 0, 1, 1, 1, 1])
  })

  it('多只扬声器映射同一声道 → 增益累加（headLocked 714 顶置层与地面层同分类）', () => {
    // TFL(-45°)/FL(-30°) 均 → FL（0）；TFR(45°)/FR(30°) 均 → FR（1）
    const speakers = [spk(0, -45), spk(0, -30), spk(1, 45), spk(1, 30)]
    expect(mapSpeakersToPhysical!(speakers, 6)).toEqual([2, 2, 0, 0, 0, 0])
  })

  it('输出声道数截断：outChannels=2 时仅 FL/FR 有增益，其余分类丢弃', () => {
    const speakers = [spk(0, -30), spk(1, 30), spk(2, 0), spk(4, -110)]
    expect(mapSpeakersToPhysical!(speakers, 2)).toEqual([1, 1])
  })

  it('LFE 输入（channel 3）静音占位：即使方位角 0 也不映射（物理 LFE 声道恒 0）', () => {
    // 用户自定义布局给 channel 3 配了增益 → 仍按 LFE 占位忽略
    const speakers = [spk(3, 0, 0.8), spk(0, -30)]
    expect(mapSpeakersToPhysical!(speakers, 6)).toEqual([1, 0, 0, 0, 0, 0])
  })

  it('无扬声器 → 全 0（无扬声器映射的声道输出 0）', () => {
    expect(mapSpeakersToPhysical!([], 6)).toEqual([0, 0, 0, 0, 0, 0])
  })
})

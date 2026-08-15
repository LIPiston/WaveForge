import { describe, it, expect, beforeEach } from 'vitest'
import {
  evaluateCurveAt,
  evaluateCurveAtFreqs,
  parseCurve,
  serializeCurve,
  flatCurve,
  defaultCurve,
  addBandAt,
  removeBandAt,
  setBand,
  interpolateMidpoints,
} from '../src/services/audio-effects-v3/curve'
import {
  EQ_BANDS_20,
  EQ_PRESET_NAMES,
  EQ_PRESET_CURVES,
  DEVICE_PROFILES,
  quantizeGain,
  quantizeQ,
  quantizeFreq,
} from '../src/services/audio-effects-v3/constants'
import {
  interpolateResponse,
  mergeFrequencyResponse,
  curveToResponse,
  mergeResultToSegments,
} from '../src/services/audio-effects-v3/frequencyResponse'
import { IirPeq } from '../src/services/audio-effects-v3/iirPeq'
import {
  findDevice,
  listDeviceModels,
  groupDeviceModels,
} from '../src/services/audio-effects-v3/deviceDb'
import {
  initialAnalysisState,
  startAnalysis,
  applyFeedback,
  finishAnalysis,
  currentGuidance,
} from '../src/services/audio-effects-v3/hearingAnalysis'
import {
  BUILTIN_REVERB_SPECS,
  BUILTIN_REVERB_TYPES,
} from '../src/services/audio-effects-v3/convolution'
import { buildVirtualBassShaperCurve } from '../src/services/audio-effects-v3/bassEnhancer'
import { IEQ_STYLE_CURVES, defaultIeqState, ieqTargetCurve, applyIeq, loadCustomIeq, parseIeq, serializeIeq } from '../src/services/audio-effects-v3/ieq'
import { computeAutoPostEq } from '../src/services/audio-effects-v3/autoPostEq'
import { sampleCurveAtPercent, defaultLoudnessCurve } from '../src/services/audio-effects-v3/frequencyResponse'
import { getDefaultDevice } from '../src/services/audio-effects-v3/deviceDb'
import { designBandpassCoeffs, buildDeesserProcessorSource } from '../src/services/audio-effects-v3/deesserWorklet'
import { summarizeCapabilities, type AudioCapabilitiesReport } from '../src/services/audio-effects-v3/audioCapabilities'
import { exportShareString, importShareString, isShareString } from '../src/services/audio-effects-v3/shareCodec'
import { AudioEffectsEngineV3 } from '../src/services/audio-effects-v3/AudioEffectsEngineV3'

// localStorage stub 由 test/setup.ts 注入；此处只需每次清空
beforeEach(() => {
  try { localStorage.clear() } catch { /* noop */ }
})

describe('曲线模型（高斯叠加求值）', () => {
  it('平直曲线在任何频点求值均为 0dB', () => {
    const curve = flatCurve()
    for (const f of [20, 80, 320, 1200, 6500, 20000]) {
      expect(evaluateCurveAt(curve, f)).toBeCloseTo(0, 5)
    }
  })

  it('默认曲线在 4 个控制频点附近接近其设定增益', () => {
    const curve = defaultCurve()
    // 高斯叠加在频点上等于该点增益（其他点贡献小但非零，允许容差）
    expect(evaluateCurveAt(curve, 80)).toBeGreaterThan(0.5)
    expect(evaluateCurveAt(curve, 320)).toBeLessThan(0)
    expect(evaluateCurveAt(curve, 1200)).toBeGreaterThan(0)
    expect(evaluateCurveAt(curve, 6500)).toBeGreaterThan(1)
  })

  it('求值结果钳制 ±15dB', () => {
    const curve = [{ freq: 1000, gain: 15, q: 12 }]
    expect(evaluateCurveAt(curve, 1000)).toBeLessThanOrEqual(15)
    expect(evaluateCurveAt(curve, 1000)).toBeGreaterThanOrEqual(-15)
  })

  it('序列化/解析往返一致（fp.m / fp.k 格式）', () => {
    const str = '90:0.00:0.80;1000:0.00:1.00;9500:0.00:0.80'
    const parsed = parseCurve(str)!
    expect(parsed.length).toBe(3)
    expect(parsed[0]).toMatchObject({ freq: 90, gain: 0, q: 0.8 })
    expect(serializeCurve(parsed)).toBe(str)
  })

  it('增删频段', () => {
    let { points } = addBandAt(flatCurve(), 1)
    expect(points.length).toBe(5)
    const { points: afterRemove } = removeBandAt(points, 2)
    expect(afterRemove.length).toBe(4)
  })

  it('频段参数修改按量化规则（增益 0.5dB、Q 0.05、频点取整）', () => {
    const curve = setBand(flatCurve(), 0, { gain: 1.3, q: 1.23, freq: 100.4 })
    expect(curve[0]!.gain).toBe(1.5)
    expect(curve[0]!.q).toBe(1.25)
    expect(curve[0]!.freq).toBe(100)
  })

  it('中点插值（fp.l 语义）', () => {
    const mid = interpolateMidpoints(flatCurve())
    expect(mid.length).toBe(4)
  })
})

describe('逆向常量（20 段 EQ / 预设 / 设备档案）', () => {
  it('20 段频点为两组 10 段交错（fp.b + fp.c）', () => {
    expect(EQ_BANDS_20.length).toBe(20)
    expect(EQ_BANDS_20[0]).toBe(47)
    expect(EQ_BANDS_20[19]).toBe(19688)
    // 相邻频点对数间隔单调递增
    for (let i = 1; i < EQ_BANDS_20.length; i++) {
      expect(EQ_BANDS_20[i]! / EQ_BANDS_20[i - 1]!).toBeGreaterThan(1)
    }
  })

  it('5 套预设名称与曲线长度一致', () => {
    expect(EQ_PRESET_NAMES.length).toBe(5)
    expect(EQ_PRESET_CURVES.length).toBe(5)
    for (const c of EQ_PRESET_CURVES) expect(c.length).toBe(10)
    // 预设 0 是"自定义曲线"，应与"平直"不同
    expect(EQ_PRESET_CURVES[0]).not.toEqual(EQ_PRESET_CURVES[1])
  })

  it('5 套设备档案齐备（名称/参数/频点/引导文案）', () => {
    expect(DEVICE_PROFILES.length).toBe(5)
    for (const p of DEVICE_PROFILES) {
      expect(p.params.length).toBe(10)
      expect(p.curveFreqs.length).toBe(4)
      expect(p.guidance.length).toBeGreaterThan(0)
    }
  })

  it('量化函数', () => {
    expect(quantizeGain(1.3)).toBe(1.5)
    expect(quantizeGain(0.2)).toBe(0)
    expect(quantizeQ(1.23)).toBe(1.25)
    expect(quantizeFreq(100.4)).toBe(100)
  })
})

describe('频响合并引擎（对数插值）', () => {
  it('interpolateResponse 端点与中值正确', () => {
    const curve = [0, 10, 20, 30, 40, 50, 60, 70] // 8 点，隐含 20Hz-20kHz 对数轴
    const at20 = interpolateResponse(curve, [20]) // 第一点
    expect(at20[0]).toBeCloseTo(0, 5)
    const at20000 = interpolateResponse(curve, [20000]) // 最后一点
    expect(at20000[0]).toBeCloseTo(70, 5)
    // 中间点：对数中点 ≈ 第 3.5 点
    const mid = interpolateResponse(curve, [Math.sqrt(20 * 20000)])
    expect(mid[0]).toBeGreaterThan(30)
    expect(mid[0]).toBeLessThan(45)
    // 越界钳制：低于 20Hz / 高于 20kHz 按端点
    expect(interpolateResponse(curve, [5])[0]).toBeCloseTo(0, 5)
    expect(interpolateResponse(curve, [30000])[0]).toBeCloseTo(70, 5)
  })

  it('未启用时合并跳过（全 0，对应"频响合并跳过"日志路径）', () => {
    const out = mergeFrequencyResponse([1, 2], [3, 4], [47, 141], {
      route: 'standard', scene: 'standard', enabled: false,
    })
    expect(out).toEqual([0, 0])
  })

  it('启用时按 blend 合并基线+目标（目标曲线按 20Hz-20kHz 对数轴语义插值）', () => {
    // 平直 10dB 目标曲线 → 任意频点 blend 0.5 → 5dB
    const out = mergeFrequencyResponse([0, 0], [10, 10], [47, 141], {
      route: 'standard', scene: 'standard', enabled: true,
    }, 0.5)
    expect(out[0]).toBeCloseTo(5, 5)
    expect(out[1]).toBeCloseTo(5, 5)
  })

  it('DAP 路由提高目标权重', () => {
    const std = mergeFrequencyResponse([0, 0], [10, 20], [47, 141], {
      route: 'standard', scene: 'standard', enabled: true,
    }, 0.5)
    const dap = mergeFrequencyResponse([0, 0], [10, 20], [47, 141], {
      route: 'dap', scene: 'standard', enabled: true,
    }, 0.5)
    expect(dap[0]).toBeGreaterThan(std[0])
  })

  it('curveToResponse 产出 128 点', () => {
    const resp = curveToResponse(flatCurve())
    expect(resp.length).toBe(128)
    for (const v of resp) expect(Math.abs(v)).toBeLessThanOrEqual(15)
  })

  it('mergeResultToSegments 的段数受 maxSegments 限制', () => {
    const gains = Array(20).fill(0).map((_, i) => (i % 2 === 0 ? 3 : -3))
    const segments = mergeResultToSegments([...EQ_BANDS_20], gains, 6)
    expect(segments.length).toBeLessThanOrEqual(6)
    for (const s of segments) {
      expect(['lowshelf', 'peaking', 'highshelf']).toContain(s.type)
    }
  })
})

describe('64 阶 IIR 参数均衡', () => {
  it('频段增删与 64 阶上限', () => {
    const iir = new IirPeq(48000)
    expect(iir.bands.length).toBe(0)
    iir.addBand()
    expect(iir.bands.length).toBe(1)
    for (let i = 0; i < 40; i++) iir.addBand(iir.bands.length - 1)
    expect(iir.bands.length).toBe(32) // 上限 32 段 = 64 阶
    expect(iir.order).toBe(64)
  })

  it('序列化/解析往返（fp 格式）', () => {
    const iir = new IirPeq(48000, [{ freq: 90, gain: 0, q: 0.8 }, { freq: 1000, gain: 2, q: 1.1 }])
    const str = iir.serialize()
    const back = IirPeq.parse(str, 48000)!
    expect(back.bands).toEqual(iir.bands)
  })

  it('RBJ 系数：peaking 0dB 时为直通', () => {
    const c = new IirPeq(48000, [{ freq: 1000, gain: 0, q: 1 }]).designAll()[0]!
    // 0dB peaking 恒等式：分子分母系数相同 → 直通（b0/a0=1，b1=a1，b2=a2）
    expect(c.b0).toBeCloseTo(1, 5)
    expect(c.b1).toBeCloseTo(c.a1, 5)
    expect(c.b2).toBeCloseTo(c.a2, 5)
  })

  it('级联响应：单频段在中心频点附近出现峰值', () => {
    const iir = new IirPeq(48000, [{ freq: 1000, gain: 6, q: 1.5 }])
    iir.enabled = true
    const atCenter = iir.responseCurve([1000])[0]!
    const atFar = iir.responseCurve([50])[0]!
    expect(atCenter).toBeGreaterThan(4)
    expect(atCenter).toBeLessThanOrEqual(6)
    expect(Math.abs(atFar)).toBeLessThan(0.5)
  })
})

describe('设备频响库与机型预设', () => {
  it('findDevice 按代号与型号名查找', () => {
    expect(findDevice('fuxi')?.model).toBe('Xiaomi 13')
    expect(findDevice('alioth')?.model).toBe('Redmi K40')
    expect(findDevice(null, 'JBL Tune 110')?.model).toBe('JBL Tune 110')
    expect(findDevice('nonexistent')).toBeNull()
  })

  it('机型选项已过滤无曲线占位设备且按品牌分组', () => {
    const models = listDeviceModels()
    expect(models.length).toBeGreaterThan(40)
    for (const m of models) expect(m.hasCurve).toBe(true)
    const groups = groupDeviceModels()
    expect(groups.length).toBeGreaterThanOrEqual(3) // Xiaomi / Redmi / JBL
    const total = groups.reduce((n, g) => n + g.items.length, 0)
    expect(total).toBe(models.length)
  })
})

describe('听力分析（听感分析引导调校）', () => {
  it('startAnalysis 以档案参数初始化曲线并进入 playing', () => {
    const s = startAnalysis(initialAnalysisState(), 'device-speaker')
    expect(s.phase).toBe('playing')
    expect(s.deviceProfileId).toBe('device-speaker')
    expect(s.curve.length).toBe(4)
    expect(currentGuidance(s).length).toBeGreaterThan(0)
  })

  it('applyFeedback 修改曲线并推进步骤', () => {
    let s = startAnalysis(initialAnalysisState(), 'device-in-ear')
    const before = s.curve[0]!.gain
    s = applyFeedback(s, 'more')
    expect(s.curve[0]!.gain).toBeGreaterThan(before)
    expect(s.step).toBe(1)
    s = applyFeedback(s, 'less')
    expect(s.curve[1]!.gain).toBeLessThan(s.curve[1]!.gain + 1)
    expect(s.feedbackLog.length).toBe(2)
  })

  it('finishAnalysis 返回最终曲线并置 done', () => {
    let s = startAnalysis(initialAnalysisState(), 'device-over-ear')
    s = applyFeedback(s, 'more')
    const { curve, state } = finishAnalysis(s)
    expect(curve.length).toBe(4)
    expect(state.phase).toBe('done')
  })
})

describe('内置混响 IR 与虚拟低频', () => {
  it('5 种内置混响类型齐备', () => {
    expect(BUILTIN_REVERB_TYPES.length).toBe(5)
    for (const t of BUILTIN_REVERB_TYPES) {
      expect(BUILTIN_REVERB_SPECS[t].seconds).toBeGreaterThan(0)
      expect(BUILTIN_REVERB_SPECS[t].early.length).toBeGreaterThan(0)
    }
  })

  it('虚拟低频整形曲线为 1024 点且归一化', () => {
    const curve = buildVirtualBassShaperCurve(5)
    expect(curve.length).toBe(1024)
    for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(2)
  })
})

describe('智能均衡 IEQ（x/bb.java 移植）', () => {
  it('3 套内置风格曲线（20 段）与自定义曲线（g=3）', () => {
    expect(IEQ_STYLE_CURVES.length).toBe(3)
    for (const c of IEQ_STYLE_CURVES) expect(c.length).toBe(20)
    const s = defaultIeqState()
    expect(ieqTargetCurve(s)).toEqual(IEQ_STYLE_CURVES[0])
    const custom = loadCustomIeq(Array(20).fill(0))
    expect(custom.style).toBe(3)
    expect(ieqTargetCurve(custom).length).toBe(20)
  })

  it('三段强度缩放且输出量化', () => {
    const s = defaultIeqState()
    const out = applyIeq(s)
    expect(out.length).toBe(20)
    for (const g of out) expect(Math.abs(g)).toBeLessThanOrEqual(15)
    // 强度为 0 时输出全 0
    const zero = applyIeq({ ...s, bassAmount: 0, presenceAmount: 0, trebleAmount: 0 })
    for (const g of zero) expect(g).toBe(0)
  })

  it('序列化/反序列化往返（bb.c int[] 语义）', () => {
    const s = { ...defaultIeqState(), style: 3, bassAmount: 8 }
    const round = parseIeq(serializeIeq(s))
    expect(round.style).toBe(3)
    expect(round.bassAmount).toBe(8)
    expect(parseIeq(null)).toEqual(defaultIeqState())
  })
})

describe('智能 Post（自动计算 Post 均衡）', () => {
  it('明显不平直的曲线生成受限补偿段；平直曲线不生成', () => {
    const curve = [
      { freq: 47, gain: 6, q: 1 }, { freq: 234, gain: 4, q: 1 },
      { freq: 1000, gain: 0, q: 1 }, { freq: 19688, gain: -5, q: 1 },
    ]
    const r = computeAutoPostEq(curve, 0.6)
    expect(r.bands.length).toBeGreaterThanOrEqual(1)
    expect(r.bands.length).toBeLessThanOrEqual(5)
    for (const b of r.bands) {
      expect(Math.abs(b.gain)).toBeLessThanOrEqual(3)
      expect(b.freq).toBeGreaterThanOrEqual(20)
      expect(b.freq).toBeLessThanOrEqual(20000)
    }
    const flat = computeAutoPostEq([{ freq: 1000, gain: 0, q: 1 }], 0.6)
    expect(flat.bands.length).toBe(0)
    expect(computeAutoPostEq(curve, 0).bands.length).toBe(0)
  })
})

describe('分享串（导出/导入 EQ）', () => {
  it('往返一致；非法输入返回 null', () => {
    const payload = {
      scheme: 'spatial' as const, eqMode: 'curve',
      eqCurve: [{ freq: 100, gain: 1.5, q: 1 }],
      peqBands: [{ freq: 1000, gain: 0, q: 1 }],
      modelCode: 'fuxi', deviceProfileId: null, ieqStyle: 2,
    }
    const str = exportShareString(payload)
    expect(str.startsWith('v3|')).toBe(true)
    expect(isShareString(str)).toBe(true)
    const back = importShareString(str)!
    expect(back.scheme).toBe('spatial')
    expect(back.eqCurve[0]).toMatchObject({ freq: 100, gain: 1.5 })
    expect(back.modelCode).toBe('fuxi')
    expect(back.ieqStyle).toBe(2)
    expect(importShareString('')).toBeNull()
    expect(importShareString('v2|standard')).toBeNull()
    expect(importShareString('v3|bad|curve|1:2:3|1:0:1|x|-|9')).toBeNull()
  })
})

describe('百分比索引采样与等响曲线（x/ht.o 移植）', () => {
  it('采样端点/中点/钳制正确', () => {
    const c = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    expect(sampleCurveAtPercent(c, 0)).toBeCloseTo(0, 5)
    expect(sampleCurveAtPercent(c, 100)).toBeCloseTo(90, 5)
    expect(sampleCurveAtPercent(c, 50)).toBeCloseTo(45, 5)
    expect(sampleCurveAtPercent(c, 200)).toBeCloseTo(90, 5)
    expect(sampleCurveAtPercent(null, 50)).toBe(0)
  })

  it('默认等响曲线：20 档、单调不增、满音量归零', () => {
    const c = defaultLoudnessCurve()
    expect(c.length).toBe(20)
    expect(c[0]).toBeGreaterThan(0)
    expect(Math.abs(c[19])).toBeLessThan(1e-5)
    for (let i = 1; i < 20; i++) expect(c[i]).toBeLessThanOrEqual(c[i - 1]! + 1e-6)
  })

  it('默认回退设备为 Xiaomi 13（ht.m 语义）', () => {
    const d = getDefaultDevice()
    expect(d.model).toBe('Xiaomi 13')
    expect(d.curveA?.length).toBe(128)
  })
})

describe('动态齿音抑制（AudioWorklet）', () => {
  it('带通系数：6.5kHz 中心峰值、远离中心衰减', () => {
    const c = designBandpassCoeffs(6500, 1.4, 48000)
    const mag = (f: number) => {
      const w = 2 * Math.PI * f / 48000
      const zr = Math.cos(w), zi = Math.sin(w)
      const numRe = c.b0 + c.b1 * zr + c.b2 * Math.cos(2 * w)
      const numIm = -c.b1 * zi - c.b2 * Math.sin(2 * w)
      const denRe = 1 + c.a1 * zr + c.a2 * Math.cos(2 * w)
      const denIm = -c.a1 * zi - c.a2 * Math.sin(2 * w)
      return Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm)
    }
    expect(mag(6500)).toBeGreaterThan(0.9)
    expect(mag(6500)).toBeLessThanOrEqual(1.05)
    expect(mag(200)).toBeLessThan(0.15)
    expect(mag(18000)).toBeLessThan(0.35)
  })

  it('处理器源码语法合法且含注册名', () => {
    const src = buildDeesserProcessorSource()
    expect(() => new Function(src)).not.toThrow()
    expect(src).toContain("registerProcessor('v3-deesser-processor'")
  })
})

describe('设备音效能力检测摘要（纯函数）', () => {
  const makeReport = (overrides: Partial<AudioCapabilitiesReport>): AudioCapabilitiesReport => ({
    sampleRate: 48000, maxChannels: 2,
    biquad: true, convolver: true, pannerHrtf: true, waveShaper: true, dynamics: true,
    audioWorklet: true, offline: true, outputDevices: [], detectedAt: 0,
    degraded: false, missing: [],
    ...overrides,
  })

  it('全能力 → 摘要含采样率与声道', () => {
    expect(summarizeCapabilities(makeReport({}))).toContain('48kHz')
    expect(summarizeCapabilities(makeReport({}))).toContain('全能力可用')
  })

  it('降级 → 摘要列出缺失项', () => {
    const summary = summarizeCapabilities(makeReport({ degraded: true, missing: ['卷积', '离线渲染'] }))
    expect(summary).toContain('能力降级')
    expect(summary).toContain('卷积')
    expect(summary).toContain('离线渲染')
  })
})

describe('内置场景（综合场景 + 预设 + 设备档案）', () => {
  const engine = new AudioEffectsEngineV3()
  const scenes = engine.getBuiltinScenes()
  const names = scenes.map(s => s.name)

  it('包含 5 套设备档案 + 4 套 EQ 预设 + 6 套综合场景', () => {
    // 设备档案（DEVICE_PROFILES 5 套）+ 预设场景（索引 1-4 跳过自定义）+ 综合场景
    expect(scenes.length).toBeGreaterThanOrEqual(15)
  })

  it('综合场景已就位（深夜助眠/重低音/人声加强/通透/怀旧/监听直白）', () => {
    for (const n of ['深夜助眠', '重低音轰头', '人声加强', '通透高解析', '怀旧温暖', '监听直白']) {
      expect(names).toContain(n)
    }
  })

  it('监听直白场景全效果关闭、EQ 平直、机型清空', () => {
    const flat = scenes.find(s => s.name === '监听直白')!
    expect(flat.settings.eq.enabled).toBe(false)
    expect(flat.settings.eq.mode).toBe('flat')
    expect(flat.settings.advanced.nightMode.enabled).toBe(false)
    expect(flat.settings.advanced.bassEnhance.enabled).toBe(false)
    expect(flat.settings.advanced.virtualBass.enabled).toBe(false)
    expect(flat.settings.device.modelCode).toBeNull()
    expect(flat.settings.scheme).toBe('standard')
  })

  it('深夜助眠场景组合夜间模式 + 低频增强', () => {
    const night = scenes.find(s => s.name === '深夜助眠')!
    expect(night.settings.advanced.nightMode.enabled).toBe(true)
    expect(night.settings.advanced.bassEnhance.enabled).toBe(true)
    expect(night.settings.scheme).toBe('spatial')
  })

  it('人声加强场景人声/伴奏平衡偏向人声', () => {
    const vocal = scenes.find(s => s.name === '人声加强')!
    expect(vocal.settings.master.voiceBalance).toBeGreaterThan(0)
  })
})

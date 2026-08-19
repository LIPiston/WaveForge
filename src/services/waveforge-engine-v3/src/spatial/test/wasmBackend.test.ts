/**
 * wasmBackend.test.ts —— WasmHrtfBackend（rust/hrtf-core WASM）测试
 *
 * 覆盖：
 *   - getLatencySamples() === 512（分区长度，与 TS Convolver 对齐）；
 *   - delta 网格（脉冲 HRIR）：0° 单扬声器输出 ≈ 延迟 512 的缩放输入（增益 1/1.5），
 *     验证延迟与距离增益；
 *   - 干湿混合公式自检：out = ((1-amount)·dry + amount·wet) · master_gain
 *     （delta HRIR 下 wet = dry/1.5，用 DC 输入验证稳态与干路延迟）；
 *   - reset 清零流式状态；
 *   - 与 TsConvolverBackend 数值对拍（同一解析 HRTF 网格 + 同 config，
 *     固定种子随机输入、不规则分块含跨块连续性，逐样本 |a-b| ≤ 1e-5）。
 *
 * 球谐插值（spherical）追加（规划书 §4.1，真实 KEMAR 网格 hrtf-data/grid.bin）：
 *   - Rust spherical vs TS spherical 对拍：多方向（网格点 0/±30/±90/±135°
 *     与离网格 45° 仰角等）随机输入多块跨块，逐样本 |a-b| ≤ 1e-5
 *     （Rust 侧 SH 拟合与 TS 侧 hrtfInterp.ts 逐位对齐，容差有最大余量）；
 *   - Rust nearest 与 spherical 在网格点上的差异与 TS 一致（差值信号对拍）；
 *   - spatial_reset 不重置插值模式（配置语义）。
 *
 * 对拍组依赖代理 A 的 TsConvolverBackend.ts / analyticHrtf.ts：
 * 未落地时该组自动跳过（动态导入 + skipIf），收口阶段自动启用。
 *
 * 契约两函数（规划书 §3.2）追加：
 *   - wasm 导出计数 14 → 16（新增 spatial_get_hrir / spatial_set_distance_model）；
 *   - spatial_get_hrir：未 load → -1、len 不足 → -2（原始导出直调）；
 *     nearest 返回与网格该方向 HRIR 逐位一致（含环绕/仰角钳制）、spherical 与
 *     hrtfInterp.sphericalHrtf 对拍 ≤ 1e-5（真实 KEMAR 网格）；
 *   - spatial_set_distance_model：linear 与 inverse 渲染输出不同；与 set_config
 *     传参等价——两入口设置同一模型输出逐位一致（同一内部字段 + 同一 dist_gain 公式）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WasmHrtfBackend } from '../WasmHrtfBackend'
import { nearestGridIndex } from '../TsConvolverBackend'
import { sphericalHrtf } from '../hrtfInterp'
import type { DistanceModel, HrtfGrid, SpatialRenderConfig } from '../types'
import type { SpatialBackend } from '../SpatialBackend'

// ---------------------------------------------------------------------------
// wasm 产物加载（缺失 → 整组跳过并打印原因）
// ---------------------------------------------------------------------------
const WASM_PATH = fileURLToPath(new URL('../../../rust/hrtf-core/pkg/hrtf_core.wasm', import.meta.url))

let wasmBytes: Uint8Array | null = null
let wasmReason = ''
try {
  wasmBytes = readFileSync(WASM_PATH)
} catch (err) {
  wasmReason = `hrtf_core.wasm 缺失（${String(err)}）——请先执行 cargo build --release --target wasm32-unknown-unknown`
}
if (!wasmBytes) {
  console.warn(`[wasmBackend.test] 跳过 WASM 后端测试：${wasmReason}`)
}

// ---------------------------------------------------------------------------
// 真实 KEMAR 网格（球谐插值对拍用；hrtf-data/grid.bin 缺失 → 该组跳过）
// 解码布局见 gridSource.ts 文件头注释（u32 头 + f32 数组）。
// ---------------------------------------------------------------------------
const GRID_PATH = fileURLToPath(new URL('../../../hrtf-data/grid.bin', import.meta.url))

function decodeGridBin(bytes: Uint8Array): HrtfGrid {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  const readU32 = (): number => {
    const v = view.getUint32(off, true)
    off += 4
    return v
  }
  const readF32 = (): number => {
    const v = view.getFloat32(off, true)
    off += 4
    return v
  }
  const sampleRate = readU32()
  const azCount = readU32()
  const elCount = readU32()
  const hrirLen = readU32()
  if (azCount < 1 || azCount > 10000 || elCount < 1 || elCount > 10000 || hrirLen < 1 || hrirLen > 100000) {
    throw new Error('invalid grid header')
  }
  const azimuths = new Array<number>(azCount)
  for (let i = 0; i < azCount; i++) azimuths[i] = readF32()
  const elevations = new Array<number>(elCount)
  for (let i = 0; i < elCount; i++) elevations[i] = readF32()
  const n = elCount * azCount * hrirLen
  const need = 16 + (azCount + elCount + 2 * n) * 4
  if (bytes.byteLength < need) throw new Error('truncated grid data')
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) left[i] = readF32()
  for (let i = 0; i < n; i++) right[i] = readF32()
  return { sampleRate, azimuths, elevations, hrirLength: hrirLen, left, right }
}

let realGrid: HrtfGrid | null = null
let realGridReason = ''
try {
  realGrid = decodeGridBin(readFileSync(GRID_PATH))
} catch (err) {
  realGridReason = `hrtf-data/grid.bin 缺失或损坏（${String(err)}）`
}
if (!realGrid) {
  console.warn(`[wasmBackend.test] 跳过球谐插值对拍组：${realGridReason}`)
}

// ---------------------------------------------------------------------------
// TS 参考后端（动态导入：A 未落地时对拍组跳过，收口阶段自动启用）
// ---------------------------------------------------------------------------
let RefBackend: unknown = null
let generateAnalyticHrtfGridFn: ((sampleRate: number) => HrtfGrid) | null = null
let refReason = ''
try {
  // 变量形式动态导入：tsc 不做路径解析（文件未落地时类型检查不报错），
  // 运行时解析失败由 try/catch 捕获 → skipIf 跳过对拍组
  const refMod: Record<string, unknown> = await import('../TsConvolverBackend')
  const anMod: Record<string, unknown> = await import('../analyticHrtf')
  RefBackend = refMod.TsConvolverBackend
  generateAnalyticHrtfGridFn = anMod.generateAnalyticHrtfGrid as ((sampleRate: number) => HrtfGrid) | null
} catch (err) {
  refReason = `TsConvolverBackend/analyticHrtf 未落地（${String(err)}）——对拍组在收口阶段自动启用`
}
if (!RefBackend || !generateAnalyticHrtfGridFn) {
  console.warn(`[wasmBackend.test] 跳过 TS 对拍组：${refReason}`)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 固定种子随机数（mulberry32，确定性——两个后端必须吃同一输入序列） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** delta 网格：所有方向 HRIR 均为单位冲激（索引 0 处为 1），卷积即恒等 */
function deltaGrid(): HrtfGrid {
  const azimuths = [-90, 0, 90]
  const elevations = [-30, 0, 30]
  const hrirLength = 1
  const n = azimuths.length * elevations.length * hrirLength
  return {
    sampleRate: 48000,
    azimuths,
    elevations,
    hrirLength,
    left: new Float32Array(n).fill(1),
    right: new Float32Array(n).fill(1),
  }
}

function makeConfig(
  speakers: SpatialRenderConfig['speakers'],
  amount: number,
  distanceModel: DistanceModel,
  masterGain: number,
): SpatialRenderConfig {
  return {
    speakers,
    room: 'off',
    roomAmount: 0,
    amount,
    distanceModel,
    hrtfInterp: 'nearest',
    convolution: 'partitioned',
    masterGain,
  }
}

/** 0° 单扬声器（声道 0，距离 1.5，增益 1）——delta 网格下湿路 = 干路/1.5 */
function deltaSingleSpeakerConfig(amount: number, masterGain: number): SpatialRenderConfig {
  return makeConfig(
    [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
    amount,
    'inverse',
    masterGain,
  )
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------
describe.skipIf(!wasmBytes)('WasmHrtfBackend（rust/hrtf-core WASM）', () => {
  const bytes = wasmBytes as Uint8Array

  it('getLatencySamples() === 512（分区长度，与 TS 侧对齐）', () => {
    const backend = new WasmHrtfBackend(bytes)
    expect(backend.getLatencySamples()).toBe(512)
  })

  it('delta HRIR：0° 单扬声器输出 ≈ 延迟 512 的缩放输入（增益 1/1.5）', () => {
    const backend = new WasmHrtfBackend(bytes)
    backend.loadHrtf(deltaGrid())
    backend.setConfig(deltaSingleSpeakerConfig(1, 1)) // 纯湿：out = wetSum
    const N = 2048
    const inL = new Float32Array(N).fill(0.5)
    const inR = new Float32Array(N).fill(0.5)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    // 128 样本块喂入（非整块长，验证流式装配/放行连续性）
    for (let off = 0; off < N; off += 128) {
      backend.processStereo(
        inL.subarray(off, off + 128),
        inR.subarray(off, off + 128),
        outL.subarray(off, off + 128),
        outR.subarray(off, off + 128),
      )
    }
    // 延迟 512：前 512 样本恒 0（湿路未就绪）
    for (let i = 0; i < 512; i++) {
      expect(Math.abs(outL[i])).toBeLessThan(1e-7)
      expect(Math.abs(outR[i])).toBeLessThan(1e-7)
    }
    // 输出位置 512 起为湿路首样本（非零，验证"延迟 512"的起点）
    expect(Math.abs(outL[512])).toBeGreaterThan(0.01)
    expect(Math.abs(outR[512])).toBeGreaterThan(0.01)
    // DC 稳态：0.5 × 距离增益 min(1, 1/max(1.5,1)) = 1/3
    // （空气吸收一阶低通对 DC 增益为 1；留 64 样本收敛余量）
    for (let i = 512 + 64; i < N; i++) {
      expect(Math.abs(outL[i] - 1 / 3)).toBeLessThan(1e-3)
      expect(Math.abs(outR[i] - 1 / 3)).toBeLessThan(1e-3)
    }
  })

  it('干湿混合公式自检：out = ((1-amount)·dry + amount·wet)·master（含干路延迟验证）', () => {
    const backend = new WasmHrtfBackend(bytes)
    backend.loadHrtf(deltaGrid())
    // amount=0.7、master=0.9：稳态 DC = 0.5·(0.3·1 + 0.7·(1/1.5))·0.9 = 0.345
    backend.setConfig(deltaSingleSpeakerConfig(0.7, 0.9))
    const N = 1024
    const inL = new Float32Array(N).fill(0.5)
    const inR = new Float32Array(N).fill(0.5)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    backend.processStereo(inL, inR, outL, outR)
    // 干路也延迟 512：前 512 样本恒 0（若干路不延迟，(1-0.7)·0.5=0.15 ≠ 0）
    for (let i = 0; i < 512; i++) {
      expect(Math.abs(outL[i])).toBeLessThan(1e-7)
      expect(Math.abs(outR[i])).toBeLessThan(1e-7)
    }
    for (let i = 512 + 64; i < N; i++) {
      expect(Math.abs(outL[i] - 0.345)).toBeLessThan(1e-3)
      expect(Math.abs(outR[i] - 0.345)).toBeLessThan(1e-3)
    }
  })

  it('reset 清零流式状态（重置后前 512 样本重新为 0）', () => {
    const backend = new WasmHrtfBackend(bytes)
    backend.loadHrtf(deltaGrid())
    backend.setConfig(deltaSingleSpeakerConfig(1, 1))
    // 喂两整块（1024），输出 512.. 非零
    const inL = new Float32Array(1024).fill(0.5)
    const out1 = new Float32Array(1024)
    backend.processStereo(inL, inL.slice(), out1, out1.slice())
    expect(Math.abs(out1[600])).toBeGreaterThan(0.1)
    // 重置：延迟线/累加器/滤波状态清零
    backend.reset()
    const in2 = new Float32Array(1024).fill(0.5)
    const out2 = new Float32Array(1024)
    backend.processStereo(in2, in2.slice(), out2, out2.slice())
    for (let i = 0; i < 512; i++) {
      expect(Math.abs(out2[i])).toBeLessThan(1e-7)
    }
    // 512 之后恢复 DC 稳态（状态确实被清空并重新收敛）
    for (let i = 512 + 64; i < 1024; i++) {
      expect(Math.abs(out2[i] - 1 / 3)).toBeLessThan(1e-3)
    }
  })

  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('与 TsConvolverBackend 数值对拍', () => {
    it('同一解析 HRTF 网格 + 同 config，固定种子随机输入，逐样本 |a-b| ≤ 1e-5（含跨块连续性）', () => {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是分区卷积/吸收/距离增益
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)

      // 固定种子随机输入
      const TOTAL = 4233
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(0xc0ffee)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      // 不规则分块（和 = 4233）：跨块连续性重点验重叠相加状态（分区历史跨块传递）。
      // 注意：块长序列必须**不收缩**——TsConvolverBackend 把整块 scratch 视图
      // （按历史最大块长）喂给 Convolver，若某块小于历史最大块长，Convolver 会把
      // scratch 中的陈旧样本重复处理（已定位：convL.totalOut 超前实际喂入量），
      // 导致湿路错位（Wasm 侧按数学期望输出，该差异为参考侧缺陷，见收口报告）。
      // 首个 128 块验证短块启动；511/1024 覆盖块中部完成（inputPos 越界）场景。
      const chunks = [128, 511, 1024, 1024, 1024, 522]
      let off = 0
      for (const c of chunks) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      let maxDiff = 0
      for (let i = 0; i < TOTAL; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(outW[ch][i] - outT[ch][i])
          if (d > maxDiff) maxDiff = d
        }
      }
      expect(maxDiff).toBeLessThanOrEqual(1e-5)
    })
  })

  // -------------------------------------------------------------------------
  // f32/f64 精度边界对拍（O1 审计 7.3 — 对拍测试缺口）：
  // 覆盖高扬声器数 / 大距离（α→1，吸收状态 f64/f32 偏差最大）/ 窄带相干输入
  // （复乘 f32/f64 最坏情况）。容差按场景放宽：高扬声器数与窄带相干 1e-4
  // （f32 累加顺序敏感度上升、复乘 f32/f64 最坏情况），大距离 1e-5（精度收紧
  // 验证吸收状态对齐修复 1.1 在最敏感场景仍稳）。
  // -------------------------------------------------------------------------
  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('f32/f64 精度边界对拍：Rust vs TS', () => {
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    /** 64 扬声器均匀环布（az -180..175 步 5.6°、el 0、dist 1.5、gain 1） */
    function speakers64(): SpatialRenderConfig['speakers'] {
      const arr: SpatialRenderConfig['speakers'] = []
      for (let i = 0; i < 64; i++) {
        // -180 + 63·5.6 = -180 + 352.8 = 172.8（不到 180，64 个均匀分布）
        arr.push({
          channel: i % 2, // 偶数→L 源、奇数→R 源（覆盖两路输入源选择路径）
          azimuthDeg: -180 + i * 5.6,
          elevationDeg: 0,
          distance: 1.5,
          gain: 1,
          size: 0,
        })
      }
      return arr
    }

    /** 固定种子随机输入（两后端吃同一序列） */
    function randomInputs(seed: number): { inL: Float32Array; inR: Float32Array } {
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(seed)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      return { inL, inR }
    }

    /** 单频正弦输入（窄带相干输入对拍用；幅度 0.5） */
    function sineInputs(freqHz: number): { inL: Float32Array; inR: Float32Array } {
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const FS = 48000
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / FS)
        inR[i] = 0.5 * Math.sin((2 * Math.PI * freqHz * i) / FS + Math.PI / 3) // 右耳相位偏移
      }
      return { inL, inR }
    }

    /** 分别用 Wasm / TS 后端渲染同一 config（同输入、同分块），返回双耳输出 */
    function renderBoth(
      config: SpatialRenderConfig,
      inputs: { inL: Float32Array; inR: Float32Array },
    ): { wasm: Float32Array[]; ts: Float32Array[] } {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)
      const { inL, inR } = inputs
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('64 扬声器对拍（覆盖高扬声器数 f32/f64 偏差）：随机输入多块跨块，逐样本 ≤ 1e-4', () => {
      // 高扬声器数下 f32 累加顺序敏感度上升（湿总线 64 路累加，每路复乘+IFFT 圆整）；
      // 1.2（湿总线 f64 中间量）+ 1.5（增益前移）+ 1.1（吸收状态 f32 截断）三处修复
      // 收敛后容差从 1e-5 放宽到 1e-4——f32 顺序差异在 64 路 Σ 中仍 ~1e-6 量级，
      // 1e-4 断言有最大余量（实测远小于此）。
      const config: SpatialRenderConfig = {
        speakers: speakers64(),
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是 64 路卷积/吸收/距离增益累加
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config, randomInputs(0x64a1))
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-4)
      // 输出确实非零且有限（多扬声器渲染实际生效，非空转）
      let m = 0
      for (let i = 512; i < TOTAL; i++) {
        if (!Number.isFinite(wasm[0][i]) || !Number.isFinite(wasm[1][i])) {
          throw new Error(`NaN/Inf at ${i}`)
        }
        m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      }
      expect(m).toBeGreaterThan(0.01)
    })

    it('大距离对拍（dist=50m，α→1 空气吸收状态 f64/f32 偏差最大）：2 扬声器，逐样本 ≤ 1e-5', () => {
      // dist=50m → fc=4000/51≈78Hz、α=1−exp(−2π·78/48000)≈0.0102；
      // α 小→低通几乎全通，但状态 y 跨块累积——Rust 每样本截断 vs TS 原实现
      // f64 carry 在大距离下偏差最大（O1 审计 1.1 的修复在最敏感场景验证）。
      // 容差收紧到 1e-5（吸收状态对齐修复后两实现逐位一致）。
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 50, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 50, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config, randomInputs(0x50d1))
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // 输出确实非零（远距离增益小但非零：dist=50 → g=1/50=0.02，仍 > 0.001）
      let m = 0
      for (let i = 512; i < TOTAL; i++) {
        m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      }
      expect(m).toBeGreaterThan(1e-4)
    })

    it('窄带相干输入对拍（440Hz 正弦，复乘 f32/f64 最坏情况）：2 扬声器，逐样本 ≤ 1e-4', () => {
      // 单频正弦输入 → 卷积谱集中于单一频率附近，复乘 r1·r2−i1·i2 在窄带下
      // f32/f64 差异最坏（无宽带平均抵消）。容差放宽到 1e-4（复乘圆整差异累积）。
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config, sineInputs(440))
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-4)
      // 输出确实非零（440Hz 正弦经 HRTF 卷积后双耳仍有显著响应）
      let m = 0
      for (let i = 512; i < TOTAL; i++) {
        m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      }
      expect(m).toBeGreaterThan(0.01)
    })
  })

  describe.skipIf(!realGrid || !RefBackend)('球谐插值（spherical）对拍：Rust vs TS（真实 KEMAR 网格）', () => {
    const grid = realGrid as HrtfGrid
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    /** 固定种子随机输入（两后端吃同一序列） */
    function randomInputs(): { inL: Float32Array; inR: Float32Array } {
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(0x5e77e1)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      return { inL, inR }
    }

    /** 分别用 Wasm / TS 后端渲染同一 config（同输入、同分块），返回双耳输出 */
    function renderBoth(
      config: SpatialRenderConfig,
    ): { wasm: Float32Array[]; ts: Float32Array[] } {
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)
      const { inL, inR } = randomInputs()
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('Rust spherical vs TS spherical：多方向（含离网格 45° 仰角）随机输入跨块，逐样本 ≤ 1e-5', () => {
      // 方向集：网格点水平环各象限 + 高/低仰角 + 离网格点（el=45°、az=17°——
      // 球谐插值的连续角度求值正是本分支的存在意义）
      const speakers = [
        { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 0, azimuthDeg: -90, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 135, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 0, azimuthDeg: -135, elevationDeg: 40, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 0, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
        { channel: 0, azimuthDeg: 17, elevationDeg: 45, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: -180, elevationDeg: 90, distance: 1.5, gain: 1, size: 0 },
      ]
      const config: SpatialRenderConfig = {
        speakers,
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是球谐 HRIR 分区谱
        distanceModel: 'inverse',
        hrtfInterp: 'spherical',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config)
      // Rust 侧 SH 拟合与 TS 侧 hrtfInterp.ts 逐位对齐（同公式同运算顺序），
      // 仅 libm 三角/开方实现差异 ~1 ULP → f32 输出差异 ≤ 1e-7 量级，
      // 1e-5 断言有最大余量。
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // 输出确实非零（球谐 HRIR 装载生效，非空转）
      let m = 0
      for (let i = 512; i < TOTAL; i++) m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      expect(m).toBeGreaterThan(0.01)
    })

    it('Rust nearest 与 spherical 在网格点上的差异与 TS 一致（差值信号 ≤ 1e-5）', () => {
      // 网格点方向（0°、30°）：nearest 取网格原 HRIR，spherical 取 SH 拟合重建。
      // 两后端的 nearest→spherical 差异信号必须一致——验证 Rust 侧 SH 分支
      // 与 TS 侧基准同源（拟合残差本身可能大，但差值信号对拍是严格容差）。
      const gridPointSpeakers = [
        { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      ]
      const base: SpatialRenderConfig = {
        speakers: gridPointSpeakers,
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const nn = renderBoth(base)
      const sp = renderBoth({ ...base, hrtfInterp: 'spherical' })
      // dR = Rust(spherical)−Rust(nearest)，dT = TS(spherical)−TS(nearest)：
      // 逐样本 |dR − dT| ≤ 1e-5
      let m = 0
      for (let i = 0; i < TOTAL; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const dR = sp.wasm[ch][i] - nn.wasm[ch][i]
          const dT = sp.ts[ch][i] - nn.ts[ch][i]
          m = Math.max(m, Math.abs(dR - dT))
        }
      }
      expect(m).toBeLessThanOrEqual(1e-5)
    })

    it('spatial_reset 不重置插值模式（配置语义：reset 后仍为 spherical 行为）', () => {
      const config: SpatialRenderConfig = {
        speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'spherical',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { inL, inR } = randomInputs()
      // 重置后的输出必须与"从头开始的新 spherical 后端"一致——若 reset 把
      // interp_mode 清回 0，输出会变成 nearest（网格点方向差 ~0.006 > 1e-7）。
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      b.setConfig(config)
      b.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), new Float32Array(1024), new Float32Array(1024))
      b.reset()
      const outA = [new Float32Array(1024), new Float32Array(1024)]
      b.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), outA[0], outA[1])

    const fresh = new WasmHrtfBackend(bytes)
    fresh.loadHrtf(grid)
    fresh.setConfig(config)
    const outB = [new Float32Array(1024), new Float32Array(1024)]
    fresh.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), outB[0], outB[1])
    expect(maxDiff(outA, outB)).toBeLessThanOrEqual(1e-7)
  })
})

  // -------------------------------------------------------------------------
  // 多普勒（§4.6，模式 C）：Rust spatial_set_doppler vs TS resampleSpeaker 对拍
  // 同分块策略与最近邻对拍组一致（不收缩序列），velocity 经 f32 ABI 量化。
  // -------------------------------------------------------------------------
  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('多普勒（§4.6，模式 C）：Rust vs TS 对拍', () => {
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    /** 分别用 Wasm / TS 后端渲染同一 doppler config（同输入、同分块），返回双耳输出 */
    function renderBoth(
      vel: { x: number; y: number; z: number } | undefined,
    ): { wasm: Float32Array[]; ts: Float32Array[] } {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是重采样 + 分区卷积/吸收/距离增益
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
        ...(vel ? { dopplerVelocity: vel } : {}),
      }
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)

      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(0xd0bb1e)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('velocity 非零（多扬声器不同 rate、f32 量化）：逐样本 |a−b| ≤ 1e-5（多块跨块）', () => {
      // speaker0 方位 0° → dir≈(0,0,1)、speaker1 方位 30° → dir≈(0.5,0,0.866)，
      // 同一速度下两 speaker rate 不同（重采样均激活）
      const { wasm, ts } = renderBoth({ x: 3.7, y: -1.2, z: 2.5 })
      const d = maxDiff(wasm, ts)
      expect(d).toBeLessThanOrEqual(1e-5)
      // 输出确实发生多普勒（rate≠1：与静止版本不同，非空转）
      const still = renderBoth({ x: 0, y: 0, z: 0 })
      expect(maxDiff(wasm, still.wasm)).toBeGreaterThan(1e-4)
    })

    it('沿声源方向速度（rate=2.0）与反向（rate=0.5）钳位边界：逐样本 ≤ 1e-5', () => {
      // 0° speaker dir=(0,0,1)（f32 精确）：v=(0,0,171.5) → rate=2.0 精确、
      // v=(0,0,−343) → rate=0.5 精确——覆盖 clamp 上/下边界路径
      for (const vel of [
        { x: 0, y: 0, z: 171.5 },
        { x: 0, y: 0, z: -343 },
      ]) {
        const { wasm, ts } = renderBoth(vel)
        expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      }
    })

    it('velocity=0 → 直通：与无 doppler 配置输出逐位相等（rate==1 分支）', () => {
      const zero = renderBoth({ x: 0, y: 0, z: 0 })
      const none = renderBoth(undefined)
      expect(maxDiff(zero.wasm, none.wasm)).toBe(0)
      expect(maxDiff(zero.ts, none.ts)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // 房间模拟（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响）：Rust vs TS 对拍
  // 两后端均经 preset（Wasm 侧 spatial_set_room_preset / TS 侧 roomSim.ts 预设表，
  // 参数表一致、早期反射阶数默认 2）。同分块策略（不收缩序列）。
  // -------------------------------------------------------------------------
  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('房间模拟（§4.5）：Rust vs TS 对拍', () => {
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    const roomConfig = (room: SpatialRenderConfig['room'], roomAmount: number): SpatialRenderConfig => ({
      speakers: [
        { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      ],
      room,
      roomAmount,
      amount: 1, // 纯湿：房间位于湿路内部（对拍重点是镜像源/FDN 与 TS 参考侧一致）
      distanceModel: 'inverse',
      hrtfInterp: 'nearest',
      convolution: 'partitioned',
      masterGain: 1,
    })

    /** 分别用 Wasm / TS 后端渲染同一 config（同输入、同分块），返回双耳输出 */
    function renderBoth(config: SpatialRenderConfig): { wasm: Float32Array[]; ts: Float32Array[] } {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(0x70a11)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('room=hall、orders=2（默认）：多块跨块随机输入，逐样本 |a−b| ≤ 1e-5', () => {
      const config = roomConfig('hall', 0.5)
      const { wasm, ts } = renderBoth(config)
      const d = maxDiff(wasm, ts)
      expect(d).toBeLessThanOrEqual(1e-5)
      // 房间确实生效（与无房间输出差异显著，非空转）
      const noRoom = renderBoth(roomConfig('off', 0))
      expect(maxDiff(wasm, noRoom.wasm)).toBeGreaterThan(1e-4)
      expect(maxDiff(ts, noRoom.ts)).toBeGreaterThan(1e-4)
    })

    it('room=studio 同样对拍（另一预设参数表路径）：逐样本 |a−b| ≤ 1e-5', () => {
      const { wasm, ts } = renderBoth(roomConfig('studio', 0.5))
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
    })

    it('room=off（roomAmount>0）与 roomAmount=0 输出逐位一致（旁路回归）', () => {
      const a = renderBoth(roomConfig('off', 0.8))
      const b = renderBoth(roomConfig('off', 0))
      expect(maxDiff(a.wasm, b.wasm)).toBe(0)
      expect(maxDiff(a.ts, b.ts)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // 本波三件套（§4.7 与契约）：声源大小 size / 时域卷积 mode / 遮挡 occlusion
  // Rust vs TS 对拍（同分块策略不收缩；analytic grid；容差实测见收口报告）
  // -------------------------------------------------------------------------
  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('三件套（§4.7/契约）：Rust vs TS 对拍', () => {
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    /** 固定种子随机输入（两后端吃同一序列） */
    function randomInputs(seed: number): { inL: Float32Array; inR: Float32Array } {
      const inL = new Float32Array(TOTAL)
      const inR = new Float32Array(TOTAL)
      const rng = mulberry32(seed)
      for (let i = 0; i < TOTAL; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      return { inL, inR }
    }

    /** 分别用 Wasm / TS 后端渲染同一 config（同输入、同分块），返回双耳输出 */
    function renderBoth(config: SpatialRenderConfig): { wasm: Float32Array[]; ts: Float32Array[] } {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)
      const { inL, inR } = randomInputs(0x5e77e1)
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processStereo(
          inL.subarray(off, off + n),
          inR.subarray(off, off + n),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('wasm 导出：spatial_* 共 16 个（既有 14 + 新增 2：spatial_get_hrir / spatial_set_distance_model，规划书 §3.2）', () => {
      const mod = new WebAssembly.Module(bytes)
      const inst = new WebAssembly.Instance(mod)
      const spatialExports = Object.keys(inst.exports).filter((k) => k.startsWith('spatial_'))
      expect(spatialExports).toContain('spatial_set_convolution_mode')
      expect(spatialExports).toContain('spatial_set_occlusion')
      expect(spatialExports).toContain('spatial_render_multi')
      expect(spatialExports).toContain('spatial_get_hrir')
      expect(spatialExports).toContain('spatial_set_distance_model')
      expect(spatialExports).toHaveLength(16)
    })

    it('size=1（方向模糊 az±30° + 右耳去相关 6 样本）：随机输入多块，逐样本 |a−b| ≤ 1e-5', () => {
      // az=30 → 模糊方向 0°/60°（网格点）；az=17 → 模糊方向 −13°/47°（离网格，
      // 最近邻查表路径）；size=1 时右耳去相关满延迟 6 样本均激活
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 1 },
          { channel: 1, azimuthDeg: 17, elevationDeg: 0, distance: 1.5, gain: 0.8, size: 1 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是模糊 HRIR 装载 + 去相关延迟
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // 输出确实非零（size 路径生效，非空转）
      let m = 0
      for (let i = 512; i < TOTAL; i++) m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      expect(m).toBeGreaterThan(0.01)
    })

    it('size=0 回归：Rust vs TS ≤ 1e-5（模糊/去相关门控关闭，与基线同容差）；Rust 侧 size 0→1→0 周期逐位一致', () => {
      const base: SpatialRenderConfig = {
        speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(base)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // Rust 侧 size 0→1→0 周期：set_config 全量重建（fresh 状态）→ 与全新 size=0
      // 后端输出逐位相同（size=0 路径 = 原方向单 HRIR、无去相关）
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const { inL, inR } = randomInputs(0x51e51e)
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      b.setConfig(base)
      b.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), new Float32Array(1024), new Float32Array(1024))
      b.setConfig({ ...base, speakers: [{ ...base.speakers[0], size: 1 }] })
      b.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), new Float32Array(1024), new Float32Array(1024))
      b.setConfig(base)
      const outA = [new Float32Array(1024), new Float32Array(1024)]
      b.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), outA[0], outA[1])
      const fresh = new WasmHrtfBackend(bytes)
      fresh.loadHrtf(grid)
      fresh.setConfig(base)
      const outB = [new Float32Array(1024), new Float32Array(1024)]
      fresh.processStereo(inL.subarray(0, 1024), inR.subarray(0, 1024), outB[0], outB[1])
      expect(maxDiff(outA, outB)).toBe(0)
    })

    it('time 模式：Rust vs TS ≤ 1e-4；Rust time vs Rust partitioned ≤ 1e-4（FFT 圆整差异）', () => {
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'time',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(config)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-4)
      // 同后端跨模式：同块调度同放行 → 仅 FFT 圆整差异
      const part = renderBoth({ ...config, convolution: 'partitioned' })
      expect(maxDiff(wasm, part.wasm)).toBeLessThanOrEqual(1e-4)
    })

    it('occlusion=0.5：随机输入多块，逐样本 |a−b| ≤ 1e-5（增益衰减 + 空气式低通）', () => {
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
        occlusionAmount: 0.5,
      }
      const { wasm, ts } = renderBoth(config)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // 遮挡确实生效（与无遮挡输出差异显著，非空转）
      const none = renderBoth({ ...config, occlusionAmount: 0 })
      expect(maxDiff(wasm, none.wasm)).toBeGreaterThan(1e-4)
      expect(maxDiff(ts, none.ts)).toBeGreaterThan(1e-4)
    })

    it('time/partitioned 脉冲位置一致（±1）：wasm 与 ts 两模式峰值位置相同（analytic grid）', () => {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const N = 4096
      const inL = new Float32Array(N)
      inL[1000] = 1 // 单脉冲（越过首个装配块）
      const inR = new Float32Array(N)
      const base: SpatialRenderConfig = {
        speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      // analytic HRIR 峰值 ≈ 中心 127（近耳）→ 输出峰值 ≈ 1000+512+127 = 1639
      const peakAt = (out: Float32Array, from: number, to: number): number => {
        let best = from
        let bestV = -1
        for (let i = from; i < to; i++) {
          const v = Math.abs(out[i])
          if (v > bestV) {
            bestV = v
            best = i
          }
        }
        return best
      }
      const peaks: Array<{ mode: 'partitioned' | 'time'; backend: string; pos: number }> = []
      for (const convolution of ['partitioned', 'time'] as const) {
        const wasmBackend = new WasmHrtfBackend(bytes)
        wasmBackend.loadHrtf(grid)
        wasmBackend.setConfig({ ...base, convolution })
        const outW = new Float32Array(N)
        wasmBackend.processStereo(inL, inR, outW, new Float32Array(N))
        peaks.push({ mode: convolution, backend: 'wasm', pos: peakAt(outW, 1500, 1900) })
        const tsBackend = new (RefBackend as new () => SpatialBackend)()
        tsBackend.loadHrtf(grid)
        tsBackend.setConfig({ ...base, convolution })
        const outT = new Float32Array(N)
        tsBackend.processStereo(inL, inR, outT, new Float32Array(N))
        peaks.push({ mode: convolution, backend: 'ts', pos: peakAt(outT, 1500, 1900) })
      }
      // 四种组合（2 模式 × 2 后端）峰值位置两两相差 ≤ 1 样本
      for (let i = 0; i < peaks.length; i++) {
        for (let j = i + 1; j < peaks.length; j++) {
          expect(Math.abs(peaks[i].pos - peaks[j].pos)).toBeLessThanOrEqual(1)
        }
      }
      // 峰值确实落在预期窗口（非空转）
      expect(Math.abs(peaks[0].pos - 1639)).toBeLessThanOrEqual(8)
    })
  })

  // -------------------------------------------------------------------------
  // 多声道输入（②，spatial_render_multi）：Rust vs TS processMulti 对拍
  // 与 processStereo 同算法仅输入侧扩展（speaker.channel 索引取源、越界取 0 号）；
  // 同分块策略（不收缩序列）。2 路输入 + 相同配置下与 processStereo 逐位一致。
  // -------------------------------------------------------------------------
  describe.skipIf(!RefBackend || !generateAnalyticHrtfGridFn)('多声道输入（spatial_render_multi）：Rust vs TS 对拍', () => {
    const TOTAL = 4233
    const CHUNKS = [128, 511, 1024, 1024, 1024, 522] // 与最近邻对拍组同分块（不收缩）

    /** 5.1 / 7.1 布局扬声器（multichannelLayout 语义：FL/FR/C/LFE占位/SL/SR[/RL/RR]） */
    function layoutSpeakers(channels: number): SpatialRenderConfig['speakers'] {
      const base = [
        { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 2, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 3, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 0, size: 0 }, // LFE 静音占位
        { channel: 4, azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 5, azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      ]
      if (channels <= 6) return base
      return [
        ...base,
        { channel: 6, azimuthDeg: -140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        { channel: 7, azimuthDeg: 140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      ]
    }

    /** 固定种子多路随机输入（两后端吃同一序列） */
    function randomInputs(channels: number, seed: number): Float32Array[] {
      const rng = mulberry32(seed)
      const inputs: Float32Array[] = []
      for (let c = 0; c < channels; c++) {
        const x = new Float32Array(TOTAL)
        for (let i = 0; i < TOTAL; i++) x[i] = rng() * 2 - 1
        inputs.push(x)
      }
      return inputs
    }

    /** 分别用 Wasm / TS 后端渲染同一 config（同输入、同分块），返回双耳输出 */
    function renderBoth(
      inputs: Float32Array[],
      config: SpatialRenderConfig,
    ): { wasm: Float32Array[]; ts: Float32Array[] } {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const wasmBackend = new WasmHrtfBackend(bytes)
      wasmBackend.loadHrtf(grid)
      wasmBackend.setConfig(config)
      const tsBackend = new (RefBackend as new () => SpatialBackend)()
      tsBackend.loadHrtf(grid)
      tsBackend.setConfig(config)
      const outW: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outT: Float32Array[] = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        wasmBackend.processMulti!(
          inputs.map((x) => x.subarray(off, off + n)),
          outW[0].subarray(off, off + n),
          outW[1].subarray(off, off + n),
        )
        tsBackend.processMulti!(
          inputs.map((x) => x.subarray(off, off + n)),
          outT[0].subarray(off, off + n),
          outT[1].subarray(off, off + n),
        )
        off += n
      }
      return { wasm: outW, ts: outT }
    }

    /** 逐样本最大绝对差 */
    function maxDiff(a: Float32Array[], b: Float32Array[]): number {
      let m = 0
      for (let i = 0; i < a[0].length; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const d = Math.abs(a[ch][i] - b[ch][i])
          if (d > m) m = d
        }
      }
      return m
    }

    it('6 路输入（5.1 布局含 LFE 占位）随机信号多块跨块：逐样本 |a−b| ≤ 1e-5', () => {
      const config: SpatialRenderConfig = {
        speakers: layoutSpeakers(6),
        room: 'off',
        roomAmount: 0,
        amount: 1, // 纯湿：对拍重点是逐声道路由 + 分区卷积/吸收/距离增益
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(randomInputs(6, 0x6d2a1), config)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
      // 输出确实非零且有限（多声道渲染实际生效，非空转）
      let m = 0
      for (let i = 512; i < TOTAL; i++) {
        if (!Number.isFinite(wasm[0][i]) || !Number.isFinite(wasm[1][i])) throw new Error(`NaN/Inf at ${i}`)
        m = Math.max(m, Math.abs(wasm[0][i]), Math.abs(wasm[1][i]))
      }
      expect(m).toBeGreaterThan(0.01)
    })

    it('8 路输入（7.1 布局）随机信号多块跨块：逐样本 |a−b| ≤ 1e-5', () => {
      const config: SpatialRenderConfig = {
        speakers: layoutSpeakers(8),
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const { wasm, ts } = renderBoth(randomInputs(8, 0x711e7), config)
      expect(maxDiff(wasm, ts)).toBeLessThanOrEqual(1e-5)
    })

    it('2 路输入 + 相同 speaker 配置：wasm processMulti 与 wasm processStereo 输出逐位一致（回归）', () => {
      const grid = (generateAnalyticHrtfGridFn as (sampleRate: number) => HrtfGrid)(48000)
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        room: 'studio',
        roomAmount: 0.3,
        amount: 0.7,
        distanceModel: 'inverse',
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
        dopplerVelocity: { x: 3.7, y: -1.2, z: 2.5 },
      }
      const inputs = randomInputs(2, 0x51e51e)
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      b.setConfig(config)
      const outS = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      const outM = [new Float32Array(TOTAL), new Float32Array(TOTAL)]
      let off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        b.processStereo(
          inputs[0].subarray(off, off + n),
          inputs[1].subarray(off, off + n),
          outS[0].subarray(off, off + n),
          outS[1].subarray(off, off + n),
        )
        off += n
      }
      b.reset() // 清零流式状态（与 TS 参考测试同模式）：两阶段各自从头渲染，方可逐位比较
      off = 0
      for (const c of CHUNKS) {
        const n = Math.min(c, TOTAL - off)
        b.processMulti!(
          [inputs[0].subarray(off, off + n), inputs[1].subarray(off, off + n)],
          outM[0].subarray(off, off + n),
          outM[1].subarray(off, off + n),
        )
        off += n
      }
      expect(maxDiff(outS, outM)).toBe(0) // 逐位一致（同配置 2 路输入）
    })
  })

  // -------------------------------------------------------------------------
  // 契约两函数（规划书 §3.2）：spatial_get_hrir / spatial_set_distance_model
  //   - get_hrir：按当前插值模式查询指定方向 HRIR 对（与 build_speaker 装载分支
  //     同源同路径）——nearest 返回网格该方向原数据段（逐位）、spherical 与
  //     hrtfInterp.sphericalHrtf 对拍 ≤ 1e-5；未 load → -1、len 不足 → -2；
  //   - set_distance_model：与 set_config 的 distanceModel 参数写同一内部字段、
  //     后调者生效（双入口等价，dist_gain 共用同一公式）——linear 与 inverse
  //     输出不同；两入口设置同一模型输出逐位一致。
  // -------------------------------------------------------------------------
  describe.skipIf(!realGrid)('契约两函数（§3.2）：get_hrir / set_distance_model', () => {
    const grid = realGrid as HrtfGrid

    /** 原始导出接口（错误码用例直调 wasm，绕过 TS 包装的抛错） */
    interface RawExports {
      memory: WebAssembly.Memory
      spatial_alloc(size: number): number
      spatial_free(ptr: number, size: number): void
      spatial_load_hrtf(
        sampleRate: number,
        azCount: number,
        elCount: number,
        hrirLen: number,
        azPtr: number,
        elPtr: number,
        leftPtr: number,
        rightPtr: number,
      ): number
      spatial_get_hrir(azimuthDeg: number, elevationDeg: number, outL: number, outR: number, len: number): number
    }

    /** 原始实例装载网格（拷贝 → load → 释放临时；视图每次 alloc 后重建防 buffer 换身份） */
    function loadGridRaw(ex: RawExports, g: HrtfGrid): void {
      const azPtr = ex.spatial_alloc(g.azimuths.length * 4)
      const elPtr = ex.spatial_alloc(g.elevations.length * 4)
      const total = g.left.length
      const lPtr = ex.spatial_alloc(total * 4)
      const rPtr = ex.spatial_alloc(total * 4)
      if (!azPtr || !elPtr || !lPtr || !rPtr) throw new Error('raw spatial_alloc 失败')
      // 全部 alloc 后重建视图（内存可能已增长）
      new Float32Array(ex.memory.buffer, azPtr, g.azimuths.length).set(g.azimuths)
      new Float32Array(ex.memory.buffer, elPtr, g.elevations.length).set(g.elevations)
      new Float32Array(ex.memory.buffer, lPtr, total).set(g.left)
      new Float32Array(ex.memory.buffer, rPtr, total).set(g.right)
      const ret = ex.spatial_load_hrtf(
        g.sampleRate,
        g.azimuths.length,
        g.elevations.length,
        g.hrirLength,
        azPtr,
        elPtr,
        lPtr,
        rPtr,
      )
      ex.spatial_free(azPtr, g.azimuths.length * 4)
      ex.spatial_free(elPtr, g.elevations.length * 4)
      ex.spatial_free(lPtr, total * 4)
      ex.spatial_free(rPtr, total * 4)
      if (ret !== 0) throw new Error(`raw spatial_load_hrtf 失败（错误码 ${ret}）`)
    }

    it('spatial_get_hrir 原始导出错误码：未 load → -1、len 不足 → -2、空指针 → -2', () => {
      const mod = new WebAssembly.Module(bytes)
      const inst = new WebAssembly.Instance(mod)
      const ex = inst.exports as unknown as RawExports
      const hl = grid.hrirLength
      // 未 load：-1（先于指针/长度校验）
      expect(ex.spatial_get_hrir(0, 0, 0, 0, hl)).toBe(-1)
      loadGridRaw(ex, grid)
      const oL = ex.spatial_alloc(hl * 4)
      const oR = ex.spatial_alloc(hl * 4)
      expect(oL).not.toBe(0)
      expect(oR).not.toBe(0)
      // len 不足（hl-1 < hl）：-2
      expect(ex.spatial_get_hrir(0, 0, oL, oR, hl - 1)).toBe(-2)
      // 空指针：-2
      expect(ex.spatial_get_hrir(0, 0, 0, 0, hl)).toBe(-2)
      // 正常调用：0 且输出 = 网格 0° 方向原数据段（顺带验证双耳写入路径）
      expect(ex.spatial_get_hrir(0, 0, oL, oR, hl)).toBe(0)
      const azIdx = grid.azimuths.indexOf(0)
      const elIdx = grid.elevations.indexOf(0)
      const base = (elIdx * grid.azimuths.length + azIdx) * hl
      // 视图在全部 alloc 后重建（内存可能已增长）
      const outL = new Float32Array(ex.memory.buffer, oL, hl)
      const outR = new Float32Array(ex.memory.buffer, oR, hl)
      for (let i = 0; i < hl; i++) {
        expect(outL[i]).toBe(grid.left[base + i])
        expect(outR[i]).toBe(grid.right[base + i])
      }
      ex.spatial_free(oL, hl * 4)
      ex.spatial_free(oR, hl * 4)
    })

    it('getHrir nearest：返回与网格该方向 HRIR 逐位一致（网格点/离网格/环绕/仰角钳制）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      const dirs: Array<[number, number]> = [
        [0, 0], // 网格点
        [30, 0],
        [-135, 40],
        [17, 45], // 离网格（最近邻映射）
        [179, 0], // 环绕：-180 与 180 相邻 → 网格 -180
        [180, -40],
        [5, 100], // 仰角钳制到 90
        [0, -100], // 仰角钳制到 -40
      ]
      for (const [az, el] of dirs) {
        const { left, right } = b.getHrir(az, el)
        expect(left.length).toBe(grid.hrirLength)
        expect(right.length).toBe(grid.hrirLength)
        const { azIdx, elIdx } = nearestGridIndex(grid, az, el)
        const base = (elIdx * grid.azimuths.length + azIdx) * grid.hrirLength
        let maxD = 0
        for (let i = 0; i < grid.hrirLength; i++) {
          maxD = Math.max(maxD, Math.abs(left[i] - grid.left[base + i]), Math.abs(right[i] - grid.right[base + i]))
        }
        expect(maxD).toBe(0) // 最近邻 = 网格原数据段拷贝（逐位）
      }
    })

    it('getHrir spherical：与 hrtfInterp.sphericalHrtf 输出对拍 ≤ 1e-5（含离网格方向）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      // 最小扬声器配置（≥1 只：空配置 spatial_alloc(0) 返回 null）：仅经 setConfig
      // 设置插值模式（spatial_set_hrtf_interp_mode），getHrir 与扬声器无关
      b.setConfig({
        speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'inverse',
        hrtfInterp: 'spherical',
        convolution: 'partitioned',
        masterGain: 1,
      })
      const dirs: Array<[number, number]> = [
        [0, 0],
        [30, 0],
        [-135, 40],
        [17, 45], // 离网格方向（球谐连续角度求值正是本分支的存在意义）
        [180, 90],
      ]
      const refL = new Float32Array(grid.hrirLength)
      const refR = new Float32Array(grid.hrirLength)
      for (const [az, el] of dirs) {
        const { left, right } = b.getHrir(az, el)
        sphericalHrtf(grid, az, el, refL, refR)
        let maxD = 0
        for (let i = 0; i < grid.hrirLength; i++) {
          maxD = Math.max(maxD, Math.abs(left[i] - refL[i]), Math.abs(right[i] - refR[i]))
        }
        // Rust 侧 SH 拟合与 TS 侧 hrtfInterp.ts 逐位对齐（仅 libm ~1 ULP 差异），
        // 1e-5 断言有最大余量
        expect(maxD).toBeLessThanOrEqual(1e-5)
      }
    })

    it('getHrir 插值模式配置语义：未 setConfig 时默认 nearest（与 set_config 的 build_speaker 同源）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(grid)
      // 未显式 setConfig → interp_mode 默认 0（nearest）：球谐角度应等于最近邻结果
      const { left, right } = b.getHrir(17, 45)
      const { azIdx, elIdx } = nearestGridIndex(grid, 17, 45)
      const base = (elIdx * grid.azimuths.length + azIdx) * grid.hrirLength
      for (let i = 0; i < grid.hrirLength; i++) {
        expect(left[i]).toBe(grid.left[base + i])
        expect(right[i]).toBe(grid.right[base + i])
      }
    })

    it('set_distance_model 生效：linear 与 inverse 渲染输出不同（距离 1.5m 增益差显著）', () => {
      const N = 4096
      const inL = new Float32Array(N)
      const inR = new Float32Array(N)
      const rng = mulberry32(0x5e77e1)
      for (let i = 0; i < N; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      const render = (model: DistanceModel): Float32Array[] => {
        const b = new WasmHrtfBackend(bytes)
        b.loadHrtf(grid)
        b.setConfig({
          speakers: [
            { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
            { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          ],
          room: 'off',
          roomAmount: 0,
          amount: 1, // 纯湿：输出直接反映距离增益
          distanceModel: model,
          hrtfInterp: 'nearest',
          convolution: 'partitioned',
          masterGain: 1,
        })
        const out = [new Float32Array(N), new Float32Array(N)]
        b.processStereo(inL, inR, out[0], out[1])
        return out
      }
      const lin = render('linear')
      const inv = render('inverse')
      // inverse d=1.5 → g=min(1,1/1.5)≈0.667；linear d=1.5 → g=1−0.5/49≈0.990
      let maxD = 0
      for (let i = 512; i < N; i++) {
        maxD = Math.max(maxD, Math.abs(lin[0][i] - inv[0][i]), Math.abs(lin[1][i] - inv[1][i]))
      }
      expect(maxD).toBeGreaterThan(1e-3)
    })

    it('set_distance_model 与 set_config 传参等价：两入口设置同一模型输出逐位一致', () => {
      const N = 4096
      const inL = new Float32Array(N)
      const inR = new Float32Array(N)
      const rng = mulberry32(0xc0ffee)
      for (let i = 0; i < N; i++) {
        inL[i] = rng() * 2 - 1
        inR[i] = rng() * 2 - 1
      }
      const config: SpatialRenderConfig = {
        speakers: [
          { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 2.5, gain: 0.8, size: 0 },
        ],
        room: 'off',
        roomAmount: 0,
        amount: 1,
        distanceModel: 'linear', // 入口 A：set_config 参数直传
        hrtfInterp: 'nearest',
        convolution: 'partitioned',
        masterGain: 1,
      }
      const bA = new WasmHrtfBackend(bytes)
      bA.loadHrtf(grid)
      bA.setConfig(config)
      const bB = new WasmHrtfBackend(bytes)
      bB.loadHrtf(grid)
      // 入口 B：先 set_config（inverse——其内部补调 spatial_set_distance_model
      // 亦为 inverse），随后显式 spatial_set_distance_model 覆盖为 linear（后调者生效）
      bB.setConfig({ ...config, distanceModel: 'inverse' })
      bB.setDistanceModel('linear')
      const outA = [new Float32Array(N), new Float32Array(N)]
      const outB = [new Float32Array(N), new Float32Array(N)]
      bA.processStereo(inL, inR, outA[0], outA[1])
      bB.processStereo(inL, inR, outB[0], outB[1])
      // 两入口写同一内部字段 + 同一 dist_gain 公式 → 输出逐位一致
      for (let i = 0; i < N; i++) {
        expect(outA[0][i]).toBe(outB[0][i])
        expect(outA[1][i]).toBe(outB[1][i])
      }
    })
  })

  // -------------------------------------------------------------------------
  // 退化网格防御（O1 审计 P1）：网格方向数 N < 基函数 16 时 AᵀA 秩亏 →
  // invert_matrix 返回 -3 → sh_hrir/build_speaker/spatial_set_config 透传 -3 →
  // JS 侧 WasmHrtfBackend 抛中文 Error。本组不依赖真实 KEMAR 网格（自构 1×1）。
  // -------------------------------------------------------------------------
  describe('退化网格防御（O1 审计 P1：奇异矩阵 → -3 → 抛错防 NaN）', () => {
    /** 1×1 网格（N=1 < 16 基函数）：AᵀA 秩 1 < 16 → invert_matrix 返回 -3 */
    function degenerateGrid(): HrtfGrid {
      return {
        sampleRate: 48000,
        azimuths: [0],
        elevations: [0],
        hrirLength: 1,
        left: new Float32Array([1]),
        right: new Float32Array([1]),
      }
    }

    it('setConfig spherical + 1×1 网格：抛错（错误码 -3，退化网格）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(degenerateGrid())
      // spherical + 1 speaker → build_speaker → sh_hrir → ensure_sh_cache →
      // ShCache::fit → invert_matrix 返回 -3 → build_speaker Err(-3) →
      // spatial_set_config 返回 -3 → JS 抛中文 Error
      expect(() =>
        b.setConfig({
          speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
          room: 'off',
          roomAmount: 0,
          amount: 1,
          distanceModel: 'inverse',
          hrtfInterp: 'spherical',
          convolution: 'partitioned',
          masterGain: 1,
        }),
      ).toThrow(/-3|退化/)
    })

    it('getHrir spherical + 1×1 网格：抛错（错误码 -3，退化网格）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(degenerateGrid())
      // setConfig spherical 会抛错（degenerate grid），但 interp_mode 已被设为 spherical
      // （spatial_set_hrtf_interp_mode 在 spatial_set_config 之前调用，前者成功后者 -3）
      expect(() =>
        b.setConfig({
          speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
          room: 'off',
          roomAmount: 0,
          amount: 1,
          distanceModel: 'inverse',
          hrtfInterp: 'spherical',
          convolution: 'partitioned',
          masterGain: 1,
        }),
      ).toThrow(/-3|退化/)
      // interp_mode 已是 spherical（setConfig 失败前已设置）→ getHrir 也应抛 -3
      // （ensure_sh_cache 不缓存错误 → 每次重试 ShCache::fit → 每次返回 -3）
      expect(() => b.getHrir(0, 0)).toThrow(/-3|退化/)
    })

    it('spatial_get_hrir 原始导出：spherical + 1×1 网格 → 返回 -3', () => {
      // 绕过 TS 包装直调 wasm 导出，验证 Rust 侧 invert_matrix 返回 -3 的完整透传链
      interface RawExports {
        memory: WebAssembly.Memory
        spatial_alloc(size: number): number
        spatial_free(ptr: number, size: number): void
        spatial_load_hrtf(
          sampleRate: number,
          azCount: number,
          elCount: number,
          hrirLen: number,
          azPtr: number,
          elPtr: number,
          leftPtr: number,
          rightPtr: number,
        ): number
        spatial_set_hrtf_interp_mode(mode: number): number
        spatial_get_hrir(az: number, el: number, outL: number, outR: number, len: number): number
      }
      const mod = new WebAssembly.Module(bytes)
      const inst = new WebAssembly.Instance(mod)
      const ex = inst.exports as unknown as RawExports
      const grid = degenerateGrid()
      // 装载 1×1 网格
      const azPtr = ex.spatial_alloc(4)
      const elPtr = ex.spatial_alloc(4)
      const lPtr = ex.spatial_alloc(4)
      const rPtr = ex.spatial_alloc(4)
      new Float32Array(ex.memory.buffer, azPtr, 1).set(grid.azimuths)
      new Float32Array(ex.memory.buffer, elPtr, 1).set(grid.elevations)
      new Float32Array(ex.memory.buffer, lPtr, 1).set(grid.left)
      new Float32Array(ex.memory.buffer, rPtr, 1).set(grid.right)
      expect(ex.spatial_load_hrtf(48000, 1, 1, 1, azPtr, elPtr, lPtr, rPtr)).toBe(0)
      // 切 spherical 模式
      expect(ex.spatial_set_hrtf_interp_mode(1)).toBe(0)
      const oL = ex.spatial_alloc(4)
      const oR = ex.spatial_alloc(4)
      // spherical + 1×1 → invert_matrix -3 → sh_hrir Err(-3) → spatial_get_hrir -3
      expect(ex.spatial_get_hrir(0, 0, oL, oR, 1)).toBe(-3)
      ex.spatial_free(azPtr, 4)
      ex.spatial_free(elPtr, 4)
      ex.spatial_free(lPtr, 4)
      ex.spatial_free(rPtr, 4)
      ex.spatial_free(oL, 4)
      ex.spatial_free(oR, 4)
    })

    it('nearest + 1×1 网格：不抛错（最近邻查表不调 invert_matrix，防御不影响 nearest）', () => {
      const b = new WasmHrtfBackend(bytes)
      b.loadHrtf(degenerateGrid())
      // nearest 模式：az/el → 网格索引 → 拷贝 HRIR 段（不走球谐拟合，无奇异矩阵问题）
      expect(() =>
        b.setConfig({
          speakers: [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }],
          room: 'off',
          roomAmount: 0,
          amount: 1,
          distanceModel: 'inverse',
          hrtfInterp: 'nearest',
          convolution: 'partitioned',
          masterGain: 1,
        }),
      ).not.toThrow()
    })
  })
})

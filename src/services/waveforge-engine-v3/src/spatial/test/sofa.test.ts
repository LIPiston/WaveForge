/**
 * sofa 解析器单元测试（NetCDF3 经典格式 SOFA + NetCDF4/HDF5 封装）
 *
 * fixture 用测试内手写的最小 NetCDF3 二进制字节构造（DataView 大端）：
 * 头部 32 字节 → 维度列表（12 字节/条）→ 变量表（名称 4 对齐 + 字段）→ 数据段
 * （固定变量在前按变量表顺序；记录变量在后按记录交错，recsize = 各记录变量
 * vsize 之和——与 sofa.ts 解析器布局约定一致，参考 netcdf-c NC_begins）。
 * 覆盖：完整解析（形状/值/行主序布局）、单耳 [M,N] 复制、0.1° 容差合并平均、
 * 缺变量 / NetCDF4(HDF5) magic / CDF-2 变体 / 坏 magic / 文件过小 / 数据截断。
 *
 * HDF5 路径为**自洽测试**：h5wasm 可写文件（测试内用 h5wasm 创建含
 * /Data/IR、/SourcePosition、/Data/SamplingRate 的最小 HDF5 → 读回字节 →
 * parseSofaFileSmart/parseSofaHdf5 解析 → 断言网格映射与 NetCDF3 规则一致）。
 * h5wasm 不可用（import 失败）→ 整组 describe.skipIf 跳过，不影响其余用例。
 */
import { describe, it, expect } from 'vitest'
import { parseSofaFile, parseSofaFileSmart } from '../sofa'

/** h5wasm 可用性探测（HDF5 用例组整体跳过用；h5wasm 为本仓库硬依赖，探测为防御） */
let h5wasmAvailable = false
try {
  const mod = await import('h5wasm')
  await mod.default.ready
  h5wasmAvailable = true
} catch {
  h5wasmAvailable = false
}

/** 大端 f32 值 → 字节 */
function f32Bytes(values: number[]): number[] {
  const out: number[] = []
  const buf = new ArrayBuffer(4)
  const view = new DataView(buf)
  for (const v of values) {
    view.setFloat32(0, v, false)
    out.push(...new Uint8Array(buf))
  }
  return out
}

interface FixtureVar {
  name: string
  dimIds: number[]
  data: number[]
}

/**
 * 测试用最小 NetCDF3 classic 文件构造器（手写大端字节）。
 * 记录变量判定：numrecs > 0 且 dimIds[0] === 0（记录维 = id 0，长度存 0）。
 */
function buildNetCdf3(opts: {
  magic?: number[]
  numrecs?: number
  dims?: { name: string; length: number }[]
  vars?: FixtureVar[]
  /** 尾部补零到该长度（真实文件可含尾部填充；解析用绝对偏移不受影响） */
  padTo?: number
}): Uint8Array {
  const magic = opts.magic ?? [0x43, 0x44, 0x46, 0x01] // 'CDF\x01'
  const numrecs = opts.numrecs ?? 0
  const dims = opts.dims ?? []
  const vars = opts.vars ?? []
  const out: number[] = []

  const u32 = (v: number): void => {
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  }
  const name = (s: string): void => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff)
    out.push(0)
    while (out.length % 4 !== 0) out.push(0)
  }
  const setU32At = (pos: number, v: number): void => {
    out[pos] = (v >>> 24) & 0xff
    out[pos + 1] = (v >>> 16) & 0xff
    out[pos + 2] = (v >>> 8) & 0xff
    out[pos + 3] = v & 0xff
  }

  // —— 头部（32 字节）：magic / numrecs / dim_list / gatt_list / var_list + 12 保留 ——
  out.push(...magic)
  u32(numrecs)
  const dimOffPos = out.length
  u32(0)
  const gattOffPos = out.length
  u32(0)
  const varOffPos = out.length
  u32(0)
  for (let i = 0; i < 12; i++) out.push(0)

  // —— 维度列表（名称 | 长度 | 保留，12 字节/条；空名记录终止）——
  const dimOff = out.length
  for (const d of dims) {
    name(d.name)
    u32(d.length)
    u32(0)
  }
  name('') // 空名终止记录（4 字节 0）

  // —— 变量表（先算 vsize/begin：固定变量数据在前，记录变量按记录交错在后）——
  const varOff = out.length
  const isRecordVar = (dimIds: number[]): boolean => numrecs > 0 && dimIds[0] === 0
  const varRecordSize = (v: FixtureVar): number => {
    const nameBytes = Math.ceil((v.name.length + 1) / 4) * 4
    return nameBytes + 4 + v.dimIds.length * 4 + 4 + 4 + 4 + 4
  }
  // 数据段起始 = 变量表后 + 空名终止记录（4 字节）
  const dataStart = varOff + vars.reduce((s, v) => s + varRecordSize(v), 0) + 4

  const begins = new Map<string, number>()
  const vsizes = new Map<string, number>()
  let cursor = dataStart
  for (const v of vars) {
    if (isRecordVar(v.dimIds)) continue // 记录变量 begin 在记录 0 内分配
    begins.set(v.name, cursor)
    const size = v.data.length * 4 // 本 fixture 全部为 float
    vsizes.set(v.name, size)
    cursor += size
  }
  const recVars = vars.filter((v) => isRecordVar(v.dimIds))
  for (const v of recVars) vsizes.set(v.name, (v.data.length / numrecs) * 4) // 单条记录大小
  let recCursor = cursor // 记录 0 起始
  for (const v of recVars) {
    begins.set(v.name, recCursor)
    recCursor += vsizes.get(v.name)!
  }

  // 写变量记录（NC_FLOAT = 5）
  for (const v of vars) {
    name(v.name)
    u32(v.dimIds.length)
    for (const d of v.dimIds) u32(d)
    u32(0) // vatt_list：无属性
    u32(5)
    u32(vsizes.get(v.name)!)
    u32(begins.get(v.name)!)
  }
  name('') // 空名终止记录（4 字节 0）

  // —— 数据段：固定变量在前（变量表顺序），记录变量按记录交错（变量表顺序）——
  for (const v of vars) {
    if (!isRecordVar(v.dimIds)) out.push(...f32Bytes(v.data))
  }
  for (let rec = 0; rec < numrecs; rec++) {
    for (const v of recVars) {
      const perRec = v.data.length / numrecs
      out.push(...f32Bytes(v.data.slice(rec * perRec, (rec + 1) * perRec)))
    }
  }

  setU32At(dimOffPos, dimOff)
  setU32At(gattOffPos, 0)
  setU32At(varOffPos, varOff)
  if (opts.padTo !== undefined) {
    while (out.length < opts.padTo) out.push(0)
  }
  return new Uint8Array(out)
}

/** 主 fixture 参数：M=2（记录维）、R=2、N=128；测量 0 (az=0,el=0)、测量 1 (az=90,el=-30) */
function mainOpts(): { numrecs: number; dims: { name: string; length: number }[]; vars: FixtureVar[] } {
  const N = 128
  const ir: number[] = []
  // 每条记录 [R,N]：先左耳 N 样本再右耳 N 样本（SOFA 惯例 R=0 左 / R=1 右）
  for (let i = 0; i < N; i++) ir.push(i + 1) // 测量 0 左耳 1..128
  for (let i = 0; i < N; i++) ir.push(-(i + 1)) // 测量 0 右耳 -1..-128
  for (let i = 0; i < N; i++) ir.push(10 * (i + 1)) // 测量 1 左耳 10..1280
  for (let i = 0; i < N; i++) ir.push(-10 * (i + 1)) // 测量 1 右耳 -10..-1280
  return {
    numrecs: 2,
    dims: [
      { name: 'M', length: 0 }, // 记录维（unlimited）：实际条数 = numrecs = 2
      { name: 'R', length: 2 },
      { name: 'N', length: N },
      { name: 'C', length: 3 }, // SourcePosition 列数（az/el/radius）
    ],
    vars: [
      { name: 'Data.IR', dimIds: [0, 1, 2], data: ir },
      { name: 'SourcePosition', dimIds: [0, 3], data: [0, 0, 1.5, 90, -30, 1.5] },
      { name: 'Data.SamplingRate', dimIds: [], data: [48000] },
      { name: 'Data.Delay', dimIds: [0, 1], data: [0, 0, 0, 0] },
    ],
  }
}

function buildMainFixture(): Uint8Array {
  return buildNetCdf3(mainOpts())
}

describe('sofa：NetCDF3 经典格式解析（[M,R,N] 双耳 + 记录维交错布局）', () => {
  it('完整解析：形状 / 采样率 / 方位仰角去重升序 / 行主序值', () => {
    const grid = parseSofaFile(buildMainFixture().buffer as ArrayBuffer)
    expect(grid.sampleRate).toBe(48000)
    expect(grid.azimuths).toEqual([0, 90]) // 升序去重
    expect(grid.elevations).toEqual([-30, 0]) // 升序去重
    expect(grid.hrirLength).toBe(128)
    expect(grid.left.length).toBe(2 * 2 * 128) // elCount·azCount·hrirLength
    expect(grid.right.length).toBe(2 * 2 * 128)

    // 行主序 [elIdx·azCount + azIdx]：测量 0 (az=0, el=0) → elIdx=1、azIdx=0 → cell 2
    const az0 = grid.azimuths.indexOf(0)
    const el0 = grid.elevations.indexOf(0)
    const base0 = (el0 * grid.azimuths.length + az0) * grid.hrirLength
    expect(grid.left[base0]).toBe(1)
    expect(grid.left[base0 + 3]).toBe(4) // 左耳 1..128
    expect(grid.right[base0]).toBe(-1) // 右耳 -1..-128
    expect(grid.right[base0 + 127]).toBe(-128)

    // 测量 1 (az=90, el=-30) → elIdx=0、azIdx=1 → cell 1
    const az1 = grid.azimuths.indexOf(90)
    const el1 = grid.elevations.indexOf(-30)
    const base1 = (el1 * grid.azimuths.length + az1) * grid.hrirLength
    expect(grid.left[base1]).toBe(10)
    expect(grid.left[base1 + 5]).toBe(60)
    expect(grid.right[base1]).toBe(-10)
    expect(grid.right[base1 + 127]).toBe(-1280)
  })

  it('单耳 [M,N]：复制到双耳（left === right）', () => {
    const N = 128
    const ir: number[] = []
    for (let i = 0; i < N; i++) ir.push(i + 1)
    for (let i = 0; i < N; i++) ir.push(10 * (i + 1))
    const fixture = buildNetCdf3({
      numrecs: 2,
      dims: [
        { name: 'M', length: 0 },
        { name: 'N', length: N },
        { name: 'C', length: 3 }, // SourcePosition 列数（az/el/radius）
      ],
      vars: [
        { name: 'Data.IR', dimIds: [0, 1], data: ir },
        { name: 'SourcePosition', dimIds: [0, 2], data: [0, 0, 1.5, 90, 0, 1.5] },
        { name: 'Data.SamplingRate', dimIds: [], data: [48000] },
      ],
    })
    const grid = parseSofaFile(fixture.buffer as ArrayBuffer)
    expect(grid.azimuths).toEqual([0, 90])
    expect(grid.elevations).toEqual([0])
    expect(grid.hrirLength).toBe(N)
    expect(grid.left.length).toBe(1 * 2 * N)
    for (let i = 0; i < grid.left.length; i++) {
      expect(grid.left[i]).toBe(grid.right[i]) // 单耳复制
    }
    // 测量 0 在 cell (el0, az0) = 0·2+0 = 0
    expect(grid.left[0]).toBe(1)
    expect(grid.left[127]).toBe(128)
    // 测量 1 在 cell (el0, az1) = 0·2+1 = 1
    expect(grid.left[N]).toBe(10)
    expect(grid.left[N + 5]).toBe(60)
  })

  it('0.1° 容差合并：az 0.04 / 0 四舍五入后同格 → 增量平均', () => {
    const N = 128
    const ir: number[] = []
    for (let i = 0; i < N; i++) ir.push(1) // 测量 0：全 1
    for (let i = 0; i < N; i++) ir.push(3) // 测量 1：全 3
    const fixture = buildNetCdf3({
      numrecs: 2,
      dims: [
        { name: 'M', length: 0 },
        { name: 'N', length: N },
        { name: 'C', length: 3 },
      ],
      vars: [
        { name: 'Data.IR', dimIds: [0, 1], data: ir },
        { name: 'SourcePosition', dimIds: [0, 2], data: [0.04, 0, 1, 0, 0, 1] },
        { name: 'Data.SamplingRate', dimIds: [], data: [48000] },
      ],
    })
    const grid = parseSofaFile(fixture.buffer as ArrayBuffer)
    expect(grid.azimuths).toEqual([0]) // 0.04 → 0 合并
    expect(grid.elevations).toEqual([0])
    expect(grid.left.length).toBe(1 * 1 * N)
    for (let i = 0; i < N; i++) {
      expect(grid.left[i]).toBe(2) // (1+3)/2 平均合并
      expect(grid.right[i]).toBe(2)
    }
  })
})

describe('sofa：防御性校验', () => {
  it('缺少 Data.SamplingRate 抛中文错误', () => {
    const fixture = buildNetCdf3({ ...mainOpts(), vars: mainOpts().vars.filter((v) => v.name !== 'Data.SamplingRate') })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/缺少变量 Data\.SamplingRate/)
  })

  it('缺少 SourcePosition 抛中文错误', () => {
    const fixture = buildNetCdf3({ ...mainOpts(), vars: mainOpts().vars.filter((v) => v.name !== 'SourcePosition') })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/缺少变量 SourcePosition/)
  })

  it('缺少 Data.IR 抛中文错误', () => {
    // 去掉 IR 后文件变小，尾部补零到 ≥1024（真实文件可含尾部填充，解析用绝对偏移不受影响）
    const fixture = buildNetCdf3({
      ...mainOpts(),
      vars: mainOpts().vars.filter((v) => v.name !== 'Data.IR'),
      padTo: 1024,
    })
    expect(fixture.byteLength).toBeGreaterThanOrEqual(1024)
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/缺少变量 Data\.IR/)
  })

  it('NetCDF4/HDF5 封装（HDF5 签名 magic）抛中文错误', () => {
    // HDF5 文件签名：\x89HDF\r\n\x1a\n（NetCDF4 底层封装）
    const fixture = buildNetCdf3({ ...mainOpts(), magic: [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a] })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/暂不支持 NetCDF4\/HDF5 封装，请导出经典格式/)
  })

  it('CDF-2（64 位偏移）变体抛中文错误', () => {
    const fixture = buildNetCdf3({ ...mainOpts(), magic: [0x43, 0x44, 0x46, 0x02] })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/暂不支持 NetCDF 扩展变体/)
  })

  it('坏 magic 抛中文错误', () => {
    const fixture = buildNetCdf3({ ...mainOpts(), magic: [0x00, 0x00, 0x00, 0x00] })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/不是有效的 NetCDF3 经典格式 SOFA 文件/)
  })

  it('文件过小（<1024 字节）抛中文错误', () => {
    const N = 4 // 小 IR → 整文件约 236 字节
    const ir: number[] = []
    for (let i = 0; i < N; i++) ir.push(1)
    for (let i = 0; i < N; i++) ir.push(-1)
    const fixture = buildNetCdf3({
      numrecs: 2,
      dims: [
        { name: 'M', length: 0 },
        { name: 'N', length: N },
        { name: 'C', length: 3 },
      ],
      vars: [
        { name: 'Data.IR', dimIds: [0, 1], data: ir },
        { name: 'SourcePosition', dimIds: [0, 2], data: [0, 0, 1, 90, 0, 1] },
        { name: 'Data.SamplingRate', dimIds: [], data: [48000] },
      ],
    })
    expect(fixture.byteLength).toBeLessThan(1024)
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/文件过小/)
  })

  it('数据段截断（文件被截尾）抛中文错误', () => {
    const fixture = buildMainFixture()
    const truncated = fixture.slice(0, fixture.byteLength - 64) // 截掉记录 1 尾部
    expect(truncated.byteLength).toBeGreaterThanOrEqual(1024)
    expect(() => parseSofaFile(truncated.buffer as ArrayBuffer)).toThrow(/文件截断/)
  })

  it('Data.IR 维度数不符合约定（如 1 维）抛中文错误', () => {
    const fixture = buildNetCdf3({ ...mainOpts(), vars: mainOpts().vars.map((v) => (v.name === 'Data.IR' ? { ...v, dimIds: [2] } : v)) })
    expect(() => parseSofaFile(fixture.buffer as ArrayBuffer)).toThrow(/Data\.IR 维度数/)
  })
})

describe('sofa：parseSofaFileSmart magic 自动分派', () => {
  it('NetCDF3 经典格式（CDF\\x01）→ 同步路径，结果与 parseSofaFile 逐位一致', async () => {
    const fixture = buildMainFixture()
    const buf = fixture.buffer as ArrayBuffer
    const grid = await parseSofaFileSmart(buf)
    expect(grid).toEqual(parseSofaFile(buf))
  })

  it('未知 magic（非 CDF\\x01 / 非 HDF5 签名）→ 抛中文错误', async () => {
    const fixture = buildNetCdf3({ ...mainOpts(), magic: [0x00, 0x01, 0x02, 0x03] })
    await expect(parseSofaFileSmart(fixture.buffer as ArrayBuffer)).rejects.toThrow(/不是有效的 SOFA 文件/)
  })

  it('文件过小（< 8 字节，装不下任何签名）→ 抛中文错误', async () => {
    const buf = new Uint8Array([0x43, 0x44, 0x46]).buffer as ArrayBuffer // 仅 3 字节
    await expect(parseSofaFileSmart(buf)).rejects.toThrow(/文件过小/)
  })
})

describe.skipIf(!h5wasmAvailable)('sofa：NetCDF4/HDF5 封装（h5wasm 自洽：h5wasm 写 → 我们读）', () => {
  /**
   * 用 h5wasm 构造最小 HDF5 SOFA 文件并读出原始字节（测试与 sofa.ts 动态 import
   * 的是同一模块实例，FS 共享；文件名带随机后缀防并行冲突，用后即删）。
   */
  async function buildSofaHdf5(opts: {
    /** 是否写 Data.SamplingRate（false = 缺变量 fixture） */
    withRate?: boolean
    /** IR 形状：'mrn' 双耳 [M,R,N] / 'mn' 单耳 [M,N] */
    irShape?: 'mrn' | 'mn'
    /** 是否写 Conventions 属性（false = 不写） */
    withConventions?: boolean
    /** Conventions 值（默认 'SOFA'） */
    conventions?: string
  }): Promise<ArrayBuffer> {
    const { withRate = true, irShape = 'mrn', withConventions = true, conventions = 'SOFA' } = opts
    const mod = await import('h5wasm')
    const h5 = mod.default
    await h5.ready
    const { FS } = await h5.ready
    const name = `sofa-hdf5-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.h5`
    try {
      const f = new h5.File(name, 'w')
      try {
        const N = 128
        const m = 2
        const r = irShape === 'mrn' ? 2 : 1
        // 与 NetCDF3 主 fixture 同数据：[M,R,N] 行主序——
        // 测量 0 左耳 1..128 / 右耳 -1..-128；测量 1 左耳 10..1280 / 右耳 -10..-1280
        const ir = new Float32Array(m * r * N)
        for (let i = 0; i < N; i++) {
          ir[i] = i + 1
          ir[N + i] = -(i + 1)
          ir[2 * N + i] = 10 * (i + 1)
          if (r === 2) ir[3 * N + i] = -10 * (i + 1)
        }
        // netCDF4 布局：名称中的 '.' 映射为分组（Data 组内含 IR/SamplingRate，
        // SourcePosition 在根组）——与 netcdf-c 写出的真实 SOFA 文件一致
        const dataGroup = f.create_group('Data')
        dataGroup.create_dataset({ name: 'IR', data: ir, shape: [m, r, N] })
        f.create_dataset({ name: 'SourcePosition', data: new Float32Array([0, 0, 1.5, 90, -30, 1.5]), shape: [2, 3] })
        if (withRate) dataGroup.create_dataset({ name: 'SamplingRate', data: 48000, dtype: '<f4' })
        if (withConventions) f.create_attribute('Conventions', conventions)
      } finally {
        f.close()
      }
      const raw = FS.readFile(name)
      const copy = new Uint8Array(raw.byteLength)
      copy.set(raw)
      return copy.buffer
    } finally {
      try {
        FS.unlink(name)
      } catch {
        /* noop */
      }
    }
  }

  it('完整解析：[M,R,N] 双耳 → 与 NetCDF3 同数据的网格映射完全一致', async () => {
    const grid = await parseSofaFileSmart(await buildSofaHdf5({}))
    expect(grid.sampleRate).toBe(48000)
    expect(grid.azimuths).toEqual([0, 90]) // 升序去重
    expect(grid.elevations).toEqual([-30, 0])
    expect(grid.hrirLength).toBe(128)
    expect(grid.left.length).toBe(2 * 2 * 128)
    expect(grid.right.length).toBe(2 * 2 * 128)

    // 行主序 [elIdx·azCount + azIdx]：测量 0 (az=0, el=0) → elIdx=1、azIdx=0 → cell 2
    const az0 = grid.azimuths.indexOf(0)
    const el0 = grid.elevations.indexOf(0)
    const base0 = (el0 * grid.azimuths.length + az0) * grid.hrirLength
    expect(grid.left[base0]).toBe(1)
    expect(grid.left[base0 + 3]).toBe(4)
    expect(grid.right[base0]).toBe(-1)
    expect(grid.right[base0 + 127]).toBe(-128)

    // 测量 1 (az=90, el=-30) → elIdx=0、azIdx=1 → cell 1
    const az1 = grid.azimuths.indexOf(90)
    const el1 = grid.elevations.indexOf(-30)
    const base1 = (el1 * grid.azimuths.length + az1) * grid.hrirLength
    expect(grid.left[base1]).toBe(10)
    expect(grid.left[base1 + 5]).toBe(60)
    expect(grid.right[base1]).toBe(-10)
    expect(grid.right[base1 + 127]).toBe(-1280)
  })

  it('单耳 [M,N]：复制到双耳（left === right）', async () => {
    const grid = await parseSofaFileSmart(await buildSofaHdf5({ irShape: 'mn' }))
    expect(grid.azimuths).toEqual([0, 90])
    expect(grid.elevations).toEqual([-30, 0])
    expect(grid.hrirLength).toBe(128)
    expect(grid.left.length).toBe(2 * 2 * 128)
    for (let i = 0; i < grid.left.length; i++) {
      expect(grid.left[i]).toBe(grid.right[i]) // 单耳复制
    }
  })

  it('HDF5 签名 → 走 parseSofaHdf5；缺 Data.SamplingRate → 中文错误', async () => {
    await expect(parseSofaFileSmart(await buildSofaHdf5({ withRate: false }))).rejects.toThrow(/缺少变量 \/Data\/SamplingRate/)
  })

  it('Conventions 属性非 SOFA → 中文错误（与 NetCDF3 路径同规则）', async () => {
    await expect(parseSofaFileSmart(await buildSofaHdf5({ conventions: 'CF-1.8' }))).rejects.toThrow(
      /Conventions 属性为「CF-1.8」，不是 SOFA/,
    )
  })
})

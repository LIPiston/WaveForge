/**
 * sofa —— SOFA（AES69）HRTF 文件解析器（NetCDF3 经典格式 + NetCDF4/HDF5 封装）
 *
 * 解析目标：HrtfGrid（见 types.ts）——azimuths/elevations 去重排序
 * （四舍五入到 0.1° 容差内合并）、HRIR 统一长度、left/right 按
 * [elIdx·azCount + azIdx] 行主序（与 grid.bin 布局一致，后端 loadHrtf 直接消费）。
 * 纯函数（NetCDF3 路径）、无浏览器 API 依赖（主线程 / 测试 / 未来 worklet 侧均可使用）。
 *
 * 支持范围与限制：
 *  - NetCDF3 经典格式（magic 'CDF\x01'）：同步解析（parseSofaFile）。
 *  - NetCDF4/HDF5 封装（HDF5 签名 \x89HDF\r\n\x1a\n）：异步解析（parseSofaHdf5）——
 *    经 h5wasm（纯 WASM HDF5 库，wasm 内联无系统依赖；动态 import 懒加载，仅导入
 *    HDF5 文件时拉取，避免主包膨胀）。两路径共享同一网格装配规则（assembleGrid）。
 *  - 入口 parseSofaFileSmart 按 magic 自动分派；CDF-2（64 位偏移）/ CDF-5（64 位
 *    数据）变体不支持（SOFA 文件罕见）；
 *  - IR 不做增益归一化（数据原样）；采样率不匹配时的重采样由 fusion.resampleGrid
 *    按需处理（导入时一次性，见 fusion.ts）。
 *
 * SOFA 惯例映射（AES69-2015）：
 *  - Data.IR：float，维度 [M,R,N]（R=0/1 为左/右耳；R=1 视为单耳复制；R>2 取 0/1
 *    两接收器，多余忽略）或 [M,N]（单耳，复制到双耳）；
 *  - SourcePosition：[M,3]（az/el/radius，度/米）或 [M,2]（az/el）→ 网格方位/仰角
 *    列表；radius 忽略（HRIR 只含方向信息，距离由后端距离衰减模型处理）；
 *  - Data.SamplingRate：标量或 [M] → 取首个；与引擎 fs 不一致时由 fusion 侧重采样；
 *  - Data.Delay：[M,R]——忽略（延迟已含于 IR 冲激中，直接卷积即可，无需额外对齐）；
 *  - ListenerPosition：忽略（SOFA 双耳渲染约定听者位于原点）。
 *
 * NetCDF4/HDF5 解析（h5wasm）：
 *  - NetCDF4 写的 SOFA 中 /Data/IR、/Data/SamplingRate、/SourcePosition 是 HDF5
 *    dataset（netcdf-c 把名称中的 '.' 映射为分组层级）；h5wasm 的 File.get(path)
 *    按绝对路径取实体，Dataset.value 读为 TypedArray、shape 为维度列表；
 *  - 大端（littleEndian=false）float 数据 h5wasm 直接按原生字节解释（值会错位），
 *    读取侧按 DataView 手动交换字节兜底（SOFA 实际文件几乎都是小端，防御分支）；
 *  - float64（size=8）容忍：降采样为 float32（HrtfGrid 统一 f32 载荷）；
 *
 * NetCDF3 classic 字节布局（参考 netcdf-c libsrc/nc3internal.c / ncx.c）：
 *   头部（32 字节）：magic(4) | numrecs(4) | dim_list 偏移(4) | gatt_list 偏移(4)
 *     | var_list 偏移(4) | 保留(12)；全部整数大端；
 *   维度记录（12 字节）：名称(null 结尾、4 字节对齐) | 长度(4) | 保留(4)；空名终止；
 *    记录维（unlimited）必须为 id 0，列表中长度存 0，实际条数 = numrecs；
 *   变量记录：名称 | ndims(4) | dimids(ndims×4) | vatt_list(4) | vtype(4) |
 *     vsize(4) | begin(4)；空名终止；vsize 不含记录维，记录变量 vsize = 单条记录字节数
 *     （4 字节对齐）；
 *   属性记录：名称 | nctype(4) | nelems(4) | 数据（每元素按 4 字节边界存放）；
 *   数据段：固定变量数据在前（按变量表顺序），记录变量数据在后**按记录交错**——
 *     recsize = 各记录变量 vsize 之和（变量表顺序），记录变量测量 i 的数据位于
 *     begin + i·recsize（NC_begins 语义）。
 */

import type * as H5 from 'h5wasm'
import type { HrtfGrid } from './types'

/** NetCDF3 外部类型码 */
const NC_BYTE = 1
const NC_CHAR = 2
const NC_SHORT = 3
const NC_INT = 4
const NC_FLOAT = 5
const NC_DOUBLE = 6

/** 各外部类型单值字节数 */
const TYPE_SIZE: Record<number, number> = {
  [NC_BYTE]: 1,
  [NC_CHAR]: 1,
  [NC_SHORT]: 2,
  [NC_INT]: 4,
  [NC_FLOAT]: 4,
  [NC_DOUBLE]: 8,
}

/** HDF5 文件签名（NetCDF4 底层封装）：\x89HDF\r\n\x1a\n */
const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]

/** HDF5 数据类型类（H5T_class_t）：float = 1（SOFA 约定 Data.IR 等均为 float） */
const H5T_FLOAT = 1

/** 临时 HDF5 文件名序号（Emscripten FS 内存文件，用完即删；序号防同毫秒重名） */
let hdf5TempSeq = 0

/** 是否为 HDF5 签名（NetCDF4 封装） */
function isHdf5Magic(bytes: Uint8Array): boolean {
  return bytes.length >= HDF5_MAGIC.length && HDF5_MAGIC.every((b, i) => bytes[i] === b)
}

/** 是否为 NetCDF3 经典格式（magic 'CDF\x01'） */
function isNetCdf3Classic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x43 && // 'C'
    bytes[1] === 0x44 && // 'D'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x01
  )
}

/** 文件过小阈值（防御：合法 SOFA 至少含头部 + 变量表 + 数据段） */
const MIN_FILE_BYTES = 1024

/** 名称最长字节数（防损坏文件死循环） */
const MAX_NAME_BYTES = 256

/** NetCDF3 维度 */
interface NcDim {
  name: string
  length: number
}

/** NetCDF3 变量 */
interface NcVar {
  name: string
  type: number
  dimIds: number[]
  /** 变量数据字节数（记录变量 = 单条记录大小，4 对齐） */
  vsize: number
  /** 数据起始绝对偏移（记录变量 = 记录 0 中该变量的位置） */
  begin: number
  /** 记录变量（数据按 numrecs 条记录交错存放：测量 i 位于 begin + i·recsize） */
  isRecord: boolean
}

/** NetCDF3 文件游标读取器（大端序；名称 null 结尾、4 字节对齐） */
class Nc3Reader {
  private readonly view: DataView
  private off = 0

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number {
    return this.bytes.length
  }

  /** 跳转绝对偏移 */
  seek(offset: number): void {
    this.off = offset
  }

  /** 读取 u32（大端） */
  u32(): number {
    this.ensure(4)
    const v = this.view.getUint32(this.off, false)
    this.off += 4
    return v
  }

  /** 读取 1 字节 */
  byte(): number {
    this.ensure(1)
    return this.bytes[this.off++]
  }

  /** 跳过 n 字节 */
  skip(n: number): void {
    this.ensure(n)
    this.off += n
  }

  /** 对齐到 4 字节边界（向后） */
  align4(): void {
    this.off = Math.min(this.bytes.length, Math.ceil(this.off / 4) * 4)
  }

  /** 读取名称：null 结尾字符串，含终止符共 4 字节对齐；空名 = 列表终止记录 */
  name(): string {
    const start = this.off
    let end = start
    const maxEnd = Math.min(this.bytes.length, start + MAX_NAME_BYTES)
    while (end < maxEnd && this.bytes[end] !== 0) end++
    const s = String.fromCharCode(...this.bytes.subarray(start, end))
    this.off = Math.min(this.bytes.length, Math.ceil((end + 1) / 4) * 4)
    return s
  }

  /** 绝对偏移读取 f32（大端），越界抛中文错误 */
  f32At(offset: number): number {
    if (offset + 4 > this.bytes.length) {
      throw new Error(`文件截断：偏移 ${offset} 需 4 字节，文件仅 ${this.bytes.length} 字节`)
    }
    return this.view.getFloat32(offset, false)
  }

  private ensure(n: number): void {
    if (this.off + n > this.bytes.length) {
      throw new Error(`文件截断：偏移 ${this.off} 需 ${n} 字节，文件仅 ${this.bytes.length} 字节`)
    }
  }
}

/** 解析维度列表（空名记录终止；记录维 id 0 长度以 numrecs 为准） */
function readDims(reader: Nc3Reader, offset: number, numrecs: number): NcDim[] {
  const dims: NcDim[] = []
  reader.seek(offset)
  for (;;) {
    const name = reader.name()
    if (name === '') break
    const length = reader.u32()
    reader.u32() // 保留字段（应为 0，忽略）
    dims.push({ name, length })
  }
  // 记录维（unlimited，id 0）：dim_list 中长度恒为 0，实际条数 = numrecs
  if (dims.length > 0 && dims[0].length === 0) dims[0].length = numrecs
  return dims
}

/** 解析变量表（空名记录终止） */
function readVars(reader: Nc3Reader, offset: number, numrecs: number): NcVar[] {
  const vars: NcVar[] = []
  reader.seek(offset)
  for (;;) {
    const name = reader.name()
    if (name === '') break
    const ndims = reader.u32()
    const dimIds: number[] = []
    for (let i = 0; i < ndims; i++) dimIds.push(reader.u32())
    reader.u32() // vatt_list（变量属性列表偏移，解析用绝对偏移，无需遍历）
    const type = reader.u32()
    const vsize = reader.u32()
    const begin = reader.u32()
    vars.push({ name, type, dimIds, vsize, begin, isRecord: numrecs > 0 && dimIds.length > 0 && dimIds[0] === 0 })
  }
  return vars
}

/** 解析属性列表（空名记录终止）→ 名称→字符串值（仅 NC_CHAR 属性；其余类型跳过） */
function readAttributes(reader: Nc3Reader, offset: number): Map<string, string> {
  const out = new Map<string, string>()
  reader.seek(offset)
  for (;;) {
    const name = reader.name()
    if (name === '') break
    const type = reader.u32()
    const nelems = reader.u32()
    if (type === NC_CHAR) {
      let s = ''
      for (let i = 0; i < nelems; i++) s += String.fromCharCode(reader.byte())
      reader.align4() // char 每元素 4 字节对齐
      out.set(name, s)
    } else {
      // 非字符属性跳过：每元素按 4 字节边界存放（byte/char/short 各占 4 字节槽）
      const elem = TYPE_SIZE[type] ?? 4
      reader.skip(nelems * (elem < 4 ? 4 : elem))
    }
  }
  return out
}

/** 在变量表中按名查找（缺失抛中文错误） */
function mustFindVar(vars: NcVar[], name: string): NcVar {
  const v = vars.find((x) => x.name === name)
  if (!v) throw new Error(`缺少变量 ${name}，不是有效的 SOFA（NetCDF3）文件`)
  return v
}

/** 变量各维长度（校验维度引用合法，防损坏文件越界） */
function varDimLengths(v: NcVar, dims: NcDim[]): number[] {
  return v.dimIds.map((id) => {
    const d = dims[id]
    if (!d) throw new Error(`变量 ${v.name} 引用了不存在的维度 #${id}（文件损坏）`)
    return d.length
  })
}

/**
 * 解析 SOFA（NetCDF3 经典格式）文件字节 → HrtfGrid。
 * 仅支持经典格式；NetCDF4/HDF5 封装抛中文错误（限制说明见文件头）。
 */
export function parseSofaFile(buffer: ArrayBuffer): HrtfGrid {
  const bytes = new Uint8Array(buffer)
  // 防御：文件过小直接拒绝（头部/变量表/数据段都装不下）
  if (bytes.byteLength < MIN_FILE_BYTES) {
    throw new Error(`文件过小（${bytes.byteLength} < ${MIN_FILE_BYTES} 字节），不是有效的 SOFA（NetCDF3）文件`)
  }

  // magic 校验：HDF5 签名（NetCDF4 封装）请走 parseSofaFileSmart/parseSofaHdf5；
  // CDF-2/CDF-5 变体不支持
  if (isHdf5Magic(bytes)) {
    // \x89HDF\r\n\x1a\n —— HDF5 文件签名（NetCDF4 底层封装）
    throw new Error('暂不支持 NetCDF4/HDF5 封装，请导出经典格式（NetCDF3 classic）')
  }
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic === 'CDF\x02' || magic === 'CDF\x05') {
    // CDF-2 = 64 位偏移、CDF-5 = 64 位数据（大文件变体，SOFA 罕见）
    throw new Error('暂不支持 NetCDF 扩展变体（CDF-2/CDF-5），请导出经典格式（NetCDF3 classic）')
  }
  if (magic !== 'CDF\x01') {
    throw new Error('不是有效的 NetCDF3 经典格式 SOFA 文件')
  }

  const reader = new Nc3Reader(bytes)
  reader.seek(4) // 跳过 magic（已在上方校验）
  const numrecs = reader.u32() // 记录条数（M 为记录维时 = 测量数）
  const dimOff = reader.u32()
  const gattOff = reader.u32()
  const varOff = reader.u32()
  // 头部第 20 字节后为 12 字节保留区（共 32 字节）；解析用绝对偏移，无需读取

  if (dimOff === 0 || dimOff >= bytes.byteLength) {
    throw new Error('缺少维度定义（文件损坏），不是有效的 SOFA（NetCDF3）文件')
  }
  if (varOff === 0 || varOff >= bytes.byteLength) {
    throw new Error('缺少变量表（文件损坏），不是有效的 SOFA（NetCDF3）文件')
  }
  const dims = readDims(reader, dimOff, numrecs)
  const vars = readVars(reader, varOff, numrecs)
  const gatts = gattOff === 0 ? new Map<string, string>() : readAttributes(reader, gattOff)

  // 软校验：Conventions 属性存在且不含 SOFA → 不是 SOFA 文件
  const conventions = gatts.get('Conventions')
  if (conventions !== undefined && !conventions.includes('SOFA')) {
    throw new Error(`文件 Conventions 属性为「${conventions}」，不是 SOFA（AES69）文件`)
  }

  const ir = mustFindVar(vars, 'Data.IR')
  const pos = mustFindVar(vars, 'SourcePosition')
  const rate = mustFindVar(vars, 'Data.SamplingRate')

  // 类型校验：SOFA 约定三者均为 float
  for (const v of [ir, pos, rate]) {
    if (v.type !== NC_FLOAT) {
      throw new Error(`变量 ${v.name} 类型不是 float（NetCDF 类型码 ${v.type}），不符合 SOFA 约定`)
    }
  }

  // Data.IR 维度：[M,R,N] 双耳 / [M,N] 单耳
  const irDims = varDimLengths(ir, dims)
  let m: number
  let r: number
  let n: number
  if (irDims.length === 3) {
    m = irDims[0]
    r = irDims[1]
    n = irDims[2]
  } else if (irDims.length === 2) {
    m = irDims[0]
    r = 1 // 单耳 [M,N]：复制到双耳
    n = irDims[1]
  } else {
    throw new Error(`Data.IR 维度数 ${irDims.length} 不符合 SOFA 约定（应为 [M,R,N] 或 [M,N]）`)
  }
  if (m < 1) throw new Error('Data.IR 测量数 M 为 0（文件无有效测量）')
  if (r < 1) throw new Error('Data.IR 接收器数 R 为 0（文件损坏）')
  if (n < 1) throw new Error('Data.IR 样本数 N 为 0（文件损坏）')

  // SourcePosition 维度：[M,3] 或 [M,2]（az/el[/radius]）
  const posDims = varDimLengths(pos, dims)
  if (posDims.length !== 2 || posDims[0] !== m || (posDims[1] !== 3 && posDims[1] !== 2)) {
    throw new Error(`SourcePosition 维度 [${posDims.join(',')}] 不符合 SOFA 约定（应为 [M,3] 或 [M,2]）`)
  }
  const posCols = posDims[1]

  // 记录段布局（NC_begins 语义）：recsize = 各记录变量 vsize 之和（变量表顺序）；
  // 记录变量测量 i 的数据位于 begin + i·recsize（记录交错）
  const recsize = vars.reduce((s, v) => (v.isRecord ? s + v.vsize : s), 0)

  // —— 读取 Data.IR（逐测量：每测量 r·n 个 float）——
  const irTotal = m * r * n
  const irStride = ir.isRecord ? recsize : r * n * 4 // 固定变量连续存放
  const irData = new Float32Array(irTotal)
  for (let i = 0; i < m; i++) {
    const recBase = ir.begin + i * irStride
    for (let j = 0; j < r * n; j++) irData[i * r * n + j] = reader.f32At(recBase + j * 4)
  }

  // —— 读取 SourcePosition ——
  const posTotal = m * posCols
  const posStride = pos.isRecord ? recsize : posCols * 4
  const posData = new Float32Array(posTotal)
  for (let i = 0; i < m; i++) {
    const recBase = pos.begin + i * posStride
    for (let j = 0; j < posCols; j++) posData[i * posCols + j] = reader.f32At(recBase + j * 4)
  }

  // —— Data.SamplingRate：标量或 [M]——取首个（不一致时由 loadHrtf/fusion 侧处理）——
  const sampleRate = Math.round(reader.f32At(rate.begin))
  if (!(sampleRate > 0)) throw new Error('Data.SamplingRate 非法（≤ 0），文件损坏')

  // —— 逐测量拆分双耳 IR（R=0 左耳 / R=1 右耳；R=1 单耳复制；R>2 忽略多余接收器）——
  const leftAll = new Float32Array(m * n)
  const rightAll = new Float32Array(m * n)
  for (let i = 0; i < m; i++) {
    const base = i * r * n
    leftAll.set(irData.subarray(base, base + n), i * n)
    if (r >= 2) rightAll.set(irData.subarray(base + n, base + 2 * n), i * n)
    else rightAll.set(irData.subarray(base, base + n), i * n)
  }

  // 网格装配（与 HDF5 路径共享同一规则，见 assembleGrid）
  const azimuthsRaw = new Array<number>(m)
  const elevationsRaw = new Array<number>(m)
  for (let i = 0; i < m; i++) {
    azimuthsRaw[i] = posData[i * posCols]
    elevationsRaw[i] = posData[i * posCols + 1]
  }
  return assembleGrid({ sampleRate, azimuthsRaw, elevationsRaw, leftAll, rightAll, hrirLength: n })
}

/**
 * 测量级数据 → HrtfGrid 装配（NetCDF3 / HDF5 两解析路径共享，保证映射规则完全一致）：
 *  - 方位/仰角四舍五入到 0.1° 容差内合并、升序去重；
 *  - 同格（0.1° 容差合并后）多测量增量平均合并；
 *  - HRIR 统一长度（各测量 N 恒等；"不足补零"约定保留供未来变长数据源扩展）；
 *  - left/right 按 [elIdx·azCount + azIdx] 行主序。
 */
function assembleGrid(opts: {
  sampleRate: number
  /** 每测量方位角（度，原始值，未去重） */
  azimuthsRaw: number[]
  /** 每测量仰角（度，原始值，未去重） */
  elevationsRaw: number[]
  /** 双耳 IR 左耳段：m·n（行主序 [测量, 样本]） */
  leftAll: Float32Array
  /** 双耳 IR 右耳段：m·n（行主序 [测量, 样本]） */
  rightAll: Float32Array
  /** 单测量 IR 样本数 N */
  hrirLength: number
}): HrtfGrid {
  const { sampleRate, azimuthsRaw, elevationsRaw, leftAll, rightAll, hrirLength } = opts

  // —— 方位/仰角四舍五入到 0.1° 容差内合并、升序去重 ——
  const round10 = (x: number): number => {
    const v = Math.round(x * 10) / 10
    return v === 0 ? 0 : v // 归一化 -0 → 0
  }
  const azimuths = Array.from(new Set(azimuthsRaw.map(round10))).sort((a, b) => a - b)
  const elevations = Array.from(new Set(elevationsRaw.map(round10))).sort((a, b) => a - b)
  if (azimuths.length < 1 || elevations.length < 1) {
    throw new Error('HRTF 网格无有效方位/仰角（文件损坏）')
  }
  const azIndex = new Map<number, number>(azimuths.map((v, i) => [v, i] as [number, number]))
  const elIndex = new Map<number, number>(elevations.map((v, i) => [v, i] as [number, number]))

  const left = new Float32Array(elevations.length * azimuths.length * hrirLength)
  const right = new Float32Array(elevations.length * azimuths.length * hrirLength)
  // 0.1° 容差合并后同格测量计数（重复方向增量平均合并）
  const cellCount = new Uint32Array(elevations.length * azimuths.length)
  for (let i = 0; i < leftAll.length / hrirLength; i++) {
    const azIdx = azIndex.get(round10(azimuthsRaw[i]))!
    const elIdx = elIndex.get(round10(elevationsRaw[i]))!
    const cell = elIdx * azimuths.length + azIdx
    const base = cell * hrirLength
    const c = cellCount[cell]
    const srcBase = i * hrirLength
    for (let t = 0; t < hrirLength; t++) {
      const lv = leftAll[srcBase + t]
      const rv = rightAll[srcBase + t]
      left[base + t] = c === 0 ? lv : (left[base + t] * c + lv) / (c + 1)
      right[base + t] = c === 0 ? rv : (right[base + t] * c + rv) / (c + 1)
    }
    cellCount[cell] = c + 1
  }

  return { sampleRate, azimuths, elevations, hrirLength, left, right }
}

/**
 * 解析 NetCDF4/HDF5 封装的 SOFA 文件 → HrtfGrid（异步）。
 *
 * 经 h5wasm（纯 WASM HDF5 库，wasm 内联、零系统依赖）：
 *  - 动态 import 懒加载（仅解析 HDF5 文件时拉取，不膨胀主包）；h5wasm 不可用 /
 *    初始化失败 → 抛中文错误（含 h5wasm 错误信息）；
 *  - 字节写入 h5wasm 内存文件系统 → File('r') 打开 → 按绝对路径读 dataset：
 *    /Data/IR（[M,R,N] 或 [M,N] float）、/SourcePosition（[M,3] 或 [M,2]）、
 *    /Data/SamplingRate（标量或 [M]）；映射规则与 NetCDF3 路径完全一致（共享
 *    assembleGrid：R=0/1 取双耳、方位角去重排序、行主序、长度统一）；
 *  - 大端 float / float64 防御性兼容（见文件头「NetCDF4/HDF5 解析」节）；
 *  - 失败 → 中文错误（h5wasm 的英文错误信息原样附带）。
 */
export async function parseSofaHdf5(buffer: ArrayBuffer): Promise<HrtfGrid> {
  // 动态加载 h5wasm（懒加载：仅在导入 NetCDF4/HDF5 文件时拉取 ~4MB 内联 wasm 模块）
  let h5wasm: typeof H5.default
  try {
    h5wasm = (await import('h5wasm')).default
  } catch (e) {
    throw new Error(`h5wasm 不可用，无法解析 NetCDF4/HDF5 封装的 SOFA 文件：${errMessage(e)}`)
  }
  let FS: typeof H5.FS
  try {
    await h5wasm.ready
    FS = (await import('h5wasm')).FS // 同一模块实例：ready 后 FS 已挂载
    if (!FS) throw new Error('文件系统（FS）未就绪')
  } catch (e) {
    throw new Error(`h5wasm 初始化失败：${errMessage(e)}`)
  }

  const name = `waveforge-sofa-${Date.now()}-${hdf5TempSeq++}.h5`
  try {
    try {
      FS.writeFile(name, new Uint8Array(buffer))
    } catch (e) {
      throw new Error(`写入临时 HDF5 文件失败：${errMessage(e)}`)
    }
    let file: H5.File
    try {
      file = new h5wasm.File(name, 'r')
    } catch (e) {
      throw new Error(`无法打开 HDF5 文件（不是有效的 NetCDF4/HDF5 封装的 SOFA 文件）：${errMessage(e)}`)
    }
    try {
      return readSofaDatasets(h5wasm, file)
    } finally {
      try {
        file.close()
      } catch {
        /* 关闭失败无副作用（临时文件随后 unlink） */
      }
    }
  } catch (e) {
    // 内部错误已是中文 → 原样抛出；h5wasm 侧错误（多为英文）补中文前缀并附原文
    if (e instanceof Error && /[\u4e00-\u9fff]/.test(e.message)) throw e
    throw new Error(`NetCDF4/HDF5 封装的 SOFA 解析失败（h5wasm）：${errMessage(e)}`)
  } finally {
    try {
      FS.unlink(name)
    } catch {
      /* noop：临时文件清理失败可忽略 */
    }
  }
}

/**
 * 按 magic 自动分派解析：'CDF\x01'（NetCDF3 经典）→ 同步路径 parseSofaFile；
 * HDF5 签名 \x89HDF\r\n\x1a\n（NetCDF4 封装）→ 异步路径 parseSofaHdf5；
 * 其它 → 中文错误。导入流程（UI 文件选择 → 网格）的统一入口。
 */
export async function parseSofaFileSmart(buffer: ArrayBuffer): Promise<HrtfGrid> {
  const bytes = new Uint8Array(buffer)
  if (bytes.byteLength < HDF5_MAGIC.length) {
    throw new Error(`文件过小（${bytes.byteLength} < ${HDF5_MAGIC.length} 字节），不是有效的 SOFA 文件`)
  }
  if (isNetCdf3Classic(bytes)) return parseSofaFile(buffer)
  if (isHdf5Magic(bytes)) return parseSofaHdf5(buffer)
  throw new Error('不是有效的 SOFA 文件：既非 NetCDF3 经典格式（CDF\\x01），也非 NetCDF4/HDF5 封装（HDF5 签名）')
}

// ==================== NetCDF4/HDF5 内部实现 ====================

/** 错误对象 → 可读信息（h5wasm 错误多为英文，原样附带进中文错误） */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读取 float dataset（类型/形状防御校验）→ { 形状, f32 值（行主序扁平） }。
 *  - 实体缺失 / 非 Dataset / 非 float 类型 / 元素大小非 4/8 字节 → 中文错误；
 *  - float64（size=8）降采样为 float32（HrtfGrid 统一 f32 载荷）；
 *  - 大端（littleEndian=false）按 DataView 逐元素交换字节兜底（h5wasm 对非原生
 *    字节序直接按原生解释，值会错位——SOFA 实际文件几乎全为小端，防御分支）。
 */
function readFloatDataset(
  h5: typeof H5.default,
  file: H5.File,
  path: string,
): { shape: number[]; values: Float32Array } {
  const ent = file.get(path)
  if (!ent || !(ent instanceof h5.Dataset)) {
    throw new Error(`缺少变量 ${path}，不是有效的 SOFA（HDF5）文件`)
  }
  const meta = ent.metadata
  if (meta.type !== H5T_FLOAT) {
    throw new Error(`变量 ${path} 类型不是 float（HDF5 类型码 ${meta.type}），不符合 SOFA 约定`)
  }
  if (meta.size !== 4 && meta.size !== 8) {
    throw new Error(`变量 ${path} 元素大小 ${meta.size} 字节不是 float32/float64，不符合 SOFA 约定`)
  }
  const raw = ent.value
  if (raw === null || raw === undefined) {
    throw new Error(`读取变量 ${path} 失败（h5wasm 返回空数据）`)
  }
  const shape = (ent.shape ?? []).map(Number)
  return { shape, values: toNativeF32(raw, meta.littleEndian, path) }
}

/** h5wasm 读取值 → Float32Array（number 标量包成单元素；f64 降采样；大端字节交换） */
function toNativeF32(raw: unknown, littleEndian: boolean, path: string): Float32Array {
  if (typeof raw === 'number') {
    return new Float32Array([raw]) // 标量 dataset（Data.SamplingRate 常见）
  }
  if (raw instanceof Float64Array) {
    // float64 → float32 降采样（HrtfGrid 统一 f32 载荷）
    return Float32Array.from(raw)
  }
  if (!(raw instanceof Float32Array)) {
    throw new Error(`读取变量 ${path} 失败：h5wasm 返回值类型异常（${Object.prototype.toString.call(raw)}）`)
  }
  if (littleEndian) {
    return raw
  }
  // 大端兜底：h5wasm 把非原生字节序直接按原生解释（值错位），此处逐元素交换字节
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, false)
  return out
}

/** 从已打开的 HDF5 文件读 SOFA 三变量并装配网格（规则与 NetCDF3 路径一致） */
function readSofaDatasets(h5: typeof H5.default, file: H5.File): HrtfGrid {
  // 软校验：Conventions 属性存在且不含 SOFA → 不是 SOFA 文件（与 NetCDF3 路径一致）
  let convValue: unknown = null
  try {
    convValue = file.attrs['Conventions']?.value ?? null
  } catch (e) {
    throw new Error(`读取 Conventions 属性失败：${errMessage(e)}`)
  }
  if (convValue !== null) {
    const s = typeof convValue === 'string' ? convValue : Array.isArray(convValue) ? (convValue as unknown[]).join('') : String(convValue)
    if (!s.includes('SOFA')) throw new Error(`文件 Conventions 属性为「${s}」，不是 SOFA（AES69）文件`)
  }

  const ir = readFloatDataset(h5, file, '/Data/IR')
  const pos = readFloatDataset(h5, file, '/SourcePosition')
  const rate = readFloatDataset(h5, file, '/Data/SamplingRate')

  // —— Data.IR 维度：[M,R,N] 双耳 / [M,N] 单耳（与 NetCDF3 路径同规则）——
  let m: number
  let r: number
  let n: number
  if (ir.shape.length === 3) {
    m = ir.shape[0]
    r = ir.shape[1]
    n = ir.shape[2]
  } else if (ir.shape.length === 2) {
    m = ir.shape[0]
    r = 1 // 单耳 [M,N]：复制到双耳
    n = ir.shape[1]
  } else {
    throw new Error(`Data.IR 维度数 ${ir.shape.length} 不符合 SOFA 约定（应为 [M,R,N] 或 [M,N]）`)
  }
  if (m < 1) throw new Error('Data.IR 测量数 M 为 0（文件无有效测量）')
  if (r < 1) throw new Error('Data.IR 接收器数 R 为 0（文件损坏）')
  if (n < 1) throw new Error('Data.IR 样本数 N 为 0（文件损坏）')
  if (ir.values.length !== m * r * n) {
    throw new Error('Data.IR 数据长度与维度 [M,R,N] 不符（文件损坏）')
  }

  // —— SourcePosition 维度：[M,3] 或 [M,2]（az/el[/radius]）——
  if (pos.shape.length !== 2 || pos.shape[0] !== m || (pos.shape[1] !== 3 && pos.shape[1] !== 2)) {
    throw new Error(`SourcePosition 维度 [${pos.shape.join(',')}] 不符合 SOFA 约定（应为 [M,3] 或 [M,2]）`)
  }
  const posCols = pos.shape[1]
  if (pos.values.length !== m * posCols) {
    throw new Error('SourcePosition 数据长度与维度不符（文件损坏）')
  }

  // —— Data.SamplingRate：标量或 [M]——取首个（与 NetCDF3 路径同规则）——
  const sampleRate = Math.round(rate.values[0])
  if (!(sampleRate > 0)) throw new Error('Data.SamplingRate 非法（≤ 0），文件损坏')

  // —— 逐测量拆分双耳 IR（R=0 左耳 / R=1 右耳；R=1 单耳复制；R>2 忽略多余接收器）——
  const leftAll = new Float32Array(m * n)
  const rightAll = new Float32Array(m * n)
  for (let i = 0; i < m; i++) {
    const base = i * r * n
    leftAll.set(ir.values.subarray(base, base + n), i * n)
    if (r >= 2) rightAll.set(ir.values.subarray(base + n, base + 2 * n), i * n)
    else rightAll.set(ir.values.subarray(base, base + n), i * n)
  }

  // 网格装配（与 NetCDF3 路径共享同一规则，见 assembleGrid）
  const azimuthsRaw = new Array<number>(m)
  const elevationsRaw = new Array<number>(m)
  for (let i = 0; i < m; i++) {
    azimuthsRaw[i] = pos.values[i * posCols]
    elevationsRaw[i] = pos.values[i * posCols + 1]
  }
  return assembleGrid({ sampleRate, azimuthsRaw, elevationsRaw, leftAll, rightAll, hrirLength: n })
}

/**
 * convert-cipic —— CIPIC HRTF 数据库 subject_003 → hrtf-data/grid-cipic.bin 转换脚本
 *
 * 数据源（二选一，自动探测；均为 HDF5 容器，经 h5wasm 读取）：
 *  - CIPIC 官方 .mat v7.3（subject_003.mat，`MATLAB 5.0 MAT-file`）：
 *    变量 hrir_l / hrir_r（[1250,200] f64，**列主序**存储）、azimuths / elevations
 *    （[1250,1] f64，CIPIC 原生约定：az 0°=正前、**正值为左**，范围 -180..180 或
 *    0..360 均可）；优先 hrir_final（若存在，与 SOFA 版同源），回退 hrir；
 *  - sofacoustics 官方 SOFA 转换（subject_003.sofa，NetCDF4/HDF5 封装，ARI 转换，
 *    /Data.IR = hrir_final）：/Data.IR（[1250,2,200] f64，R=0 左耳 / R=1 右耳）、
 *    /SourcePosition（[1250,3]，az/el 度）、/Data.SamplingRate（44100）。
 *    下载：http://sofacoustics.org/data/database/cipic/subject_003.sofa
 *    （官方 ece.ucdavis.edu 已 410/WordPress 错误页；.mat 镜像同格式亦可）。
 *  - 源文件定位：命令行参数（路径）> 环境变量 CIPIC_SOURCE > hrtf-data/cipic/
 *    目录下自动探测（subject_003.mat 优先，其次 .sofa）。
 *
 * 方位角约定转换（关键，勿删）：
 *  - CIPIC/SOFA 约定 az>0 = 左（经 ITD 实测验证：SOFA az=+80 时左耳 HRIR 峰值
 *    更早）；应用约定 az>0 = 右（analyticHrtf/hrtfInterp 文档注释 + KEMAR grid.bin
 *    ITD 实测：az=+90 右耳峰值更早）。故 appAz = wrap180(-az)。
 *  - 双耳数据不交换：近耳由方向决定，耳数据随测量原样保留（左耳段 → left）。
 *
 * 规整网格（CIPIC 双极坐标网格 → 矩形 HrtfGrid，行主序 [elIdx·azCount + azIdx]）：
 *  - CIPIC 1250 个测量方向为双极网格交点，仰角连续（实测 322 个不同值），无天然
 *    分层 → 吸附到 25 个规范 CIPIC 仰角（论文标准列表，1.4° 用 0° 替代——实测
 *    水平环位于 el=0，且应用约定水平面为 0°；其余 24 值与论文一致）；
 *  - az 网格 = 水平环（|el|<0.05）实测 50 个方位角（换算到应用约定后排序）；
 *    CIPIC 水平环覆盖全周（0..360，5° 步进，前后左右非均匀：±(5..45) 步 5°、
 *    其余弧段有 10-20° 缺口），与常见「±80°」印象不同——以实际数据为准；
 *  - 填充：每 (el 层, az 格) 取该层中方位角最接近的测量（|Δaz| ≤ 10°，约等于
 *    水平环最大缺口 20° 的一半；确定性：Δaz 同分取 Δel 更小，再同分取文件中
 *    先出现者）；无测量接近 → 该方向补零 HRIR（「CIPIC 后方/两侧分辨率缺失，
 *    缺失方向静音」，且避免把错位数据硬填到远方向）。预计填充率 ≈ 90%，
 *    空单元集中在高仰角稀疏层（el≥53.6）与环缺口方向。
 *
 * 重采样：44.1kHz → 48kHz（线性插值，200 → 217 样本，尾部补零到 256——
 *  HRIR 尾段已衰减，补零不引入伪影；与 KEMAR 网格同 hrirLen=256）。
 *
 * 输出 hrtf-data/grid-cipic.bin（与 grid.bin 相同小端布局，供 build-spatial-worklet
 *  base64 内嵌）：
 *   u32 sampleRate | u32 azCount | u32 elCount | u32 hrirLen
 *   | f32 az[azCount] | f32 el[elCount]
 *   | f32 left[elCount·azCount·hrirLen] | f32 right[...]
 *
 * 运行：node scripts/convert-cipic.mjs [源文件路径]  （仓库根或本目录均可）
 * 源文件缺失 → 退出码 1 + 中文提示（不生成产物；构建脚本会跳过 CIPIC 内嵌）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → waveforge-engine-v3 → services → src → 仓库根（4 级）
const root = path.resolve(here, '../../../../')
const hrtfDataDir = path.join(root, 'src/services/waveforge-engine-v3/hrtf-data')
const outBin = path.join(hrtfDataDir, 'grid-cipic.bin')

/** 目标采样率（与 KEMAR 网格一致） */
const TARGET_FS = 48000
/** 输出 HRIR 长度（与 KEMAR 网格一致） */
const TARGET_HRIR_LEN = 256
/** 输出方位角网格：水平环实测 50 值（应用约定） */
const AZ_GRID_SOURCE = 'ring'
/** 填充容差（度）：|测量az - 网格az| ≤ 该值才填充该格（水平环最大缺口 20° 的一半） */
const AZ_TOLERANCE_DEG = 10

/** CIPIC 规范仰角（论文 Algazi 2001 标准 25 值；1.4 → 0：实测水平环在 el=0） */
const CIPIC_ELEVATIONS = [
  -45, -39.2, -33.4, -27.6, -21.8, -16, -10.2, -4.4, 0, 7.2, 13, 18.8, 24.6, 30.4,
  36.2, 42, 47.8, 53.6, 59.4, 65.2, 71, 76.8, 82.6, 88.4, 94.2,
]

/** 角度 wrap 到 [-180, 180) */
function wrap180(x) {
  return ((((x + 180) % 360) + 360) % 360) - 180
}

/** 0.1° 取整（-0 归一化为 0） */
function round01(x) {
  const v = Math.round(x * 10) / 10
  return v === 0 ? 0 : v
}

// ── 定位源文件 ────────────────────────────────────────────────────────────
function locateSource() {
  const arg = process.argv[2]
  if (arg) return existsSync(arg) ? arg : null
  if (process.env.CIPIC_SOURCE && existsSync(process.env.CIPIC_SOURCE)) return process.env.CIPIC_SOURCE
  for (const name of ['subject_003.mat', 'subject_003.sofa']) {
    const p = path.join(hrtfDataDir, 'cipic', name)
    if (existsSync(p)) return p
  }
  return null
}

const source = locateSource()
if (!source) {
  console.error(
    '[convert-cipic] 未找到 CIPIC 源文件（subject_003.mat / subject_003.sofa）。\n' +
      '  请下载后放到 hrtf-data/cipic/，或用参数 / CIPIC_SOURCE 指定路径：\n' +
      '    官方 .mat：https://www.ece.ucdavis.edu/cipic/spatial-sounds/hrtf-data/subject_003.mat（已 410）\n' +
      '    SOFA 镜像：http://sofacoustics.org/data/database/cipic/subject_003.sofa\n' +
      '  [convert-cipic] 跳过：不生成 grid-cipic.bin（构建脚本将内嵌 null，UI 标注「数据未打包」）',
  )
  process.exit(1)
}
console.log(`[convert-cipic] 源文件：${path.basename(source)}（${(readFileSync(source).length / 1024 / 1024).toFixed(1)}MB）`)

// ── h5wasm 读取 ──────────────────────────────────────────────────────────
const H5 = (await import('h5wasm')).default
await H5.ready
const FS = (await import('h5wasm')).FS

const name = `waveforge-cipic-${Date.now()}.h5`
FS.writeFile(name, readFileSync(source))
const file = new H5.File(name, 'r')
/** 读取 float dataset → 行主序 f64 扁平数组（.mat f64 / SOFA f64 原样；f32 升 f64） */
function readValues(pathName) {
  const ent = file.get(pathName)
  if (!ent) return null
  const raw = ent.value
  const shape = (ent.shape ?? []).map(Number)
  if (raw instanceof Float64Array) return { values: Array.from(raw), shape }
  if (raw instanceof Float32Array) return { values: Array.from(raw).map(Number), shape }
  if (typeof raw === 'number') return { values: [raw], shape: [] }
  return null
}

/** 读取测量数据：{ hrirL, hrirR, azRaw[], elRaw[], fs }（hrirL/R 为 m×n 行主序） */
function readMeasurements() {
  // 优先 SOFA 布局（/Data.IR [M,R,N]、/SourcePosition [M,3]、/Data.SamplingRate）
  const sofaIr = readValues('/Data.IR')
  const sofaPos = readValues('/SourcePosition')
  if (sofaIr && sofaPos && sofaIr.shape.length === 3) {
    const [M, R, N] = sofaIr.shape
    if (R < 1) throw new Error('SOFA Data.IR 接收器数 R<1')
    const left = new Float64Array(M * N)
    const right = new Float64Array(M * N)
    for (let i = 0; i < M; i++) {
      const base = i * R * N
      left.set(sofaIr.values.slice(base, base + N), i * N)
      right.set(sofaIr.values.slice(base + Math.min(1, R - 1) * N, base + Math.min(1, R - 1) * N + N), i * N)
    }
    if (sofaPos.shape[1] < 2) throw new Error('SOFA SourcePosition 列数不足')
    const azRaw = new Array(M)
    const elRaw = new Array(M)
    for (let i = 0; i < M; i++) {
      azRaw[i] = sofaPos.values[i * sofaPos.shape[1]]
      elRaw[i] = sofaPos.values[i * sofaPos.shape[1] + 1]
    }
    const rate = readValues('/Data.SamplingRate')
    const fs = rate && rate.values.length > 0 ? Math.round(rate.values[0]) : 44100
    return { hrirL: left, hrirR: right, azRaw, elRaw, fs, sourceKind: 'sofa' }
  }
  // .mat v7.3 布局：hrir_final / hrir_l（[1250,200] f64，**列主序**存储）
  for (const varName of ['hrir_final', 'hrir_l']) {
    const L = readValues(`/${varName}`)
    const Rv = readValues('/hrir_r')
    if (L && Rv && L.shape.length === 2) {
      const [d0, d1] = L.shape
      const M = d0 === 1250 ? d0 : d1 === 1250 ? d1 : null
      const N = d0 === 1250 ? d1 : d1 === 1250 ? d0 : null
      if (!M || !N) throw new Error(`.mat ${varName} 形状 [${d0},${d1}] 不是 [1250,200]`)
      const left = new Float64Array(M * N)
      const right = new Float64Array(M * N)
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < M; i++) {
          // 列主序：flat[i + j·M] = 逻辑 (i, j)
          left[i * N + j] = L.values[i + j * M]
          right[i * N + j] = Rv.values[i + j * M]
        }
      }
      const azEnt = readValues('/azimuths')
      const elEnt = readValues('/elevations')
      if (!azEnt || !elEnt) throw new Error('.mat 缺少 azimuths/elevations 变量')
      const azRaw = azEnt.shape[0] === M ? azEnt.values : azEnt.values.slice(0, M)
      const elRaw = elEnt.shape[0] === M ? elEnt.values : elEnt.values.slice(0, M)
      return { hrirL: left, hrirR: right, azRaw, elRaw, fs: 44100, sourceKind: 'mat' }
    }
  }
  throw new Error('源文件不是可识别的 CIPIC 数据（缺少 /Data.IR 或 /hrir_l）')
}

let measurements
try {
  measurements = readMeasurements()
} finally {
  try {
    file.close()
  } catch {
    /* noop */
  }
  try {
    FS.unlink(name)
  } catch {
    /* noop */
  }
}

const { hrirL, hrirR, azRaw, elRaw, fs: srcFs, sourceKind } = measurements
const M = azRaw.length
console.log(
  `[convert-cipic] 读取：${M} 个测量 @${srcFs}Hz（${sourceKind === 'sofa' ? 'SOFA/NetCDF4' : '.mat v7.3'}），HRIR ${hrirL.length / M} 样本`,
)

// ── 方位角约定转换（CIPIC az>0=左 → 应用约定 az>0=右） + 层吸附 ────────────
const appAz = azRaw.map((a) => round01(wrap180(-a)))
// 每测量 → 最近规范仰角层索引
const layerOf = new Int32Array(M)
for (let i = 0; i < M; i++) {
  let best = 0
  let bd = Infinity
  for (let j = 0; j < CIPIC_ELEVATIONS.length; j++) {
    const d = Math.abs(elRaw[i] - CIPIC_ELEVATIONS[j])
    if (d < bd) {
      bd = d
      best = j
    }
  }
  layerOf[i] = best
}

// ── 方位角网格：水平环（|el| < 0.05）实测值 ────────────────────────────────
const ringAz = []
for (let i = 0; i < M; i++) {
  if (Math.abs(elRaw[i]) < 0.05) ringAz.push(appAz[i])
}
if (ringAz.length < 8) throw new Error(`水平环方位角不足（${ringAz.length}），数据异常`)
const azimuths = [...new Set(ringAz)].sort((a, b) => a - b)
console.log(`[convert-cipic] 方位角网格：${azimuths.length} 个（水平环实测）`)

// ── 规整填充（行主序 el×az；缺方向补零） ───────────────────────────────────
// 逐格求「层内 Δaz 最小」的测量（Δaz 同分取 Δel 更小；再同分保留文件中先出现者），
// 确定性且无后处理依赖；Δaz 超容差（AZ_TOLERANCE_DEG）→ 该方向视为无数据（补零）。
const elCount = CIPIC_ELEVATIONS.length
const azCount = azimuths.length
const srcLen = hrirL.length / M // 200
const grid = new Float64Array(elCount * azCount * srcLen)
const gridRight = new Float64Array(elCount * azCount * srcLen)
const fillCount = new Uint32Array(elCount * azCount)
{
  const cellBest = new Map() // cell → { i, dAz, dEl }（确定性：按比较规则取唯一胜者）
  for (let i = 0; i < M; i++) {
    const k = layerOf[i]
    let bestJ = -1
    let bestDAz = Infinity
    for (let j = 0; j < azCount; j++) {
      const d = Math.abs(appAz[i] - azimuths[j])
      if (d < bestDAz) {
        bestDAz = d
        bestJ = j
      }
    }
    if (bestDAz > AZ_TOLERANCE_DEG) continue // 该层该方向无数据
    const cell = k * azCount + bestJ
    const elDev = Math.abs(elRaw[i] - CIPIC_ELEVATIONS[k])
    const prev = cellBest.get(cell)
    if (!prev || bestDAz < prev.dAz || (bestDAz === prev.dAz && elDev < prev.dEl)) {
      cellBest.set(cell, { i, dAz: bestDAz, dEl: elDev })
    }
  }
  for (const [cell, { i }] of cellBest) {
    const base = cell * srcLen
    grid.set(hrirL.subarray(i * srcLen, (i + 1) * srcLen), base)
    gridRight.set(hrirR.subarray(i * srcLen, (i + 1) * srcLen), base)
    fillCount[cell] = 1
  }
}

// ── 统计 ─────────────────────────────────────────────────────────────────
let filled = 0
for (let k = 0; k < elCount; k++) {
  let layerFilled = 0
  for (let j = 0; j < azCount; j++) {
    if (fillCount[k * azCount + j]) {
      filled++
      layerFilled++
    }
  }
  console.log(
    `[convert-cipic] 层 el=${String(CIPIC_ELEVATIONS[k]).padStart(5)}：填充 ${String(layerFilled).padStart(2)}/${azCount} 格${layerFilled === 0 ? '（整层无数据→静音层）' : ''}`,
  )
}
console.log(`[convert-cipic] 填充率：${filled}/${elCount * azCount} = ${((filled / (elCount * azCount)) * 100).toFixed(1)}%（缺方向补零）`)

// ── 重采样 44.1k → 48k（线性插值，200 → 217 样本，尾部补零到 256） ────────
const newLen = Math.floor((srcLen * TARGET_FS) / srcFs) // 200×48000/44100 = 217.69 → 217
const total = elCount * azCount
const left48 = new Float32Array(total * TARGET_HRIR_LEN)
const right48 = new Float32Array(total * TARGET_HRIR_LEN)
const ratio = srcFs / TARGET_FS // 0.91875：输出样本 o 对应输入位置 o·ratio
for (let c = 0; c < total; c++) {
  const srcBase = c * srcLen
  const dstBase = c * TARGET_HRIR_LEN
  for (let o = 0; o < newLen; o++) {
    const pos = o * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(srcLen - 1, i0 + 1)
    const frac = pos - i0
    left48[dstBase + o] = grid[srcBase + i0] * (1 - frac) + grid[srcBase + i1] * frac
    right48[dstBase + o] = gridRight[srcBase + i0] * (1 - frac) + gridRight[srcBase + i1] * frac
  }
  // 尾部（newLen..255）保持 0（补零）
}
console.log(`[convert-cipic] 重采样：${srcFs}Hz/${srcLen}样本 → ${TARGET_FS}Hz/${newLen}样本（线性插值），补零到 ${TARGET_HRIR_LEN}`)

// ── 写 grid-cipic.bin（与 grid.bin 相同小端布局） ─────────────────────────
mkdirSync(hrtfDataDir, { recursive: true })
const header = 16
const azBytes = azCount * 4
const elBytes = elCount * 4
const dataBytes = 2 * total * TARGET_HRIR_LEN * 4
const buf = Buffer.alloc(header + azBytes + elBytes + dataBytes)
let off = 0
buf.writeUInt32LE(TARGET_FS, off); off += 4
buf.writeUInt32LE(azCount, off); off += 4
buf.writeUInt32LE(elCount, off); off += 4
buf.writeUInt32LE(TARGET_HRIR_LEN, off); off += 4
for (const a of azimuths) {
  buf.writeFloatLE(a, off)
  off += 4
}
for (const e of CIPIC_ELEVATIONS) {
  buf.writeFloatLE(e, off)
  off += 4
}
const f32L = new Float32Array(left48.buffer, left48.byteOffset, left48.length)
const f32R = new Float32Array(right48.buffer, right48.byteOffset, right48.length)
for (let i = 0; i < f32L.length; i++) {
  buf.writeFloatLE(f32L[i], off)
  off += 4
}
for (let i = 0; i < f32R.length; i++) {
  buf.writeFloatLE(f32R[i], off)
  off += 4
}
writeFileSync(outBin, buf)
console.log(
  `[convert-cipic] 已生成 ${path.relative(root, outBin)}（${(buf.length / 1024 / 1024).toFixed(2)}MB，${azCount}az×${elCount}el×${TARGET_HRIR_LEN}样本@${TARGET_FS}Hz）`,
)

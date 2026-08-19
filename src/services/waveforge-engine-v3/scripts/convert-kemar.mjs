/**
 * convert-kemar —— MIT KEMAR HRTF 测量 → hrtf-data/grid.bin 转换脚本（溯源）
 *
 * 数据源（SOFA 格式，HDF5 容器，经 h5wasm 读取——与 convert-cipic.mjs 同路径）：
 *   http://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa
 *   （MIT KEMAR normal pinna；SOFA 标准 /Data.IR [M,R,N]、/SourcePosition [M,3]、
 *    /Data.SamplingRate。R=0 左耳 / R=1 右耳。）
 *
 * 定位源文件（按序探测，首个命中即用）：
 *  ① 命令行参数（路径）；② 环境变量 KEMAR_SOURCE；③ hrtf-data/kemar/
 *    目录下的 mit_kemar_normal_pinna.sofa；④ 以上均无 → 自动从上述 URL 下载
 *    缓存到 hrtf-data/kemar/ 供下次离线复用。
 *
 * 方位角约定转换（关键，勿删；与 convert-cipic 同约定）：
 *  - SOFA 约定 az>0 = 左（ITU/ISO 标准：方位角从前方顺时针为负？实测 SOFA az=+80
 *    时左耳 HRIR 峰值更早——与 CIPIC 同）；应用约定 az>0 = 右（analyticHrtf/
 *    hrtfInterp 文档 + 现有 grid.bin ITD 实测：az=+90 右耳峰值更早）。故 appAz =
 *    wrap180(-az)。
 *  - 双耳数据不交换：近耳由方向决定，耳数据随测量原样保留（左耳段 → left）。
 *
 * 规整网格（与现有 grid.bin 同形状：72az × 14el × 256@48kHz——MIT KEMAR 论文标准网格）：
 *  - 方位角网格 = 水平环（|el|<0.05）实测方位角，换算到应用约定后吸附到 5° 步进、
 *    去重升序（MIT KEMAR 水平环为 -180..175 步 5°，共 72 值——覆盖全周均匀）；
 *  - 仰角网格 = MIT KEMAR 论文 14 规范值（-40..90 步 10；紧凑数据集标准层列，
 *    与现有 grid.bin 一致；测量吸附到最近层）；KEMAR_ELEVATIONS 见下方常量；
 *  - 填充：每 (el 层, az 格) 取该层中方位角最接近的测量（确定性：Δaz 同分取
 *    Δel 更小，再同分取文件中先出现者）；MIT KEMAR 全方位覆盖，无缺方向（不为零）。
 *
 * 重采样：源 fs（常见 44100/48000）→ 48kHz（线性插值，200/181 → 217 样本，
 *  尾部补零到 256——HRIR 尾段已衰减，补零不引入伪影；与 cipic 网格同 hrirLen=256）。
 *  若源 fs 已为 48000，仍补零/截断到 256 对齐长度。
 *
 * 输出 hrtf-data/grid.bin（小端布局，供 build-spatial-worklet base64 内嵌，
 *  与 grid-cipic.bin 同布局）：
 *   u32 sampleRate | u32 azCount | u32 elCount | u32 hrirLen
 *   | f32 az[azCount] | f32 el[elCount]
 *   | f32 left[elCount·azCount·hrirLen] | f32 right[...]
 *
 * 运行：node scripts/convert-kemar.mjs [源文件路径]
 *  下载失败 / 源文件缺失 / 解析失败 → 退出码 1 + 中文提示，**不生成产物**
 *  （保持现有 grid.bin 不变；构建脚本继续用既有 grid.bin）。
 *
 * 注意：本脚本既是转换工具，也是 grid.bin 的「溯源文档」——注释写明数据源 URL +
 *  转换逻辑；若需重建/校验 grid.bin，运行此脚本即可（需网络或本地 SOFA 缓存）。
 *  ⚠️ 仓库已提交的 grid.bin 是**调优基线**：其缺方向格由更密源/手填补全（非零填充），
 *  本脚本从 mit_kemar_normal_pinna.sofa 转换会零填充 70% 覆盖外的方向，与基线
 *  不逐字节一致（球谐插值单测基线容差按调优数据校准）。故本脚本主要价值是溯源
 *  （数据源 URL + 转换逻辑可复现/校验），**勿用其产物覆盖已提交的 grid.bin**——
 *  如需实验性重建，先备份 grid.bin 再运行，对比后决定是否采纳。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → waveforge-engine-v3 → services → src → 仓库根（4 级）
const root = path.resolve(here, '../../../../')
const hrtfDataDir = path.join(root, 'src/services/waveforge-engine-v3/hrtf-data')
const kemarCacheDir = path.join(hrtfDataDir, 'kemar')
const outBin = path.join(hrtfDataDir, 'grid.bin')

/** 数据源 URL（MIT KEMAR normal pinna，SOFA 镜像） */
const KEMAR_SOURCE_URL = 'http://sofacoustics.org/data/database/mit/mit_kemar_normal_pinna.sofa'
/** 本地缓存文件名 */
const KEMAR_CACHE_NAME = 'mit_kemar_normal_pinna.sofa'

/** 目标采样率（与现有 grid.bin / cipic 一致） */
const TARGET_FS = 48000
/** 输出 HRIR 长度（与现有 grid.bin / cipic 一致） */
const TARGET_HRIR_LEN = 256
/** 方位角吸附步进（度）：MIT KEMAR 水平环为 5° 步进 */
const AZ_SNAP_STEP = 5
/** 仰角吸附容差（度）：测量仰角到规范层 |Δ| ≤ 该值才填充该格（防远层误吸附） */
const EL_TOLERANCE_DEG = 6

/** MIT KEMAR 规范仰角（论文紧凑数据集 14 值，-40..90 步 10；与现有 grid.bin 一致） */
const KEMAR_ELEVATIONS = [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]

/** 角度 wrap 到 [-180, 180) */
function wrap180(x) {
  return ((((x + 180) % 360) + 360) % 360) - 180
}
/** 吸附到最近步进值（度），消除浮点噪声 */
function snapToStep(x, step) {
  return Math.round(x / step) * step
}
/** 0.1° 取整（-0 归一化为 0） */
function round01(x) {
  const v = Math.round(x * 10) / 10
  return v === 0 ? 0 : v
}

// ── 定位源文件（本地 > 下载） ──────────────────────────────────────────────
function locateLocal() {
  const arg = process.argv[2]
  if (arg) return existsSync(arg) ? arg : null
  if (process.env.KEMAR_SOURCE && existsSync(process.env.KEMAR_SOURCE)) return process.env.KEMAR_SOURCE
  const p = path.join(kemarCacheDir, KEMAR_CACHE_NAME)
  return existsSync(p) ? p : null
}

/** 下载 SOFA 到本地缓存（best-effort；网络不可达抛错由调用方处理） */
async function downloadSource() {
  console.log(`[convert-kemar] 本地无 SOFA 缓存，尝试下载：${KEMAR_SOURCE_URL}`)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const resp = await fetch(KEMAR_SOURCE_URL, { signal: ctrl.signal, redirect: 'follow' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
    const ab = await resp.arrayBuffer()
    mkdirSync(kemarCacheDir, { recursive: true })
    const cachePath = path.join(kemarCacheDir, KEMAR_CACHE_NAME)
    writeFileSync(cachePath, Buffer.from(ab))
    console.log(`[convert-kemar] 下载完成并缓存：${path.relative(root, cachePath)}（${(ab.byteLength / 1024 / 1024).toFixed(1)}MB）`)
    return cachePath
  } finally {
    clearTimeout(timer)
  }
}

let source = locateLocal()
if (!source) {
  try {
    source = await downloadSource()
  } catch (e) {
    console.error(
      `[convert-kemar] 下载失败：${e instanceof Error ? e.message : String(e)}\n` +
        '  手动下载后放到 hrtf-data/kemar/mit_kemar_normal_pinna.sofa，或用参数 / KEMAR_SOURCE 指定路径：\n' +
        `    ${KEMAR_SOURCE_URL}\n` +
        '[convert-kemar] 跳过：不生成 grid.bin（保持现有 grid.bin 不变）',
    )
    process.exit(1)
  }
}
console.log(`[convert-kemar] 源文件：${path.basename(source)}（${(readFileSync(source).length / 1024 / 1024).toFixed(1)}MB）`)

// ── h5wasm 读取（与 convert-cipic 同范式） ─────────────────────────────────
const H5 = (await import('h5wasm')).default
await H5.ready
const FS = (await import('h5wasm')).FS

const h5Name = `waveforge-kemar-${Date.now()}.h5`
FS.writeFile(h5Name, readFileSync(source))
const file = new H5.File(h5Name, 'r')

/** 读取 float dataset → 行主序 f64 扁平数组 */
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

/** 读取测量数据：{ hrirL, hrirR, azRaw[], elRaw[], fs }（hrirL/R 为 M×N 行主序） */
function readMeasurements() {
  const ir = readValues('/Data.IR')
  const pos = readValues('/SourcePosition')
  if (!ir || !pos || ir.shape.length !== 3) {
    throw new Error('源文件不是可识别的 KEMAR SOFA 数据（缺少 /Data.IR [M,R,N] 或 /SourcePosition）')
  }
  const [M, R, N] = ir.shape
  if (R < 1) throw new Error('SOFA Data.IR 接收器数 R<1')
  const left = new Float64Array(M * N)
  const right = new Float64Array(M * N)
  for (let i = 0; i < M; i++) {
    const base = i * R * N
    left.set(ir.values.slice(base, base + N), i * N)
    right.set(ir.values.slice(base + Math.min(1, R - 1) * N, base + Math.min(1, R - 1) * N + N), i * N)
  }
  if (pos.shape[1] < 2) throw new Error('SOFA SourcePosition 列数不足')
  const azRaw = new Array(M)
  const elRaw = new Array(M)
  for (let i = 0; i < M; i++) {
    azRaw[i] = pos.values[i * pos.shape[1]]
    elRaw[i] = pos.values[i * pos.shape[1] + 1]
  }
  const rate = readValues('/Data.SamplingRate')
  const fs = rate && rate.values.length > 0 ? Math.round(rate.values[0]) : 44100
  return { hrirL: left, hrirR: right, azRaw, elRaw, fs }
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
    FS.unlink(h5Name)
  } catch {
    /* noop */
  }
}

const { hrirL, hrirR, azRaw, elRaw, fs: srcFs } = measurements
const M = azRaw.length
console.log(`[convert-kemar] 读取：${M} 个测量 @${srcFs}Hz（SOFA/NetCDF4），HRIR ${hrirL.length / M} 样本`)

// ── 方位角约定转换（SOFA az>0=左 → 应用约定 az>0=右） + 5° 吸附 ────────────
const appAz = azRaw.map((a) => snapToStep(wrap180(-a), AZ_SNAP_STEP))

// ── 方位角网格：水平环（|el|<0.05）实测值吸附去重升序 ───────────────────────
const ringAz = []
for (let i = 0; i < M; i++) {
  if (Math.abs(elRaw[i]) < 0.05) ringAz.push(appAz[i])
}
if (ringAz.length < 8) throw new Error(`水平环方位角不足（${ringAz.length}），数据异常`)
const azimuths = [...new Set(ringAz)].sort((a, b) => a - b)
console.log(`[convert-kemar] 方位角网格：${azimuths.length} 个（水平环实测，5° 吸附）`)

// ── 规整填充（行主序 el×az；每格取层内 Δaz 最小的测量） ─────────────────────
// 确定性：Δaz 同分取 Δel 更小，再同分取文件中先出现者。KEMAR 全方位覆盖，无缺方向。
const elCount = KEMAR_ELEVATIONS.length
const azCount = azimuths.length
const srcLen = hrirL.length / M
const grid = new Float64Array(elCount * azCount * srcLen)
const gridRight = new Float64Array(elCount * azCount * srcLen)
const fillCount = new Uint32Array(elCount * azCount)
{
  // 每测量吸附到最近规范仰角层（|Δel| ≤ EL_TOLERANCE_DEG 才参与填充）
  const cellBest = new Map()
  for (let i = 0; i < M; i++) {
    // 找最近规范仰角层
    let bestK = -1
    let bestDEl = Infinity
    for (let k = 0; k < elCount; k++) {
      const d = Math.abs(elRaw[i] - KEMAR_ELEVATIONS[k])
      if (d < bestDEl) {
        bestDEl = d
        bestK = k
      }
    }
    if (bestDEl > EL_TOLERANCE_DEG) continue // 测量仰角偏离所有规范层过远，跳过
    // 找最近方位角格
    let bestJ = -1
    let bestDAz = Infinity
    for (let j = 0; j < azCount; j++) {
      const d = Math.abs(appAz[i] - azimuths[j])
      if (d < bestDAz) {
        bestDAz = d
        bestJ = j
      }
    }
    const cell = bestK * azCount + bestJ
    const prev = cellBest.get(cell)
    if (!prev || bestDAz < prev.dAz || (bestDAz === prev.dAz && bestDEl < prev.dEl)) {
      cellBest.set(cell, { i, dAz: bestDAz, dEl: bestDEl })
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
    `[convert-kemar] 层 el=${String(KEMAR_ELEVATIONS[k]).padStart(4)}：填充 ${String(layerFilled).padStart(2)}/${azCount} 格${layerFilled === 0 ? '（整层无数据→静音层）' : ''}`,
  )
}
console.log(`[convert-kemar] 填充率：${filled}/${elCount * azCount} = ${((filled / (elCount * azCount)) * 100).toFixed(1)}%`)

// ── 重采样 → 48k / 256（线性插值，尾部补零） ──────────────────────────────
const total = elCount * azCount
const left48 = new Float32Array(total * TARGET_HRIR_LEN)
const right48 = new Float32Array(total * TARGET_HRIR_LEN)
if (srcFs === TARGET_FS) {
  // 源已为 48k：直接复制 + 补零/截断到 256
  for (let c = 0; c < total; c++) {
    const srcBase = c * srcLen
    const dstBase = c * TARGET_HRIR_LEN
    const n = Math.min(srcLen, TARGET_HRIR_LEN)
    for (let o = 0; o < n; o++) {
      left48[dstBase + o] = grid[srcBase + o]
      right48[dstBase + o] = gridRight[srcBase + o]
    }
    // 尾部保持 0（srcLen < 256 时补零；srcLen > 256 时截断尾部已衰减段）
  }
} else {
  const newLen = Math.floor((srcLen * TARGET_FS) / srcFs)
  const ratio = srcFs / TARGET_FS
  for (let c = 0; c < total; c++) {
    const srcBase = c * srcLen
    const dstBase = c * TARGET_HRIR_LEN
    for (let o = 0; o < newLen && o < TARGET_HRIR_LEN; o++) {
      const pos = o * ratio
      const i0 = Math.floor(pos)
      const i1 = Math.min(srcLen - 1, i0 + 1)
      const frac = pos - i0
      left48[dstBase + o] = grid[srcBase + i0] * (1 - frac) + grid[srcBase + i1] * frac
      right48[dstBase + o] = gridRight[srcBase + i0] * (1 - frac) + gridRight[srcBase + i1] * frac
    }
  }
}
console.log(`[convert-kemar] 重采样：${srcFs}Hz/${srcLen}样本 → ${TARGET_FS}Hz/${TARGET_HRIR_LEN}样本（线性插值 + 补零）`)

// ── 写 grid.bin（与 grid-cipic.bin 相同小端布局） ─────────────────────────
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
for (const e of KEMAR_ELEVATIONS) {
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
// 直接覆盖写（与 convert-cipic 同范式）：转换已成功到此处才会写，
// 下载/解析失败在前置步骤已退出，grid.bin 不受影响。
writeFileSync(outBin, buf)
console.log(
  `[convert-kemar] 已生成 ${path.relative(root, outBin)}（${(buf.length / 1024 / 1024).toFixed(2)}MB，${azCount}az×${elCount}el×${TARGET_HRIR_LEN}样本@${TARGET_FS}Hz）`,
)

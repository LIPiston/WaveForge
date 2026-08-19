/**
 * 空间音频 worklet 打包 + 生成文件生成脚本
 *
 * 职责（四步，全部对缺失源优雅降级）：
 *  ① Rust HRTF 内核（可选，代理 B）：rust/hrtf-core/src/lib.rs 存在时
 *     cargo build --release --target wasm32-unknown-unknown（失败仅告警不中断），
 *     产物复制到 rust/hrtf-core/pkg/hrtf_core.wasm；
 *  ② HRTF 网格（可选）：hrtf-data/grid.bin 存在 → base64 内嵌
 *     src/spatial/data/grid.ts，否则生成 null 变体（运行时合成网格兜底）；
 *  ②b 内置数据集表（多数据集，可选）：grid.bin → 'kemar'、grid-cipic.bin →
 *     'cipic'（scripts/convert-cipic.mjs 生成），base64 写入 data/datasets.ts；
 *     cipic 文件缺失 → 该条目 base64 = null（UI 标注「数据未打包」禁用，
 *     fusion.setBuiltinDataset 静默忽略）；kemar 条目引用 grid.ts 的
 *     HRTF_GRID_BASE64（同源数据不重复内嵌）；
 *  ③ 后端索引：WasmHrtfBackend.ts 与 pkg wasm 都存在 → 生成 wasm 变体
 *     （WASM_BYTES 内嵌 + createWorkletBackend 优先 Wasm、失败降级 TS），
 *     否则纯 TS 变体；
 *  ④ esbuild：entry src/spatial/SpatialProcessor.ts，bundle → public/spatial-worklet.js
 *     （iife + minify，AudioWorklet 全局作用域不支持裸 import/export）。
 *
 * 产物均为"自动生成，勿手改"；开发时先跑本脚本再提交生成文件。
 */
import { build } from 'esbuild'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
// scripts/ → waveforge-engine-v3 → services → src → 仓库根（4 级）
const root = path.resolve(here, '../../../../')
const spatialDir = path.join(root, 'src/services/waveforge-engine-v3/src/spatial')
// Rust 内核位置：优先 v3 模块内（src/services/waveforge-engine-v3/rust/hrtf-core），
// 兼容规范路径（仓库根 rust/hrtf-core）
const rustCrateCandidates = [
  path.join(spatialDir, '../../rust/hrtf-core'),
  path.join(root, 'rust/hrtf-core'),
]
const rustCrate = rustCrateCandidates.find((p) => existsSync(path.join(p, 'src/lib.rs'))) ?? null
const pkgDir = rustCrate ? path.join(rustCrate, 'pkg') : path.join(root, 'rust/hrtf-core/pkg')
const pkgWasm = path.join(pkgDir, 'hrtf_core.wasm')
const wasmBackendFile = path.join(spatialDir, 'WasmHrtfBackend.ts')
// HRTF 网格数据位于 HSE 文件夹内（src/services/waveforge-engine-v3/hrtf-data/grid.bin）
const gridBin = path.join(root, 'src/services/waveforge-engine-v3/hrtf-data/grid.bin')
// CIPIC 网格（scripts/convert-cipic.mjs 生成）；缺失 → 数据集表 cipic 条目为 null
const cipicBin = path.join(root, 'src/services/waveforge-engine-v3/hrtf-data/grid-cipic.bin')
const outGrid = path.join(spatialDir, 'data/grid.ts')
const outDatasets = path.join(spatialDir, 'data/datasets.ts')
const outIndex = path.join(spatialDir, 'backendIndex.generated.ts')
const outWorklet = path.join(root, 'public/spatial-worklet.js')

const fmtSize = (p) => `${(statSync(p).size / 1024).toFixed(1)}KB`

// ── ① Rust HRTF 内核（可选） ──────────────────────────────────────────────
if (rustCrate) {
  try {
    execSync('cargo build --release --target wasm32-unknown-unknown', {
      cwd: rustCrate,
      stdio: 'inherit',
    })
    const targetWasm = path.join(rustCrate, 'target/wasm32-unknown-unknown/release/hrtf_core.wasm')
    if (existsSync(targetWasm)) {
      mkdirSync(pkgDir, { recursive: true })
      copyFileSync(targetWasm, pkgWasm)
      console.log(`[build-spatial-worklet] hrtf_core.wasm 已复制（${fmtSize(pkgWasm)}）`)
    } else {
      console.warn('[build-spatial-worklet] cargo 构建成功但未找到 wasm 产物，跳过内嵌')
    }
  } catch (e) {
    console.warn(`[build-spatial-worklet] cargo 构建失败（不影响 TS 兜底）：${e instanceof Error ? e.message : String(e)}`)
  }
} else {
  console.warn('[build-spatial-worklet] rust/hrtf-core 不存在，跳过 wasm 构建')
}

// ── ② HRTF 网格数据（可选） ───────────────────────────────────────────────
mkdirSync(path.dirname(outGrid), { recursive: true })
let gridHeader = ''
if (existsSync(gridBin)) {
  const b64 = readFileSync(gridBin).toString('base64')
  writeFileSync(
    outGrid,
    `/**
 * 自动生成：npm run build:spatial-worklet —— 勿手改
 * HRTF 网格数据（hrtf-data/grid.bin 的 base64 内嵌；布局见 gridSource.ts 文件头注释）。
 * 运行时：gridSource.loadSpatialGrid 解码；解码失败回退合成网格。
 */
export const HRTF_GRID_BASE64: string | null = '${b64}'
`,
    'utf8',
  )
  gridHeader = `网格已内嵌（${fmtSize(gridBin)} → base64 ${(b64.length / 1024).toFixed(0)}KB）`
} else {
  writeFileSync(
    outGrid,
    `/**
 * 自动生成：npm run build:spatial-worklet —— 勿手改
 * HRTF 网格数据缺失（hrtf-data/grid.bin 不存在）→ null：运行时用合成网格兜底
 * （generateAnalyticHrtfGrid，见 spatial/analyticHrtf.ts）。
 */
export const HRTF_GRID_BASE64: string | null = null
`,
    'utf8',
  )
  gridHeader = 'hrtf-data/grid.bin 缺失 → null 变体（合成网格兜底）'
}

// ── ②b 内置 HRTF 数据集表（多数据集：kemar 必填 / cipic 可选） ──────────────
// kemar 条目引用 grid.ts 的 HRTF_GRID_BASE64（同源数据不重复内嵌——grid.bin 缺失时
// 该条目随之 null）；cipic 条目读 grid-cipic.bin（convert-cipic.mjs 产物），缺失 → null。
mkdirSync(path.dirname(outDatasets), { recursive: true })
const cipicB64 = existsSync(cipicBin) ? readFileSync(cipicBin).toString('base64') : null
const cipicLine = cipicB64
  ? `  { id: 'cipic', name: 'CIPIC subject_003', base64: '${cipicB64}' },`
  : `  { id: 'cipic', name: 'CIPIC subject_003', base64: null }, // null = 数据未打包（hrtf-data/grid-cipic.bin 缺失）`
writeFileSync(
  outDatasets,
  `/**
 * 自动生成：npm run build:spatial-worklet —— 勿手改
 * 内置 HRTF 数据集表：'kemar'（MIT KEMAR，hrtf-data/grid.bin）与 'cipic'
 * （CIPIC subject_003，hrtf-data/grid-cipic.bin，scripts/convert-cipic.mjs 生成）。
 * base64 = null 表示该数据集未打包（数据文件缺失，构建时跳过内嵌）——
 * UI 标注「数据未打包」禁用，fusion.setBuiltinDataset 收到 null 静默忽略。
 * 网格二进制布局见 gridSource.ts 文件头注释；解码统一走 gridSource 公共函数。
 */
import { HRTF_GRID_BASE64 } from './grid'

export const BUILTIN_HRTF_DATASETS: { id: 'kemar' | 'cipic'; name: string; base64: string | null }[] = [
  { id: 'kemar', name: 'MIT KEMAR', base64: HRTF_GRID_BASE64 },
${cipicLine}
]
`,
  'utf8',
)
const datasetsHeader = cipicB64
  ? `数据集表已生成（kemar + cipic 双内嵌：cipic ${fmtSize(cipicBin)} → base64 ${(cipicB64.length / 1024).toFixed(0)}KB）`
  : `数据集表已生成（cipic 数据未打包 → null 变体，UI 禁用标注）`

// ── ③ 后端索引（wasm / TS 变体） ──────────────────────────────────────────
const hasWasm = existsSync(wasmBackendFile) && existsSync(pkgWasm)
if (hasWasm) {
  const b64 = readFileSync(pkgWasm).toString('base64')
  writeFileSync(
    outIndex,
    `/**
 * 自动生成：npm run build:spatial-worklet —— 勿手改
 * 空间渲染后端索引：WASM 后端可用（WasmHrtfBackend + rust/hrtf-core/pkg/hrtf_core.wasm 已构建）。
 * createWorkletBackend 优先 Wasm、构造失败降级纯 TS 参考后端（音频不中断）。
 */
import { TsConvolverBackend } from './TsConvolverBackend'
import { WasmHrtfBackend } from './WasmHrtfBackend'
import type { SpatialBackend } from './SpatialBackend'

const WASM_BASE64 = '${b64}'

/** RFC 4648 base64 → 字节（纯函数；AudioWorklet 全局作用域不保证 atob，自实现避免依赖） */
function decodeBase64(b64: string): Uint8Array {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const lookup = new Int16Array(128)
  lookup.fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) lookup[ALPHABET.charCodeAt(i)] = i
  const clean = b64.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)]
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export const WASM_BYTES: Uint8Array | null = decodeBase64(WASM_BASE64)

export function createWorkletBackend(): SpatialBackend {
  try {
    if (WASM_BYTES) return new WasmHrtfBackend(WASM_BYTES)
  } catch {
    // WASM 构造失败：降级纯 TS 参考后端（音频不中断）
  }
  return new TsConvolverBackend()
}
`,
    'utf8',
  )
  console.log(`[build-spatial-worklet] 后端索引：wasm 变体（wasm ${fmtSize(pkgWasm)} 内嵌）`)
} else {
  writeFileSync(
    outIndex,
    `/**
 * 自动生成：npm run build:spatial-worklet —— 勿手改
 * 空间渲染后端索引：无 WASM 后端（WasmHrtfBackend.ts 或 rust/hrtf-core/pkg/hrtf_core.wasm 缺失）
 * → 纯 TS 参考后端（TsConvolverBackend，兼数值对拍 ground truth）。
 */
import { TsConvolverBackend } from './TsConvolverBackend'
import type { SpatialBackend } from './SpatialBackend'

export const WASM_BYTES: Uint8Array | null = null

export function createWorkletBackend(): SpatialBackend {
  return new TsConvolverBackend()
}
`,
    'utf8',
  )
  console.log('[build-spatial-worklet] 后端索引：TS 变体（wasm 缺失，降级参考后端）')
}

// ── ④ esbuild 打包 worklet ────────────────────────────────────────────────
mkdirSync(path.dirname(outWorklet), { recursive: true })
await build({
  entryPoints: [path.join(spatialDir, 'SpatialProcessor.ts')],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: outWorklet,
  banner: {
    js: '// WaveForge spatial AudioWorklet processor (waveforge-spatial) — 自动生成，勿手改；重新生成：npm run build:spatial-worklet',
  },
  logLevel: 'info',
})

console.log(`[build-spatial-worklet] ${gridHeader}`)
console.log(`[build-spatial-worklet] ${datasetsHeader}`)
console.log(`[build-spatial-worklet] ${path.relative(root, outWorklet)} 已生成（${fmtSize(outWorklet)}）`)
console.log(`[build-spatial-worklet] ${path.relative(root, outGrid)} 已生成`)
console.log(`[build-spatial-worklet] ${path.relative(root, outDatasets)} 已生成`)
console.log(`[build-spatial-worklet] ${path.relative(root, outIndex)} 已生成`)

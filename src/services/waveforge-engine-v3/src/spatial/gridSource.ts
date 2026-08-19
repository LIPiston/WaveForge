/**
 * gridSource —— HRTF 网格装载（构建脚本内嵌数据的解码 / 合成兜底）
 *
 * HRTF_GRID_BASE64 非空（hrtf-data/grid.bin 存在并被构建脚本内嵌）→ 解码为 HrtfGrid；
 * 为空或解码失败（数据损坏）→ 回退 generateAnalyticHrtfGrid（KEMAR 缺失兜底，音频不中断）。
 *
 * grid.bin 字节布局（小端，构建脚本 scripts/build-spatial-worklet.mjs 生成）：
 *   u32 sampleRate | u32 azCount | u32 elCount | u32 hrirLen
 *   | f32 az[azCount] | f32 el[elCount]
 *   | f32 left[elCount·azCount·hrirLen] | f32 right[...]
 *
 * 多内置数据集（规划书 §4.1「初始集成 2 套」）：
 *  - data/datasets.ts（构建脚本生成）持有内置数据集表 BUILTIN_HRTF_DATASETS
 *    （'kemar' MIT KEMAR / 'cipic' CIPIC subject_003，base64 或 null=未打包）；
 *  - loadBuiltinGrid(id) 按 id 解码（与 loadSpatialGrid 同布局，共用公共解码函数
 *    decodeSpatialGrid）；未打包 / 解码失败 → null（调用方静默，不抛）；
 *  - loadSpatialGrid 保持 KEMAR 兼容路径不变（worklet 构造时装载 kemar）。
 *  注：worklet 侧（SpatialProcessor）只调 loadSpatialGrid——本模块对 datasets.ts
 *  的引用若被 esbuild 判定未使用会整体 tree-shake 掉，worklet 体积不增（cipic
 *  数据仅经 fusion.setBuiltinDataset → postGrid 热更新进入处理器）。
 *
 * 注意：AudioWorklet 全局作用域不保证 atob/btoa，base64 解码用自实现纯函数（RFC 4648）。
 */

import { HRTF_GRID_BASE64 } from './data/grid'
import { BUILTIN_HRTF_DATASETS } from './data/datasets'
import { generateAnalyticHrtfGrid } from './analyticHrtf'
import type { HrtfGrid } from './types'

/** RFC 4648 base64 → 字节（纯函数，无 atob 依赖，主线程/worklet/Node 通用） */
export function decodeBase64(b64: string): Uint8Array {
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
    if (v < 0) continue // 非法字符跳过（数据由构建脚本生成，防御性分支）
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

/** 按 grid.bin 布局解码（布局见文件头；数据损坏抛错由调用方回退合成网格）。
 *  公共解码函数：loadSpatialGrid / loadBuiltinGrid 共用，测试直接断言形状。 */
export function decodeSpatialGrid(b64: string): HrtfGrid {
  const bytes = decodeBase64(b64)
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
  // 头校验（防损坏头导致巨大分配）
  if (azCount < 1 || azCount > 10000 || elCount < 1 || elCount > 10000 || hrirLen < 1 || hrirLen > 100000) {
    throw new Error('invalid grid header')
  }
  const az = new Array<number>(azCount)
  for (let i = 0; i < azCount; i++) az[i] = readF32()
  const el = new Array<number>(elCount)
  for (let i = 0; i < elCount; i++) el[i] = readF32()

  const n = elCount * azCount * hrirLen
  const need = 16 + (azCount + elCount + 2 * n) * 4
  if (bytes.byteLength < need) throw new Error('truncated grid data')

  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) left[i] = readF32()
  for (let i = 0; i < n; i++) right[i] = readF32()

  return { sampleRate, azimuths: az, elevations: el, hrirLength: hrirLen, left, right }
}

/**
 * 装载空间网格：内嵌数据优先（解码失败回退合成），否则合成（KEMAR 缺失兜底）。
 * 传入采样率仅用于合成路径；解码网格以文件内 sampleRate 为准。
 */
export function loadSpatialGrid(sampleRate: number): HrtfGrid {
  if (HRTF_GRID_BASE64) {
    try {
      return decodeSpatialGrid(HRTF_GRID_BASE64)
    } catch {
      // 内嵌数据损坏：回退合成网格（音频不中断）
    }
  }
  return generateAnalyticHrtfGrid(sampleRate)
}

/**
 * 按 id 装载内置 HRTF 数据集（规划书 §4.1：'kemar' | 'cipic'）。
 *  - 从 data/datasets.ts 查表 → base64 解码（与 grid.bin 同布局，decodeSpatialGrid）；
 *  - 数据未打包（base64 null）/ 解码失败 → null（**静默**，不抛——调用方
 *    fusion.setBuiltinDataset 对 null 直接忽略，UI 保持禁用标注「数据未打包」）；
 *  - 采样率适配不在本函数：解码网格以文件内 sampleRate 为准，由调用方
 *    （fusion，重采样/上下文一致性）负责。
 */
export function loadBuiltinGrid(id: 'kemar' | 'cipic'): HrtfGrid | null {
  const entry = BUILTIN_HRTF_DATASETS.find((d) => d.id === id)
  if (!entry || entry.base64 === null) return null // 未打包：静默（调用方忽略）
  try {
    return decodeSpatialGrid(entry.base64)
  } catch {
    return null // 内嵌数据损坏：静默（调用方忽略，不中断音频）
  }
}

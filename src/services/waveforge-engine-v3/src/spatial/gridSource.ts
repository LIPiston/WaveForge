/**
 * gridSource —— HRTF 网格装载（合成兜底 + 运行时文件读取）
 *
 * 空间音频已内联到 EngineV3（纯 TS），不再使用独立 worklet/构建脚本内嵌数据。
 * HRTF 网格优先用合成解析 HRTF（generateAnalyticHrtfGrid，确定性、无外部依赖）。
 * hrtf-data/grid.bin 仍保留（KEMAR 实测数据），可由运行时 fetch 读取（后续扩展）。
 *
 * 注意：AudioWorklet 全局作用域不保证 atob/btoa，base64 解码用自实现纯函数（RFC 4648）。
 */

import { generateAnalyticHrtfGrid } from './analyticHrtf'
import type { HrtfGrid } from './types'

/** 内嵌 HRTF 网格 base64（旧构建脚本产物，现已废弃——纯 TS 内联用合成网格） */
export const HRTF_GRID_BASE64: string | null = null

/** 内置数据集表（旧构建脚本产物，现已废弃——数据集切换功能保留接口，后续可运行时加载） */
export const BUILTIN_HRTF_DATASETS: { id: 'kemar' | 'cipic'; name: string; base64: string | null }[] = [
  { id: 'kemar', name: 'MIT KEMAR（合成兜底）', base64: null },
  { id: 'cipic', name: 'CIPIC subject_003（合成兜底）', base64: null },
]

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
  const entry = BUILTIN_HRTF_DATASETS.find((d: { id: string; name: string; base64: string | null }) => d.id === id)
  if (!entry || entry.base64 === null) return null // 未打包：静默（调用方忽略）
  try {
    return decodeSpatialGrid(entry.base64)
  } catch {
    return null // 内嵌数据损坏：静默（调用方忽略，不中断音频）
  }
}

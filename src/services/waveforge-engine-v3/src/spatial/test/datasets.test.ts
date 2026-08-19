/**
 * 内置 HRTF 数据集表 / 解码单元测试（规划书 §4.1：KEMAR + CIPIC 两套内置）
 *
 * 覆盖：BUILTIN_HRTF_DATASETS 结构（两条目、kemar base64 非空、cipic 可为 null =
 * 数据未打包）；decodeSpatialGrid 公共解码函数与 grid.bin 已知形状一致
 * （48kHz / 72az×14el×256，数据来自构建脚本内嵌）；loadBuiltinGrid 按 id 解码
 * （cipic 已打包 → 50az×25el×256@48k，缺方向补零可解码；未打包 → null 静默）；
 * 损坏数据 → 解码抛错 / loadBuiltinGrid 返回 null（不抛）。
 *
 * 注：grid.ts / datasets.ts 为构建产物（npm run build:spatial-worklet 生成），
 * 本测试依赖当前构建状态——cipic 条目按实际打包状态分支断言，两态均通过。
 */
import { describe, it, expect } from 'vitest'
import { BUILTIN_HRTF_DATASETS } from '../gridSource'
import { HRTF_GRID_BASE64 } from '../gridSource'
import { decodeSpatialGrid, loadBuiltinGrid } from '../gridSource'

/** kemar 网格已知形状（grid.bin 头部实测：48kHz / 72az×14el×256） */
const KEMAR_SHAPE = { sampleRate: 48000, azCount: 72, elCount: 14, hrirLen: 256 }

describe('spatial：内置 HRTF 数据集表（BUILTIN_HRTF_DATASETS）', () => {
  it('结构：kemar + cipic 两条目，id/name 齐全，kemar base64 非空（cipic 可为 null）', () => {
    expect(BUILTIN_HRTF_DATASETS).toHaveLength(2)
    expect(BUILTIN_HRTF_DATASETS.map((d) => d.id)).toEqual(['kemar', 'cipic'])
    for (const d of BUILTIN_HRTF_DATASETS) {
      expect(typeof d.name).toBe('string')
      expect(d.name.length).toBeGreaterThan(0)
      // base64 只能为 string（已打包）或 null（未打包）
      expect(d.base64 === null || typeof d.base64 === 'string').toBe(true)
    }
    // kemar（grid.bin）必须已打包——worklet 构造依赖它（缺失时合成网格兜底，但内嵌应始终在）
    expect(BUILTIN_HRTF_DATASETS[0].base64).not.toBeNull()
  })

  it('HRTF_GRID_BASE64 与数据集表 kemar 条目同源（同一 base64 载荷）', () => {
    const kemar = BUILTIN_HRTF_DATASETS.find((d) => d.id === 'kemar')
    expect(kemar?.base64).toBe(HRTF_GRID_BASE64)
  })
})

describe('spatial：解码函数（decodeSpatialGrid，与 grid.bin 布局一致）', () => {
  it('解码 kemar 内嵌 → 已知形状（48kHz / 72az×14el×256），行主序长度一致', () => {
    const grid = decodeSpatialGrid(HRTF_GRID_BASE64!)
    expect(grid.sampleRate).toBe(KEMAR_SHAPE.sampleRate)
    expect(grid.azimuths).toHaveLength(KEMAR_SHAPE.azCount)
    expect(grid.elevations).toHaveLength(KEMAR_SHAPE.elCount)
    expect(grid.hrirLength).toBe(KEMAR_SHAPE.hrirLen)
    const expectLen = KEMAR_SHAPE.elCount * KEMAR_SHAPE.azCount * KEMAR_SHAPE.hrirLen
    expect(grid.left).toHaveLength(expectLen)
    expect(grid.right).toHaveLength(expectLen)
    // 方位/仰角升序（后端最近邻/球谐插值的索引前提）
    for (let i = 1; i < grid.azimuths.length; i++) expect(grid.azimuths[i]).toBeGreaterThan(grid.azimuths[i - 1])
    for (let i = 1; i < grid.elevations.length; i++) expect(grid.elevations[i]).toBeGreaterThan(grid.elevations[i - 1])
  })

  it('损坏数据（非法头）→ 解码抛错（调用方回退合成/静默）', () => {
    // 'AAAA' → 3 字节 0x00：azCount=0 → 头校验拒绝
    expect(() => decodeSpatialGrid('AAAA')).toThrow()
  })
})

describe('spatial：loadBuiltinGrid（内置数据集按 id 装载）', () => {
  it('kemar：解码成功 → 与 decodeSpatialGrid 形状一致', () => {
    const grid = loadBuiltinGrid('kemar')
    expect(grid).not.toBeNull()
    expect(grid!.azimuths).toHaveLength(KEMAR_SHAPE.azCount)
    expect(grid!.elevations).toHaveLength(KEMAR_SHAPE.elCount)
    expect(grid!.hrirLength).toBe(KEMAR_SHAPE.hrirLen)
    expect(grid!.sampleRate).toBe(KEMAR_SHAPE.sampleRate)
  })

  it('cipic：按打包状态分支——已打包 → 50az×25el×256@48k（含缺方向补零）；未打包 → null 静默', () => {
    const entry = BUILTIN_HRTF_DATASETS.find((d) => d.id === 'cipic')!
    if (entry.base64 === null) {
      // 数据未打包（hrtf-data/grid-cipic.bin 缺失）：静默 null，不抛
      expect(loadBuiltinGrid('cipic')).toBeNull()
      return
    }
    const grid = loadBuiltinGrid('cipic')
    expect(grid).not.toBeNull()
    // 转换脚本产出约定：48kHz / 水平环 50az × CIPIC 规范 25el × 256 样本
    expect(grid!.sampleRate).toBe(48000)
    expect(grid!.azimuths).toHaveLength(50)
    expect(grid!.elevations).toHaveLength(25)
    expect(grid!.hrirLength).toBe(256)
    expect(grid!.left).toHaveLength(50 * 25 * 256)
    expect(grid!.right).toHaveLength(50 * 25 * 256)
    // 水平环覆盖 -180..180（CIPIC 实测全周 50 方位，含后方）
    expect(grid!.azimuths[0]).toBe(-180)
    expect(grid!.azimuths[grid!.azimuths.length - 1]).toBe(175)
    // 缺方向补零：存在全零格（CIPIC 各层 az 集合不齐，未打包方向静音）
    let zeroCells = 0
    for (let c = 0; c < 50 * 25; c++) {
      const base = c * 256
      let z = true
      for (let t = 0; t < 256; t++) {
        if (grid!.left[base + t] !== 0 || grid!.right[base + t] !== 0) {
          z = false
          break
        }
      }
      if (z) zeroCells++
    }
    expect(zeroCells).toBeGreaterThan(0) // 至少一个缺方向补零格（如 94.2° 顶层层）
    expect(zeroCells).toBeLessThan(50 * 25) // 且非全空（水平带已填充）
  })
})

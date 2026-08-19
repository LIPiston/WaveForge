/**
 * hrtfStore 单元测试（IndexedDB 封装）
 *
 * vitest node 环境无 IndexedDB（typeof indexedDB === 'undefined'）→ 四个函数
 * 均 reject 中文错误（生产环境浏览器端正常读写，由真实 IDB 覆盖）。
 */
import { describe, it, expect } from 'vitest'
import { saveHrtfDataset, loadHrtfDataset, listHrtfDatasets, deleteHrtfDataset, getLatestDataset } from '../hrtfStore'
import type { HrtfGrid } from '../types'

/** 最小合法网格（仅作存取载荷，Node 环境不会真正落库） */
const tinyGrid: HrtfGrid = {
  sampleRate: 48000,
  azimuths: [-30, 30],
  elevations: [0],
  hrirLength: 8,
  left: new Float32Array(16).fill(0.1),
  right: new Float32Array(16).fill(-0.1),
}

describe('hrtfStore：Node 环境无 IndexedDB → reject 中文错误', () => {
  it('saveHrtfDataset reject', async () => {
    await expect(saveHrtfDataset('2026-08-18T00:00:00.000Z', tinyGrid)).rejects.toThrow(
      /当前环境不支持 IndexedDB（Node 测试环境无该 API）/,
    )
  })

  it('loadHrtfDataset reject', async () => {
    await expect(loadHrtfDataset('2026-08-18T00:00:00.000Z')).rejects.toThrow(/IndexedDB/)
  })

  it('listHrtfDatasets reject', async () => {
    await expect(listHrtfDatasets()).rejects.toThrow(/IndexedDB/)
  })

  it('deleteHrtfDataset reject', async () => {
    await expect(deleteHrtfDataset('2026-08-18T00:00:00.000Z')).rejects.toThrow(/IndexedDB/)
  })

  it('getLatestDataset reject', async () => {
    await expect(getLatestDataset()).rejects.toThrow(/IndexedDB/)
  })
})

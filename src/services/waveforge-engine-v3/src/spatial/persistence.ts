/**
 * persistence —— 空间音频参数持久化（localStorage 'waveforge:spatial-params'）
 *
 * 语义同 attachV3Engine.persistParams 范式：save 400ms 防抖（滑动窗口内最后一次胜出）、
 * restore 与默认值深合并（容错坏 JSON / 缺字段），失败回默认。
 * 存储可注入（测试用内存 mock）；默认 window.localStorage（typeof window 守卫，
 * Node/无 window 环境降级为 null → restore 回默认、save 空操作，不影响调用方）。
 */

import { createDefaultSpatialParams } from './types'
import type { DeepPartial, SpatialParams } from './types'

/** 持久化键（空间音频独立命名空间，与 V3EngineParams 完全解耦） */
export const SPATIAL_PARAMS_KEY = 'waveforge:spatial-params'
/** 保存防抖窗口（ms） */
const SAVE_DEBOUNCE_MS = 400

export interface SpatialStore {
  restore(): SpatialParams
  save(p: SpatialParams): void
}

/**
 * 深合并：普通对象递归；数组/Float32Array/原始值直接替换（同 ui/hooks.ts 语义）。
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || patch instanceof Float32Array) {
    return patch as T
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base) || base instanceof Float32Array) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(patch as Record<string, unknown>)) {
    const pv = (patch as Record<string, unknown>)[key]
    const bv = (base as Record<string, unknown>)[key]
    out[key] = deepMerge(bv as never, pv as never)
  }
  return out as T
}

export function createSpatialStore(storage?: Pick<Storage, 'getItem' | 'setItem'>): SpatialStore {
  const backing = storage ?? (typeof window !== 'undefined' ? window.localStorage : null)
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    restore(): SpatialParams {
      const base = createDefaultSpatialParams()
      if (!backing) return base
      try {
        const raw = backing.getItem(SPATIAL_PARAMS_KEY)
        if (!raw) return base
        const saved = JSON.parse(raw) as DeepPartial<SpatialParams>
        if (!saved || typeof saved !== 'object') return base
        return deepMerge(base, saved)
      } catch {
        return base // 坏数据回默认（不影响播放）
      }
    },
    save(p: SpatialParams): void {
      if (!backing) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        try {
          backing.setItem(SPATIAL_PARAMS_KEY, JSON.stringify(p))
        } catch {
          // 存储不可用时静默（不影响播放）
        }
      }, SAVE_DEBOUNCE_MS)
    },
  }
}

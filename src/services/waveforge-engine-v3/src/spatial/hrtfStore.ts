/**
 * hrtfStore —— HRTF 数据集 IndexedDB 持久化（用户导入的 SOFA 网格）
 *
 * db 'waveforge-hrtf' / store 'datasets'，key = 数据集 id（日期戳，由调用方生成）。
 * 无第三方依赖：手写 Promise 封装（IDBRequest / IDBTransaction → Promise）。
 * Node 测试环境无 IndexedDB（typeof indexedDB === 'undefined'）→ 所有操作
 * reject 中文错误（测试断言 reject，生产环境不受影响）。
 *
 * 注意：写操作在事务 oncomplete 后 resolve（避免提前 db.close() 中止未提交事务
 * 导致写入回滚）；Float32Array 网格由结构化克隆存入（IDB 原生支持）。
 */

import type { HrtfGrid } from './types'

const DB_NAME = 'waveforge-hrtf'
const DB_VERSION = 1
const STORE_NAME = 'datasets'

/** 打开数据库（无 IndexedDB 环境 reject 中文错误） */
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境不支持 IndexedDB（Node 测试环境无该 API）'))
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME) // 无 keyPath → put/get 显式传 key（id）
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

/** 只读操作：请求成功即返回（读事务中途 close 无副作用） */
function readDb<T>(op: (db: IDBDatabase) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作失败'))
      }).finally(() => db.close()),
  )
}

/** 写操作：事务完成后 resolve（此时可安全 close，事务已提交） */
function writeDb(op: (db: IDBDatabase) => IDBTransaction): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = op(db)
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入中止'))
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'))
      }).finally(() => db.close()),
  )
}

/** 保存 HRTF 数据集（id 为 key；同 id 重复保存覆盖） */
export function saveHrtfDataset(id: string, grid: HrtfGrid): Promise<void> {
  return writeDb((db) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(grid, id)
    return tx
  })
}

/** 读取 HRTF 数据集（不存在返回 null） */
export function loadHrtfDataset(id: string): Promise<HrtfGrid | null> {
  return readDb((db) => db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id))
}

/** 列出全部数据集 id（时间戳升序） */
export function listHrtfDatasets(): Promise<string[]> {
  return readDb((db) => db.transaction(STORE_NAME).objectStore(STORE_NAME).getAllKeys()).then((keys) =>
    keys.map((k) => String(k)),
  )
}

/**
 * 取最近导入的数据集：id 为日期戳（ISO 8601，由 setHrtfDataset 生成）——
 * 字典序即时间序，取字典序最大 = 最新 → loadHrtfDataset。
 * 无任何数据集 / 最新 id 读不到 → null；IndexedDB 不可用 → reject（同其他函数）。
 * 用途：导入数据集跨重启自动恢复（fusion.restoreHrtfDataset 在 attach 流程恢复
 * 最近一次生效的自定义网格）。
 */
export async function getLatestDataset(): Promise<{ id: string; grid: HrtfGrid } | null> {
  const ids = await listHrtfDatasets()
  if (ids.length === 0) return null
  const latestId = ids.reduce((a, b) => (a > b ? a : b))
  const grid = await loadHrtfDataset(latestId)
  return grid === null ? null : { id: latestId, grid }
}

/** 删除数据集（不存在时静默成功） */
export function deleteHrtfDataset(id: string): Promise<void> {
  return writeDb((db) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    return tx
  })
}

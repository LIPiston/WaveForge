/**
 * 大对象缓存统一入口（深挖 localStorage 配额问题的产物）：
 * - 存储分层：IndexedDB（首选，配额以百 MB 计）→ localStorage（降级，~5MB，只允许小对象碰运气）→ 内存兜底无
 * - 适用：聚合 payload、封面墙列表等「数百 KB ~ MB 级、丢了只是慢一拍」的缓存
 * - 不适用：小设置项（继续 localStorage 同步读写）、媒体文件（走 userData 磁盘）
 * 任何失败都静默降级：缓存永远不能把「加载成功」变成「报错」。
 */

const DB_NAME = 'WaveForgeLargeCache'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      try {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

function safeLocalSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: value, savedAt: Date.now() }))
  } catch {
    // 配额满：放弃落盘（缓存语义，可接受）
  }
}

function safeLocalGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // 兼容本模块包装格式 { v, savedAt } 与调用方历史裸格式
    if (parsed && typeof parsed === 'object' && 'v' in parsed) return parsed.v as T
    return parsed as T
  } catch {
    return null
  }
}

export async function largeCacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb()
  if (!db) return safeLocalGet<T>(key)
  try {
    const item = await new Promise<{ value: T; savedAt: number; expiresAt?: number } | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    if (!item) return null
    if (item.expiresAt && Date.now() > item.expiresAt) {
      void largeCacheDelete(key)
      return null
    }
    return (item.value ?? null) as T | null
  } catch {
    return safeLocalGet<T>(key)
  }
}

export async function largeCacheSet(key: string, value: unknown, ttlMs?: number): Promise<void> {
  const db = await openDb()
  const record = { value, savedAt: Date.now(), expiresAt: ttlMs ? Date.now() + ttlMs : undefined }
  if (db) {
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(record, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
      return
    } catch {
      // IDB 写失败（隐私模式/磁盘满）→ 降级 localStorage，写不下就算了
    }
  }
  safeLocalSet(key, value)
}

export async function largeCacheDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略
  }
  if (!db) return
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // 忽略
  }
}

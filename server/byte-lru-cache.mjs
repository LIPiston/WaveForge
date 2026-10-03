/**
 * 过期扫描的最小间隔。set 在图片代理里最多 32 并发在飞，而每次插入都全表遍历
 * （maxEntries 上限内最多 800 条）纯属浪费——过期条目在 get 时本就会被惰性剔除。
 * 容量淘汰不受此节流影响，见 set()。
 */
export const DEFAULT_PRUNE_INTERVAL_MS = 10_000

export class ByteLruCache {
  constructor({ maxBytes, maxEntries, ttlMs, pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS }) {
    for (const [name, value] of Object.entries({ maxBytes, maxEntries, ttlMs })) {
      if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`)
    }
    if (!Number.isFinite(pruneIntervalMs) || pruneIntervalMs < 0) {
      throw new TypeError('pruneIntervalMs must be a non-negative finite number')
    }
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.pruneIntervalMs = pruneIntervalMs
    this.lastPruneAt = Number.NEGATIVE_INFINITY
    this.entries = new Map()
    this.totalBytes = 0
    this.hits = 0
    this.misses = 0
    this.evictions = 0
    this.expirations = 0
  }

  get(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return null
    }
    if (now - entry.at >= this.ttlMs) {
      this.delete(key)
      this.expirations += 1
      this.misses += 1
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key, value, bytes, now = Date.now()) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('bytes must be a non-negative safe integer')
    this.maybePruneExpired(now)
    this.delete(key)
    if (bytes > this.maxBytes) return false
    this.entries.set(key, { value, bytes, at: now })
    this.totalBytes += bytes
    // 容量淘汰刻意不节流：这段是 O(淘汰数) 而非 O(n)，且必须每次精确执行，
    // 否则 totalBytes/maxEntries 的硬上限会短暂失效。
    this.evictOverCapacity()
    return true
  }

  /** 按 pruneIntervalMs 节流地回收过期条目；窗口内跳过，交给 get 的惰性判断兜底。 */
  maybePruneExpired(now = Date.now()) {
    if (now - this.lastPruneAt < this.pruneIntervalMs) return 0
    this.lastPruneAt = now
    return this.pruneExpired(now)
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes)
    return this.entries.delete(key)
  }

  pruneExpired(now = Date.now()) {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) {
        this.delete(key)
        this.expirations += 1
        removed += 1
      }
    }
    return removed
  }

  evictOverCapacity() {
    let removed = 0
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
      this.evictions += 1
      removed += 1
    }
    return removed
  }

  /** 立即做一次完整的过期扫描 + 容量收敛（不节流）。 */
  prune(now = Date.now()) {
    this.lastPruneAt = now
    let removed = this.pruneExpired(now)
    removed += this.evictOverCapacity()
    return removed
  }

  clear() {
    this.entries.clear()
    this.totalBytes = 0
  }

  stats() {
    return {
      size: this.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      pruneIntervalMs: this.pruneIntervalMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    }
  }

  get size() { return this.entries.size }
  get bytes() { return this.totalBytes }
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'))
  let onAbort
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      onAbort = () => reject(signal.reason || new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
    }),
  ]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

export async function readResponseWithLimit(response, maxBytes, signal) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer')
  const contentLength = response.headers?.get?.('content-length')
  const declared = contentLength === null || contentLength === undefined ? null : Number(contentLength)
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
    throw new Error('response has invalid content-length')
  }
  if (declared !== null && declared > maxBytes) throw new Error('response exceeds byte limit')
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await abortable(response.arrayBuffer(), signal))
    if (buffer.length > maxBytes) throw new Error('response exceeds byte limit')
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      let result
      try {
        result = await abortable(reader.read(), signal)
      } catch (error) {
        await Promise.resolve(reader.cancel(error)).catch(() => undefined)
        throw error
      }
      const { done, value } = result
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await Promise.resolve(reader.cancel('response exceeds byte limit')).catch(() => undefined)
        throw new Error('response exceeds byte limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

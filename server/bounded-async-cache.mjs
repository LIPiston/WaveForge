/**
 * 带单飞（single-flight）的有界异步缓存。
 *
 * 同一个 key 的并发首次计算只执行一次 factory，其余调用共享同一个 Promise；
 * 容量上限同时约束条目数与总字节数（按插入序做 LRU），每条按 TTL 惰性过期。
 * TTL 是**滑动**的：命中会刷新存活时间，活跃使用的条目不会被 TTL 淘汰（播放中反复
 * seek 会持续命中同一 key，固定 TTL 会在拖进度条时把条目清掉，紧接着又要整轨重算）。
 *
 * 抽成独立模块的原因：汽水解密缓存（整轨下载 + 逐 sample 解密，代价很高）与图片代理的
 * in-flight 去重是同一套语义。做成可注入 factory / sizeOf 的纯缓存后，缓存行为可以脱离
 * 业务单独测（否则想验证「单飞只算一次」就得真去解密一段 CENC 音频）。
 */

function assertPositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`)
}

export class BoundedAsyncCache {
  /**
   * @param {object} options
   * @param {number} options.maxEntries 条目数上限
   * @param {number} options.maxBytes   总字节数上限（按 sizeOf 累计）
   * @param {number} options.ttlMs      条目存活时长，惰性判断
   * @param {(value: any) => number} [options.sizeOf] 取单个条目的字节数，默认 0
   */
  constructor({ maxEntries, maxBytes, ttlMs, sizeOf = () => 0 }) {
    assertPositive(maxEntries, 'maxEntries')
    assertPositive(maxBytes, 'maxBytes')
    assertPositive(ttlMs, 'ttlMs')
    if (typeof sizeOf !== 'function') throw new TypeError('sizeOf must be a function')
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.ttlMs = ttlMs
    this.sizeOf = sizeOf
    this.entries = new Map()
    this.pending = new Map()
    this.totalBytes = 0
    this.generation = 0
    this.expirations = 0
    this.evictions = 0
    this.coalesced = 0
    this.hits = 0
    this.misses = 0
  }

  /**
   * 取缓存值；未命中或已过期返回 null。
   * 命中会刷新存活时间（滑动 TTL），见类注释。
   * 注意：调用方的缓存值不能是 null（null 是未命中的哨兵）。
   */
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
    // Map 的插入序即 LRU 序：命中后移到队尾并刷新 at，淘汰时从队首取
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.at = now
    this.hits += 1
    return entry.value
  }

  /** 写入一条；单条超过 maxBytes 时拒绝写入并返回 false。 */
  set(key, value, now = Date.now()) {
    const size = Math.max(0, Number(this.sizeOf(value)) || 0)
    if (size > this.maxBytes) return false
    this.delete(key)
    this.entries.set(key, { value, size, at: now })
    this.totalBytes += size
    this.evictOverCapacity()
    return true
  }

  /**
   * 命中即返回；否则调用 factory 计算并写入。
   * 同一 key 的并发调用共享同一个 Promise（factory 只执行一次）。
   * factory 抛错时不写缓存，错误原样传给所有等待者。
   */
  async getOrCreate(key, factory, now = Date.now()) {
    const cached = this.get(key, now)
    if (cached !== null) return cached
    const existing = this.pending.get(key)
    if (existing) {
      this.coalesced += 1
      return existing
    }
    const generation = this.generation
    const task = Promise.resolve()
      .then(factory)
      .then(value => {
        // clear() 之后完成的在途计算不再回填：否则刚清空的缓存会被重新填上
        if (generation === this.generation) this.set(key, value)
        return value
      })
      .finally(() => {
        this.pending.delete(key)
      })
    this.pending.set(key, task)
    return task
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.totalBytes = Math.max(0, this.totalBytes - entry.size)
    return this.entries.delete(key)
  }

  evictOverCapacity() {
    let removed = 0
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
      this.evictions += 1
      removed += 1
    }
    return removed
  }

  /** 立即回收已过期条目，返回回收条数。 */
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

  /** 清空缓存。在途计算完成后不会回填（见 getOrCreate）。 */
  clear() {
    this.entries.clear()
    this.totalBytes = 0
    this.generation += 1
  }

  stats(now = Date.now()) {
    let expired = 0
    for (const entry of this.entries.values()) {
      if (now - entry.at >= this.ttlMs) expired += 1
    }
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      inFlight: this.pending.size,
      expired,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      coalesced: this.coalesced,
    }
  }

  get size() { return this.entries.size }
  get bytes() { return this.totalBytes }
  get inFlight() { return this.pending.size }
}

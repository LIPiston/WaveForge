import { describe, expect, it, vi } from 'vitest'
import { BoundedAsyncCache } from '../server/bounded-async-cache.mjs'

const sizeOfBuffer = value => value?.buffer?.length || 0

function createCache(overrides = {}) {
  return new BoundedAsyncCache({
    maxEntries: 10,
    maxBytes: 1_000,
    ttlMs: 1_000,
    sizeOf: sizeOfBuffer,
    ...overrides,
  })
}

describe('BoundedAsyncCache 容量与淘汰', () => {
  it('按条目数上限淘汰最久未使用的条目', () => {
    const cache = createCache({ maxEntries: 2 })
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    cache.set('b', { buffer: Buffer.alloc(1) }, 0)
    expect(cache.get('a', 1)).not.toBeNull()
    cache.set('c', { buffer: Buffer.alloc(1) }, 1)
    expect(cache.get('b', 2)).toBeNull()
    expect(cache.get('a', 2)).not.toBeNull()
    expect(cache.size).toBe(2)
  })

  it('按字节上限淘汰，且精确维护字节账目', () => {
    const cache = createCache({ maxEntries: 100, maxBytes: 10 })
    cache.set('a', { buffer: Buffer.alloc(4) }, 0)
    cache.set('b', { buffer: Buffer.alloc(4) }, 0)
    expect(cache.bytes).toBe(8)
    cache.set('c', { buffer: Buffer.alloc(4) }, 0)
    expect(cache.bytes).toBe(8)
    expect(cache.stats(0).evictions).toBe(1)
  })

  it('拒绝超过总预算的单条数据', () => {
    const cache = createCache({ maxBytes: 5 })
    expect(cache.set('huge', { buffer: Buffer.alloc(6) }, 0)).toBe(false)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('校验构造参数', () => {
    expect(() => new BoundedAsyncCache({ maxEntries: 0, maxBytes: 1, ttlMs: 1 })).toThrow(/maxEntries/)
    expect(() => new BoundedAsyncCache({ maxEntries: 1, maxBytes: 1, ttlMs: 0 })).toThrow(/ttlMs/)
  })
})

describe('BoundedAsyncCache TTL', () => {
  it('get 惰性剔除过期条目', () => {
    const cache = createCache({ ttlMs: 10 })
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    cache.set('b', { buffer: Buffer.alloc(1) }, 0)
    // b 在 9 秒时被命中（刷新存活时间），a 一直没被访问
    expect(cache.get('b', 9)).not.toBeNull()
    expect(cache.get('a', 10)).toBeNull()
    expect(cache.size).toBe(1)
    expect(cache.stats(10).expirations).toBe(1)
  })

  it('TTL 是滑动的：命中会刷新存活时间', () => {
    const cache = createCache({ ttlMs: 10 })
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    // 每 9 秒命中一次：尽管总时长已远超 10 秒，条目仍然有效
    expect(cache.get('a', 9)).not.toBeNull()
    expect(cache.get('a', 18)).not.toBeNull()
    expect(cache.get('a', 27)).not.toBeNull()
    // 停止命中后按时过期
    expect(cache.get('a', 37)).toBeNull()
  })

  it('pruneExpired 主动回收过期条目', () => {
    const cache = createCache({ ttlMs: 10 })
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    cache.set('b', { buffer: Buffer.alloc(1) }, 0)
    cache.set('c', { buffer: Buffer.alloc(1) }, 100)
    expect(cache.pruneExpired(100)).toBe(2)
    expect(cache.size).toBe(1)
  })

  it('stats 报告过期但尚未回收的条目', () => {
    const cache = createCache({ ttlMs: 10 })
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    expect(cache.stats(50)).toMatchObject({ entries: 1, expired: 1 })
  })
})

describe('BoundedAsyncCache 单飞', () => {
  it('同一 key 的并发首次计算只执行一次 factory', async () => {
    const cache = createCache()
    let resolveFactory
    const factory = vi.fn(() => new Promise(resolve => { resolveFactory = resolve }))
    const first = cache.getOrCreate('k', factory)
    const second = cache.getOrCreate('k', factory)
    const third = cache.getOrCreate('k', factory)

    // 让 factory 的微任务起步，确认三次调用都挂在同一个在途条目上
    await Promise.resolve()
    expect(cache.inFlight).toBe(1)
    expect(factory).toHaveBeenCalledTimes(1)

    const payload = { buffer: Buffer.alloc(4), contentType: 'audio/mp4' }
    resolveFactory(payload)
    expect(await first).toBe(payload)
    expect(await second).toBe(payload)
    expect(await third).toBe(payload)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(cache.stats().coalesced).toBe(2)
    expect(cache.inFlight).toBe(0)
  })

  it('factory 完成后命中缓存，不再执行 factory', async () => {
    const cache = createCache()
    const factory = vi.fn(async () => ({ buffer: Buffer.alloc(4) }))
    await cache.getOrCreate('k', factory)
    await cache.getOrCreate('k', factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(cache.bytes).toBe(4)
  })

  it('factory 抛错时不写缓存，错误传给所有等待者', async () => {
    const cache = createCache()
    const factory = vi.fn(async () => { throw new Error('decrypt failed') })
    const first = cache.getOrCreate('k', factory)
    const second = cache.getOrCreate('k', factory)
    await expect(first).rejects.toThrow('decrypt failed')
    await expect(second).rejects.toThrow('decrypt failed')
    expect(cache.size).toBe(0)
    expect(cache.inFlight).toBe(0)

    // 失败后可以重试：下一次调用会重新执行 factory
    const retry = vi.fn(async () => ({ buffer: Buffer.alloc(2) }))
    await expect(cache.getOrCreate('k', retry)).resolves.toMatchObject({ buffer: Buffer.alloc(2) })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('不同 key 各自独立计算', async () => {
    const cache = createCache()
    const factory = vi.fn(async key => ({ buffer: Buffer.alloc(1), key }))
    await Promise.all([cache.getOrCreate('a', () => factory('a')), cache.getOrCreate('b', () => factory('b'))])
    expect(cache.size).toBe(2)
  })
})

describe('BoundedAsyncCache clear', () => {
  it('清空条目与字节账目', () => {
    const cache = createCache()
    cache.set('a', { buffer: Buffer.alloc(4) }, 0)
    cache.set('b', { buffer: Buffer.alloc(4) }, 0)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })

  it('clear 之后完成的在途计算不再回填缓存', async () => {
    const cache = createCache()
    let resolveFactory
    const pending = cache.getOrCreate('k', () => new Promise(resolve => { resolveFactory = resolve }))
    await Promise.resolve()
    expect(cache.inFlight).toBe(1)

    cache.clear()
    resolveFactory({ buffer: Buffer.alloc(4) })
    const value = await pending
    // 调用方仍拿到值（当前请求要能正常返回），但缓存保持为空
    expect(value).toMatchObject({ buffer: Buffer.alloc(4) })
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })
})

describe('BoundedAsyncCache 统计', () => {
  it('报告命中/未命中与容量配置', () => {
    const cache = createCache()
    cache.set('a', { buffer: Buffer.alloc(1) }, 0)
    expect(cache.get('a', 1)).not.toBeNull()
    expect(cache.get('missing', 1)).toBeNull()
    expect(cache.stats(1)).toMatchObject({
      entries: 1,
      bytes: 1,
      maxEntries: 10,
      maxBytes: 1_000,
      ttlMs: 1_000,
      inFlight: 0,
      hits: 1,
      misses: 1,
    })
  })
})

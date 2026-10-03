import { describe, expect, it } from 'vitest'
import {
  clearSodaDecryptCache,
  getSodaDecryptCacheStats,
  pruneSodaDecryptCache,
} from '../server/qishui-audio-decryptor.mjs'

/**
 * 汽水解密缓存的管理接口契约。
 *
 * 缓存本身的行为（单飞 / TTL / 容量与字节淘汰 / clear 不回填）由
 * test/boundedAsyncCache.test.ts 覆盖——该缓存已抽成 server/bounded-async-cache.mjs。
 * 这里只钉住薄封装层的形状：设置页「清理缓存」依赖这些字段，改名会静默丢掉展示。
 *
 * 缓存内容无法在此注入（写入需要真解密一段 CENC 音频），因此这里只覆盖空缓存路径。
 */
describe('汽水解密缓存管理接口', () => {
  it('清理是幂等的，且不因空缓存报错', () => {
    expect(clearSodaDecryptCache()).toEqual({ success: true, cleared: 0, freedBytes: 0 })
    expect(clearSodaDecryptCache()).toEqual({ success: true, cleared: 0, freedBytes: 0 })
  })

  it('统计报告容量配置与在途计数', () => {
    expect(getSodaDecryptCacheStats()).toMatchObject({
      entries: 0,
      bytes: 0,
      maxEntries: 12,
      maxBytes: 256 * 1024 * 1024,
      ttlMs: 20 * 60 * 1000,
      inFlight: 0,
      expired: 0,
    })
  })

  it('主动回收在空缓存上返回 0', () => {
    expect(pruneSodaDecryptCache()).toBe(0)
  })
})

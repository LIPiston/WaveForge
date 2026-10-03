import { describe, expect, it } from 'vitest'
import { resolveSongUrlTtl } from '../src/services/musicApi'

const DEFAULT_TTL = 5 * 60 * 1000
const NEGATIVE_FLOOR = 15 * 1000

describe('resolveSongUrlTtl', () => {
  it('上游未声明有效期时沿用默认 5 分钟', () => {
    expect(resolveSongUrlTtl(undefined)).toBe(DEFAULT_TTL)
    expect(resolveSongUrlTtl(null)).toBe(DEFAULT_TTL)
    expect(resolveSongUrlTtl(0)).toBe(DEFAULT_TTL)
    expect(resolveSongUrlTtl(-1)).toBe(DEFAULT_TTL)
    expect(resolveSongUrlTtl(Number.NaN)).toBe(DEFAULT_TTL)
    expect(resolveSongUrlTtl('600')).toBe(DEFAULT_TTL)
  })

  it('有效期短于默认值时按其收窄，并留出 30 秒缓冲', () => {
    // 网易云常见下发 expi=600（10 分钟）：仍受默认上限约束
    expect(resolveSongUrlTtl(600)).toBe(DEFAULT_TTL)
    // 有效期 3 分钟 → 3min - 30s = 2.5min
    expect(resolveSongUrlTtl(180)).toBe(150 * 1000)
    // 有效期正好 5 分钟 → 5min - 30s
    expect(resolveSongUrlTtl(300)).toBe(270 * 1000)
  })

  it('设下限，避免极短有效期导致缓存反复抖动', () => {
    // expi=20 → 20s - 30s 为负，收敛到下限
    expect(resolveSongUrlTtl(20)).toBe(NEGATIVE_FLOOR)
    expect(resolveSongUrlTtl(1)).toBe(NEGATIVE_FLOOR)
  })

  it('不会超过默认上限（有效期再长也不会把缓存拉长）', () => {
    expect(resolveSongUrlTtl(86_400)).toBe(DEFAULT_TTL)
  })
})

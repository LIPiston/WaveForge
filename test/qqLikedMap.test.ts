import { describe, expect, it } from 'vitest'

import { likedMapValues } from '../server/qq-liked-map.mjs'

describe('QQ liked-list map shape normalization', () => {
  it('reads keys out of the upstream object shape (the real 2026-09-27 production shape)', () => {
    // 断言顺序无关：纯数字键会被 JS 按数值升序枚举（不是插入序），
    // 这正是"不能拿 id/mid 按下标配对"的原因（见 qq-liked-map.mjs 模块注释）。
    const upstream = { '501231481': 1, '351268824': 1, '108991193': 1 }
    expect([...likedMapValues(upstream)].sort()).toEqual(['108991193', '351268824', '501231481'])
    const mids = { '004a6uCg1jmsgO': 1, '0018EZ1S325Joo': 1 }
    expect(likedMapValues(mids)).toEqual(['004a6uCg1jmsgO', '0018EZ1S325Joo'])
  })

  it('keeps array input working (older / other upstream shapes)', () => {
    expect(likedMapValues(['1', '2', 3])).toEqual(['1', '2', '3'])
  })

  it('returns an empty array for missing or unusable input', () => {
    expect(likedMapValues(undefined)).toEqual([])
    expect(likedMapValues(null)).toEqual([])
    expect(likedMapValues('nope')).toEqual([])
    expect(likedMapValues(42)).toEqual([])
    expect(likedMapValues({})).toEqual([])
  })

  it('drops blank keys so callers never cache an empty identifier', () => {
    expect(likedMapValues({ '': 1, '  ': 1, ok: 1 })).toEqual(['ok'])
    expect(likedMapValues(['', '  ', 'x'])).toEqual(['x'])
  })
})

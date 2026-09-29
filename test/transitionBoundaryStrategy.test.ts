import { describe, expect, it } from 'vitest'
import { resolveBoundaryStrategyFor, resolvePairTransitionStrategy } from '../src/hooks/useAudioPlayer'

/**
 * 回归锁（P0-3）：专辑相邻曲 + AutoMix 开启时，边界策略必须是 gapless——历史上
 * 触发/ended 分支按字面量比较导致两条分支都不命中，每次换歌都硬切 + 整曲重载。
 */
describe('边界（曲尾交界）策略分流', () => {
  it.each([
    // pair,        album, 期望
    ['automix', true, 'gapless'],
    ['automix', false, 'automix'],
    ['gapless', true, 'gapless'],
    ['gapless', false, 'gapless'],
    ['fixed-crossfade', true, 'fixed-crossfade'],
    ['fixed-crossfade', false, 'fixed-crossfade'],
    ['none', true, 'none'],
    ['none', false, 'none'],
  ] as const)('resolveBoundaryStrategyFor(%s, album=%s) → %s', (pair, album, expected) => {
    expect(resolveBoundaryStrategyFor(pair, album)).toBe(expected)
  })

  it('专辑 + 只开 AutoMix（UI 的常态组合）不再退化为"两条分支都不走"', () => {
    const settings = { autoMix: true, crossfade: false, gapless: false }
    const pair = resolvePairTransitionStrategy({ url: 'a' }, { url: 'b' }, settings)
    expect(pair).toBe('automix')
    // 专辑场景：必须变成 gapless 边界（由 seamlessJoinController 接管），而不是无策略
    expect(resolveBoundaryStrategyFor(pair, true)).toBe('gapless')
    // 非专辑场景：维持 automix 智能过渡
    expect(resolveBoundaryStrategyFor(pair, false)).toBe('automix')
  })

  it('Apple 相邻边在专辑/非专辑下都保持 gapless', () => {
    const settings = { autoMix: true, crossfade: false, gapless: false }
    const pair = resolvePairTransitionStrategy({ url: 'a', appleHls: {} }, { url: 'b' }, settings)
    expect(pair).toBe('gapless')
    expect(resolveBoundaryStrategyFor(pair, true)).toBe('gapless')
    expect(resolveBoundaryStrategyFor(pair, false)).toBe('gapless')
  })
})

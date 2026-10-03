import { describe, expect, it } from 'vitest'
import {
  mergeOrder,
  moveIdByOffset,
  moveIdToIndex,
  parseStoredIdList,
  resolveEffectiveVisible,
  toggleVisible,
} from '../src/components/lyricModePrefs'

describe('parseStoredIdList', () => {
  it('解析正常列表', () => {
    expect(parseStoredIdList('["a","b"]')).toEqual(['a', 'b'])
  })

  it('脏值一律当没存过（回落到默认顺序，而不是让界面打不开）', () => {
    expect(parseStoredIdList(null)).toBeNull()
    expect(parseStoredIdList('')).toBeNull()
    expect(parseStoredIdList('not json')).toBeNull()
    expect(parseStoredIdList('{"a":1}')).toBeNull()
    expect(parseStoredIdList('[]')).toBeNull()
    expect(parseStoredIdList('[1,2]')).toBeNull()
  })

  it('丢弃非法元素但保留合法项', () => {
    expect(parseStoredIdList('["a",1,null,"b",""]')).toEqual(['a', 'b'])
  })
})

describe('mergeOrder', () => {
  const all = ['a', 'b', 'c', 'd']

  it('没保存过时用默认顺序', () => {
    expect(mergeOrder(all, null)).toEqual(all)
  })

  it('保存的顺序生效', () => {
    expect(mergeOrder(all, ['c', 'a', 'd', 'b'])).toEqual(['c', 'a', 'd', 'b'])
  })

  it('新增项追加到末尾：顺序表过时不会让新模式消失', () => {
    expect(mergeOrder(all, ['d', 'b'])).toEqual(['d', 'b', 'a', 'c'])
  })

  it('已删除的项被丢弃、重复项去重', () => {
    expect(mergeOrder(all, ['removed', 'b', 'b', 'a'])).toEqual(['b', 'a', 'c', 'd'])
  })

  it('空的全量清单返回空', () => {
    expect(mergeOrder([], ['a'])).toEqual([])
  })
})

describe('moveIdToIndex / moveIdByOffset', () => {
  const order = ['a', 'b', 'c', 'd']

  it('向后移：落到目标行所在位置', () => {
    expect(moveIdToIndex(order, 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveIdToIndex(order, 'a', 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('向前移：同样落在目标行位置（拖拽上下都不需要 ±1 修正）', () => {
    expect(moveIdToIndex(order, 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveIdToIndex(order, 'c', 0)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('下标越界时收敛到两端', () => {
    expect(moveIdToIndex(order, 'a', -5)).toEqual(['a', 'b', 'c', 'd'])
    expect(moveIdToIndex(order, 'a', 99)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('未知 id 原样返回副本', () => {
    expect(moveIdToIndex(order, 'zzz', 0)).toEqual(order)
  })

  it('相对移动在端点时不变', () => {
    expect(moveIdByOffset(order, 'b', -1)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveIdByOffset(order, 'a', -1)).toEqual(order)
    expect(moveIdByOffset(order, 'd', 1)).toEqual(order)
  })
})

describe('resolveEffectiveVisible', () => {
  const all = ['m1', 'm2', 'm3', 'm4']

  it('清理失效 id 并按默认顺序排列', () => {
    expect(resolveEffectiveVisible({
      allIds: all,
      visible: ['gone', 'm3', 'm1'],
      currentId: 'm1',
    })).toEqual(['m1', 'm3'])
  })

  it('当前项即使不在可见集合里也保留（否则所在模式会从选择条消失）', () => {
    expect(resolveEffectiveVisible({
      allIds: all,
      visible: ['m1'],
      currentId: 'm4',
    })).toEqual(['m1', 'm4'])
  })

  it('必留项始终保留', () => {
    expect(resolveEffectiveVisible({
      allIds: all,
      visible: ['m2'],
      currentId: 'm2',
      alwaysVisibleIds: ['m1'],
    })).toEqual(['m1', 'm2'])
  })

  it('可见数不足时按默认顺序补齐到 minVisible', () => {
    // 输出始终按默认顺序（可见性只管在不在，顺序由 mergeOrder 决定）
    expect(resolveEffectiveVisible({
      allIds: all,
      visible: [],
      currentId: 'm3',
      minVisible: 2,
    })).toEqual(['m1', 'm3'])
  })
})

describe('toggleVisible', () => {
  const base = { allIds: ['m1', 'm2', 'm3'], currentId: 'm1', minVisible: 2 }

  it('可以隐藏非当前、非锁定的项', () => {
    expect(toggleVisible({ ...base, visible: ['m1', 'm2', 'm3'], id: 'm3' }))
      .toEqual({ ok: true, visible: ['m1', 'm2'] })
  })

  it('可以重新打开已隐藏的项', () => {
    expect(toggleVisible({ ...base, visible: ['m1', 'm2'], id: 'm3' }))
      .toEqual({ ok: true, visible: ['m1', 'm2', 'm3'] })
  })

  it('当前项不可隐藏', () => {
    expect(toggleVisible({ ...base, visible: ['m1', 'm2', 'm3'], id: 'm1' }))
      .toEqual({ ok: false, reason: 'current' })
  })

  it('锁定项不可隐藏', () => {
    expect(toggleVisible({ ...base, visible: ['m1', 'm2', 'm3'], id: 'm2', lockedIds: ['m2'] }))
      .toEqual({ ok: false, reason: 'locked' })
  })

  it('关掉后不足最小可见数时拒绝（避免选择条被关空）', () => {
    expect(toggleVisible({ ...base, visible: ['m1', 'm2'], id: 'm2' }))
      .toEqual({ ok: false, reason: 'last-visible' })
  })
})

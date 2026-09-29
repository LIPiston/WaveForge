/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createTransitionVisualStore } from '../src/audio/transitionVisualStore'
import { transitionLyricsCrossfadeProgress, transitionOverlayProgress, useTransitionLyricsCrossfade, useTransitionOverlayProgress, useTransitionVisualIdentity } from '../src/hooks/useTransitionVisual'

/**
 * 视觉轨道的"展示进度"回归锁。
 *
 * 背景：store 在过渡提交后会**保留最后一帧**（progress=1）供 App 同批渲染使用；如果叶子组件
 * 直接把那一帧当成当前进度，就会在"下一首已武装（armed）、过渡还没开始"时把 MV 预载槽按
 * opacity=1 显示出来 —— 实测表现为"歌曲开始 1~2 秒后 MV 背景变成下一首的画面"。
 */
describe('过渡叠加层展示进度', () => {
  it('窗口归一化 + smoothstep：窗口前为 0，窗口内单调递增，90% 处到 1', () => {
    const dur = 12
    const lead = 10
    // 窗口门控：progress < 1 - lead/dur = 1-10/12 ≈ 0.167 时保持 0
    expect(transitionOverlayProgress(0, dur, lead)).toBe(0)
    expect(transitionOverlayProgress(0.1, dur, lead)).toBe(0)
    // 窗口内：从 0 平滑升到 1
    const mid = transitionOverlayProgress(0.8, dur, lead)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    // 终点（90% 切换点）到 1，且之后保持 1
    expect(transitionOverlayProgress(0.9, dur, lead)).toBe(1)
    expect(transitionOverlayProgress(1, dur, lead)).toBe(1)
    // 单调不减
    let previous = 0
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const value = transitionOverlayProgress(p, dur, lead)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
  })

  it('duration 缺失时回落到 20s 口径（不出现 NaN/越界）', () => {
    expect(transitionOverlayProgress(0, 0, 10)).toBe(0)
    expect(transitionOverlayProgress(1, 0, 10)).toBe(1)
    expect(Number.isFinite(transitionOverlayProgress(0.5, 0, 0))).toBe(true)
  })

  it('store 非活动（含提交后保留的最后一帧）时，叶子组件读到的是 0', () => {
    const store = createTransitionVisualStore()
    const { result } = renderHook(() => useTransitionOverlayProgress(store))

    // 未开始过渡：即使 store 里残留 progress=1（上一轮保帧），也必须读 0
    expect(result.current).toBe(0)

    act(() => store.begin({ fromTrackKey: 'a', toTrackKey: 'b', duration: 12, animationLeadSeconds: 10 }))
    act(() => store.publish({ progress: 0.95 }))
    expect(result.current).toBe(1)

    // 提交：end(holdFinalFrame=true) 只保留进度值，active 置 false ⇒ 叶子组件必须回到 0
    act(() => store.end(true))
    expect(store.getSnapshot().progress).toBe(1)
    expect(result.current).toBe(0)
  })

  it('未传 store 的老调用点沿用外部传入的进度值', () => {
    const { result } = renderHook(() => useTransitionOverlayProgress(null, 0.42))
    expect(result.current).toBe(0.42)
  })
})

/**
 * 歌词交叉淡化（用户诉求：前一首进入过渡就按过渡时长逐渐淡出、后一首同时逐渐淡入）。
 * 与叠加层进度不同：它覆盖**整段过渡**（不做最后 4 秒窗口门控），终点同样锚在 90% 切换帧。
 */
describe('歌词交叉淡化进度', () => {
  it('从过渡一开始就推进，在 90%（视觉切换帧）恰好到 1', () => {
    expect(transitionLyricsCrossfadeProgress(0, false)).toBe(0)
    expect(transitionLyricsCrossfadeProgress(0.1, false)).toBeGreaterThan(0)
    expect(transitionLyricsCrossfadeProgress(0.45, false)).toBeCloseTo(0.5, 5)
    expect(transitionLyricsCrossfadeProgress(0.9, false)).toBe(1)
    expect(transitionLyricsCrossfadeProgress(1, false)).toBe(1)
    // 已切换（视觉已属于目标曲）→ 直接 1，切换帧不再变化
    expect(transitionLyricsCrossfadeProgress(0.5, true)).toBe(1)
    // 单调不减 + 值域 [0,1]
    let previous = 0
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const value = transitionLyricsCrossfadeProgress(p, false)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
    // 非法输入不产生 NaN
    expect(Number.isFinite(transitionLyricsCrossfadeProgress(Number.NaN, false))).toBe(true)
  })

  it('订阅：非活动期读到 0（保帧不泄漏），活动期跟随进度', () => {
    const store = createTransitionVisualStore()
    const { result } = renderHook(() => useTransitionLyricsCrossfade(store))
    expect(result.current).toBe(0)
    act(() => store.begin({ fromTrackKey: 'a', toTrackKey: 'b', duration: 20 }))
    act(() => store.publish({ progress: 0.45 }))
    expect(result.current).toBeCloseTo(0.5, 5)
    act(() => store.markSwitched())
    expect(result.current).toBe(1)
    act(() => store.end(true))
    expect(result.current).toBe(0)
  })

  it('离散事实订阅：逐帧进度不触发宿主重渲染，只有 active/switched/trackKey 变化才更新', () => {
    const store = createTransitionVisualStore()
    const { result } = renderHook(() => useTransitionVisualIdentity(store))
    expect(result.current.active).toBe(false)
    act(() => store.begin({ fromTrackKey: 'a', toTrackKey: 'b', duration: 20 }))
    expect(result.current).toMatchObject({ active: true, switched: false, fromTrackKey: 'a', toTrackKey: 'b' })
    // 进度更新不算"事实变化"：快照字符串不变 ⇒ useSyncExternalStore 不触发重渲染
    const before = result.current
    act(() => store.publish({ progress: 0.3, targetTime: 12 }))
    expect(result.current).toBe(before)
    act(() => store.markSwitched())
    expect(result.current.switched).toBe(true)
  })
})

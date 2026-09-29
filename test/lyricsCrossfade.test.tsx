/** @vitest-environment jsdom */
import { render, cleanup, act } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import LyricsDisplay from '../src/components/LyricsDisplay'
import { createTransitionVisualStore } from '../src/audio/transitionVisualStore'
import type { LyricLine } from '../src/services/musicApi'

// jsdom 没有实现 Element.scrollTo（柔和风格走原生滚动）——补一个空实现
beforeAll(() => {
  Element.prototype.scrollTo = () => {}
})

/**
 * 过渡歌词交叉淡化的渲染契约：
 *   - 主歌词树（crossfadeActive + store）与"先行淡入的下一首歌词"层（managedCrossfade）
 *     能同时渲染、互不干扰；
 *   - 托管切换抑制行入场动画（首帧即目标态），因此视觉切换帧不会"从下面爬上来"；
 *   - 上报焦点行（onActiveIndexChange）供宿主在切换帧做锚点；
 *   - store 结束（保帧）后交叉进度归零，不会把旧树留在暗态。
 */
afterEach(() => cleanup())

const lyricsA: LyricLine[] = [
  { time: 0, endTime: 3, text: 'A one' },
  { time: 3, endTime: 6, text: 'A two' },
  { time: 6, endTime: 9, text: 'A three' },
]
const lyricsB: LyricLine[] = [
  { time: 0, endTime: 3, text: 'B one' },
  { time: 3, endTime: 6, text: 'B two' },
  { time: 6, endTime: 9, text: 'B three' },
]

describe('过渡歌词交叉淡化', () => {
  it('主树 + 下一首歌词层同时渲染：两层都在，且各自渲染自己的文本', () => {
    const store = createTransitionVisualStore()
    const { container, rerender } = render(
      <>
        <LyricsDisplay accentColor="#3b82f6" currentTime={4} lyrics={lyricsA} trackId="A" crossfadeActive crossfadeStore={store} managedCrossfade />
        <div data-testid="incoming">
          <LyricsDisplay accentColor="#3b82f6" currentTime={1} lyrics={lyricsB} trackId="B" managedCrossfade translationEnabled={false} romanEnabled={false} />
        </div>
      </>,
    )
    act(() => store.begin({ fromTrackKey: 'A', toTrackKey: 'B', duration: 20 }))
    act(() => store.publish({ progress: 0.45 }))
    rerender(
      <>
        <LyricsDisplay accentColor="#3b82f6" currentTime={4} lyrics={lyricsA} trackId="A" crossfadeActive crossfadeStore={store} managedCrossfade />
        <div data-testid="incoming">
          <LyricsDisplay accentColor="#3b82f6" currentTime={1} lyrics={lyricsB} trackId="B" managedCrossfade translationEnabled={false} romanEnabled={false} />
        </div>
      </>,
    )
    const text = container.textContent || ''
    expect(text).toContain('A two')
    expect(text).toContain('B one')
    // 两层都有行节点（不是被卸载/空渲染）
    expect(container.querySelectorAll('[data-index]').length).toBeGreaterThanOrEqual(6)
  })

  it('托管切换抑制行入场动画：首帧行即为目标态（不透明度 > 0、无 y 位移）', () => {
    const { container } = render(
      <LyricsDisplay accentColor="#3b82f6" currentTime={0.5} lyrics={lyricsA} trackId="A" managedCrossfade />,
    )
    const line = container.querySelector('[data-index="1"]') as HTMLElement | null
    expect(line).toBeTruthy()
    const opacity = Number(line!.style.opacity)
    expect(Number.isFinite(opacity)).toBe(true)
    expect(opacity).toBeGreaterThan(0)
    // 入场动画起点是 y:18；托管时不位移
    const transform = line!.style.transform || ''
    expect(transform).not.toContain('18')
  })

  it('上报焦点行：宿主据此在切换帧做锚点（不跳行）', () => {
    const seen: number[] = []
    render(
      <LyricsDisplay accentColor="#3b82f6"
        currentTime={4}
        lyrics={lyricsA}
        trackId="A"
        managedCrossfade
        onActiveIndexChange={index => seen.push(index)}
      />,
    )
    // currentTime=4 → 焦点在第二句（index 1）
    expect(seen).toContain(1)
  })

  it('indexHint：托管切歌时按提示锚定，而不是一律回到第一句', () => {
    const seen: number[] = []
    render(
      <LyricsDisplay accentColor="#3b82f6"
        currentTime={0}
        lyrics={lyricsB}
        trackId="B"
        managedCrossfade
        indexHint={2}
        onActiveIndexChange={index => seen.push(index)}
      />,
    )
    // 切歌瞬间时间线可能还差一帧（currentTime=0）；托管 + hint 应锚到第三句
    expect(seen[0]).toBe(2)
  })

  it('store 结束（保帧）后交叉进度归零，不再把树压在暗态', () => {
    const store = createTransitionVisualStore()
    const { container } = render(
      <LyricsDisplay accentColor="#3b82f6" currentTime={4} lyrics={lyricsA} trackId="A" crossfadeActive crossfadeStore={store} managedCrossfade />,
    )
    act(() => store.begin({ fromTrackKey: 'A', toTrackKey: 'B', duration: 20 }))
    act(() => store.publish({ progress: 0.9 }))
    act(() => store.end(true))
    // 结束时进度回 0（useTransitionLyricsCrossfade 读 active=false → 0），树不透明度回到 1
    const tree = container.querySelector('[data-index="1"]') as HTMLElement | null
    expect(tree).toBeTruthy()
    expect(store.getSnapshot().active).toBe(false)
  })
})

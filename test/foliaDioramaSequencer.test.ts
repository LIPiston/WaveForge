import { describe, it, expect } from 'vitest'
import {
    createSequencerState,
    activeSegment,
    appendSegment,
    updateActiveSegmentLines,
    totalGlobalLines,
    resolveGlobal,
    pruneSegments,
} from '../src/components/foliaDiorama/dioramaSequencer'
import type { Line } from '../src/components/foliaDiorama/types'

// 构造最小可用的 Line（sequencer 只关心 length + index 访问，不读字段语义）
const makeLine = (i: number): Line => ({
    words: [{ text: `w${i}`, startTime: i, endTime: i + 1 }],
    startTime: i,
    endTime: i + 1,
    fullText: `line ${i}`,
})

const makeLines = (n: number): Line[] => Array.from({ length: n }, (_, i) => makeLine(i))

const ORIGIN = { x: 0, y: 0, z: 0 }
const OFFSET = { x: 100, y: 0, z: 0 }

describe('createSequencerState', () => {
    it('初始为空，无活动段，全局索引空间为 0', () => {
        const s = createSequencerState()
        expect(s.segments).toHaveLength(0)
        expect(s.nextGlobalStart).toBe(0)
        expect(activeSegment(s)).toBeNull()
        expect(totalGlobalLines(s)).toBe(0)
    })

    it('空状态下 resolveGlobal 任意索引都返回 null', () => {
        const s = createSequencerState()
        expect(resolveGlobal(s, 0)).toBeNull()
        expect(resolveGlobal(s, -1)).toBeNull()
        expect(resolveGlobal(s, 100)).toBeNull()
    })
})

describe('appendSegment', () => {
    it('首段落在世界原点，globalStart=0，span=行数，nextGlobalStart 推进', () => {
        const s = createSequencerState()
        const seg = appendSegment(s, { seed: 'song-a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        expect(seg.key).toBe('song-a#0')
        expect(seg.seed).toBe('song-a')
        expect(seg.round).toBe(0)
        expect(seg.globalStart).toBe(0)
        expect(seg.span).toBe(3)
        expect(seg.linesEpoch).toBe(0)
        expect(seg.placementOrigin).toBe(ORIGIN)
        expect(s.segments).toHaveLength(1)
        expect(s.nextGlobalStart).toBe(3)
        expect(totalGlobalLines(s)).toBe(3)
        expect(activeSegment(s)).toBe(seg)
    })

    it('第二段 globalStart 续接前段 span，placementOrigin 独立', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        const seg2 = appendSegment(s, { seed: 'b', lines: makeLines(2), round: 0, placementOrigin: OFFSET })
        expect(seg2.globalStart).toBe(3)
        expect(seg2.span).toBe(2)
        expect(seg2.placementOrigin).toBe(OFFSET)
        expect(s.segments).toHaveLength(2)
        expect(s.nextGlobalStart).toBe(5)
        expect(activeSegment(s)).toBe(seg2)
    })

    it('空歌词段 span=1（至少占一格，无词曲目也能前进）', () => {
        const s = createSequencerState()
        const seg = appendSegment(s, { seed: 'instr', lines: [], round: 0, placementOrigin: ORIGIN })
        expect(seg.span).toBe(1)
        expect(s.nextGlobalStart).toBe(1)
        // 空歌词段的 localIndex 0 返回 null line（越界回退）
        expect(resolveGlobal(s, 0)?.line).toBeNull()
    })

    it('同 seed 不同 round 生成不同 key（循环轮次区分）', () => {
        const s = createSequencerState()
        const r0 = appendSegment(s, { seed: 'loop', lines: makeLines(2), round: 0, placementOrigin: ORIGIN })
        const r1 = appendSegment(s, { seed: 'loop', lines: makeLines(2), round: 1, placementOrigin: OFFSET })
        expect(r0.key).toBe('loop#0')
        expect(r1.key).toBe('loop#1')
        expect(s.nextGlobalStart).toBe(4)
    })
})

describe('updateActiveSegmentLines', () => {
    it('原位重建活动段：保持 globalStart 与 placementOrigin，span 增量同步到 nextGlobalStart，linesEpoch 自增', () => {
        const s = createSequencerState()
        const seg = appendSegment(s, { seed: 'late', lines: makeLines(2), round: 0, placementOrigin: OFFSET })
        const beforeNext = s.nextGlobalStart
        // 歌词晚到：从 2 行重建为 5 行
        updateActiveSegmentLines(s, makeLines(5))
        expect(seg.lines).toHaveLength(5)
        expect(seg.span).toBe(5)
        expect(seg.globalStart).toBe(0) // 不变
        expect(seg.placementOrigin).toBe(OFFSET) // 不变
        expect(seg.linesEpoch).toBe(1)
        expect(s.nextGlobalStart).toBe(beforeNext + 3) // +3 = 5-2
        expect(totalGlobalLines(s)).toBe(5)
    })

    it('歌词缩短时 nextGlobalStart 同步回退', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'x', lines: makeLines(5), round: 0, placementOrigin: ORIGIN })
        expect(s.nextGlobalStart).toBe(5)
        updateActiveSegmentLines(s, makeLines(2))
        expect(s.nextGlobalStart).toBe(2)
        expect(totalGlobalLines(s)).toBe(2)
    })

    it('空状态下调用不抛错（无活动段时 no-op）', () => {
        const s = createSequencerState()
        expect(() => updateActiveSegmentLines(s, makeLines(3))).not.toThrow()
        expect(s.segments).toHaveLength(0)
        expect(s.nextGlobalStart).toBe(0)
    })

    it('多次重建 linesEpoch 单调递增（缓存消费者据此判废）', () => {
        const s = createSequencerState()
        const seg = appendSegment(s, { seed: 'x', lines: makeLines(1), round: 0, placementOrigin: ORIGIN })
        updateActiveSegmentLines(s, makeLines(1))
        updateActiveSegmentLines(s, makeLines(1))
        expect(seg.linesEpoch).toBe(2)
    })
})

describe('resolveGlobal', () => {
    it('段内索引返回正确段 / localIndex / line', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        appendSegment(s, { seed: 'b', lines: makeLines(2), round: 0, placementOrigin: OFFSET })
        // 第一段：0,1,2
        expect(resolveGlobal(s, 0)?.segment.seed).toBe('a')
        expect(resolveGlobal(s, 0)?.localIndex).toBe(0)
        expect(resolveGlobal(s, 2)?.localIndex).toBe(2)
        expect(resolveGlobal(s, 2)?.line?.fullText).toBe('line 2')
        // 第二段：3,4
        expect(resolveGlobal(s, 3)?.segment.seed).toBe('b')
        expect(resolveGlobal(s, 3)?.localIndex).toBe(0)
        expect(resolveGlobal(s, 4)?.localIndex).toBe(1)
    })

    it('边界外索引返回 null（负数 / 越过 nextGlobalStart）', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        expect(resolveGlobal(s, -1)).toBeNull()
        expect(resolveGlobal(s, 3)).toBeNull() // span=3 → 有效索引 0..2
        expect(resolveGlobal(s, 99)).toBeNull()
    })

    it('返回的 frame 来自该段（不同段 placementOrigin 不同则 frame.position 不同）', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(1), round: 0, placementOrigin: ORIGIN })
        appendSegment(s, { seed: 'b', lines: makeLines(1), round: 0, placementOrigin: OFFSET })
        const f1 = resolveGlobal(s, 0)?.frame
        const f2 = resolveGlobal(s, 1)?.frame
        expect(f1).toBeDefined()
        expect(f2).toBeDefined()
        // 第二段 frame 平移了 OFFSET，故 position.x 必然不同
        expect(f1!.position.x).not.toBe(f2!.position.x)
    })
})

describe('pruneSegments', () => {
    it('段数 ≤1 时 no-op（活动段永不被裁）', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        pruneSegments(s, 100) // 即便 keepFrom 远超 span 也不裁
        expect(s.segments).toHaveLength(1)
    })

    it('裁掉完全在 keepFromGlobal 之前的段，保留与 keepFrom 相交的段', () => {
        const s = createSequencerState()
        // 段 A: 全局 0..2 (span=3)，段 B: 全局 3..4 (span=2)，段 C: 全局 5..7 (span=3)
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN })
        appendSegment(s, { seed: 'b', lines: makeLines(2), round: 0, placementOrigin: OFFSET })
        appendSegment(s, { seed: 'c', lines: makeLines(3), round: 0, placementOrigin: { x: 200, y: 0, z: 0 } })
        // keepFrom=3：段 A 末索引 = 2 < 3 → 裁；段 B 末索引 = 4 ≥ 3 → 留；段 C 留
        pruneSegments(s, 3)
        expect(s.segments.map(seg => seg.seed)).toEqual(['b', 'c'])
    })

    it('keepFrom 落在段中段不被裁（与窗口相交即留）', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(5), round: 0, placementOrigin: ORIGIN }) // 0..4
        appendSegment(s, { seed: 'b', lines: makeLines(5), round: 0, placementOrigin: OFFSET }) // 5..9
        // keepFrom=2：段 A 末索引 = 4 ≥ 2 → 留
        pruneSegments(s, 2)
        expect(s.segments.map(seg => seg.seed)).toEqual(['a', 'b'])
    })

    it('活动段（最末段）即便完全在 keepFrom 之前也不被裁（≤1 早退兜底 + filter 仅在 >1 时生效）', () => {
        const s = createSequencerState()
        appendSegment(s, { seed: 'a', lines: makeLines(3), round: 0, placementOrigin: ORIGIN }) // 0..2
        // 只剩这一一段，filter 不执行
        pruneSegments(s, 100)
        expect(s.segments).toHaveLength(1)
    })
})

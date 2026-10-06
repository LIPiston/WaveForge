import { describe, expect, it } from 'vitest'
import { activeLyricLine, formatMvSyncSnapshot, type MvSyncSnapshot } from '../src/services/mvSyncDiagnostics'
import type { LyricLine } from '../src/services/musicApi'

function snapshot(overrides: Partial<MvSyncSnapshot> = {}): MvSyncSnapshot {
  return {
    songKey: 'qq:330436570',
    songTitle: 'Dead Inside',
    bvid: 'BV11G4y1m7Gc',
    videoTitle: 'Dead Inside-АДЛИН【无损音质MV】',
    candidateType: 'other',
    ccVerification: 'unverified',
    alignment: { offsetSeconds: 1.5, confidence: 0.55, method: 'envelope' },
    aligned: true,
    audioSeconds: 24.93,
    videoSeconds: 26.43,
    effectiveOffset: 1.5,
    lyricLine: { time: 24.5, text: 'Сижу среди четырёх стен' },
    corrections: 0,
    slot: 'A',
    ...overrides,
  }
}

describe('formatMvSyncSnapshot', () => {
  it('已对齐：一行说全 映射/漂移/歌词行', () => {
    const line = formatMvSyncSnapshot('跟踪开始', snapshot())
    expect(line).toContain('跟踪开始 song=qq:330436570 "Dead Inside"')
    expect(line).toContain('候选=other/unverified')
    expect(line).toContain('bvid=BV11G4y1m7Gc')
    expect(line).toContain('对齐=offset=1.5s conf=0.55 method=envelope')
    expect(line).toContain('audio=24.93s video=26.43s')
    expect(line).toContain('漂移=+0.00s')
    expect(line).toContain('歌词行="Сижу среди четырёх стен"@24.5s')
    expect(line).toContain('校正=0')
    expect(line.length).toBeLessThan(400) // automixLog 单条截断 400 字符
  })

  it('无对齐：明确标注自由播放，漂移按 offset=0 计算', () => {
    const line = formatMvSyncSnapshot('心跳', snapshot({
      alignment: null,
      aligned: false,
      effectiveOffset: 0,
      videoSeconds: 24.93,
    }))
    expect(line).toContain('对齐=无 → 自由播放')
    expect(line).toContain('漂移=+0.00s')
  })

  it('有缓存但置信不足：写明数值与自由播放结论', () => {
    const line = formatMvSyncSnapshot('跟踪开始', snapshot({
      alignment: { offsetSeconds: 12.16, confidence: 0.3, method: 'beat' },
      aligned: false,
      effectiveOffset: 0,
      videoSeconds: 30,
    }))
    expect(line).toContain('对齐=有缓存但置信不足(0.30/beat) → 自由播放')
    expect(line).toContain('漂移=+5.07s')
  })

  it('负漂移带符号；超长标题/歌词截断', () => {
    const longTitle = 'X'.repeat(60)
    const line = formatMvSyncSnapshot('心跳', snapshot({
      songTitle: longTitle,
      videoTitle: longTitle,
      lyricLine: { time: 1, text: 'Y'.repeat(40) },
      videoSeconds: 20,
    }))
    expect(line).toContain(`"${'X'.repeat(30)}…"`)
    expect(line).toContain(`"${'Y'.repeat(24)}…"`)
    expect(line).toMatch(/漂移=-6\.43s/)
  })

  it('缺省字段（无视频/无槽/无候选）不抛错', () => {
    const line = formatMvSyncSnapshot('跟踪开始', snapshot({
      bvid: '',
      videoTitle: undefined,
      candidateType: undefined,
      ccVerification: undefined,
      lyricLine: null,
      slot: null,
    }))
    expect(line).toContain('槽=- 候选=- bvid=空')
    expect(line).not.toContain('歌词行=')
  })
})

describe('activeLyricLine', () => {
  const lyrics: LyricLine[] = [
    { time: 0, text: '' }, // 元数据/空行跳过
    { time: 3.9, text: 'Первая строка' },
    { time: 8.1, text: 'Вторая строка' },
    { time: 12.4, text: 'Третья строка' },
  ]

  it('取时间 ≤ 位置的最后一行非空行', () => {
    expect(activeLyricLine(lyrics, 5)).toEqual({ time: 3.9, text: 'Первая строка' })
    expect(activeLyricLine(lyrics, 12.4)).toEqual({ time: 12.4, text: 'Третья строка' })
    expect(activeLyricLine(lyrics, 999)).toEqual({ time: 12.4, text: 'Третья строка' })
  })

  it('首行之前 / 无歌词 / 非法位置 → null', () => {
    expect(activeLyricLine(lyrics, 1)).toBeNull()
    expect(activeLyricLine([], 10)).toBeNull()
    expect(activeLyricLine(lyrics, Number.NaN)).toBeNull()
  })
})

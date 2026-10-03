/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { parseAMLLTTMLLyrics, parseYrc } from '../src/services/musicApi'

// 结构取自 ME! 的真实 AMLL TTML（ncm 1382781549）：主句末尾挂 x-bg 和声，
// 段落 end 延伸到和声结束——真机据此让主句唱完后保持全亮、和声以小字逐词点亮。
const AMLL_FIXTURE = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en">
  <body><div>
    <p begin="8.738" end="13.638" ttm:agent="v1">
      <span begin="8.738" end="9.886">And you&apos;re the kind of guy the </span><span begin="10.191" end="10.760">ladies</span> <span begin="10.863" end="11.264">want</span>
      <span ttm:role="x-translation" xml:lang="zh-CN">而你很招女士们喜欢</span>
      <span ttm:role="x-bg" begin="11.357" end="13.638">
        <span begin="11.357" end="11.458">(And</span> <span begin="11.510" end="12.392">cool</span> <span begin="13.148" end="13.638">there)</span>
        <span ttm:role="x-translation" xml:lang="zh-CN">外面很多美女对你虎视眈眈</span>
      </span>
    </p>
  </div></body>
</tt>`

describe('AMLL TTML 背景和声（网易云/QQ 歌词主路径）', () => {
  it('x-bg 随主行下发：时间窗、相对词时间、去括号、和声翻译', () => {
    const lines = parseAMLLTTMLLyrics(AMLL_FIXTURE)
    expect(lines).toHaveLength(1)
    const line = lines[0]
    expect(line.text).toBe('And you\'re the kind of guy the ladies want')
    expect(line.translation).toBe('而你很招女士们喜欢')

    expect(line.backgroundVocals).toHaveLength(1)
    const bg = line.backgroundVocals![0]
    // 绝对时间窗（秒）：以 x-bg 自己的 begin/end 为准，而不是主行起点
    expect(bg.time).toBeCloseTo(11.357, 3)
    expect(bg.endTime).toBeCloseTo(13.638, 3)
    // 词文本去掉打轴包裹括号，词时间为相对和声起点的毫秒
    expect(bg.words.map(word => word.word)).toEqual(['And', 'cool', 'there'])
    expect(bg.words[0].startTime).toBeCloseTo(0, 3)
    expect(bg.words[2].startTime).toBeCloseTo(1791, 0)
    // 和声自己的翻译（真机在和声行下方显示）
    expect(bg.translation).toBe('外面很多美女对你虎视眈眈')
  })
})

describe('YRC 背景和声行（QQ/网易云括号惯例）', () => {
  it('整行括号包裹的和声不再作为独立行，挂到上一主行的 backgroundVocals', () => {
    const yrc = [
      '[8738,2526](8738,180,0)And (8918,180,0)want',
      '[11357,2281](11357,101,0)(And (11458,400,0)cool (11858,535,0)there)',
    ].join('\n')
    const lines = parseYrc(yrc)
    // 和声行被归并：只剩一条主行
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('And want')
    expect(lines[0].backgroundVocals).toHaveLength(1)
    const bg = lines[0].backgroundVocals![0]
    expect(bg.time).toBeCloseTo(11.357, 3)
    expect(bg.endTime).toBeCloseTo(13.638, 3)
    expect(bg.text).toBe('And cool there')
    expect(bg.words.map(word => word.word)).toEqual(['And', 'cool', 'there'])
  })

  it('非括号行不受影响', () => {
    const yrc = [
      '[8738,2526](8738,180,0)And (8918,180,0)want',
      '[14004,2405](14004,97,0)I (14172,166,0)know',
    ].join('\n')
    const lines = parseYrc(yrc)
    expect(lines).toHaveLength(2)
    expect(lines.every(line => !line.backgroundVocals)).toBe(true)
  })
})

/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * MV 背景同步诊断（日志 tag：[renderer:MvSync]）的纯格式化函数。
 *
 * 背景：「MV 背景歌词快/慢一句」类反馈（实测 5АМ、Dead Inside）只有零散事件日志
 * （匹配完成/seek跟随），缺一条能把「歌曲 ↔ 视频 ↔ 对齐 ↔ 歌词行」在同一时刻的
 * 对应关系说全的行。这里把诊断行做成纯函数便于单测，组件侧（BilibiliMvBackground
 * 的同步循环）只负责采样与节流。
 *
 * 日志读取：automix-backend.log 里 grep `MvSync`：
 * - 跟踪开始：(歌曲, 视频, 对齐态) 任一变化时一行 —— 含完整映射声明；
 * - 心跳：播放中每 10s 一行 —— audio/video 位置、漂移、当前歌词行、校正次数。
 *
 * 判读「背景快了/慢了」：
 * - 漂移 = 视频位置 − (音频位置 + 生效偏移)。漂移 ≈ 0 而用户仍看到错位 →
 *   视频内嵌字幕自身的时间轴与该视频音频不符（上传者制作问题，系统无法修）；
 * - 漂移大 → 同步链路问题（看生效偏移、method、置信度定位到具体环节）；
 * - 对齐=无/置信不足 → 本来就自由播放，背景内嵌歌词与歌曲时间轴无关。
 */

import type { LyricLine } from './musicApi'

export interface MvSyncSnapshot {
  songKey: string
  songTitle: string
  /** 当前活跃槽视频 bvid；空串 = 无视频 */
  bvid: string
  videoTitle?: string
  candidateType?: string
  ccVerification?: string
  /** 对齐缓存结果（无缓存或被闸门拒绝时为 null） */
  alignment: { offsetSeconds: number; confidence: number; method: string } | null
  /** 对齐是否达到应用门槛（< MIN_ALIGNMENT_CONFIDENCE 一律自由播放） */
  aligned: boolean
  audioSeconds: number
  videoSeconds: number
  /** 当前生效偏移（aligned 时 = alignment.offsetSeconds，否则 0） */
  effectiveOffset: number
  /** 音频位置所在的歌词行（无歌词/首行前为 null） */
  lyricLine: { time: number; text: string } | null
  /** 本次跟踪期内的 seek 校正次数 */
  corrections: number
  slot: 'A' | 'B' | null
}

function quote(text: string | undefined, max: number): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return '空'
  return clean.length > max ? `"${clean.slice(0, max)}…"` : `"${clean}"`
}

/**
 * 诊断行（跟踪开始 / 心跳共用格式，字段顺序固定便于 grep 与 diff）：
 * 跟踪开始 song=… "标题" 视频="…" 槽=A 候选=other/unverified 对齐=offset=1.5s conf=0.55 method=envelope audio=24.93s video=26.43s 漂移=+0.00s 歌词行="…"@24.5s 校正=0
 */
export function formatMvSyncSnapshot(prefix: '跟踪开始' | '心跳', s: MvSyncSnapshot): string {
  const align = s.alignment && s.aligned
    ? `offset=${s.alignment.offsetSeconds}s conf=${s.alignment.confidence.toFixed(2)} method=${s.alignment.method}`
    : s.alignment
      ? `有缓存但置信不足(${s.alignment.confidence.toFixed(2)}/${s.alignment.method}) → 自由播放`
      : '无 → 自由播放'
  const drift = s.videoSeconds - (s.audioSeconds + s.effectiveOffset)
  const owner = [s.candidateType, s.ccVerification].filter(Boolean).join('/') || '-'
  const lyric = s.lyricLine ? ` 歌词行=${quote(s.lyricLine.text, 24)}@${s.lyricLine.time.toFixed(1)}s` : ''
  return `${prefix} song=${s.songKey} ${quote(s.songTitle, 30)} 视频=${quote(s.videoTitle || s.bvid, 34)}` +
    ` 槽=${s.slot ?? '-'} 候选=${owner} bvid=${s.bvid || '空'} 对齐=${align}` +
    ` audio=${s.audioSeconds.toFixed(2)}s video=${s.videoSeconds.toFixed(2)}s` +
    ` 漂移=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s${lyric} 校正=${s.corrections}`
}

/** 音频位置所在的歌词行：时间 ≤ 位置的最后一行非空行；无歌词/首行前返回 null */
export function activeLyricLine(lyrics: LyricLine[], positionSeconds: number): { time: number; text: string } | null {
  if (!Array.isArray(lyrics) || lyrics.length === 0) return null
  if (!Number.isFinite(positionSeconds)) return null
  let best: { time: number; text: string } | null = null
  for (const line of lyrics) {
    if (!line || typeof line.time !== 'number' || !Number.isFinite(line.time)) continue
    if (line.time > positionSeconds) continue
    const text = String(line.text || '').trim()
    if (!text) continue
    best = { time: line.time, text }
  }
  return best
}

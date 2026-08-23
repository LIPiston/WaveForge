/**
 * MV 背景 ↔ 歌曲「对齐」服务
 *
 * MV 背景是静音循环视频，画面时间要映射到歌曲音频时间轴上。不同 MV 的起点不同：
 * 有的开口即唱（offset≈0），有的带前摇/前奏（offset 为几秒到几十秒），现场版/翻唱
 * 则根本对不上。盲目用「音频位置 % 视频时长」做同步（旧逻辑）会对不上的视频反复
 * seek → 每次 seek 触发重缓冲 → 形成「放着放着卡一下」的死循环。
 *
 * 本服务为每个 (歌曲, MV) 计算一个带置信度的偏移量：
 * - 字幕对齐（快/准）：MV 的 B 站 CC 字幕行时间 ↔ 本地歌词行时间做文本匹配，取偏移中位数
 * - 节拍对齐（通用/慢）：Python beat 服务分析 MV 音频轨的节拍点，与歌曲节拍点做互相关峰值
 * - 置信度不足（现场版/翻唱/完全对不上）→ 返回 null，调用方"不操作"（自由循环播放）
 *
 * 结果按 (songKey, bvid) 持久化（localStorage），同一对只算一次。
 */

import type { LyricLine } from './musicApi'
import {
  getBilibiliSubtitles,
  getBilibiliSubtitleJson,
  pickBestSubtitle,
  cleanSubtitleLines,
  getBilibiliWatchSettings,
  type BilibiliSubtitleLine,
} from './bilibiliApi'
import { autoMixAnalysisService } from './autoMixAnalysisService'

export interface MvAlignment {
  /** MV 视频时间 - 歌曲音频时间的偏移（秒）：歌曲位置 s 对应视频位置 s + offsetSeconds */
  offsetSeconds: number
  /** 0-1 置信度 */
  confidence: number
  method: 'subtitle' | 'beat'
}

/** 低于该置信度视为不可靠，调用方应自由播放、不做对齐校正 */
export const MIN_ALIGNMENT_CONFIDENCE = 0.5
/** 偏移量合理性上限：前摇超过 45s 基本是货不对板（别的现场/剪辑），不冒险对齐 */
const MAX_SANE_OFFSET_SECONDS = 45

const STORAGE_KEY = 'waveforge:mv-alignments'
const CACHE_MAX = 200
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

interface CachedEntry extends MvAlignment {
  ts: number
}

const memoryCache = new Map<string, MvAlignment>()
const inFlight = new Map<string, Promise<MvAlignment | null>>()

function loadPersisted(): Map<string, MvAlignment> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as Record<string, CachedEntry>
    const now = Date.now()
    const map = new Map<string, MvAlignment>()
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.offsetSeconds === 'number' && now - entry.ts < CACHE_TTL_MS) {
        map.set(key, { offsetSeconds: entry.offsetSeconds, confidence: entry.confidence, method: entry.method })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

function persist(): void {
  try {
    const now = Date.now()
    const all: Record<string, CachedEntry> = {}
    const entries = [...memoryCache.entries()]
    // 只保留最新 CACHE_MAX 条（Map 插入序 = 时间序）
    for (const [key, value] of entries.slice(-CACHE_MAX)) {
      all[key] = { ...value, ts: now }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // 存储失败（隐私模式等）静默
  }
}

/** 同步读取：内存缓存（已持久化的惰性加载一次） */
export function getMvAlignment(songKey: string, bvid: string): MvAlignment | null {
  if (!bvid) return null
  const key = `${songKey}|${bvid}`
  if (memoryCache.size === 0 && localStorage) {
    for (const [k, v] of loadPersisted()) memoryCache.set(k, v)
  }
  return memoryCache.get(key) || null
}

export interface MvAlignmentInput {
  songKey: string
  songTitle: string
  songArtists: string[]
  songDuration: number
  /** 歌曲音频 URL（节拍对齐需要；blob/空则不跑节拍路径） */
  songUrl?: string
  /** 本地歌词（字幕对齐需要；无歌词则跳过字幕路径） */
  lyrics?: LyricLine[]
  bvid: string
  cid: number
  /** MV DASH 音频流 URL（节拍对齐需要） */
  videoUrl?: string
  /** B 站 playurl 的 cacheKey（音频流同源生成用） */
  cacheKey?: string
  signal?: AbortSignal
}

/** 计算并对齐缓存；已缓存/在途时直接返回。失败或置信度不足返回 null。 */
export async function ensureMvAlignment(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  const { songKey, bvid } = input
  if (!songKey || !bvid || bvid.startsWith('fallback-')) return null
  const key = `${songKey}|${bvid}`
  const cached = getMvAlignment(songKey, bvid)
  if (cached) return cached
  if (inFlight.has(key)) return inFlight.get(key)!
  const promise = detectAlignment(input, signal)
  inFlight.set(key, promise)
  try {
    const result = await promise
    if (result && result.confidence >= MIN_ALIGNMENT_CONFIDENCE) {
      memoryCache.set(key, result)
      persist()
      return result
    }
    return null
  } finally {
    inFlight.delete(key)
  }
}

async function detectAlignment(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  // 1. 字幕对齐（快）：本地歌词 + MV CC 字幕文本匹配
  if (input.lyrics && input.lyrics.length > 0) {
    const subResult = await detectViaSubtitles(input, signal)
    if (subResult) return subResult
  }
  // 2. 节拍对齐（通用）：Python beat 服务分析 MV 音频轨 ↔ 歌曲节拍互相关
  return detectViaBeats(input, signal)
}

// ===== 字幕对齐 =====

function normalizeText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s·•\-–—()（）\[\]【】「」『』<>《》"'`,.，。！？!?&/|:：~～♪♫…]+/g, '')
    .replace(/[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+/g, (m) => m.replace(/[āáǎà]/g, 'a').replace(/[ēéěè]/g, 'e').replace(/[īíǐì]/g, 'i').replace(/[ōóǒò]/g, 'o').replace(/[ūúǔù]/g, 'u').replace(/[ǖǘǚǜ]/g, 'ü'))
}

/** 字幕行时间 ↔ 本地歌词行时间文本匹配，取偏移中位数；匹配数或离散度过低返回 null */
export function detectOffsetFromSubtitles(
  songLyrics: LyricLine[],
  subLines: BilibiliSubtitleLine[],
): MvAlignment | null {
  if (!songLyrics.length || !subLines.length) return null
  const lyricEntries = songLyrics
    .filter((l) => l.text && l.text.trim())
    .map((l) => ({ timeSeconds: l.time / 1000, norm: normalizeText(l.text) }))
    .filter((e) => e.norm.length >= 2)
  if (lyricEntries.length < 3) return null

  const lyricByNorm = new Map<string, number>()
  for (const e of lyricEntries) {
    // 同词多行（副歌重复）取第一次出现；后续匹配按时间就近
    if (!lyricByNorm.has(e.norm)) lyricByNorm.set(e.norm, e.timeSeconds)
  }

  const offsets: number[] = []
  for (const sub of subLines) {
    const norm = normalizeText(sub.content)
    if (norm.length < 2) continue
    const lyricTime = lyricByNorm.get(norm)
    if (lyricTime === undefined) continue
    const offset = sub.from - lyricTime
    // 剔除明显越界的匹配（字幕与歌词行整体偏移应在合理前摇范围内）
    if (Math.abs(offset) > MAX_SANE_OFFSET_SECONDS) continue
    offsets.push(offset)
  }
  if (offsets.length < 3) return null

  const sorted = [...offsets].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  // 离散度：|中位数偏移与四分位距|（对少量异常匹配鲁棒）
  const q1 = sorted[Math.floor(sorted.length / 4)]
  const q3 = sorted[Math.floor((3 * sorted.length) / 4)]
  const spread = q3 - q1
  if (spread > 3) return null

  const confidence = Math.max(0, Math.min(1, 0.35 + 0.1 * offsets.length - 0.06 * spread))
  return { offsetSeconds: median, confidence, method: 'subtitle' }
}

async function detectViaSubtitles(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  try {
    const info = await getBilibiliSubtitles(input.bvid, input.cid, signal)
    if (info.code !== 0 || !info.subtitles.length) return null
    const pref = getBilibiliWatchSettings().subtitlePreference
    const chosen = pickBestSubtitle(info.subtitles, pref) || info.subtitles[0] || null
    if (!chosen) return null
    const lines = await getBilibiliSubtitleJson(chosen.cacheKey, signal)
    const clean = cleanSubtitleLines(lines)
    return detectOffsetFromSubtitles(input.lyrics || [], clean)
  } catch {
    return null
  }
}

// ===== 节拍对齐 =====

/**
 * 歌曲节拍序列 ↔ MV 节拍序列互相关求偏移。
 * 逐对计算 δ = mvBeat - songBeat 的直方图（0.25s 桶）定位峰值偏移，再在峰值桶中心
 * ±0.25s 内 0.02s 步进精化，对取得最大匹配数的偏移取平均（均匀节拍网格的 ±半拍
 * 歧义取中心即精确偏移）。
 * 判定（宽容度）：真对齐时「匹配率」（MV 节拍能在容差内命中歌曲节拍的比例）高，
 * 且命中对的「节拍下标差」恒定；现场变速/翻唱 → 匹配率低或下标差漂移；随机 → 下标差
 * 杂乱。二者因任一不足被拒绝（返回 null → 调用方不操作、自由播放）。
 */
export function detectOffsetFromBeats(songBeats: number[], mvBeats: number[]): MvAlignment | null {
  const S = [...songBeats.filter((t) => Number.isFinite(t))].sort((a, b) => a - b)
  const M = mvBeats.filter((t) => Number.isFinite(t))
  if (S.length < 10 || M.length < 10) return null

  const BUCKET = 0.25
  const hist = new Map<number, number>()
  for (const m of M) {
    for (const s of S) {
      const delta = m - s
      if (Math.abs(delta) > MAX_SANE_OFFSET_SECONDS) continue
      const bucket = Math.round(delta / BUCKET)
      hist.set(bucket, (hist.get(bucket) || 0) + 1)
    }
  }
  if (hist.size === 0) return null
  let peakBucket = 0
  let peakCount = 0
  for (const [bucket, count] of hist) {
    if (count > peakCount) {
      peakCount = count
      peakBucket = bucket
    }
  }
  const peakCenter = peakBucket * BUCKET

  // 精化：峰值桶中心 ±0.25s、0.02s 步进，统计容差 0.15s 内的匹配对；
  // 对取得最大匹配数的偏移取平均（半拍歧义取中心即精确偏移）
  const TOL = 0.15
  let bestMatches = 0
  let bestSum = 0
  let bestCount = 0
  for (let d = -0.25; d <= 0.25 + 1e-9; d += 0.02) {
    const offset = peakCenter + d
    let matches = 0
    for (const m of M) {
      if (nearestIndex(S, m - offset, TOL) >= 0) matches += 1
    }
    if (matches > bestMatches) {
      bestMatches = matches
      bestSum = offset
      bestCount = 1
    } else if (matches === bestMatches && bestMatches > 0) {
      bestSum += offset
      bestCount += 1
    }
  }
  if (bestMatches === 0) return null
  const bestOffset = bestSum / bestCount
  if (Math.abs(bestOffset) > MAX_SANE_OFFSET_SECONDS) return null

  const minLen = Math.min(S.length, M.length)
  const matchRatio = bestMatches / minLen
  if (matchRatio < 0.5) return null

  // 节拍下标差一致性：真对齐时每个命中对的 (歌曲下标 - MV下标) 恒定（±2 内）。
  // 随机命中 → 下标差杂乱；现场变速 → 随时间漂移。此判别把"随机撞上"与真对齐分开。
  const indexDiffs: number[] = []
  for (let i = 0; i < M.length; i++) {
    const j = nearestIndex(S, M[i] - bestOffset, TOL)
    if (j >= 0) indexDiffs.push(j - i)
  }
  if (indexDiffs.length < Math.max(5, minLen * 0.4)) return null
  const diffCounts = new Map<number, number>()
  for (const d of indexDiffs) diffCounts.set(d, (diffCounts.get(d) || 0) + 1)
  let mode = 0
  let modeCount = 0
  for (const [d, c] of diffCounts) {
    if (c > modeCount) {
      modeCount = c
      mode = d
    }
  }
  const consistent = indexDiffs.filter((d) => Math.abs(d - mode) <= 2).length / indexDiffs.length
  if (consistent < 0.6) return null

  const confidence = Math.max(0, Math.min(1, 0.3 + matchRatio * 0.6 + consistent * 0.3))
  return { offsetSeconds: Math.round(bestOffset * 100) / 100, confidence, method: 'beat' }
}

/** 在升序数组里二分找距 target 最近的元素下标；|差值| > tol 返回 -1 */
function nearestIndex(sortedAsc: number[], target: number, tol: number): number {
  let lo = 0
  let hi = sortedAsc.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedAsc[mid] < target) lo = mid + 1
    else hi = mid
  }
  let best = lo
  if (lo > 0 && Math.abs(sortedAsc[lo - 1] - target) < Math.abs(sortedAsc[lo] - target)) best = lo - 1
  return Math.abs(sortedAsc[best] - target) <= tol ? best : -1
}

async function detectViaBeats(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  const songUrl = input.songUrl || ''
  const videoUrl = input.videoUrl || ''
  if (!songUrl.startsWith('http') || !videoUrl.startsWith('http')) return null

  try {
    // 1. 歌曲节拍：用歌曲自己的 trackKey（与 automix 同一 key → 命中已缓存分析免重算）
    const songAnalysis = await autoMixAnalysisService.analyze({
      trackKey: input.songKey,
      url: songUrl,
      duration: input.songDuration,
      signal,
    })
    const songBeats = songAnalysis?.beats || null
    if (!songBeats || songBeats.length < 10) return null

    // 2. MV 音频轨节拍：走 analyze 全链路（Python → Electron worker → 浏览器
    //    decodeAudioData，最后者原生支持 m4a/aac——B站 DASH 音频轨是 m4s/aac，
    //    Python/librosa 打不开，必须靠浏览器解码兜底）
    const mvAnalysis = await autoMixAnalysisService.analyze({
      trackKey: `mv-align-video:${input.songKey}:${input.bvid}`,
      url: videoUrl,
      duration: input.songDuration,
      signal,
    })
    const mvBeats = mvAnalysis?.beats || null
    if (!mvBeats || mvBeats.length < 10) return null

    return detectOffsetFromBeats(songBeats, mvBeats)
  } catch {
    return null
  }
}

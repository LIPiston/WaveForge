/**
 * 哔哩哔哩「MV 背景」层（ECHO NEXT 风格）
 *
 * 作为歌词页/播放页的背景层：匹配当前歌曲的 B 站视频，静音循环播放，
 * 画面时间跟随本地音频时钟（偏差超阈值才 seek 校正一次），歌曲音频始终由本地引擎播放。
 * - auto → 直接播放（高置信）
 * - confirm → 底部轻量候选条（点选即播放并记忆）
 * - none/error → 保持透明，短暂提示
 * - 播放失败 → 沿 fallbackChain 自动尝试下一候选
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, Clock, Eye } from 'lucide-react'
import {
  findBestBilibiliMv,
  getBilibiliView,
  getBilibiliPlayUrl,
  bilibiliStreamUrl,
  pickBestPage,
  songKeyOf,
  setBilibiliOverride,
  getBilibiliOverride,
  clearBilibiliOverride,
  getBilibiliWatchSettings,
  resolveBiliPic,
  formatBiliTime,
  type MatchContext,
  type CandidateScore,
  type CandidateType,
} from '../services/bilibiliApi'
import { computeMvSyncTarget, shouldSeekMvVideo } from '../services/mvBackground'

type MvBackgroundStatus = 'idle' | 'searching' | 'loading' | 'playing' | 'confirm' | 'none' | 'error'

/** 即将播放的歌曲（预加载评分高的视频，与看歌模式同一数据源） */
export interface MvBackgroundUpcomingSong {
  songTitle: string
  songArtists: string[]
  songDuration: number
  platform?: string
  id?: string | number
}

interface BilibiliMvBackgroundProps {
  songTitle: string
  songArtists: string[]
  /** 歌曲时长（秒） */
  songDuration: number
  platform?: string
  songId?: string | number
  isPlaying: boolean
  getAudioElement: () => HTMLAudioElement | null
  playerTheme?: 'light' | 'dark'
  /** 即将播放的歌曲：提前匹配 MV 填充缓存（切到该歌时秒播） */
  upcomingSongs?: MvBackgroundUpcomingSong[]
  /**
   * 未找到 MV / 播放失败时的回退回调：true = 请外部切回普通封面背景。
   * 组件进入死胡同（none/error/候选条被关闭）时上报 true；恢复播放时上报 false。
   */
  onFallbackChange?: (fallback: boolean) => void
  /**
   * 已加载视频上报：切到看歌时复用同一视频流，避免重新搜索/拉流卡顿。
   * 加载成功上报 {bvid, cid, videoUrl, cacheKey, currentTime}；失败/死胡同/卸载时上报 null。
   */
  onPlayStateChange?: (state: { bvid: string; cid: number; videoUrl: string; cacheKey: string; currentTime: number } | null) => void
  /**
   * 开关关闭时不清空已缓冲的视频（display:none 隐藏 + 暂停），重开秒播不重新加载。
   * 默认 true；置 false 只隐藏，搜索/加载照常，恢复后立即续播。
   */
  enabled?: boolean
  /** 视频背景模糊度（px，独立于封面背景的模糊设置；默认 0 = 视频清晰显示） */
  blur?: number
}

/** 上报给外部的播放状态（用于看歌无缝接管） */
export interface MvBackgroundPlayState {
  bvid: string
  cid: number
  videoUrl: string
  /** 播放接口的 cacheKey：看歌据此直接生成音频流 URL，跳过重新请求播放地址 */
  cacheKey: string
  currentTime: number
}

const TYPE_BADGES: Record<CandidateType, { label: string; color: string }> = {
  official: { label: '官方', color: '#FB7299' },
  live: { label: '现场', color: '#4C8DFF' },
  cover: { label: '翻唱', color: '#F5A623' },
  instrumental: { label: '演奏', color: '#8B7CF6' },
  lyrics: { label: '字幕', color: '#52C41A' },
  other: { label: '其他', color: '#8A8F99' },
}

function formatPlayCount(play: number): string {
  if (play >= 100000000) return `${(play / 100000000).toFixed(1)}亿`
  if (play >= 10000) return `${(play / 10000).toFixed(1)}万`
  return String(play || 0)
}

export default function BilibiliMvBackground({
  songTitle,
  songArtists,
  songDuration,
  platform,
  songId,
  isPlaying,
  getAudioElement,
  playerTheme = 'dark',
  upcomingSongs = [],
  onFallbackChange,
  onPlayStateChange,
  enabled = true,
  blur = 0,
}: BilibiliMvBackgroundProps) {
  const slotARef = useRef<HTMLVideoElement>(null)
  const slotBRef = useRef<HTMLVideoElement>(null)
  const searchControllerRef = useRef<AbortController | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const fallbackChainRef = useRef<CandidateScore[]>([])
  // 看歌无缝接管：最新播放状态经 ref 上报（含实时进度）
  const onPlayStateChangeRef = useRef(onPlayStateChange)
  onPlayStateChangeRef.current = onPlayStateChange
  const lastPlayStateRef = useRef<{ bvid: string; cid: number; videoUrl: string; cacheKey: string } | null>(null)
  const failedBvidsRef = useRef<Set<string>>(new Set())
  // getAudioElement 每次渲染都是新函数，同步循环里经 ref 读取避免 effect 反复重建
  const getAudioRef = useRef(getAudioElement)
  getAudioRef.current = getAudioElement
  // 歌曲元数据经 ref 读取：App 每次渲染 songArtists 都是新数组引用，
  // 若进 effect 依赖会导致搜索/加载每帧重跑、video 反复卸载重建（闪烁）。仅 songKey 变化才重新匹配。
  const songRef = useRef({ songTitle, songArtists, songDuration, platform, songId })
  songRef.current = { songTitle, songArtists, songDuration, platform, songId }

  const [status, setStatus] = useState<MvBackgroundStatus>('idle')
  // MV 从未启用过就不搜索（避免开关关闭时每首歌白调 B 站接口）；启用过则保持视频缓冲待用
  const wasEnabledRef = useRef(enabled)
  wasEnabledRef.current = wasEnabledRef.current || enabled
  const searchedSongKeyRef = useRef('')
  // A/B 双视频槽位：切歌时旧视频继续播放，新视频在另一槽位缓冲好后交叉淡入（封面式过渡，无黑屏）
  const [slotAUrl, setSlotAUrl] = useState<string | null>(null)
  const [slotBUrl, setSlotBUrl] = useState<string | null>(null)
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const activeSlotRef = useRef<'A' | 'B'>('A')
  // 已放入但未淡入的槽位（等待 canplay）；淡出中的槽位（过渡期间不参与同步，避免被 seek 到新歌位置跳变）
  const stagedSlotRef = useRef<'A' | 'B' | null>(null)
  const fadingOutSlotRef = useRef<'A' | 'B' | null>(null)
  const crossfadeTimerRef = useRef<number | null>(null)
  const [candidates, setCandidates] = useState<CandidateScore[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  const [notice, setNotice] = useState('')

  const songKey = songKeyOf({ songTitle, artists: songArtists, songDuration, platform, id: songId })

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 4000)
  }, [])

  const slotUrl = (slot: 'A' | 'B') => (slot === 'A' ? slotAUrl : slotBUrl)
  const slotOpacity = (slot: 'A' | 'B') => (slot === activeSlot ? 1 : 0)
  const slotEl = (slot: 'A' | 'B') => (slot === 'A' ? slotARef.current : slotBRef.current)
  const activeEl = () => slotEl(activeSlotRef.current)
  const otherSlot = (slot: 'A' | 'B') => (slot === 'A' ? 'B' : 'A')

  const loadVideo = useCallback(
    (candidate: CandidateScore, chainIndex = 0) => {
      const controller = new AbortController()
      searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      setStatus('loading')
      const { songTitle: st, songArtists: sa, songDuration: sd } = songRef.current

      void (async () => {
        try {
          let cid = candidate.cid || 0
          if (!cid) {
            const view = await getBilibiliView(candidate.video.bvid, controller.signal)
            if (view.code !== 0) throw new Error(view.code === -404 ? '视频已失效或删除' : '获取视频信息失败')
            // 多 P（选集）视频：挑选最匹配歌曲的分 P（on vocal/歌名命中优先）
            if (Array.isArray(view.data.pages) && view.data.pages.length > 1) {
              const bestIndex = pickBestPage(view.data.pages, { songTitle: st, artists: sa })
              const chosen = view.data.pages[bestIndex]
              if (chosen?.cid) cid = chosen.cid
            }
            if (!cid) cid = view.data.cid
          }
          const settings = getBilibiliWatchSettings()
          const qn = settings.targetQuality === 'auto' ? 127 : settings.targetQuality
          const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, qn, controller.signal)
          if (playInfo.code === -404) throw new Error('视频已失效或删除')
          if (playInfo.code !== 0 || !playInfo.cacheKey) throw new Error(playInfo.error || '获取播放地址失败')
          const newVideoUrl = bilibiliStreamUrl(playInfo.cacheKey, 'video')
          lastPlayStateRef.current = { bvid: candidate.video.bvid, cid, videoUrl: newVideoUrl, cacheKey: playInfo.cacheKey }
          const currentActiveEl = activeEl()
          const currentActiveUrl = currentActiveEl?.currentSrc || currentActiveEl?.src || null
          if (!currentActiveUrl || currentActiveUrl === newVideoUrl) {
            // 首个视频 / 同一视频：直接进当前槽位，无需过渡
            if (activeSlotRef.current === 'A') setSlotAUrl(newVideoUrl)
            else setSlotBUrl(newVideoUrl)
            if (fadingOutSlotRef.current) {
              const deadSlot = fadingOutSlotRef.current
              if (deadSlot === 'A') setSlotAUrl(null)
              else setSlotBUrl(null)
              fadingOutSlotRef.current = null
            }
            stagedSlotRef.current = null
          } else {
            // 换歌：新视频放另一槽位（隐藏缓冲），canplay 后交叉淡入
            const stage = otherSlot(activeSlotRef.current)
            stagedSlotRef.current = stage
            // 目标槽还在上一轮淡出中：取消其清理定时器，直接复用该槽
            if (fadingOutSlotRef.current === stage) {
              fadingOutSlotRef.current = null
              if (crossfadeTimerRef.current) {
                window.clearTimeout(crossfadeTimerRef.current)
                crossfadeTimerRef.current = null
              }
            }
            if (stage === 'A') setSlotAUrl(newVideoUrl)
            else setSlotBUrl(newVideoUrl)
          }
          setStatus('playing')
          onPlayStateChangeRef.current?.({ ...lastPlayStateRef.current, currentTime: activeEl()?.currentTime || 0 })
        } catch (error) {
          if (controller.signal.aborted) return
          // 手动记住的视频失效 → 清除记忆，避免每次切到这首歌都卡住
          if (getBilibiliOverride(songKey) === candidate.video.bvid) clearBilibiliOverride(songKey)
          const message = error instanceof Error ? error.message : 'MV 加载失败'
          failedBvidsRef.current.add(candidate.video.bvid)
          const nextIndex = fallbackChainRef.current.findIndex((c, i) => i > chainIndex && !failedBvidsRef.current.has(c.video.bvid))
          if (nextIndex >= 0) {
            void loadVideo(fallbackChainRef.current[nextIndex], nextIndex)
            return
          }
          setStatus('error')
          showNotice(message)
        }
      })()
    },
    [songKey, showNotice],
  )

  // 待淡入槽位的视频缓冲完成 → 开始交叉过渡：新槽 0→1，旧槽 1→0，淡出完成后释放旧槽
  const beginCrossfade = (slot: 'A' | 'B') => {
    if (stagedSlotRef.current !== slot) return
    const prevActive = activeSlotRef.current
    stagedSlotRef.current = null
    fadingOutSlotRef.current = prevActive
    activeSlotRef.current = slot
    setActiveSlot(slot)
    setStatus('playing')
    if (crossfadeTimerRef.current) window.clearTimeout(crossfadeTimerRef.current)
    crossfadeTimerRef.current = window.setTimeout(() => {
      // 旧槽已不再 active 才清空（快速切歌时该槽可能已被新视频复用）
      if (prevActive === 'A' && activeSlotRef.current !== 'A') setSlotAUrl(null)
      else if (prevActive === 'B' && activeSlotRef.current !== 'B') setSlotBUrl(null)
      fadingOutSlotRef.current = null
      crossfadeTimerRef.current = null
    }, 850)
  }

  // 切歌/首次挂载：自动匹配当前歌曲（仅 songKey 变化才重跑，避免 App 每 ~1s 重渲染导致视频反复卸载）。
  // MV 从未启用过（开关关闭且没启用过）则不搜索，避免每首歌白调 B 站接口；开关关→开时补搜一次。
  useEffect(() => {
    if (!enabled && !wasEnabledRef.current) return
    // 开关关闭但此前启用过：保留已加载视频，不重复搜索（开关打开时 enabled 变化会再触发）
    if (!enabled && searchedSongKeyRef.current === songKey) return
    searchedSongKeyRef.current = songKey
    let cancelled = false
    const controller = new AbortController()
    searchControllerRef.current?.abort()
    searchControllerRef.current = controller
    failedBvidsRef.current = new Set()
    fallbackChainRef.current = []
    lastPlayStateRef.current = null
    onPlayStateChangeRef.current?.(null) // 旧歌曲视频作废，切看歌时不复用
    // 不清空当前视频：切歌时旧视频继续播放，新视频加载好后交叉淡入（封面式过渡，无黑屏闪断）
    setStatus('searching')
    setShowCandidates(false)
    setCandidates([])

    void (async () => {
      const { songTitle: st, songArtists: sa, songDuration: sd, platform: pf, songId: sid } = songRef.current
      const ctx: MatchContext = { songTitle: st, artists: sa, songDuration: sd, platform: pf, id: sid }
      const result = await findBestBilibiliMv(ctx, { signal: controller.signal })
      if (cancelled || controller.signal.aborted) return
      if (result.status === 'auto' && result.best) {
        fallbackChainRef.current = result.fallbackChain
        loadVideo(result.best)
      } else if (result.status === 'confirm') {
        setCandidates(result.candidates)
        setStatus('confirm')
        setShowCandidates(true)
      } else if (result.status === 'none') {
        setStatus('none')
        showNotice('未找到相关 MV')
      } else {
        setStatus('error')
        showNotice(result.error || 'MV 匹配失败')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, enabled])

  // 预加载：为即将播放的歌曲提前匹配评分高的视频（findBestBilibiliMv 结果按歌缓存 24h，
  // 切到该歌时直接命中缓存秒播；与看歌模式同款逻辑，不阻塞当前播放）
  useEffect(() => {
    if (!enabled && !wasEnabledRef.current) return
    if (!upcomingSongs?.length) return
    const preloadController = new AbortController()
    for (const upcoming of upcomingSongs.slice(0, 2)) {
      void findBestBilibiliMv(
        { songTitle: upcoming.songTitle, artists: upcoming.songArtists, songDuration: upcoming.songDuration, platform: upcoming.platform, id: upcoming.id },
        { signal: preloadController.signal, settings: getBilibiliWatchSettings() },
      ).catch(() => { /* 预加载失败静默 */ })
    }
    return () => preloadController.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, JSON.stringify(upcomingSongs || [])])

  // 死胡同状态（未找到 / 匹配失败 / 播放失败 / 候选条被关闭）→ 通知外部回退到普通封面背景；
  // 恢复播放（搜索中/加载中/候选选择中）→ 通知取消回退。外部据此在 MV 层与封面层之间切换。
  useEffect(() => {
    const fallbackActive = status === 'none' || status === 'error' || (status === 'confirm' && !showCandidates)
    onFallbackChange?.(fallbackActive)
  }, [status, showCandidates, onFallbackChange])

  // 同步循环：视频时间 = 音频位置 % 视频时长，偏差超阈值才 seek。
  // fMP4 的 duration 在缓冲期不稳定，且反复 seek 会触发重新缓冲（黑屏）；
  // 因此只在 readyState>=2、非 seeking、时长有限时校正，阈值 0.9s（原 1.5s 时漂移可感知）。
  // 双槽位：pendingStage 期间当前槽自由播放（避免被 seek 到新歌位置跳变），淡出槽不参与同步。
  useEffect(() => {
    if (!isPlaying || !enabled) {
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current && !ref.current.paused) ref.current.pause()
      }
      return
    }
    let raf = 0
    let lastReport = 0
    const tick = () => {
      const audio = getAudioRef.current()
      const pendingStage = stagedSlotRef.current !== null
      for (const [ref, slot] of [[slotARef, 'A'], [slotBRef, 'B']] as const) {
        const video = ref.current
        if (!video || !audio) continue
        const isActive = slot === activeSlotRef.current
        if (pendingStage && isActive) continue
        if (slot === fadingOutSlotRef.current) continue
        const target = computeMvSyncTarget(audio.currentTime, video.duration)
        if (target !== null && video.readyState >= 2 && !video.seeking && shouldSeekMvVideo(video.currentTime, target, 0.9)) {
          video.currentTime = target
        }
        if (video.paused && video.readyState >= 2) void video.play().catch(() => undefined)
      }
      // 节流上报实时进度（约 1s 一次），供切到看歌时无缝续播
      const now = performance.now()
      const active = activeEl()
      if (lastPlayStateRef.current && active && now - lastReport > 1000) {
        lastReport = now
        onPlayStateChangeRef.current?.({ ...lastPlayStateRef.current, currentTime: active.currentTime || 0 })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, enabled])

  // 卸载清理
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort()
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current) {
          ref.current.pause()
          ref.current.removeAttribute('src')
          ref.current.load()
        }
      }
      if (crossfadeTimerRef.current) window.clearTimeout(crossfadeTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
      // 组件卸载（切看歌/关开关/回退）时作废复用缓存
      onPlayStateChangeRef.current?.(null)
    }
  }, [])

  const selectCandidate = (candidate: CandidateScore) => {
    setBilibiliOverride(songKey, candidate.video.bvid)
    setShowCandidates(false)
    setCandidates([])
    fallbackChainRef.current = [candidate, ...fallbackChainRef.current.filter((c) => c.video.bvid !== candidate.video.bvid)]
    loadVideo(candidate)
  }

  const dark = playerTheme !== 'light'

  return (
    <div
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none"
      style={enabled ? undefined : { display: 'none' }}
    >
      {/* A 槽视频 */}
      <video
        ref={slotARef}
        src={slotAUrl ?? undefined}
        autoPlay={isPlaying}
        loop
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: slotOpacity('A'),
          transition: 'opacity 0.65s ease',
          display: slotAUrl ? undefined : 'none',
          filter: blur > 0 ? `blur(${blur}px) scale(1.08)` : undefined,
        }}
        onCanPlay={() => beginCrossfade('A')}
        onError={() => {
          const slot = 'A'
          if (stagedSlotRef.current === slot) stagedSlotRef.current = null
          else if (fadingOutSlotRef.current === slot) fadingOutSlotRef.current = null
          setSlotAUrl(null)
          if (activeSlotRef.current === slot) {
            setStatus('error')
            showNotice('MV 播放失败')
          }
        }}
      />
      {/* B 槽视频：换歌时新视频在此缓冲后交叉淡入 */}
      <video
        ref={slotBRef}
        src={slotBUrl ?? undefined}
        autoPlay={isPlaying}
        loop
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: slotOpacity('B'),
          transition: 'opacity 0.65s ease',
          display: slotBUrl ? undefined : 'none',
          filter: blur > 0 ? `blur(${blur}px) scale(1.08)` : undefined,
        }}
        onCanPlay={() => beginCrossfade('B')}
        onError={() => {
          const slot = 'B'
          if (stagedSlotRef.current === slot) stagedSlotRef.current = null
          else if (fadingOutSlotRef.current === slot) fadingOutSlotRef.current = null
          setSlotBUrl(null)
          if (activeSlotRef.current === slot) {
            setStatus('error')
            showNotice('MV 播放失败')
          }
        }}
      />

      {/* 搜索/加载指示 */}
      {(status === 'searching' || status === 'loading') && (
        <div className="absolute right-6 bottom-6 z-30 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs backdrop-blur-md"
          style={{
            backgroundColor: dark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.5)',
            borderColor: dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
            color: dark ? '#fff' : '#000',
          }}>
          <Search className="w-3.5 h-3.5 animate-pulse" />
          {status === 'loading' ? 'MV 加载中' : 'MV 匹配中'}
        </div>
      )}

      {/* 轻量候选条（低置信确认） */}
      {showCandidates && candidates.length > 0 && (
        <div className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,760px)]"
          style={{
            backgroundColor: dark ? 'rgba(10,12,18,0.88)' : 'rgba(255,255,255,0.92)',
            border: `1px solid ${dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'}`,
            borderRadius: 14,
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          }}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs"
            style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)' }}>
            <span className="font-medium">匹配置信度不足，选择要作为背景的 MV</span>
            <button
              type="button"
              aria-label="关闭候选列表"
              onClick={() => setShowCandidates(false)}
              className="ml-auto rounded-full p-1 transition-colors hover:bg-black/10"
              style={{ color: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto px-3 pb-3">
            {candidates.map((c) => (
              <button
                key={c.video.bvid}
                type="button"
                onClick={() => selectCandidate(c)}
                className="group w-36 shrink-0 overflow-hidden rounded-lg text-left transition-transform hover:scale-[1.03]"
                style={{ backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
              >
                <div className="relative aspect-video w-full overflow-hidden">
                  <img src={resolveBiliPic(c.video.pic)} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  <span
                    className="absolute left-1 top-1 rounded px-1 py-0.5 text-[10px] font-medium text-white"
                    style={{ backgroundColor: TYPE_BADGES[c.type].color }}
                  >
                    {TYPE_BADGES[c.type].label}
                  </span>
                  <span className="absolute right-1 bottom-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                    <Clock className="w-2.5 h-2.5" />
                    {formatBiliTime(c.video.duration)}
                  </span>
                </div>
                <div className="truncate px-1.5 pt-1 text-xs font-medium" style={{ color: dark ? '#fff' : '#000' }}>
                  {c.video.title}
                </div>
                <div className="flex items-center gap-1 truncate px-1.5 pb-1.5 text-[11px]"
                  style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)' }}>
                  <span className="truncate">{c.video.author}</span>
                  <span className="flex items-center gap-0.5 shrink-0">
                    <Eye className="w-2.5 h-2.5" />
                    {formatPlayCount(c.video.play)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 短暂提示 */}
      {notice && (
        <div className="pointer-events-auto absolute top-24 left-1/2 -translate-x-1/2 z-40 rounded-full border px-4 py-2 text-sm backdrop-blur-md"
          style={{
            backgroundColor: dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)',
            borderColor: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)',
            color: dark ? '#fff' : '#000',
          }}>
          {notice}
        </div>
      )}
    </div>
  )
}

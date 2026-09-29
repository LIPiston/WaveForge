// 网易云音乐 PC 客户端「推荐」页复刻（传统模式中栏）。
//
// 官方 PC 推荐页三段式：顶部 7 张快捷卡（每日推荐/私人漫游/私人雷达/相似歌曲/华语流行日推/
// 心情氛围歌单/音乐播客）→ 推荐歌单（一行 9 个）→ 精选活动（一行 5 张 16:7 横卡）。
// 数据一律走已有原生接口：Link Platform 推荐页拿快捷卡与歌单货架，banner 拿精选活动，
// 缺失的部分各自独立兜底（歌单广场热榜 / 本地快捷卡），保证任何一路失败都不白屏。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarDays, Compass, Loader2, Mic2, Music2, Play, Radar, RefreshCw, Sparkles, Waves,
} from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getUserPlaylists } from '../../services/playlistService'
import {
  fetchNeteaseDailySongs, fetchNeteaseDailyStyleConfig, fetchNeteaseDailyStyleSongs,
  fetchNeteaseNativeHome, fetchNeteaseSimilarSongs,
} from '../neteaseExplore/api'
import { fetchNeteaseLinkPage } from '../neteaseExplore/discover'
import {
  neteaseResourceArtwork, neteaseShortcutKind, normalizeNeteaseLinkPage, normalizeNeteaseShortcuts,
  type NeteaseNativeBlock, type NeteaseNativeResource, type NeteaseShortcutKind,
} from '../neteaseExplore/model'
import {
  PcCountBadge, PcCover, PcEmpty, PcIconButton, PcNoticeBar, PcSectionTitle, pcTheme,
  type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

/** 三个 PC 复刻页面共用的 props（TraditionalView 统一接线）。 */
export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  /** 隐藏保活页为 false：非 active 时不发任何请求 */
  active?: boolean
  currentSongKey?: string
  /** 「相似歌曲」等需要种子的入口使用 */
  currentSong?: Song | null
}

interface QuickCard {
  key: string
  title: string
  subtitle: string
  Icon: typeof CalendarDays
}

// 官方顶部 7 张卡（标题/副标题与实机一致）；顺序与 PC 客户端一致
const QUICK_CARDS: QuickCard[] = [
  { key: 'daily', title: '每日推荐', subtitle: '今日限定好歌推荐', Icon: CalendarDays },
  { key: 'roam', title: '私人漫游', subtitle: '多样频道无限畅听', Icon: Compass },
  { key: 'radar', title: '私人雷达', subtitle: '反复聆听你爱的歌', Icon: Radar },
  { key: 'similar', title: '相似歌曲', subtitle: '从你喜欢的歌听起', Icon: Waves },
  { key: 'style', title: '华语流行日推', subtitle: '每天为你精选的华语好歌', Icon: Sparkles },
  { key: 'mood', title: '心情氛围歌单', subtitle: '跟着心情换歌单', Icon: Music2 },
  { key: 'podcast', title: '音乐播客', subtitle: '音乐背后的故事', Icon: Mic2 },
]

/** 站点公开数据（banner / 歌单热榜）无需 cookie，直接走本地网关。 */
async function fetchPublicJson(path: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`${getApiBase()}${path}`, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`)
  return data
}

/** 原始歌单（用户歌单 / 公开接口）→ 传统模式歌单页所需的 ExplorePlaylist 形状。 */
function playlistFromRaw(raw: any, source: string) {
  return {
    id: String(raw?.id ?? raw?.playlistId ?? ''),
    name: String(raw?.name || raw?.title || '歌单'),
    coverUrl: String(raw?.coverImgUrl || raw?.coverUrl || raw?.picUrl || '').replace(/^http:/, 'https:'),
    description: String(raw?.description || raw?.copywriter || '') || undefined,
    playCount: Number(raw?.playCount || 0) || undefined,
    trackCount: Number(raw?.trackCount || raw?.songCount || 0) || undefined,
    creator: raw?.creator?.nickname ? String(raw.creator.nickname) : undefined,
    platform: 'netease' as const,
    source,
  }
}

/** 推荐歌单货架的候选：优先官方「推荐歌单」类区块，其次任何带歌单的区块。 */
function collectPlaylistResources(blocks: NeteaseNativeBlock[]): NeteaseNativeResource[] {
  const preferred = blocks.filter(block => /SPECIAL_CLOUD_VILLAGE|PLAYLIST_RCMD|SLIDE_PLAYLIST|MOOD_PLAYLIST|FEELING_PLAYLIST|STYLE_PLAYLIST|SCENE_PLAYLIST/i.test(`${block.blockCode} ${block.showType}`))
  const pool = preferred.length > 0 ? preferred : blocks
  const out: NeteaseNativeResource[] = []
  const seen = new Set<string>()
  for (const block of pool) {
    for (const resource of block.resources) {
      const playlist = resource.playlist || (resource.action.type === 'playlist' ? resource.action.playlist : null)
      if (!playlist?.id || seen.has(playlist.id)) continue
      seen.add(playlist.id)
      out.push(resource)
      if (out.length >= 18) return out
    }
  }
  return out
}

/** 骨架块：各区块独立 loading，互不阻塞。 */
function PcSkeleton({ theme, className }: { theme: PcTheme; className: string }) {
  return <span className={`block animate-pulse rounded-lg ${theme.surface} ${className}`} />
}

function NeteasePcHome({ chrome, account, actions, authRevision = 0, active = true, currentSong }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent

  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [shortcuts, setShortcuts] = useState<NeteaseNativeResource[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [hotPlaylists, setHotPlaylists] = useState<any[]>([])
  const [hotLoading, setHotLoading] = useState(false)
  const [banners, setBanners] = useState<any[]>([])
  const [bannersLoading, setBannersLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  // 快捷卡与歌单货架同源（Link Platform 推荐页），失败再退旧协议 homepage；两路都失败也不报错。
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setHomeLoading(true)
    void (async () => {
      let nextBlocks: NeteaseNativeBlock[] = []
      let nextShortcuts: NeteaseNativeResource[] = []
      try {
        const payload = await fetchNeteaseLinkPage('HOME_RECOMMEND_PAGE', '0', false, controller.signal)
        nextBlocks = normalizeNeteaseLinkPage(payload).blocks
        nextShortcuts = normalizeNeteaseShortcuts(payload)
      } catch { /* 静默降级：旧协议或纯公开兜底 */ }
      if (controller.signal.aborted) return
      if (nextBlocks.length === 0) {
        try {
          const home = await fetchNeteaseNativeHome(false, controller.signal)
          nextBlocks = home.blocks
          if (nextShortcuts.length === 0) nextShortcuts = normalizeNeteaseShortcuts(home.rawBlocks ? { data: { blocks: home.rawBlocks } } : {})
        } catch { /* 兜底货架在后面处理 */ }
      }
      if (controller.signal.aborted) return
      setBlocks(nextBlocks)
      setShortcuts(nextShortcuts)
      setHomeLoading(false)
    })()
    return () => controller.abort()
  }, [active, authRevision, reloadToken])

  // 精选活动：PC banner（type=2）是公开接口，未登录也能出图；无数据就整块不渲染。
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setBannersLoading(true)
    fetchPublicJson('/netease/banner?type=2', controller.signal)
      .then(data => { if (!controller.signal.aborted) setBanners(Array.isArray(data?.banners) ? data.banners : []) })
      .catch(() => { if (!controller.signal.aborted) setBanners([]) })
      .finally(() => { if (!controller.signal.aborted) setBannersLoading(false) })
    return () => controller.abort()
  }, [active, reloadToken])

  const playlistResources = useMemo(() => collectPlaylistResources(blocks), [blocks])
  const needHotFallback = !homeLoading && playlistResources.length === 0

  // 只在这两种入口卡都缺图时兜底，避免每次都多打一路接口
  useEffect(() => {
    if (!active || !needHotFallback) return
    const controller = new AbortController()
    setHotLoading(true)
    fetchPublicJson('/netease/playlist/hot?limit=18', controller.signal)
      .then(data => { if (!controller.signal.aborted) setHotPlaylists(Array.isArray(data?.playlists) ? data.playlists : []) })
      .catch(() => { if (!controller.signal.aborted) setHotPlaylists([]) })
      .finally(() => { if (!controller.signal.aborted) setHotLoading(false) })
    return () => controller.abort()
  }, [active, needHotFallback, reloadToken])

  const shortcutOf = useCallback((kind: NeteaseShortcutKind) => shortcuts.find(resource => neteaseShortcutKind(resource) === kind), [shortcuts])
  const dailyFallbackCover = useMemo(
    () => neteaseResourceArtwork(blocks.find(block => /DAILY_RECOMMEND/i.test(block.blockCode))?.resources[0] || ({} as NeteaseNativeResource)),
    [blocks],
  )
  const moodBlock = useMemo(
    () => blocks.find(block => /MOOD_PLAYLIST|FEELING_PLAYLIST|心情氛围/i.test(`${block.blockCode} ${block.showType} ${block.title}`)),
    [blocks],
  )

  // 每张卡各自加载：卡片自身显示转圈，失败只在顶部提示条里说明，不影响其它卡
  const runCard = useCallback(async (key: string, task: () => Promise<void>) => {
    if (busyKey) return
    setNotice('')
    setBusyKey(key)
    try { await task() } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '暂时无法打开，请稍后再试')
    } finally { setBusyKey('') }
  }, [busyKey])

  const openDaily = () => { void runCard('daily', async () => {
    if (!account.loggedIn) { actions.onLogin?.(); setNotice('登录后可查看「每日推荐」'); return }
    const songs = await fetchNeteaseDailySongs()
    if (!songs.length) throw new Error('今日暂无每日推荐')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openRadar = () => { void runCard('radar', async () => {
    // 先找账号里名字带「雷达」的歌单（官方雷达歌单就是普通歌单），没有再落到榜单页
    if (account.loggedIn && account.userId) {
      const lists = await getUserPlaylists('netease', account.userId).catch(() => [])
      const radar = (Array.isArray(lists) ? lists : []).find(item => /雷达/.test(String(item?.name || '')))
      if (radar?.id) { actions.onOpenPlaylist(playlistFromRaw(radar, 'netease-radar')); return }
    }
    actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'charts' })
  }) }

  const openSimilar = () => { void runCard('similar', async () => {
    if (!currentSong?.id) { setNotice('播放一首歌后可用「相似歌曲」'); return }
    const songs = await fetchNeteaseSimilarSongs([currentSong.id])
    if (!songs.length) throw new Error('相似歌曲暂无内容')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openStyleDaily = () => { void runCard('style', async () => {
    const categories = await fetchNeteaseDailyStyleConfig()
    const category = categories.find(item => /华语/.test(item.categoryName)) || categories[0]
    const tag = category?.tags[0]
    if (!category || !tag) throw new Error('风格日推暂不可用')
    const songs = await fetchNeteaseDailyStyleSongs(category.categoryId, tag.tagId)
    if (!songs.length) throw new Error('风格日推暂无歌曲')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openMood = () => { void runCard('mood', async () => {
    const resource = moodBlock?.resources.find(item => Boolean(item.playlist)) || moodBlock?.resources[0]
    const playlist = resource?.playlist
    if (resource && playlist?.id) {
      actions.onOpenPlaylist({ ...playlist, coverUrl: playlist.coverUrl || neteaseResourceArtwork(resource) })
      return
    }
    actions.onNavigate({ kind: 'netease', page: 'featured' })
  }) }

  const cardArtwork = useCallback((key: string): string => {
    if (key === 'daily') return neteaseResourceArtwork(shortcutOf('daily') || ({} as NeteaseNativeResource)) || dailyFallbackCover
    if (key === 'roam') return neteaseResourceArtwork(shortcutOf('roam') || ({} as NeteaseNativeResource))
    if (key === 'radar') return neteaseResourceArtwork(shortcutOf('radar') || ({} as NeteaseNativeResource))
    if (key === 'similar') return neteaseResourceArtwork(shortcutOf('similar') || ({} as NeteaseNativeResource)) || currentSong?.album?.picUrl || ''
    if (key === 'mood') return neteaseResourceArtwork(moodBlock?.resources[0] || ({} as NeteaseNativeResource))
    if (key === 'podcast') return neteaseResourceArtwork(shortcutOf('podcast') || ({} as NeteaseNativeResource))
    return ''
  }, [currentSong?.album?.picUrl, dailyFallbackCover, moodBlock, shortcutOf])

  const cardSubtitle = useCallback((card: QuickCard): string => {
    const kind: NeteaseShortcutKind = card.key === 'daily' ? 'daily' : card.key === 'roam' ? 'roam' : card.key === 'radar' ? 'radar' : card.key === 'similar' ? 'similar' : card.key === 'podcast' ? 'podcast' : null
    const resource = kind ? shortcutOf(kind) : undefined
    const remote = (resource?.subtitle || '').trim()
    // 原生资源的 subtitle 有时就是标题本身（私人漫游/私人雷达），照抄会出现「私人漫游 | 私人漫游」，
    // 这种退化情况用本地兜底文案更有信息量
    if (remote && remote !== card.title) return remote
    return card.subtitle
  }, [shortcutOf])

  const onQuickCard = (key: string) => {
    switch (key) {
      case 'daily': openDaily(); return
      case 'roam': actions.onNavigate({ kind: 'netease', page: 'roam' }); return
      case 'radar': openRadar(); return
      case 'similar': openSimilar(); return
      case 'style': openStyleDaily(); return
      case 'mood': openMood(); return
      case 'podcast': actions.onNavigate({ kind: 'netease', page: 'podcast' }); return
      default: return
    }
  }

  // 精选活动横幅：PC banner 接口的图片字段是 pic（早期接口才用 imageUrl，这里两者都认）。
  // targetType=1000 才是歌单（可以直接进详情），其余是活动外链（走系统浏览器打开）。
  const bannerCover = (banner: any) => String(banner?.pic || banner?.imageUrl || '').replace(/^http:/, 'https:')
  const bannerPlaylist = (banner: any) => {
    const type = Number(banner?.targetType)
    const id = String(banner?.targetId || '')
    if (!id || id === '0' || type !== 1000) return null
    return {
      id,
      name: String(banner?.typeTitle || banner?.title || '精选活动'),
      coverUrl: bannerCover(banner),
      platform: 'netease' as const,
      source: 'netease-banner',
    }
  }
  const openBanner = (banner: any) => {
    const playlist = bannerPlaylist(banner)
    if (playlist) { actions.onOpenPlaylist(playlist); return }
    const url = String(banner?.url || '')
    if (!url) return
    // 活动页是站外/官方 web 页：交给系统浏览器，不在应用内嵌 webview
    if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="pb-6">
      {notice && <PcNoticeBar theme={theme} onClose={() => setNotice('')}>{notice}</PcNoticeBar>}

      {/* 顶部 7 张快捷卡：宽屏一行铺满（官方同款），窄屏自动折行 */}
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {QUICK_CARDS.map((card, index) => {
          const artwork = cardArtwork(card.key)
          const busy = busyKey === card.key
          const { Icon } = card
          return (
            <button
              key={card.key}
              type="button"
              disabled={busy}
              onClick={() => onQuickCard(card.key)}
              className="group relative block overflow-hidden rounded-lg text-left transition hover:-translate-y-0.5 disabled:opacity-80"
            >
              <PcCover
                src={artwork}
                alt={card.title}
                eager={index < 4}
                className="aspect-square w-full"
                rounded="rounded-lg"
                overlay={(
                  <>
                    {/* 无真实资源时用本地兜底：强调色渐变 + 功能图标，仍可点 */}
                    {!artwork && (
                      <span className="absolute inset-0 flex items-center justify-center" style={{ background: `linear-gradient(140deg, ${accent}30, ${accent}0d)` }}>
                        <Icon className="h-9 w-9" style={{ color: accent }} />
                      </span>
                    )}
                    <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-[5px] bg-black/45 text-white/90 backdrop-blur-sm">
                      <Icon className="h-3 w-3" />
                    </span>
                    <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-black/55 px-2 py-1.5 backdrop-blur-sm">
                      {/* 官方同款说明条：标题 | 副标题 */}
                      <span className="line-clamp-2 min-w-0 text-[11px] font-medium leading-tight text-white/95">
                        {card.title}
                        <span className="font-normal text-white/60"> | {cardSubtitle(card)}</span>
                      </span>
                      {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/85" />}
                    </span>
                  </>
                )}
              />
            </button>
          )
        })}
      </section>

      {/* 推荐歌单：官方一行 9 个 */}
      <section className="mb-8">
        <div className="flex items-start justify-between gap-3">
          <PcSectionTitle title="推荐歌单" more="更多" onMore={() => actions.onNavigate({ kind: 'netease', page: 'featured' })} theme={theme} />
          <PcIconButton theme={theme} title="刷新推荐" onClick={() => setReloadToken(token => token + 1)}>
            <RefreshCw className="h-4 w-4" />
          </PcIconButton>
        </div>
        {homeLoading || (needHotFallback && hotLoading) ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9">
            {Array.from({ length: 9 }).map((_, index) => (
              <div key={`skeleton:${index}`}>
                <PcSkeleton theme={theme} className="aspect-square w-full" />
                <PcSkeleton theme={theme} className="mt-2 h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : playlistResources.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9">
            {playlistResources.map(resource => {
              const playlist = resource.playlist as any
              const cover = neteaseResourceArtwork(resource) || playlist?.coverUrl || ''
              const name = resource.title || playlist?.name || '歌单'
              return (
                <button
                  key={`home-playlist:${playlist?.id}`}
                  type="button"
                  onClick={() => actions.onOpenPlaylist({ ...playlist, coverUrl: playlist?.coverUrl || cover, source: 'netease-recommend' })}
                  onContextMenu={event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: { ...playlist, coverUrl: playlist?.coverUrl || cover } }) }}
                  className="group block text-left"
                >
                  <PcCover
                    src={cover}
                    alt={name}
                    className="aspect-square w-full"
                    rounded="rounded-lg"
                    overlay={(
                      <>
                        <PcCountBadge value={resource.playCount ?? playlist?.playCount} />
                        <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                          <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                        </span>
                      </>
                    )}
                  />
                  <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{name}</span>
                </button>
              )
            })}
          </div>
        ) : hotPlaylists.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9">
            {hotPlaylists.map(raw => {
              const playlist = playlistFromRaw(raw, 'netease-hot-playlist')
              if (!playlist.id) return null
              return (
                <button
                  key={`hot-playlist:${playlist.id}`}
                  type="button"
                  onClick={() => actions.onOpenPlaylist(playlist)}
                  onContextMenu={event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
                  className="group block text-left"
                >
                  <PcCover
                    src={playlist.coverUrl}
                    alt={playlist.name}
                    className="aspect-square w-full"
                    rounded="rounded-lg"
                    overlay={(
                      <>
                        <PcCountBadge value={playlist.playCount} />
                        <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                          <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                        </span>
                      </>
                    )}
                  />
                  <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{playlist.name}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无推荐歌单" description={account.loggedIn ? '稍后再试试' : '登录后可解锁个性化推荐'} />
        )}
      </section>

      {/* 精选活动：一行 5 张宽幅横卡；无 banner 数据时整块不渲染 */}
      {(bannersLoading || banners.length > 0) && (
        <section>
          <PcSectionTitle title="精选活动" theme={theme} />
          {bannersLoading ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, index) => <PcSkeleton key={`banner-skeleton:${index}`} theme={theme} className="aspect-[16/7] w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {banners.slice(0, 5).map((banner, index) => {
                const cover = bannerCover(banner)
                if (!cover) return null
                const label = String(banner?.typeTitle || '')
                const interactive = Boolean(bannerPlaylist(banner) || banner?.url)
                return (
                  <button
                    key={`banner:${banner?.bannerId || banner?.targetId || index}`}
                    type="button"
                    disabled={!interactive}
                    onClick={() => openBanner(banner)}
                    className={`block overflow-hidden rounded-lg text-left ${interactive ? 'transition hover:-translate-y-0.5' : 'cursor-default'}`}
                  >
                    <PcCover
                      src={cover}
                      alt={label || `精选活动 ${index + 1}`}
                      eager={index < 2}
                      className="aspect-[16/7] w-full"
                      rounded="rounded-lg"
                      overlay={label ? (
                        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-[11px] text-white/90">{label}</span>
                      ) : undefined}
                    />
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default memo(NeteasePcHome)

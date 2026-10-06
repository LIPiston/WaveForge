// QQ 音乐 PC 客户端「乐馆」页（官方音乐馆货架的复刻）。
//
// 官方乐馆 = 顶部分类 + 多个货架（编辑甄选 / 今日尖货 / 排行榜 / 明星空降 …），
// 卡片形态统一是「封面 + 标题 + 副标题」。这里只保留有真实数据源的四类：
//   · 推荐：账号级聚合接口的 musicHall 货架（要登录 cookie，未登录整体空态，不编内容）；
//   · 歌手：公开歌手列表接口（分页 80 条/页，可继续加载）；
//   · 排行：聚合接口 /api/explore/qq 透传的官方榜单目录（上游 top/category），
//     失败/为空时退回货架里 action=open-chart 的榜单卡（见 renderCharts）；
//   · 歌单：公开的歌单分类 + 分类歌单接口。
// 星光 / 农场 / 直播 / 听书 在网关里没有对应数据源，整类不做（不留点了没反应的分类）。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Play, RefreshCw, User } from 'lucide-react'
import { fetchExploreHome, type ExploreChart } from '../../services/exploreApi'
import { getApiBase } from '../../services/apiConfig'
import { openExternalLink } from '../../utils/externalLink'
import { fetchQQExploreBootstrap } from '../qqExplore/api'
import { isHiddenQQMusicHallShelf } from '../qqExplore/model'
import type { QQExploreSnapshot, QQMusicHallCard, QQMusicHallShelf } from '../qqExplore/model'
import {
  PcCardGrid, PcChips, PcCountBadge, PcCover, PcEmpty, PcGhostButton, PcIconButton,
  PcPageTitle, PcPrimaryButton, PcSectionTitle, pcTheme, type PcTabItem,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface QQPcHallProps {
  chrome: { tone: 'light' | 'dark'; skin: 'qq'; accent: string }
  account: PcAccount
  actions: PcActions
  /** false（隐藏保活页）时不发任何请求 */
  active?: boolean
}

type HallTab = 'recommend' | 'artists' | 'charts' | 'playlists'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/** 顶部分类：只列有数据源的四类（星光/农场/直播/听书没有数据源，不做）。 */
const HALL_TABS: PcTabItem[] = [
  { key: 'recommend', label: '推荐' },
  { key: 'artists', label: '歌手' },
  { key: 'charts', label: '排行' },
  { key: 'playlists', label: '歌单' },
]

/** 父层未接线时的兜底：页面必须能独立渲染，不许因缺回调抛错。 */
const FALLBACK_ACTIONS: PcActions = {
  onPlaySongs: () => {},
  onSongMenu: () => {},
  onOpenPlaylist: () => {},
  onNavigate: () => {},
}

/** 歌手列表每页条数由上游固定为 80（singer/list 的 sin 步长），用来判断「还有下一页」。 */
const SINGER_PAGE_SIZE = 80

interface QQSinger { mid: string; name: string; picUrl: string }
interface QQSquareCategory { id: number; name: string; group: string }
interface QQSquarePlaylist { id: string; name: string; coverUrl: string; playCount: number; trackCount?: number }

/* ------------------------------------------------------------------ *
 * 服务端返回解析（字段名有多套历史写法，这里逐层兜底，拿不到就少渲染）
 * ------------------------------------------------------------------ */

function parseQQSingers(payload: any): QQSinger[] {
  const raw = payload?.data?.list || payload?.data?.singers?.singerlist || payload?.data?.singerlist || []
  return (Array.isArray(raw) ? raw : []).map((item: any) => ({
    mid: String(item?.singer_mid || item?.mid || ''),
    name: String(item?.singer_name || item?.name || ''),
    // 歌手头像原样保留 .webp 后缀：实测（2026-09-28）去掉后缀 y.gtimg.cn 会直接 404，
    // 本地 /cover 代理会照常转发，前端 CachedImage 也能解码 webp
    picUrl: String(item?.singer_pic || item?.picUrl || ''),
  })).filter(item => item.mid && item.name)
}

/** 歌单分类：服务端按「分组 → 分类列表」两级返回，拍平成带 group 的一维列表。 */
function parseQQCategories(payload: any): QQSquareCategory[] {
  const groups = payload?.data
  const list: QQSquareCategory[] = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const item of group?.list || []) {
      if (item?.id != null) list.push({ id: Number(item.id), name: String(item.name || ''), group: String(group?.type || '') })
    }
  }
  return list
}

function parseQQSquarePlaylists(payload: any): QQSquarePlaylist[] {
  const raw = payload?.data?.list || []
  return (Array.isArray(raw) ? raw : []).map((item: any) => ({
    id: String(item?.dissid || item?.id || ''),
    name: String(item?.dissname || item?.name || ''),
    coverUrl: String(item?.imgurl || item?.coverUrl || ''),
    playCount: Number(item?.listennum || item?.play_count || 0),
    trackCount: Number(item?.song_count || 0) || undefined,
  })).filter(item => item.id && item.name)
}

/* ------------------------------------------------------------------ *
 * 货架卡片：副标题 / 角标 / 点击行为
 * ------------------------------------------------------------------ */

/** count 是纯数字才交给角标（pcCount 会转成 万/亿）；是「1.2万」这类文案就原样并进副标题。 */
function hallCardCount(card: QQMusicHallCard): number | undefined {
  const count = (card.count || '').trim()
  return /^\d+$/.test(count) ? Number(count) : undefined
}

function hallCardSubtitle(card: QQMusicHallCard): string {
  const subtitle = (card.subtitle || '').trim()
  const count = (card.count || '').trim()
  if (!count || /^\d+$/.test(count)) return subtitle
  return subtitle ? `${subtitle} · ${count}` : count
}

/**
 * 货架卡片 → 可打开的歌单对象（与探索页 executeMusicHallCard 同口径）。
 * 为什么不用 model.qqCardPlaylist：它的入参是「探索 feed 卡」类型（QQExploreCard 要求 feedKey 等字段），
 * 货架卡片类型缺这些字段，类型不通；这里按同样的字段口径构造一次。
 */
function hallPlaylist(card: QQMusicHallCard) {
  return {
    id: card.action.type === 'open-playlist' ? card.action.playlistId : card.id,
    name: card.title || 'QQ 音乐歌单',
    description: card.subtitle || '',
    coverUrl: card.coverUrl || '',
    platform: 'qq' as const,
    source: 'qq-native-music-hall',
  }
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

function QQPcHall({ chrome, account, actions, active = true }: QQPcHallProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const act = actions || FALLBACK_ACTIONS
  const loggedIn = Boolean(account?.loggedIn)
  const userId = account?.userId || ''

  const [tab, setTab] = useState<HallTab>('recommend')
  /** 刷新令牌：+1 会让所有「已加载键」失效，从而只重取当前需要的几路数据。 */
  const [revision, setRevision] = useState(0)

  // 推荐 / 排行共用的账号级货架快照
  const [snapshot, setSnapshot] = useState<QQExploreSnapshot | null>(null)
  const [snapshotState, setSnapshotState] = useState<LoadState>('idle')
  const [snapshotError, setSnapshotError] = useState('')
  const snapshotKeyRef = useRef('')

  // 排行：官方榜单目录（聚合接口 /api/explore/qq 的 charts 字段，上游来自 top/category 全量榜单）
  const [directoryCharts, setDirectoryCharts] = useState<ExploreChart[]>([])
  const [directoryState, setDirectoryState] = useState<LoadState>('idle')
  const directoryKeyRef = useRef('')

  // 歌手
  const [singers, setSingers] = useState<QQSinger[]>([])
  const [singerState, setSingerState] = useState<LoadState>('idle')
  const [singerLoadingMore, setSingerLoadingMore] = useState(false)
  const [singerHasMore, setSingerHasMore] = useState(false)
  const singerPageRef = useRef(1)
  const singerKeyRef = useRef('')
  const singerAbortRef = useRef<AbortController | null>(null)

  // 歌单分类 / 分类歌单
  const [categories, setCategories] = useState<QQSquareCategory[]>([])
  const [activeCategory, setActiveCategory] = useState<number | null>(null)
  const [squarePlaylists, setSquarePlaylists] = useState<QQSquarePlaylist[]>([])
  const [squareState, setSquareState] = useState<LoadState>('idle')
  const [squareLoadingMore, setSquareLoadingMore] = useState(false)
  const [squareHasMore, setSquareHasMore] = useState(false)
  const squarePageRef = useRef(1)
  const categoryKeyRef = useRef('')
  const squareKeyRef = useRef('')
  const squareAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => singerAbortRef.current?.abort(), [])

  /* ── 推荐 / 排行：账号级货架快照 ── */
  const snapshotKey = `${userId}:${revision}`
  useEffect(() => {
    // 未登录时接口必然 401（网关要求 cookie），索性不发请求，直接走登录空态
    if (!active || !loggedIn) return
    if (snapshotKeyRef.current === snapshotKey) return
    snapshotKeyRef.current = snapshotKey
    const controller = new AbortController()
    setSnapshotState('loading')
    setSnapshotError('')
    void fetchQQExploreBootstrap(controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setSnapshot(data)
        setSnapshotState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // 失败不留请求锁：重试按钮会通过 revision 再发一次
        if (snapshotKeyRef.current === snapshotKey) snapshotKeyRef.current = ''
        setSnapshot(null)
        setSnapshotState('error')
        setSnapshotError(error instanceof Error ? error.message : '乐馆内容加载失败')
      })
    return () => {
      controller.abort()
      // 中断（例如页面被隐藏）后允许下次可见时重来，否则会永远停在加载中
      if (snapshotKeyRef.current === snapshotKey) snapshotKeyRef.current = ''
    }
  }, [active, loggedIn, snapshotKey])

  /* ── 排行：榜单目录（聚合接口公开可用，进入页签才请求；失败时退回货架榜单卡） ── */
  const directoryKey = `charts-directory:${revision}`
  useEffect(() => {
    if (!active || tab !== 'charts') return
    if (directoryKeyRef.current === directoryKey) return
    directoryKeyRef.current = directoryKey
    const controller = new AbortController()
    setDirectoryState('loading')
    void fetchExploreHome('qq', controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setDirectoryCharts(Array.isArray(data?.charts) ? data.charts : [])
        setDirectoryState('ready')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // 失败不留请求锁：重试按钮会通过 revision 再发一次
        if (directoryKeyRef.current === directoryKey) directoryKeyRef.current = ''
        setDirectoryCharts([])
        setDirectoryState('error')
      })
    return () => {
      controller.abort()
      if (directoryKeyRef.current === directoryKey) directoryKeyRef.current = ''
    }
  }, [active, tab, directoryKey])

  /* ── 歌手：公开接口，进入页签才请求 ── */
  const loadSingers = useCallback((page: number, append: boolean) => {
    singerAbortRef.current?.abort()
    const controller = new AbortController()
    singerAbortRef.current = controller
    if (append) setSingerLoadingMore(true)
    else { setSingerState('loading'); setSingers([]) }
    fetch(`${getApiBase()}/qq/singer/list?area=-100&sex=-100&pageNo=${page}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQSingers(payload)
        const total = Number(payload?.data?.total || 0)
        setSingers(previous => (append ? [...previous.filter(item => !list.some(next => next.mid === item.mid)), ...list] : list))
        singerPageRef.current = page
        setSingerHasMore(total > 0 ? page * SINGER_PAGE_SIZE < total : list.length >= SINGER_PAGE_SIZE)
        setSingerState('ready')
        setSingerLoadingMore(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // 追加失败保持原列表（已有内容不丢），首屏失败才落空态
        setSingerLoadingMore(false)
        setSingerState(append ? 'ready' : 'error')
      })
  }, [])

  const singerKey = `singers:${revision}`
  useEffect(() => {
    if (!active || tab !== 'artists') return
    if (singerKeyRef.current === singerKey) return
    singerKeyRef.current = singerKey
    loadSingers(1, false)
  }, [active, tab, singerKey, loadSingers])

  /* ── 歌单分类：公开接口 ── */
  const categoryKey = `categories:${revision}`
  useEffect(() => {
    if (!active || tab !== 'playlists') return
    if (categoryKeyRef.current === categoryKey) return
    categoryKeyRef.current = categoryKey
    const controller = new AbortController()
    fetch(`${getApiBase()}/qq/songlist/category`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQCategories(payload)
        setCategories(list)
        setActiveCategory(previous => (previous != null && list.some(item => item.id === previous)
          ? previous
          : list.find(item => item.name === '全部')?.id ?? list[0]?.id ?? null))
      })
      .catch(() => {
        if (controller.signal.aborted) return
        if (categoryKeyRef.current === categoryKey) categoryKeyRef.current = ''
        setCategories([])
      })
    return () => {
      controller.abort()
      if (categoryKeyRef.current === categoryKey) categoryKeyRef.current = ''
    }
  }, [active, tab, categoryKey])

  /* ── 分类歌单网格：服务端路由已做 id→category / page→pageNo / pageSize→num 映射，
       分类与翻页都能真实生效，因此这里与歌手区一样提供「加载更多」。 ── */
  const SQUARE_PAGE_SIZE = 30
  const loadSquare = useCallback((categoryId: number, page: number, append: boolean) => {
    squareAbortRef.current?.abort()
    const controller = new AbortController()
    squareAbortRef.current = controller
    if (append) setSquareLoadingMore(true)
    else { setSquareState('loading'); setSquarePlaylists([]) }
    fetch(`${getApiBase()}/qq/songlist/list?id=${categoryId}&page=${page}&pageSize=${SQUARE_PAGE_SIZE}&sort=5`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQSquarePlaylists(payload)
        setSquarePlaylists(previous => (append
          ? [...previous.filter(item => !list.some(next => next.id === item.id)), ...list]
          : list))
        squarePageRef.current = page
        setSquareHasMore(list.length >= SQUARE_PAGE_SIZE)
        setSquareState('ready')
        setSquareLoadingMore(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setSquareLoadingMore(false)
        setSquareState(append ? 'ready' : 'error')
      })
  }, [])

  const squareKey = `${activeCategory}:${revision}`
  useEffect(() => {
    if (!active || tab !== 'playlists' || activeCategory == null) return
    if (squareKeyRef.current === squareKey) return
    squareKeyRef.current = squareKey
    loadSquare(activeCategory, 1, false)
    return () => {
      squareAbortRef.current?.abort()
      if (squareKeyRef.current === squareKey) squareKeyRef.current = ''
    }
  }, [active, tab, activeCategory, squareKey, loadSquare])

  const loadMoreSquare = useCallback(() => {
    if (activeCategory == null || squareLoadingMore) return
    loadSquare(activeCategory, squarePageRef.current + 1, true)
  }, [activeCategory, squareLoadingMore, loadSquare])

  /* ── 派生数据 ── */

  // 推荐货架：官方顺序 + 去掉听书/直播/数字专辑等无数据源货架，并丢掉没有可展示卡片的空货架
  const visibleShelves = useMemo(() => {
    const shelves = snapshot?.musicHall || []
    return shelves
      .filter(shelf => shelf.title.trim() && shelf.cards.length > 0 && !isHiddenQQMusicHallShelf(shelf))
      .sort((left, right) => left.serverOrder - right.serverOrder)
  }, [snapshot])

  /**
   * 排行榜兜底目录：正常情况用聚合接口 /api/explore/qq 透传的全量榜单（directoryCharts，
   * 上游 top/category），接口失败或为空时才从货架里 action=open-chart 的卡片反推。
   * 这里刻意不套 isHiddenQQMusicHallShelf：隐藏规则是为了首页版面（编辑甄选等），
   * 不代表里面的榜单卡无效。
   */
  const charts = useMemo<ExploreChart[]>(() => {
    const seen = new Set<string>()
    const list: ExploreChart[] = []
    for (const shelf of snapshot?.musicHall || []) {
      for (const card of shelf.cards) {
        if (card.action.type !== 'open-chart' || !card.action.chartId) continue
        if (seen.has(card.action.chartId)) continue
        seen.add(card.action.chartId)
        list.push({
          id: card.action.chartId,
          name: card.title || 'QQ 音乐榜单',
          group: shelf.title || '排行榜',
          coverUrl: card.coverUrl || '',
          platform: 'qq',
          songs: [],
        })
      }
    }
    return list
  }, [snapshot])

  /** 分类胶囊按官方分组顺序渲染（同组内一行）。 */
  const categoryGroups = useMemo(() => {
    const map = new Map<string, QQSquareCategory[]>()
    for (const item of categories) {
      const arr = map.get(item.group) || []
      arr.push(item)
      map.set(item.group, arr)
    }
    return [...map.entries()]
  }, [categories])

  /**
   * 卡片点击行为：null = 本软件没有对应目标（该卡渲染成静态元素，不留点了没反应的按钮）。
   * 可覆盖的动作与官方客户端的落点一一对应：歌单/榜单/歌曲/专辑/歌手/MV/更多分区/搜索。
   */
  const cardAction = useCallback((card: QQMusicHallCard): (() => void) | null => {
    const action = card.action
    switch (action.type) {
      case 'open-playlist':
        return () => act.onOpenPlaylist(hallPlaylist(card))
      case 'open-chart':
        return () => act.onOpenChart?.({
          id: action.chartId,
          name: card.title || 'QQ 音乐榜单',
          group: '',
          coverUrl: card.coverUrl || '',
          platform: 'qq' as const,
          songs: [],
        })
      case 'play-songs':
        return card.songs.length ? () => act.onPlaySongs(card.songs[0], card.songs, 0) : null
      case 'open-album':
        return act.onOpenAlbum ? () => act.onOpenAlbum?.(action.albumId, 'qq') : null
      case 'open-mv':
        // 走全局 MV 弹窗直接播放（与左栏「MV」入口同一链路）；弹窗不可用时才退回系统浏览器
        if (act.onOpenMv) return () => act.onOpenMv?.(action.mvId, 'qq')
        return () => openExternalLink(`https://y.qq.com/n/ryqq/mv/${action.mvId}`)
      case 'open-external':
        return () => openExternalLink(action.url)
      case 'open-section':
        // 官方的「更多」入口：能对上我们页签的跳页签，MV 分区走全局 MV 弹窗，其余不响应
        if (action.section === 'artists') return () => setTab('artists')
        if (action.section === 'charts') return () => setTab('charts')
        if (action.section === 'playlists') return () => setTab('playlists')
        if (action.section === 'mvs' && act.onOpenMv) return () => act.onOpenMv?.(undefined, 'qq')
        return null
      case 'search':
        return () => act.onNavigate({ kind: 'qq', page: 'search', keyword: action.query })
      case 'unsupported':
      case 'play-radio':
      case 'play-radar':
      case 'open-preferences':
        return null
      default: {
        // 上游 action 联合类型里没有 open-artist，但货架实测会出现，做一次宽松兜底
        const loose = action as unknown as { type?: string; artistId?: string; mid?: string }
        const artistId = String(loose.artistId || loose.mid || '')
        if (loose.type === 'open-artist' && artistId) return () => act.onOpenArtist?.(artistId, 'qq')
        return null
      }
    }
  }, [act])

  const refresh = useCallback(() => {
    // 已加载键全部失效 + revision 变化：当前页签需要的数据会重新拉取，其余页签等切过去再拉
    snapshotKeyRef.current = ''
    directoryKeyRef.current = ''
    singerKeyRef.current = ''
    categoryKeyRef.current = ''
    squareKeyRef.current = ''
    setRevision(value => value + 1)
  }, [])

  const loadingLine = <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>

  const loginEmpty = (
    <PcEmpty
      theme={theme}
      title="登录后查看乐馆内容"
      description="部分货架需要登录 QQ 音乐，登录后显示与手机客户端同账号的内容"
      action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined}
    />
  )

  const snapshotErrorEmpty = (
    <PcEmpty
      theme={theme}
      title="乐馆内容加载失败"
      description={snapshotError || '本地网关暂时没有返回内容'}
      action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />}
    />
  )

  /* ── 推荐：官方货架（标题 + 6 列封面卡） ── */
  const renderShelves = () => {
    if (!loggedIn) return loginEmpty
    if (snapshotState === 'error') return snapshotErrorEmpty
    if (snapshotState === 'loading' && !snapshot) return loadingLine
    if (!visibleShelves.length) {
      return <PcEmpty theme={theme} title="暂无货架内容" description="QQ 音乐没有返回可展示的推荐货架" />
    }
    return visibleShelves.map(shelf => (
      <section key={`${shelf.id}:${shelf.title}`} className="mb-8">
        <PcSectionTitle title={shelf.title} theme={theme} />
        {/* 为什么不用 PcCardGrid：它只会渲染 <button>，而货架里存在本软件打不开的卡片，
            硬套就会留下「点了没反应」的死按钮。这里复用同一套栅格样式，按可点性切换 button/div。 */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {shelf.cards.map((card, index) => {
            const run = cardAction(card)
            const subtitle = hallCardSubtitle(card)
            const body = (
              <>
                <PcCover
                  src={card.coverUrl}
                  alt={card.title || shelf.title}
                  className="aspect-square w-full"
                  rounded="rounded-[8px]"
                  overlay={
                    <>
                      <PcCountBadge value={hallCardCount(card)} />
                      {run ? (
                        <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                          <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                        </span>
                      ) : null}
                    </>
                  }
                />
                <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{card.title}</span>
                {subtitle ? <span className={`mt-0.5 line-clamp-2 block text-[11px] leading-snug ${theme.faint}`}>{subtitle}</span> : null}
              </>
            )
            const key = `${shelf.id}:${card.id}:${card.subId}:${index}`
            if (!run) {
              return (
                <div key={key} className="block text-left" title="该内容只能在 QQ 音乐客户端中打开">
                  {body}
                </div>
              )
            }
            return (
              <button
                key={key}
                type="button"
                onClick={run}
                title={card.title}
                // 只有歌单类卡片右击才有意义（菜单里是歌单操作）
                onContextMenu={card.action.type === 'open-playlist'
                  ? (event: ReactMouseEvent) => {
                    event.preventDefault()
                    act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: hallPlaylist(card) })
                  }
                  : undefined}
                className="group block text-left"
              >
                {body}
              </button>
            )
          })}
        </div>
      </section>
    ))
  }

  /* ── 歌手：圆形头像网格 ── */
  const renderArtists = () => {
    if (!act.onOpenArtist) return <PcEmpty theme={theme} title="当前版本不支持打开歌手页" />
    if (singerState === 'loading') return loadingLine
    if (singerState === 'error') {
      return <PcEmpty theme={theme} title="歌手列表加载失败" description="公开接口暂时不可用" action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />} />
    }
    if (!singers.length) return <PcEmpty theme={theme} title="暂无歌手" description="接口没有返回可展示的歌手" />
    return (
      <>
        <PcCardGrid
          items={singers.map(singer => ({
            key: `singer:${singer.mid}`,
            coverUrl: singer.picUrl,
            title: singer.name,
            rounded: 'rounded-full',
            onClick: () => act.onOpenArtist?.(singer.mid, 'qq'),
          }))}
          theme={theme}
          accent={accent}
          columns={6}
          showPlayOnHover={false}
        />
        {singerHasMore ? (
          <div className="mt-6 flex justify-center">
            <PcGhostButton
              label="加载更多歌手"
              theme={theme}
              disabled={singerLoadingMore}
              onClick={() => loadSingers(singerPageRef.current + 1, true)}
            />
          </div>
        ) : null}
      </>
    )
  }

  /* ── 排行：官方榜单目录（聚合接口透传 top/category 全量）；目录不可用时退回货架榜单卡 ── */
  const renderCharts = () => {
    if (!act.onOpenChart) return <PcEmpty theme={theme} title="当前版本不支持打开榜单" />
    // 优先：聚合接口的「全部榜单」目录（公开接口，未登录也能看）
    if (directoryCharts.length) {
      return (
        <PcCardGrid
          items={directoryCharts.map(chart => ({
            key: `chart-dir:${chart.id}`,
            coverUrl: chart.coverUrl,
            title: chart.name,
            subtitle: chart.group || undefined,
            onClick: () => act.onOpenChart?.(chart),
          }))}
          theme={theme}
          accent={accent}
          columns={6}
          showPlayOnHover={false}
        />
      )
    }
    // 目录未就绪：货架里已有榜单卡就先展示，货架也没有才等目录
    if (charts.length) {
      return (
        <PcCardGrid
          items={charts.map(chart => ({
            key: `chart:${chart.id}`,
            coverUrl: chart.coverUrl,
            title: chart.name,
            subtitle: chart.group || undefined,
            onClick: () => act.onOpenChart?.(chart),
          }))}
          theme={theme}
          accent={accent}
          columns={6}
          showPlayOnHover={false}
        />
      )
    }
    if (directoryState === 'loading') return loadingLine
    if (!loggedIn) {
      return <PcEmpty theme={theme} title="登录后查看官方排行榜" description="榜单目录暂时不可用，登录后可从账号货架补齐榜单" action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined} />
    }
    if (snapshotState === 'loading' && !snapshot) return loadingLine
    if (snapshotState === 'error') return snapshotErrorEmpty
    return <PcEmpty theme={theme} title="暂无榜单" description="榜单目录与账号货架里都没有榜单" />
  }

  /* ── 歌单：分类胶囊 + 歌单网格 ── */
  const renderPlaylists = () => {
    const grid = squareState === 'error'
      ? <PcEmpty theme={theme} title="歌单加载失败" description="公开接口暂时不可用" action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />} />
      : squareState === 'loading'
        ? loadingLine
        : squarePlaylists.length
          ? (
            <PcCardGrid
              items={squarePlaylists.map(playlist => {
                const open = () => act.onOpenPlaylist({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq', source: 'qq-songlist-square' })
                return {
                  key: `qq-playlist:${playlist.id}`,
                  coverUrl: playlist.coverUrl,
                  title: playlist.name,
                  subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : undefined,
                  playCount: playlist.playCount,
                  onClick: open,
                  onContextMenu: (event: ReactMouseEvent) => {
                    event.preventDefault()
                    act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: { id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq' } })
                  },
                }
              })}
              theme={theme}
              accent={accent}
              columns={6}
            />
          )
          : <PcEmpty theme={theme} title="暂无歌单" description="该分类没有返回歌单" />
    return (
      <div className="space-y-4">
        {categoryGroups.map(([group, items]) => (
          <div key={group || 'default'} className="flex items-start gap-2">
            {group ? <span className={`mt-1.5 w-10 shrink-0 text-right text-[12px] ${theme.faint}`}>{group}</span> : null}
            <PcChips
              items={items.map(item => ({ key: String(item.id), label: item.name }))}
              value={activeCategory == null ? '' : String(activeCategory)}
              onChange={key => setActiveCategory(Number(key))}
              accent={accent}
              theme={theme}
              className="flex-1"
            />
          </div>
        ))}
        <div className="pt-2">{grid}</div>
        {squareState === 'ready' && squareHasMore ? (
          <div className="flex justify-center pt-2">
            <PcGhostButton
              label="加载更多歌单"
              theme={theme}
              disabled={squareLoadingMore}
              onClick={loadMoreSquare}
            />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="pb-8">
      <PcPageTitle
        title="乐馆"
        theme={theme}
        extra={(
          <PcIconButton theme={theme} title="刷新" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
          </PcIconButton>
        )}
      />

      <PcChips
        items={HALL_TABS}
        value={tab}
        onChange={key => setTab(key as HallTab)}
        accent={accent}
        theme={theme}
        className="mb-5"
      />

      {tab === 'recommend' && renderShelves()}
      {tab === 'artists' && renderArtists()}
      {tab === 'charts' && renderCharts()}
      {tab === 'playlists' && renderPlaylists()}
    </div>
  )
}

export default memo(QQPcHall)

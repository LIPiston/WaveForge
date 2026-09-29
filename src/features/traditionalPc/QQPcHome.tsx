// QQ 音乐 PC 客户端「Hi xx 今日为你推荐」首页（逆向官方 PC 布局）。
//
// 数据源：**QQ 客户端的原生推荐流**（`music.recommend.RecommendFeed/get_recommend_feed`，
// 走 qqExplore 的 bootstrap 接口），不是探索页那套聚合数据——后者来自手机端模块，
// 卡片内容与 PC 客户端对不上（实测过：PC 流的模块标题就是「Hi <昵称>  今日为你推荐」，
// 卡片顺序/类型与客户端首页一一对应：猜你喜欢大卡 + 每日30首/雷达模式/百万收藏/新歌推荐/歌手漫游 + 自定义）。
//
// 结构：顶部个性标题 → 一行卡（一张主推大卡 + 彩色功能卡 + 自定义小位）→「你的歌单宝藏库」封面货架。
// 卡片点击严格按 feed 里的 action 分发；数据拿不到就整块不渲染，不伪造数字。无任何下载类入口。
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { Compass, Play } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { ExplorePayload } from '../../services/exploreApi'
import { fetchExploreRecommendationBatch } from '../../services/exploreApi'
import { fetchQQExploreBootstrap, fetchQQRadarSongs } from '../qqExplore/api'
import { qqCardPlaylist, type QQExploreCard, type QQExploreModule } from '../qqExplore/model'
import { PcCardGrid, PcEmpty, PcPrimaryButton, PcSectionTitle, pcTheme, type PcTone } from './pcKit'
import type { PcActions, PcAccount, PcChrome } from './types'

/** 主推卡的蓝色渐变 + 绿色播放按钮（官方 For You 卡配色语义）。 */
const PROMO_GRADIENT = 'linear-gradient(112deg, #3E86F5 0%, #5EA6F9 48%, #8CC6FF 100%)'
const PROMO_PLAY_GREEN = '#1FCB57'
/** 推荐语缺失时的固定文案（官方 For You 卡原文）。 */
const FALLBACK_RECOMMENDATION_LINE = '尝试来点儿音乐提提神吧~'
/** 彩色功能卡的底条配色：官方每张卡颜色不同，这里按位次循环（纯装饰，不表示任何数据）。 */
const CARD_BAR_COLORS = ['#4A9DF8', '#F0A03C', '#8B5CF6', '#22C55E', '#EC5B8B']
const DEFAULT_ACCENT = '#31c27c'

export interface QQPcHomeProps {
  /** 聚合 payload：仅用于「歌单宝藏库」在 PC 歌单接口不可用时的兜底。 */
  payload: ExplorePayload | null
  chrome?: PcChrome
  account?: PcAccount
  actions?: PcActions
  /** 页面是否可见（隐藏保活页为 false 时不请求） */
  active?: boolean
  /** 旧接线兼容（父层若还按老 props 传） */
  username?: string
  loggedIn?: boolean
  muted?: string
  surface?: string
}

const EMPTY_ACTIONS: PcActions = { onPlaySongs: () => {}, onSongMenu: () => {}, onOpenPlaylist: () => {}, onNavigate: () => {} }

const artistLine = (song: Song): string => (song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')

interface TreasureItem { key: string; coverUrl?: string; title: string; subtitle?: string; playCount?: number; playlist: any }

function QQPcHome({ payload, chrome, account, actions, active = true, username, loggedIn, muted }: QQPcHomeProps) {
  // 旧接线兼容：父层的 muted token 里含 white 即深色皮肤
  const tone: PcTone = chrome?.tone ?? (typeof muted === 'string' && muted.includes('white') ? 'dark' : 'light')
  const theme = pcTheme(tone)
  const accent = chrome?.accent || DEFAULT_ACCENT
  const act = useMemo<PcActions>(() => ({ ...EMPTY_ACTIONS, ...(actions || {}) }), [actions])
  const isLoggedIn = account?.loggedIn ?? Boolean(loggedIn)
  const displayName = account?.username || username || ''

  const [modules, setModules] = useState<QQExploreModule[]>([])
  const [daily30, setDaily30] = useState<{ playlistId?: string; title?: string; coverUrl?: string; songs?: Song[]; dateKey?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [notice, setNotice] = useState('')
  const [treasure, setTreasure] = useState<TreasureItem[]>([])

  // PC 原生推荐流（含每日 30 首）；失败时不报错，交给下面的空态
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    void fetchQQExploreBootstrap()
      .then(snapshot => {
        if (cancelled) return
        setModules(snapshot?.feed?.modules || [])
        setDaily30(snapshot?.daily30 || null)
      })
      .catch(() => { if (!cancelled) setModules([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active])

  // 歌单宝藏库：走 QQ 公开歌单广场的「推荐」分类（music_cover + 标题|副标题，与客户端同款卡片）；
  // 接口异常时退回聚合 payload 的歌单，保证这一块不会空着。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const fallback = () => {
      if (payload?.playlists?.length) {
        setTreasure(payload.playlists.slice(0, 18).map((playlist, index) => ({
          key: `payload:${playlist.platform || 'qq'}:${playlist.id || index}`,
          title: playlist.name,
          subtitle: playlist.creator || undefined,
          coverUrl: playlist.coverUrl,
          playCount: playlist.playCount,
          playlist,
        })))
      }
    }
    void fetch('http://localhost:3001/api/qq/songlist/list?id=10000000&page=1&pageSize=18&sort=5', { cache: 'no-store' })
      .then(response => response.json())
      .then(data => {
        if (cancelled) return
        const list: any[] = data?.list || data?.data?.list || []
        const items: TreasureItem[] = list.map((item, index) => {
          const title = String(item.title || item.dissname || item.name || '').trim()
          if (!title) return null
          const id = String(item.dissid || item.content_id || item.tid || item.id || index)
          const coverUrl = String(item.picurl || item.cover || item.imgurl || '').replace(/^http:/, 'https:')
          return {
            key: `treasure:${id}`,
            title,
            // 官方这类卡片把「标题 | 副标题」拼在一行显示，副标题缺失就不拼
            subtitle: String(item.subtitle || '').trim() || undefined,
            coverUrl,
            playCount: Number(item.listennum || item.playcount || 0) || undefined,
            playlist: { id, name: title, coverUrl, platform: 'qq' as const, source: 'qq-songlist-recommend' },
          } as TreasureItem
        }).filter((item): item is TreasureItem => Boolean(item))
        if (items.length) setTreasure(items)
        else fallback()
      })
      .catch(() => { if (!cancelled) fallback() })
    return () => { cancelled = true }
  }, [active, payload])

  const heroModule = modules[0]
  const heroCards = useMemo(() => (heroModule?.cards || []).filter(card => card.action?.type !== 'unsupported'), [heroModule])

  /** 主推大卡：优先 style 201/203 的电台类卡片（官方就是这张蓝色大卡）。 */
  const promoCard = useMemo(() => heroCards.find(card => (card.style === 201 || card.style === 203) && (card.action?.type === 'play-radio' || card.action?.type === 'play-songs'))
    || heroCards.find(card => card.style === 201 || card.style === 203)
    || null, [heroCards])
  /** 彩色功能卡：style 202（每日30首 / 雷达模式 / 百万收藏 / 新歌推荐 / 歌手漫游…），最多 4 张。 */
  // 客户端的 Hero 行 = 主推大卡 + 4 张彩色卡；彩色卡只取 type 500（每日30首/官方歌单），
  // 900 的「雷达模式 / 自定义」不进这一行（客户端把它们放在别处）
  const featureCards = useMemo(() => heroCards.filter(card => card.style === 202 && card.type === 500).slice(0, 4), [heroCards])

  const runCard = useCallback(async (card: QQExploreCard) => {
    const type = card.action?.type
    const key = card.id || card.title
    try {
      setNotice('')
      setBusyKey(key)
      switch (type) {
        case 'play-radio': {
          // 猜你喜欢：拉一批电台歌曲直接播放（与探索页同一接口）
          const songs = await fetchExploreRecommendationBatch('qq', 0, [])
          if (!songs.length) throw new Error('猜你喜欢暂时没有返回歌曲')
          act.onPlaySongs(songs[0], songs, 0)
          return
        }
        case 'play-radar': {
          const result = await fetchQQRadarSongs({ page: 1, reqType: 0, entranceSongs: [] })
          const songs: Song[] = result?.songs || []
          if (!songs.length) throw new Error('雷达模式暂时没有返回歌曲')
          act.onPlaySongs(songs[0], songs, 0)
          return
        }
        case 'play-songs': {
          const songs = card.songs || []
          if (!songs.length) throw new Error('这张卡片暂时没有可播放的歌曲')
          act.onPlaySongs(songs[0], songs, 0)
          return
        }
        case 'open-playlist': {
          // 每日30首走 PC 流的槽位（客户端也是打开这张歌单）
          if (card.subtype === 510 && daily30?.playlistId) {
            act.onOpenPlaylist({
              id: String(daily30.playlistId),
              name: daily30.title || card.title || '每日30首',
              coverUrl: daily30.coverUrl || card.coverUrl || card.songs?.[0]?.album?.picUrl || '',
              platform: 'qq' as const,
              source: 'qq-daily-30',
            })
            return
          }
          const playlist = qqCardPlaylist(card)
          if (!playlist) throw new Error('这张卡片暂时打不开')
          act.onOpenPlaylist(playlist)
          return
        }
        case 'open-preferences':
          act.onNavigate({ kind: 'qq', page: 'settings' })
          return
        default:
          return
      }
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '暂时无法打开，请稍后再试')
    } finally {
      setBusyKey('')
    }
  }, [act, daily30])

  const featureLabel = useCallback((card: QQExploreCard): { label: string; caption: string; subtitle: string } => {
    // 每日30首：用 PC 流的真实文案 + 首曲
    if (card.subtype === 510) {
      const first = daily30?.songs?.[0]
      return {
        label: 'Daily 30',
        caption: card.subtitle || (first ? `${first.name} - ${artistLine(first)}` : (daily30?.title || '每日30首')),
        subtitle: '每日30首',
      }
    }
    const first = card.songs?.[0]
    // 标签优先用 feed 自带的官方名（客户端就是显示这个，如 "Daily 30" / "Million Fav"），
    // 没有才退歌单中文名——不编造
    const layerTitle = String((card as { layerTitle?: string }).layerTitle || '').trim()
    return {
      label: layerTitle || card.title || '推荐',
      caption: card.subtitle || (first ? `${first.name} - ${artistLine(first)}` : (card.reason || '')),
      subtitle: card.title || card.reason || '',
    }
  }, [daily30])

  const hasHero = Boolean(promoCard || featureCards.length)
  const nothingAtAll = !loading && !hasHero && treasure.length === 0

  if (!isLoggedIn && nothingAtAll) {
    return (
      <PcEmpty
        theme={theme}
        title="登录后解锁个性化推荐"
        description="QQ 音乐的推荐流需要登录态"
        action={<PcPrimaryButton label="立即登录" accent={accent} onClick={() => act.onLogin?.()} />}
      />
    )
  }
  if (nothingAtAll) {
    return <PcEmpty theme={theme} title="暂时没有可用的推荐内容" description="稍后再试，或到乐馆逛逛" />
  }

  return (
    <div className="pb-8">
      <h1 className={`mb-5 text-[22px] font-semibold tracking-tight ${theme.text}`}>
        {displayName ? `Hi ${displayName}` : 'Hi'} <span className="font-normal">今日为你推荐</span>
      </h1>

      {notice ? <div className={`mb-4 rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>{notice}</div> : null}

      {/* 卡行：主推大卡 + 彩色功能卡 + 自定义位（列模板按实际卡数生成，避免自定义被挤到第二行） */}
      {hasHero && (
        <div
          className="mb-9 grid grid-cols-2 gap-3 lg:grid-cols-[var(--qq-hero-cols)]"
          style={{ '--qq-hero-cols': `2.4fr repeat(${Math.max(1, featureCards.length)}, minmax(0, 1fr))` } as CSSProperties}
        >
          {promoCard && (() => {
            const caption = promoCard.subtitle || promoCard.reason || FALLBACK_RECOMMENDATION_LINE
            const cover = promoCard.coverUrl || promoCard.songs?.[0]?.album?.picUrl
            const busy = busyKey === (promoCard.id || promoCard.title)
            return (
              <button
                type="button"
                onClick={() => { void runCard(promoCard) }}
                disabled={busy}
                className="col-span-2 flex h-[188px] items-stretch justify-between gap-4 overflow-hidden rounded-2xl px-6 py-5 text-left transition hover:brightness-[1.03] disabled:opacity-80 lg:col-span-1"
                style={{ background: PROMO_GRADIENT }}
              >
                <span className="flex min-w-0 flex-1 flex-col justify-between">
                  <span>
                    <span className="block truncate text-[26px] font-semibold leading-tight text-white">{promoCard.title || '猜你喜欢'}</span>
                    <span className="mt-2 line-clamp-2 block max-w-[15rem] text-[13px] leading-snug text-white/85">{caption}</span>
                  </span>
                  <span className="mt-3 flex h-11 w-11 items-center justify-center rounded-full" style={{ background: PROMO_PLAY_GREEN }}>
                    <Play className="h-5 w-5 fill-white text-white" />
                  </span>
                </span>
                {cover ? (
                  <span className="relative hidden w-[132px] shrink-0 self-center overflow-hidden rounded-xl shadow-lg sm:block">
                    <img src={cover} alt={promoCard.title || '推荐封面'} className="h-[132px] w-[132px] object-cover" loading="eager" referrerPolicy="no-referrer" />
                  </span>
                ) : null}
              </button>
            )
          })()}

          {featureCards.map((card, index) => {
            const { label, caption, subtitle } = featureLabel(card)
            const cover = card.coverUrl || card.songs?.[0]?.album?.picUrl
            const busy = busyKey === (card.id || card.title)
            return (
              <button
                key={card.id || `${card.title}:${index}`}
                type="button"
                onClick={() => { void runCard(card) }}
                disabled={busy}
                className="group flex min-w-0 flex-col text-left disabled:opacity-80"
              >
                <span className="relative block aspect-[1.55] w-full overflow-hidden rounded-2xl">
                  {cover
                    ? <img src={cover} alt={card.title || '推荐封面'} className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                    : <span className={`flex h-full w-full items-center justify-center ${theme.surface}`}><Compass className={`h-6 w-6 ${theme.faint}`} /></span>}
                  {/* 官方：实色标签条压在封面底部 */}
                  <span className="absolute inset-x-0 bottom-0 flex h-9 items-center px-3 text-[15px] font-semibold text-white" style={{ background: CARD_BAR_COLORS[index % CARD_BAR_COLORS.length] }}>
                    <span className="truncate">{label}</span>
                  </span>
                </span>
                <span className={`mt-2 truncate text-[13px] ${theme.text}`}>{caption}</span>
                <span className={`truncate text-[12px] ${theme.subtle}`}>{subtitle}</span>
              </button>
            )
          })}

        </div>
      )}

      {/* 你的歌单宝藏库 */}
      {treasure.length > 0 && (
        <section>
          <PcSectionTitle title="你的歌单宝藏库" theme={theme} />
          <PcCardGrid
            items={treasure.map(item => ({
              key: item.key,
              coverUrl: item.coverUrl,
              title: item.subtitle ? `${item.title} | ${item.subtitle}` : item.title,
              playCount: item.playCount,
              onClick: () => act.onOpenPlaylist(item.playlist),
              onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: item.playlist }) },
            }))}
            theme={theme}
            accent={accent}
            columns={6}
          />
        </section>
      )}

      {loading && !hasHero && treasure.length === 0 ? <PcEmpty theme={theme} title="正在加载今日推荐…" /> : null}

    </div>
  )
}

export default memo(QQPcHome)

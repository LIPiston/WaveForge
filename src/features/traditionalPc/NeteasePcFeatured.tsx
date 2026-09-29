// 网易云音乐 PC 客户端「精选」页复刻（传统模式中栏）。
//
// 顶部是横排频道文字页签（选中加粗 + 强调色，不是胶囊），右侧「更多∨」列出音乐风格分类；
// 子页分工：精选 = 官方歌单大卡 + 最新音乐三列 + 排行榜；歌单广场/曲风频道 = 分类 + 封面墙分页；
// 排行榜 = 榜单卡；歌手 = 地区/性别分类 + 歌手列表；VIP = 会员等级与权益。
// 数据全部走已有接口；某一路没有数据时只降级该区块（空态），不挡其它区块。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Loader2, Play, UserRound } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { normalizeNeteaseSongs } from '../neteaseExplore/api'
import {
  fetchNeteasePlaylistSquare, fetchNeteaseToplist, fetchNeteaseVipPage, normalizeNeteaseSquareBlocks, normalizeNeteaseToplistBlocks,
} from '../neteaseExplore/discover'
import { neteaseResourceArtwork, type NeteaseNativeBlock, type NeteaseNativeResource } from '../neteaseExplore/model'
import {
  PcCardGrid, PcChips, PcCountBadge, PcCover, PcEmpty, PcGhostButton, PcSectionTitle, PcSongBadges, PcSongTable,
  pcSongArtwork, pcSongKey, pcTheme, type PcCardItem, type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  active?: boolean
  currentSongKey?: string
  currentSong?: Song | null
  /** 可选：入口指定初始频道（例如「私人雷达」兜底跳到排行榜） */
  initialChannel?: string
}

type ChannelKey = 'featured' | 'square' | 'charts' | 'artist' | 'vip' | 'classic' | 'western' | 'cantonese' | 'drive' | 'global'

interface ChannelDef { key: ChannelKey; label: string; category?: string }

// 官方频道顺序；曲风类频道没有独立数据源，直接复用歌单广场的分类查询
const CHANNELS: ChannelDef[] = [
  { key: 'featured', label: '精选' },
  { key: 'square', label: '歌单广场' },
  { key: 'charts', label: '排行榜' },
  { key: 'artist', label: '歌手' },
  { key: 'vip', label: 'VIP' },
  { key: 'classic', label: '经典', category: '经典' },
  { key: 'western', label: '欧美', category: '欧美' },
  { key: 'cantonese', label: '粤语', category: '粤语' },
  { key: 'drive', label: '驾车', category: '驾车' },
  { key: 'global', label: '全球', category: '全球' },
]

const FALLBACK_CATEGORIES = ['全部', '华语', '欧美', '电子', '流行', '摇滚', '民谣', '古典', '说唱', '古风', '轻音乐', '爵士']

const ARTIST_AREAS = [{ label: '全部', id: -1 }, { label: '华语', id: 7 }, { label: '欧美', id: 96 }, { label: '日本', id: 8 }, { label: '韩国', id: 16 }, { label: '其他', id: 0 }]
const ARTIST_TYPES = [{ label: '全部', id: -1 }, { label: '男', id: 1 }, { label: '女', id: 2 }, { label: '乐队/组合', id: 3 }]

/** 站点公开数据（精品歌单/新歌/歌手/catlist）无需 cookie，直接走本地网关。 */
async function fetchPublicJson(path: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${getApiBase()}${path}`, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`)
  return data
}

/** 歌单卡片去重（歌单广场翻页与分类切换都会重复下发同一批高热歌单）。 */
function dedupePlaylists<T extends { id: string | number }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter(item => {
    const key = String(item.id)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 新歌接口 result[] → 本地 Song（PC 端字段与 App 侧不同，这里单独归一化）。 */
function normalizeNewsongSongs(payload: any): Song[] {
  const list = Array.isArray(payload?.result) ? payload.result : []
  const songs = list.map((entry: any) => {
    const track = entry?.song || entry || {}
    const album = track?.al || track?.album || {}
    const artists = track?.ar || track?.artists || entry?.artists || []
    return {
      id: Number(track?.id || entry?.id || 0),
      name: String(track?.name || entry?.name || ''),
      artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
      album: {
        id: Number(album?.id) || undefined,
        name: String(album?.name || ''),
        picUrl: String(album?.picUrl || album?.blurPicUrl || entry?.picUrl || '').replace(/^http:/, 'https:'),
      },
      duration: Number(track?.dt || track?.duration || 0),
      platform: 'netease' as const,
      fee: Number(track?.fee || 0),
      vip: Number(track?.fee) === 1,
      requiredTier: Number(track?.fee) === 1 ? 'vip' as const : 'free' as const,
    }
  }).filter((song: Song) => song.id && song.name)
  return dedupePlaylists(songs)
}

/** 歌单资源 → 传统模式歌单页形状（TraditionalView 按 id + platform 拉曲目）。 */
function playlistOf(resource: NeteaseNativeResource, source: string) {
  const playlist = resource.playlist
  if (!playlist?.id) return null
  return {
    ...playlist,
    name: playlist.name || resource.title || '歌单',
    coverUrl: playlist.coverUrl || neteaseResourceArtwork(resource),
    playCount: playlist.playCount ?? resource.playCount,
    platform: 'netease' as const,
    source,
  }
}

/** 榜单资源 → onOpenChart 载荷（不带预览曲目，由 TraditionalView 自己拉全量）。 */
function chartOf(resource: NeteaseNativeResource) {
  return {
    id: resource.id,
    name: resource.title || '排行榜',
    group: '',
    coverUrl: neteaseResourceArtwork(resource),
    platform: 'netease' as const,
    songs: [] as Array<{ id?: number; name: string; artist: string }>,
  }
}

/* ------------------------------------------------------------------ *
 * 精选子页
 * ------------------------------------------------------------------ */

function FeaturedPanel({ theme, accent, actions, active, onOpenChannel }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
  onOpenChannel: (key: ChannelKey) => void
}) {
  const [official, setOfficial] = useState<any[]>([])
  const [officialLoading, setOfficialLoading] = useState(true)
  const [songs, setSongs] = useState<Song[]>([])
  const [songsLoading, setSongsLoading] = useState(true)
  const [charts, setCharts] = useState<NeteaseNativeResource[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  // 官方歌单：精品歌单（公开）优先，空则退热门歌单
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setOfficialLoading(true)
    void (async () => {
      let list: any[] = []
      try {
        const data = await fetchPublicJson('/netease/playlist/highquality?limit=12', controller.signal)
        list = Array.isArray(data?.playlists) ? data.playlists : []
      } catch { /* 退热门歌单 */ }
      if (controller.signal.aborted) return
      if (list.length === 0) {
        try {
          const data = await fetchPublicJson('/netease/playlist/hot?limit=12', controller.signal)
          list = Array.isArray(data?.playlists) ? data.playlists : []
        } catch { /* 空态 */ }
      }
      if (controller.signal.aborted) return
      setOfficial(list.slice(0, 6))
      setOfficialLoading(false)
    })()
    return () => controller.abort()
  }, [active])

  // 最新音乐
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setSongsLoading(true)
    fetchPublicJson('/netease/personalized/newsong?limit=30', controller.signal)
      .then(data => { if (!controller.signal.aborted) setSongs(normalizeNewsongSongs(data)) })
      .catch(() => { if (!controller.signal.aborted) setSongs([]) })
      .finally(() => { if (!controller.signal.aborted) setSongsLoading(false) })
    return () => controller.abort()
  }, [active])

  // 排行榜（原生 toplist，取前 6 个）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setChartsLoading(true)
    fetchNeteaseToplist(controller.signal)
      .then(list => {
        if (controller.signal.aborted) return
        const blocks = normalizeNeteaseToplistBlocks(Array.isArray(list) ? list : [])
        setCharts(blocks.flatMap(block => block.resources).slice(0, 6))
      })
      .catch(() => { if (!controller.signal.aborted) setCharts([]) })
      .finally(() => { if (!controller.signal.aborted) setChartsLoading(false) })
    return () => controller.abort()
  }, [active])

  return (
    <div className="space-y-8">
      {/* 官方歌单：一行 6 张大卡（封面中央大字标题 + 底部深色说明条） */}
      <section>
        <PcSectionTitle title="官方歌单" more="更多" onMore={() => onOpenChannel('square')} theme={theme} />
        {officialLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => <span key={`official-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
          </div>
        ) : official.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {official.map((raw, index) => {
              const name = String(raw?.name || '歌单')
              const subtitle = String(raw?.copywriter || raw?.description || raw?.creator?.nickname || '').trim()
              const playlist = {
                id: String(raw?.id || ''),
                name,
                coverUrl: String(raw?.coverImgUrl || raw?.coverUrl || '').replace(/^http:/, 'https:'),
                description: String(raw?.description || raw?.copywriter || '') || undefined,
                playCount: Number(raw?.playCount || 0) || undefined,
                trackCount: Number(raw?.trackCount || 0) || undefined,
                creator: raw?.creator?.nickname ? String(raw.creator.nickname) : undefined,
                platform: 'netease' as const,
                source: 'netease-highquality',
              }
              if (!playlist.id) return null
              return (
                <button
                  key={`official:${playlist.id}`}
                  type="button"
                  onClick={() => actions.onOpenPlaylist(playlist)}
                  onContextMenu={event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
                  className="group block text-left"
                >
                  <PcCover
                    src={playlist.coverUrl}
                    alt={name}
                    eager={index < 3}
                    className="aspect-square w-full"
                    rounded="rounded-lg"
                    overlay={(
                      <>
                        <PcCountBadge value={playlist.playCount} />
                        {/* 中央大字标题 + 底部说明条都压在封面内（官方同款）：
                            说明条放封面外时，长文案会把该行卡片撑高、整行高度不齐 */}
                        <span className="absolute inset-x-0 bottom-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/45 to-transparent px-2 pb-2 pt-6">
                          <span className="line-clamp-2 text-[11px] leading-snug text-white/90">
                            {subtitle ? `${name} | ${subtitle}` : name}
                          </span>
                        </span>
                        <span className="absolute inset-0 flex items-center justify-center px-3 pb-14">
                          <span className="line-clamp-2 text-center text-[19px] font-semibold leading-tight text-white drop-shadow-[0_1px_6px_rgba(0,0,0,.65)]">{name}</span>
                        </span>
                      </>
                    )}
                  />
                </button>
              )
            })}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无官方歌单" />
        )}
      </section>

      {/* 最新音乐：3 列歌曲行（双击播放 / 右键菜单） */}
      <section>
        <PcSectionTitle title="最新音乐" theme={theme} />
        {songsLoading ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 9 }).map((_, index) => <span key={`newsong-skeleton:${index}`} className={`block h-14 animate-pulse rounded-md ${theme.surface}`} />)}
          </div>
        ) : songs.length > 0 ? (
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
            {songs.slice(0, 21).map((song, index) => (
              <div
                key={`new:${pcSongKey(song)}:${index}`}
                onDoubleClick={() => actions.onPlaySongs(song, songs, index)}
                onContextMenu={event => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song }) }}
                className={`group flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 transition ${theme.hover}`}
              >
                <span className="relative shrink-0">
                  <PcCover src={pcSongArtwork(song)} alt={song.name} className="h-10 w-10" rounded="rounded-md" />
                  <button
                    type="button"
                    onClick={() => actions.onPlaySongs(song, songs, index)}
                    aria-label={`播放 ${song.name}`}
                    className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 opacity-0 transition group-hover:opacity-100"
                  >
                    <Play className="h-3.5 w-3.5 fill-current text-white" />
                  </button>
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`flex items-center gap-1.5 text-[13px] ${theme.text}`}>
                    <span className="truncate">{song.name}</span>
                    <PcSongBadges song={song} skin="netease" />
                  </span>
                  <span className={`mt-[2px] block truncate text-[12px] ${theme.subtle}`}>
                    {(song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')}
                  </span>
                </span>
                <span className={`hidden w-[30%] shrink-0 truncate text-right text-[12px] lg:block ${theme.faint}`}>{song.album?.name || ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无最新音乐" />
        )}
      </section>

      {/* 排行榜：前 6 张榜单卡 */}
      <section>
        <PcSectionTitle title="排行榜" more="更多" onMore={() => onOpenChannel('charts')} theme={theme} />
        {chartsLoading ? (
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => <span key={`chart-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
          </div>
        ) : charts.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 lg:grid-cols-6">
            {charts.map(resource => (
              <button key={`chart:${resource.id}`} type="button" onClick={() => actions.onOpenChart?.(chartOf(resource), false)} className="group block text-left">
                <PcCover
                  src={neteaseResourceArtwork(resource)}
                  alt={resource.title}
                  className="aspect-square w-full"
                  rounded="rounded-lg"
                  overlay={(
                    <>
                      <PcCountBadge value={resource.playCount} />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                      </span>
                    </>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{resource.title}</span>
                <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{resource.subtitle || '网易云音乐榜'}</span>
              </button>
            ))}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无排行榜" />
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌单广场（歌单广场 + 曲风频道共用）
 * ------------------------------------------------------------------ */

function SquarePanel({ theme, accent, actions, active, category, categories, onCategory, showChips = true, title }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
  category: string
  categories: string[]
  onCategory: (next: string) => void
  showChips?: boolean
  title?: string
}) {
  const PAGE_SIZE = 30
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  // 官方的「全部」= 广场默认推荐流
  const queryCategory = category === '全部' ? '推荐' : category

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setItems([])
    setOffset(0)
    fetchNeteasePlaylistSquare(queryCategory, 0, PAGE_SIZE, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const blocks = normalizeNeteaseSquareBlocks(payload)
        const list = blocks.flatMap(block => block.resources)
          .map(resource => playlistOf(resource, 'netease-playlist-square'))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
        setItems(dedupePlaylists(list))
        setOffset(PAGE_SIZE)
        setHasMore(payload?.data?.hasMore !== false && list.length > 0)
      })
      .catch(() => { if (!controller.signal.aborted) { setItems([]); setHasMore(false) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, queryCategory])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const payload = await fetchNeteasePlaylistSquare(queryCategory, offset, PAGE_SIZE)
      const list = normalizeNeteaseSquareBlocks(payload).flatMap(block => block.resources)
        .map(resource => playlistOf(resource, 'netease-playlist-square'))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      setItems(previous => dedupePlaylists([...previous, ...list]))
      setOffset(value => value + PAGE_SIZE)
      setHasMore(payload?.data?.hasMore !== false && list.length > 0)
    } catch { /* 加载更多失败：保留已有内容 */ } finally { setLoadingMore(false) }
  }, [hasMore, loadingMore, offset, queryCategory])

  const cards: PcCardItem[] = useMemo(() => items.map(item => ({
    key: `square:${item.id}`,
    coverUrl: item.coverUrl,
    title: item.name,
    subtitle: item.trackCount ? `${item.trackCount} 首` : (item.creator || ''),
    playCount: item.playCount,
    onClick: () => actions.onOpenPlaylist(item),
    onContextMenu: event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: item }) },
  })), [actions, items])

  return (
    <div className="space-y-4">
      {title && <PcSectionTitle title={title} theme={theme} />}
      {showChips && (
        <PcChips
          items={categories.map(name => ({ key: name, label: name }))}
          value={category}
          onChange={onCategory}
          accent={accent}
          theme={theme}
        />
      )}
      {loading ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, index) => <span key={`square-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
        </div>
      ) : cards.length > 0 ? (
        <>
          <PcCardGrid items={cards} theme={theme} accent={accent} columns={6} />
          <div className="flex justify-center pt-2">
            {hasMore
              ? (
                <PcGhostButton
                  theme={theme}
                  label={loadingMore ? '正在加载…' : '加载更多'}
                  icon={loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  onClick={() => { void loadMore() }}
                  disabled={loadingMore}
                />
              )
              : <span className={`py-4 text-[12px] ${theme.faint}`}>没有更多了</span>}
          </div>
        </>
      ) : (
        <PcEmpty theme={theme} title="该分类暂无歌单" description="换个分类试试" />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 排行榜子页
 * ------------------------------------------------------------------ */

function ChartsPanel({ theme, accent, actions, active }: { theme: PcTheme; accent: string; actions: PcActions; active: boolean }) {
  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchNeteaseToplist(controller.signal)
      .then(list => { if (!controller.signal.aborted) setBlocks(normalizeNeteaseToplistBlocks(Array.isArray(list) ? list : [])) })
      .catch(() => { if (!controller.signal.aborted) setBlocks([]) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active])

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, index) => <span key={`charts-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
      </div>
    )
  }

  if (blocks.length === 0) return <PcEmpty theme={theme} title="暂无排行榜" />

  return (
    <div className="space-y-8">
      {blocks.map(block => (
        <section key={block.id}>
          <PcSectionTitle title={block.title || '排行榜'} theme={theme} />
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {block.resources.map(resource => (
              <button key={`chart-all:${resource.id}`} type="button" onClick={() => actions.onOpenChart?.(chartOf(resource), false)} className="group block text-left">
                <PcCover
                  src={neteaseResourceArtwork(resource)}
                  alt={resource.title}
                  className="aspect-square w-full"
                  rounded="rounded-lg"
                  overlay={(
                    <>
                      <PcCountBadge value={resource.playCount} />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                      </span>
                    </>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{resource.title}</span>
                <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{resource.subtitle || '网易云音乐榜'}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌手子页
 * ------------------------------------------------------------------ */

function ArtistPanel({ theme, accent, actions, active }: { theme: PcTheme; accent: string; actions: PcActions; active: boolean }) {
  const [area, setArea] = useState(-1)
  const [type, setType] = useState(-1)
  const [artists, setArtists] = useState<Array<{ id: number; name: string; picUrl: string; alias?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchPublicJson(`/netease/artist/list?type=${type}&area=${area}&limit=60&offset=0`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        const list = (Array.isArray(data?.artists) ? data.artists : []).map((item: any) => ({
          id: Number(item?.id || 0),
          name: String(item?.name || ''),
          picUrl: String(item?.picUrl || '').replace(/^http:/, 'https:'),
          alias: Array.isArray(item?.alias) ? String(item.alias[0] || '') : '',
        })).filter((item: { id: number; name: string }) => item.id && item.name)
        setArtists(list)
        setHasMore(list.length >= 60)
      })
      .catch(() => { if (!controller.signal.aborted) { setArtists([]); setHasMore(false) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, area, type])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const data = await fetchPublicJson(`/netease/artist/list?type=${type}&area=${area}&limit=60&offset=${artists.length}`)
      const list = (Array.isArray(data?.artists) ? data.artists : []).map((item: any) => ({
        id: Number(item?.id || 0),
        name: String(item?.name || ''),
        picUrl: String(item?.picUrl || '').replace(/^http:/, 'https:'),
        alias: Array.isArray(item?.alias) ? String(item.alias[0] || '') : '',
      })).filter((item: { id: number; name: string }) => item.id && item.name)
      setArtists(previous => {
        const seen = new Set(previous.map(item => item.id))
        return [...previous, ...list.filter((item: { id: number }) => !seen.has(item.id))]
      })
      setHasMore(list.length >= 60)
    } catch { /* 保留已有列表 */ } finally { setLoadingMore(false) }
  }, [area, artists.length, hasMore, loadingMore, type])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PcChips
          items={ARTIST_AREAS.map(item => ({ key: String(item.id), label: item.label }))}
          value={String(area)}
          onChange={next => setArea(Number(next))}
          accent={accent}
          theme={theme}
        />
        <PcChips
          items={ARTIST_TYPES.map(item => ({ key: String(item.id), label: item.label }))}
          value={String(type)}
          onChange={next => setType(Number(next))}
          accent={accent}
          theme={theme}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, index) => <span key={`artist-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-full ${theme.surface}`} />)}
        </div>
      ) : artists.length > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {artists.map(artist => (
              <button key={`artist:${artist.id}`} type="button" onClick={() => actions.onOpenArtist?.(String(artist.id), 'netease')} className="group block text-center">
                <PcCover
                  src={artist.picUrl}
                  alt={artist.name}
                  className="aspect-square w-full"
                  rounded="rounded-full"
                  overlay={(
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/25 opacity-0 transition group-hover:opacity-100">
                      <UserRound className="h-6 w-6 text-white/90" />
                    </span>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{artist.name}</span>
                {artist.alias ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{artist.alias}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex justify-center pt-2">
            {hasMore
              ? (
                <PcGhostButton
                  theme={theme}
                  label={loadingMore ? '正在加载…' : '加载更多'}
                  icon={loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  onClick={() => { void loadMore() }}
                  disabled={loadingMore}
                />
              )
              : <span className={`py-4 text-[12px] ${theme.faint}`}>没有更多了</span>}
          </div>
        </>
      ) : (
        <PcEmpty theme={theme} title="该分类暂无歌手" />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * VIP 子页
 * ------------------------------------------------------------------ */

function VipPanel({ theme, accent, actions, active }: { theme: PcTheme; accent: string; actions: PcActions; active: boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchNeteaseVipPage>> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchNeteaseVipPage(false, controller.signal)
      .then(page => { if (!controller.signal.aborted) setData(page) })
      .catch(() => { if (!controller.signal.aborted) setData(null) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active])

  if (loading) return <div className="flex min-h-40 items-center justify-center"><Loader2 className={`h-6 w-6 animate-spin ${theme.faint}`} /></div>
  if (!data || (!data.card.level && data.privileges.length === 0 && data.songs.length === 0)) {
    return <PcEmpty theme={theme} title="暂未获取到 VIP 内容" description="登录网易云会员账号后可见会员等级与权益" />
  }

  const songs = normalizeNeteaseSongs({ data: data.songs })

  return (
    <div className="space-y-6">
      <section className={`flex items-center gap-4 rounded-lg p-4 ${theme.surface}`}>
        <PcCover src={data.card.levelImage} alt="会员等级" className="h-20 w-20 shrink-0" rounded="rounded-lg" />
        <div className="min-w-0">
          <h2 className={`text-[18px] font-semibold ${theme.text}`}>{data.level.levelTitle || '黑胶 VIP'}</h2>
          <p className={`mt-1 text-[12px] ${theme.subtle}`}>
            {data.level.nextLevelTitle ? `距离 ${data.level.nextLevelTitle} 还需 ${Math.max(0, data.level.nextLevelGrowthPoint - data.level.growthPoint)} 成长值` : '已是最高等级'}
          </p>
          <p className={`mt-1 text-[12px] ${theme.faint}`}>成长值 {data.level.growthPoint}</p>
        </div>
      </section>

      {data.privileges.length > 0 && (
        <section>
          <PcSectionTitle title="会员权益" theme={theme} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {data.privileges.map(privilege => (
              <div key={`privilege:${privilege.title}`} className={`flex items-center gap-2 rounded-lg px-3 py-2 ${theme.surface}`}>
                <PcCover src={privilege.icon} alt={privilege.title} className="h-7 w-7 shrink-0" rounded="rounded-full" />
                <span className={`min-w-0 truncate text-[12px] ${theme.text}`}>{privilege.title}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {songs.length > 0 && (
        <section>
          <PcSectionTitle title="VIP 专属好歌" theme={theme} />
          <PcSongTable
            songs={songs}
            skin="netease"
            theme={theme}
            accent={accent}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            likedKeys={actions.likedKeys}
            onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
            onMenu={(event, song) => actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song })}
            onToggleLike={actions.onToggleLike}
          />
        </section>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

function NeteasePcFeatured({ chrome, account, actions, active = true, initialChannel }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const [channel, setChannel] = useState<ChannelKey>(() => (CHANNELS.some(item => item.key === initialChannel) ? initialChannel as ChannelKey : 'featured'))
  const [squareCategory, setSquareCategory] = useState('全部')
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  const [moreOpen, setMoreOpen] = useState(false)

  // 入口指定频道（如「私人雷达」兜底跳排行榜）
  useEffect(() => {
    if (initialChannel && CHANNELS.some(item => item.key === initialChannel)) setChannel(initialChannel as ChannelKey)
  }, [initialChannel])

  // 风格分类（公开接口）：只用于「更多」下拉与歌单广场分类条，拿不到就用固定分类
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchPublicJson('/netease/playlist/catlist', controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        const sub: string[] = Array.isArray(data?.sub) ? data.sub.map((item: any) => String(item?.name || '')).filter((name: string) => Boolean(name)) : []
        if (sub.length > 0) setCategories(['全部', ...Array.from(new Set<string>(sub))])
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [active])

  // 切到曲风频道时同步歌单广场分类，保证点了频道不空白
  useEffect(() => {
    const target = CHANNELS.find(item => item.key === channel)
    if (target?.category) setSquareCategory(target.category)
  }, [channel])

  const activeDef = CHANNELS.find(item => item.key === channel)

  return (
    <div className="pb-6">
      {/* 频道页签：横排文字 + 选中加粗（官方 PC「精选」页顶部） */}
      <div className="mb-6 flex items-center gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
          {CHANNELS.map(item => {
            const selected = item.key === channel
            return (
              <button
                key={`channel:${item.key}`}
                type="button"
                onClick={() => { setChannel(item.key); setMoreOpen(false) }}
                className={`shrink-0 whitespace-nowrap pb-1 text-[15px] transition ${selected ? 'font-semibold' : theme.tabIdle}`}
                style={selected ? { color: accent } : undefined}
              >
                {item.label}
              </button>
            )
          })}
        </div>
        {/* 更多∨：风格分类下拉（直接跳到歌单广场对应分类）；放在滚动容器外，避免下拉被裁切 */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMoreOpen(open => !open)}
            className={`flex items-center gap-0.5 whitespace-nowrap pb-1 text-[15px] transition ${moreOpen ? 'font-semibold' : theme.tabIdle}`}
            style={moreOpen ? { color: accent } : undefined}
            aria-expanded={moreOpen}
          >
            更多<ChevronDown className="h-4 w-4" />
          </button>
          {moreOpen && (
            <>
              <button type="button" aria-label="关闭分类菜单" className="fixed inset-0 z-40 cursor-default" onClick={() => setMoreOpen(false)} />
              <div className={`absolute right-0 top-full z-50 mt-2 w-[420px] max-w-[70vw] rounded-lg border p-3 shadow-2xl ${theme.divider} ${theme.tone === 'dark' ? 'bg-[#1b1b1f]' : 'bg-white'}`}>
                <div className="grid grid-cols-4 gap-1.5">
                  {categories.filter(name => name !== '全部').slice(0, 24).map(name => (
                    <button
                      key={`more:${name}`}
                      type="button"
                      onClick={() => { setSquareCategory(name); setChannel('square'); setMoreOpen(false) }}
                      className={`truncate rounded-md px-2 py-1.5 text-[12px] transition ${theme.subtle} ${theme.hover}`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {channel === 'featured' && <FeaturedPanel theme={theme} accent={accent} actions={actions} active={active} onOpenChannel={setChannel} />}

      {channel === 'square' && (
        <SquarePanel
          theme={theme} accent={accent} actions={actions} active={active}
          category={squareCategory} categories={categories} onCategory={setSquareCategory}
        />
      )}

      {channel === 'charts' && <ChartsPanel theme={theme} accent={accent} actions={actions} active={active} />}

      {channel === 'artist' && <ArtistPanel theme={theme} accent={accent} actions={actions} active={active} />}

      {channel === 'vip' && <VipPanel theme={theme} accent={accent} actions={actions} active={active} />}

      {/* 经典/欧美/粤语/驾车/全球：官方是独立曲风页，这里用同名分类的歌单广场结果，保证点了有内容 */}
      {activeDef?.category && (
        <SquarePanel
          theme={theme} accent={accent} actions={actions} active={active}
          category={activeDef.category} categories={categories} onCategory={setSquareCategory}
          showChips={false} title={`${activeDef.label}歌单`}
        />
      )}
    </div>
  )
}

export default memo(NeteasePcFeatured)

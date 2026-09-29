// 网易云 PC 客户端「关注」页复刻。
//
// 官方 PC 关注页是动态流（关注的新歌 / 关注的歌手 / 关注的用户）。我们没有动态流接口，
// 用「关注的歌手 → 每个歌手的热门歌曲混排」还原「关注的新歌」，歌手/用户页签用真实关注列表还原，
// 拿不到数据时给空态，不用假数据凑数（三个页签各自独立加载，互不阻塞）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LogIn, RefreshCw } from 'lucide-react'
import { getArtistTopSongs, getSubscribedArtists, getUserFollows } from '../../services/musicApi'
import { getPlatformCookie } from '../../services/platforms'
import type { Song } from '../../services/musicApi'
import {
  PcCardGrid, PcEmpty, PcGhostButton, PcPageTitle, PcPrimaryButton, PcSongTable, PcTabs, pcTheme,
  type PcTheme,
} from './pcKit'
import type { PcAccount, PcActions, PcChrome } from './types'

type FollowTab = 'songs' | 'artists' | 'users'

interface FollowArtist {
  id: string
  name: string
  picUrl: string
  /** 歌手作品数（官方卡片副标题用的就是它） */
  musicSize?: number
}

interface FollowUser {
  userId: string
  nickname: string
  avatarUrl: string
  signature?: string
}

/** 「关注的新歌」参与混排的歌手数量：每个歌手一次热门歌请求，太多会拖慢首屏。 */
const SONG_ARTIST_LIMIT = 8
/** 混排后的歌曲上限（官方这一栏也是有限长度的推荐流，不是全量）。 */
const SONG_LIMIT = 60
/** 一次拉取的关注用户数。 */
const USER_LIMIT = 50

/** 关注的歌手列表：兼容 data.list / artists / 裸数组几种返回形态（服务端版本差异）。 */
function parseArtistList(payload: any): FollowArtist[] {
  const candidates = [payload?.data?.list, payload?.data?.artists, payload?.artists, payload?.data, payload?.list]
  const list = candidates.find(Array.isArray) || []
  return (list as any[]).map(item => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    picUrl: String(item?.picUrl || item?.avatar || item?.img1v1Url || ''),
    musicSize: Number(item?.musicSize || item?.songSize || 0) || undefined,
  })).filter(artist => artist.id && artist.name)
}

/** 关注的用户列表：/api/netease/user/follows 返回 follow 数组。 */
function parseUserList(payload: any): FollowUser[] {
  const candidates = [payload?.follow, payload?.data?.follow, payload?.data?.list, payload?.data]
  const list = candidates.find(Array.isArray) || []
  return (list as any[]).map(item => ({
    userId: String(item?.userId || item?.id || ''),
    nickname: String(item?.nickname || item?.name || ''),
    avatarUrl: String(item?.avatarUrl || item?.avatar || ''),
    signature: String(item?.signature || '') || undefined,
  })).filter(user => user.userId && user.nickname)
}

/**
 * 多歌手热门歌交叉混排：按轮次从每个歌手取一首，而不是一个歌手接一个歌手。
 * 为什么：关注页应该是「混流」，串行拼接会变成「第一个歌手的 50 首」。
 */
function mergeArtistTopSongs(lists: Song[][]): Song[] {
  const merged: Song[] = []
  const seen = new Set<string>()
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0)
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const song = list[index]
      if (!song) continue
      const id = String(song.id || song.name)
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(song)
      if (merged.length >= SONG_LIMIT) return merged
    }
  }
  return merged
}

/** 页面内的空态/失败态统一外壳，避免三个页签各写一遍。 */
function EmptyBlock({ theme, title, description, onRetry, retrying }: { theme: PcTheme; title: string; description?: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <PcEmpty
      theme={theme}
      title={title}
      description={description}
      action={onRetry ? (
        <PcGhostButton
          label="重试"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />}
          theme={theme}
          onClick={onRetry}
          disabled={retrying}
        />
      ) : undefined}
    />
  )
}

export interface NeteasePcFollowProps {
  chrome: PcChrome
  account: PcAccount
  actions: PcActions
  authRevision?: number
  /** 隐藏保活页为 false：非 active 时不拉数据 */
  active?: boolean
}

function NeteasePcFollow({ chrome, account, actions, authRevision, active = true }: NeteasePcFollowProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)
  const userId = String(account.userId || '')

  const [tab, setTab] = useState<FollowTab>('songs')
  // reloadToken 用于「刷新」按钮/登录态变化后的重新加载
  const [reloadToken, setReloadToken] = useState(0)

  const [artists, setArtists] = useState<FollowArtist[]>([])
  const [artistsLoading, setArtistsLoading] = useState(false)
  const [artistsError, setArtistsError] = useState('')

  const [songs, setSongs] = useState<Song[]>([])
  const [songsLoading, setSongsLoading] = useState(false)
  const [songsError, setSongsError] = useState('')

  const [users, setUsers] = useState<FollowUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')

  const refresh = useCallback(() => setReloadToken(value => value + 1), [])
  // 已加载标记：页签来回切换时不重复打接口（authRevision / 刷新按钮变化才重新拉）
  const loadKey = `${authRevision ?? 0}:${reloadToken}`
  const artistsKeyRef = useRef('')
  const usersKeyRef = useRef('')

  // 关注的歌手：「关注的新歌」也要用它做种子，所以两个页签共用一个加载入口
  useEffect(() => {
    if (!active || !loggedIn) return
    if (tab !== 'songs' && tab !== 'artists') return
    if (artistsKeyRef.current === loadKey) return
    let cancelled = false
    setArtistsLoading(true)
    setArtistsError('')
    // getSubscribedArtists 内部就是 /api/netease/artist/sublist，失败返回 null（不抛错）
    getSubscribedArtists('netease', { cookie: getPlatformCookie('netease') })
      .then(payload => {
        if (cancelled) return
        artistsKeyRef.current = loadKey
        const list = parseArtistList(payload)
        setArtists(list)
        setArtistsLoading(false)
        if (!payload || list.length === 0) setArtistsError('没有读取到关注的歌手')
      })
      .catch(() => {
        if (cancelled) return
        setArtists([])
        setArtistsError('关注的歌手加载失败')
        setArtistsLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, authRevision, reloadToken, loadKey])

  // 关注的新歌：对前若干位关注的歌手各取热门歌，再交叉混排
  // artists 数组引用作为「种子已换过」的判定：页签来回切换不重算，刷新/登录态变化才会生成新数组
  const loadedArtistsRef = useRef<FollowArtist[] | null>(null)
  useEffect(() => {
    if (!active || !loggedIn) return
    if (tab !== 'songs') return
    if (!artists.length) return
    if (loadedArtistsRef.current === artists) return
    loadedArtistsRef.current = artists
    let cancelled = false
    setSongsLoading(true)
    setSongsError('')
    const seeds = artists.slice(0, SONG_ARTIST_LIMIT)
    Promise.all(seeds.map(artist => getArtistTopSongs(artist.id, 'netease').catch(() => [] as Song[])))
      .then(lists => {
        if (cancelled) return
        const merged = mergeArtistTopSongs(lists)
        setSongs(merged)
        setSongsLoading(false)
        if (merged.length === 0) setSongsError('关注歌手的热门歌曲暂不可用')
      })
      .catch(() => {
        if (cancelled) return
        setSongs([])
        setSongsError('关注的新歌加载失败')
        setSongsLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, artists, authRevision, reloadToken])

  // 关注的用户：只在用户页签请求
  useEffect(() => {
    if (!active || !loggedIn) return
    if (tab !== 'users') return
    if (usersKeyRef.current === loadKey) return
    if (!userId) {
      setUsers([])
      setUsersError('未获取到账号 ID，请重新登录网易云音乐')
      return
    }
    let cancelled = false
    setUsersLoading(true)
    setUsersError('')
    getUserFollows(userId, { cookie: getPlatformCookie('netease'), limit: USER_LIMIT })
      .then(payload => {
        if (cancelled) return
        usersKeyRef.current = loadKey
        const list = parseUserList(payload)
        setUsers(list)
        setUsersLoading(false)
        if (list.length === 0) setUsersError('没有读取到关注的用户')
      })
      .catch(() => {
        if (cancelled) return
        setUsers([])
        setUsersError('关注的用户加载失败')
        setUsersLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, userId, authRevision, reloadToken, loadKey])

  const tabItems = useMemo(() => [
    { key: 'songs', label: '关注的新歌', count: songs.length || undefined },
    { key: 'artists', label: '关注的歌手', count: artists.length || undefined },
    { key: 'users', label: '关注的用户', count: users.length || undefined },
  ], [songs.length, artists.length, users.length])

  const artistCards = useMemo(() => artists.map(artist => ({
    key: `artist:${artist.id}`,
    coverUrl: artist.picUrl,
    title: artist.name,
    subtitle: artist.musicSize ? `${artist.musicSize} 首歌曲` : '已关注',
    rounded: 'rounded-full',
    onClick: () => actions.onOpenArtist?.(artist.id, 'netease'),
  })), [artists, actions])

  const userCards = useMemo(() => users.map(user => ({
    key: `user:${user.userId}`,
    coverUrl: user.avatarUrl,
    title: user.nickname,
    subtitle: user.signature || '已关注',
    rounded: 'rounded-full',
    // 没有用户主页参数通道，这里只做「打开个人中心」的导航
    onClick: () => actions.onNavigate({ kind: 'netease', page: 'profile' }),
  })), [users, actions])

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="关注" subtitle="登录后查看关注的歌手、新歌与用户" />
        <PcEmpty
          theme={theme}
          title="登录后查看关注动态"
          description="关注的歌手、关注的新歌与关注的用户都来自你的网易云音乐账号"
          action={<PcPrimaryButton label="立即登录" icon={<LogIn className="h-3.5 w-3.5" />} accent={accent} onClick={() => actions.onLogin?.()} />}
        />
      </div>
    )
  }

  return (
    <div className="pb-8">
      <PcPageTitle theme={theme} title="关注" subtitle="关注的歌手与他们的热门歌曲" />

      <div className={`mb-4 flex flex-wrap items-end justify-between gap-4 border-b pb-2 ${theme.divider}`}>
        <PcTabs items={tabItems} value={tab} onChange={key => setTab(key as FollowTab)} accent={accent} theme={theme} />
        <div className="flex items-center gap-2">
          <PcGhostButton
            label="刷新"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${songsLoading || artistsLoading || usersLoading ? 'animate-spin' : ''}`} />}
            theme={theme}
            onClick={refresh}
            disabled={songsLoading || artistsLoading || usersLoading}
          />
          {tab === 'songs' && <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />}
        </div>
      </div>

      {tab === 'songs' && (
        <>
          {artistsError && !artists.length ? (
            <EmptyBlock theme={theme} title="未能读取关注的歌手" description={artistsError} onRetry={refresh} retrying={artistsLoading} />
          ) : (
            <PcSongTable
              songs={songs}
              skin={chrome.skin}
              theme={theme}
              accent={accent}
              loading={songsLoading || artistsLoading}
              columns={{ index: true, like: true, album: true, duration: true }}
              playingKey={actions.currentSongKey}
              isPlaying={actions.isPlaying}
              onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
              onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
              likedKeys={actions.likedKeys}
              onToggleLike={actions.onToggleLike}
              empty={(
                <EmptyBlock
                  theme={theme}
                  title="关注的新歌暂无内容"
                  description={songsError || '关注歌手后，这里会混排他们的热门歌曲'}
                  onRetry={refresh}
                  retrying={songsLoading}
                />
              )}
            />
          )}
        </>
      )}

      {tab === 'artists' && (
        artistsLoading && !artists.length ? (
          <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载关注的歌手…</div>
        ) : artists.length === 0 ? (
          <EmptyBlock theme={theme} title="还没有关注歌手" description={artistsError || '在歌手页点关注后，这里会显示关注的歌手'} onRetry={refresh} retrying={artistsLoading} />
        ) : (
          <PcCardGrid items={artistCards} theme={theme} accent={accent} columns={6} showPlayOnHover={false} />
        )
      )}

      {tab === 'users' && (
        usersLoading && !users.length ? (
          <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载关注的用户…</div>
        ) : users.length === 0 ? (
          <EmptyBlock theme={theme} title="还没有关注用户" description={usersError || '关注用户后，这里会显示他们的头像与昵称'} onRetry={refresh} retrying={usersLoading} />
        ) : (
          <PcCardGrid items={userCards} theme={theme} accent={accent} columns={6} showPlayOnHover={false} />
        )
      )}
    </div>
  )
}

export default memo(NeteasePcFollow)

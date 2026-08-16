import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, ListMusic, Loader2, LogIn, Music, Play, RotateCw, Search, Sparkles } from 'lucide-react'
import type { Song } from '../services/musicApi'
import type { SongSelectHandler } from '../types/playbackNavigation'
import {
  APPLE_EXPLORE_COUNTRIES,
  findPlayableAppleSong,
  getAppleAlbumTracks,
  getAppleHotAlbums,
  getAppleHotSongs,
  getAppleLibraryPlaylists,
  getApplePlaylistTracks,
  searchAppleCatalog,
  type AppleCatalogAlbum,
  type AppleCatalogSong,
  type AppleLibraryPlaylist,
} from '../services/appleCatalog'

interface AppleExploreViewProps {
  onSongSelect: SongSelectHandler
  accentColor?: string
  /** 初始商店（来自 Apple 账号 storefront，缺省 cn） */
  initialCountry?: string
  /** 是否已登录 Apple Music（用于显示「我的歌单」） */
  appleLoggedIn?: boolean
  /** 打开 Apple 登录面板 */
  onOpenLogin?: () => void
}

type AppleTab = 'songs' | 'albums' | 'library' | 'search'

const formatDuration = (ms?: number) => {
  if (!ms) return ''
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Apple Music 探索：热门歌曲 / 热门专辑 / 目录搜索。
 * 播放走跨平台匹配（Apple 曲目 → 网易云/QQ 同款），封面与歌词仍可来自 Apple。
 */
export default function AppleExploreView({
  onSongSelect,
  accentColor = '#31e68b',
  initialCountry = 'cn',
  appleLoggedIn = false,
  onOpenLogin,
}: AppleExploreViewProps) {
  const [country, setCountry] = useState(() => (
    APPLE_EXPLORE_COUNTRIES.some(item => item.code === initialCountry) ? initialCountry : 'cn'
  ))
  const [tab, setTab] = useState<AppleTab>('songs')
  const [songs, setSongs] = useState<AppleCatalogSong[]>([])
  const [albums, setAlbums] = useState<AppleCatalogAlbum[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expandedAlbumId, setExpandedAlbumId] = useState<string | null>(null)
  const [albumTracks, setAlbumTracks] = useState<Record<string, AppleCatalogSong[]>>({})
  const [albumLoading, setAlbumLoading] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<AppleCatalogSong[]>([])
  const [searching, setSearching] = useState(false)
  // 我的歌单（需登录）
  const [playlists, setPlaylists] = useState<AppleLibraryPlaylist[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState<string | null>(null)
  const [expandedPlaylistId, setExpandedPlaylistId] = useState<string | null>(null)
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, AppleCatalogSong[]>>({})
  const [playlistLoading, setPlaylistLoading] = useState<string | null>(null)

  const cacheRef = useRef<Record<string, AppleCatalogSong[] | AppleCatalogAlbum[] | AppleLibraryPlaylist[]>>({})
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), 2600)
  }, [])

  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
  }, [])

  useEffect(() => {
    setExpandedAlbumId(null)
    setAlbumTracks({})
    void loadSongs(country)
  }, [country])

  const loadSongs = async (targetCountry: string) => {
    const key = `songs:${targetCountry}`
    const cached = cacheRef.current[key] as AppleCatalogSong[] | undefined
    if (cached) {
      setSongs(cached)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getAppleHotSongs(targetCountry, 30)
      cacheRef.current[key] = data
      setSongs(data)
      if (data.length === 0) setError('该地区暂无热门歌曲数据')
    } catch (fetchError) {
      setError('Apple 榜单加载失败，请检查网络')
    } finally {
      setLoading(false)
    }
  }

  const loadAlbums = async (targetCountry: string) => {
    const key = `albums:${targetCountry}`
    const cached = cacheRef.current[key] as AppleCatalogAlbum[] | undefined
    if (cached) {
      setAlbums(cached)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await getAppleHotAlbums(targetCountry, 24)
      cacheRef.current[key] = data
      setAlbums(data)
      if (data.length === 0) setError('该地区暂无热门专辑数据')
    } catch (fetchError) {
      setError('Apple 专辑加载失败，请检查网络')
    } finally {
      setLoading(false)
    }
  }

  const loadPlaylists = async () => {
    const cached = cacheRef.current['library'] as AppleLibraryPlaylist[] | undefined
    if (cached) {
      setPlaylists(cached)
      return
    }
    setPlaylistsLoading(true)
    setPlaylistsError(null)
    try {
      const data = await getAppleLibraryPlaylists(100)
      cacheRef.current['library'] = data
      setPlaylists(data)
      if (data.length === 0) setPlaylistsError('资料库暂无歌单')
    } catch (fetchError) {
      setPlaylistsError('Apple 歌单加载失败，请检查网络或登录状态')
    } finally {
      setPlaylistsLoading(false)
    }
  }

  const switchTab = (next: AppleTab) => {
    setTab(next)
    setError(null)
    setPlaylistsError(null)
    if (next === 'songs' && songs.length === 0) void loadSongs(country)
    if (next === 'albums' && albums.length === 0) void loadAlbums(country)
    if (next === 'library' && appleLoggedIn && playlists.length === 0) void loadPlaylists()
  }

  const togglePlaylist = async (playlist: AppleLibraryPlaylist) => {
    if (expandedPlaylistId === playlist.id) {
      setExpandedPlaylistId(null)
      return
    }
    setExpandedPlaylistId(playlist.id)
    if (playlistTracks[playlist.id]) return
    setPlaylistLoading(playlist.id)
    try {
      const tracks = await getApplePlaylistTracks(playlist.id)
      setPlaylistTracks(prev => ({ ...prev, [playlist.id]: tracks }))
    } finally {
      setPlaylistLoading(null)
    }
  }

  const playSong = async (song: AppleCatalogSong) => {
    if (busyId) return
    setBusyId(song.id)
    setNotice(null)
    try {
      const matched = await findPlayableAppleSong({ name: song.name, artistName: song.artistName, durationMs: song.durationMs })
      if (matched) {
        onSongSelect(matched, [matched], { mode: 'explore', surface: 'explore-detail' })
      } else {
        showNotice('该歌曲在网易云/QQ 未找到可播放版本')
      }
    } finally {
      setBusyId(null)
    }
  }

  const toggleAlbum = async (album: AppleCatalogAlbum) => {
    if (expandedAlbumId === album.id) {
      setExpandedAlbumId(null)
      return
    }
    setExpandedAlbumId(album.id)
    if (albumTracks[album.id]) return
    setAlbumLoading(album.id)
    try {
      const tracks = await getAppleAlbumTracks(album.id, country)
      setAlbumTracks(prev => ({ ...prev, [album.id]: tracks }))
    } finally {
      setAlbumLoading(null)
    }
  }

  const runSearch = async () => {
    const term = keyword.trim()
    if (!term || searching) return
    setSearching(true)
    setError(null)
    try {
      const results = await searchAppleCatalog(term, '', 25)
      setSearchResults(results)
      if (results.length === 0) setError('Apple Music 未搜索到相关歌曲')
    } catch (searchError) {
      setError('Apple Music 搜索失败，请检查网络')
    } finally {
      setSearching(false)
    }
  }

  const renderSongRow = (song: AppleCatalogSong, index: number, accent: string) => (
    <button
      key={song.id}
      type="button"
      onClick={() => void playSong(song)}
      className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
    >
      <span className="w-6 shrink-0 text-center text-xs tabular-nums text-white/35">{index + 1}</span>
      <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-white/[0.06]">
        {song.artworkUrl ? (
          <img src={song.artworkUrl} alt={song.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center"><Music className="h-4 w-4 text-white/30" /></span>
        )}
        <span
          className={`absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100 ${busyId === song.id ? 'opacity-100' : ''}`}
        >
          {busyId === song.id ? (
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          ) : (
            <Play className="h-4 w-4 fill-current text-white" />
          )}
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white/90">{song.name}</span>
        <span className="block truncate text-xs text-white/45">{song.artistName}{song.albumName ? ` · ${song.albumName}` : ''}</span>
      </span>
      {song.durationMs ? <span className="shrink-0 text-[10px] tabular-nums text-white/30">{formatDuration(song.durationMs)}</span> : null}
    </button>
  )

  const accent = accentColor

  return (
    <section className="mt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" style={{ color: accent }} />
            <h2 className="text-lg font-semibold text-white">Apple Music 探索</h2>
          </div>
          <p className="mt-1 text-sm text-white/45">
            来自 Apple Music 榜单与目录。点击歌曲自动在网易云/QQ 匹配可播放版本，歌词与封面仍来自 Apple。
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 text-white/35" />
          {APPLE_EXPLORE_COUNTRIES.map(item => (
            <button
              key={item.code}
              type="button"
              onClick={() => setCountry(item.code)}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                country === item.code ? 'font-medium text-[#071018]' : 'text-white/55 hover:bg-white/[0.08]'
              }`}
              style={country === item.code ? { background: accent } : undefined}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] p-1 w-fit">
        {([
          ['songs', '热门歌曲'],
          ['albums', '热门专辑'],
          ['library', '我的歌单'],
          ['search', '搜索'],
        ] as Array<[AppleTab, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
              tab === key ? 'text-[#071018]' : 'text-white/55 hover:text-white'
            }`}
            style={tab === key ? { background: accent } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="mb-3 rounded-xl border border-amber-400/25 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-300">
          {notice}
        </div>
      )}

      {tab === 'library' ? (
        !appleLoggedIn ? (
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-6 text-center">
            <ListMusic className="h-8 w-8 text-white/25" />
            <div>
              <p className="text-sm font-medium text-white/80">登录 Apple Music 查看你的歌单</p>
              <p className="mt-1 text-xs text-white/40">登录后可同步 Apple 账号资料库歌单，点击歌曲自动匹配网易云/QQ 音源播放</p>
            </div>
            <button
              type="button"
              onClick={onOpenLogin}
              className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-[#071018]"
              style={{ background: accent }}
            >
              <LogIn className="h-4 w-4" /> 登录 Apple Music
            </button>
          </div>
        ) : playlistsLoading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-white/40" />
          </div>
        ) : playlistsError && playlists.length === 0 ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] text-center">
            <p className="text-sm text-white/45">{playlistsError}</p>
            <button
              type="button"
              onClick={() => void loadPlaylists()}
              className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-[#071018]"
              style={{ background: accent }}
            >
              <RotateCw className="h-4 w-4" /> 重新加载
            </button>
          </div>
        ) : playlists.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
            <p className="text-sm text-white/45">资料库暂无歌单</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {playlists.map(playlist => (
              <div key={playlist.id} className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.04]">
                <button
                  type="button"
                  onClick={() => void togglePlaylist(playlist)}
                  className="group block w-full text-left"
                >
                  <span className="relative block aspect-square overflow-hidden bg-white/[0.05]">
                    {playlist.artworkUrl ? (
                      <img src={playlist.artworkUrl} alt={playlist.name} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                    ) : (
                      <span className="flex h-full items-center justify-center"><ListMusic className="h-8 w-8 text-white/25" /></span>
                    )}
                  </span>
                  <span className="block px-3 pb-3 pt-2.5">
                    <span className="line-clamp-1 block text-sm font-semibold text-white/90">{playlist.name}</span>
                    {playlist.trackCount != null && (
                      <span className="mt-0.5 block text-xs text-white/40">{playlist.trackCount} 首</span>
                    )}
                  </span>
                </button>
                {expandedPlaylistId === playlist.id && (
                  <div className="border-t border-white/[0.07] px-2 py-1.5">
                    {playlistLoading === playlist.id ? (
                      <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-white/40" /></div>
                    ) : (playlistTracks[playlist.id] || []).length === 0 ? (
                      <p className="py-2 text-center text-xs text-white/35">暂无曲目数据</p>
                    ) : (
                      (playlistTracks[playlist.id] || []).map((track, index) => (
                        <button
                          key={`${playlist.id}-${track.id}-${index}`}
                          type="button"
                          onClick={() => void playSong(track)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                        >
                          <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-white/30">{index + 1}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-white/75">{track.name}</span>
                          {track.durationMs ? <span className="shrink-0 text-[10px] tabular-nums text-white/30">{formatDuration(track.durationMs)}</span> : null}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      ) : tab === 'search' ? (
        <div>
          <div className="flex gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.05] px-3">
              <Search className="h-4 w-4 shrink-0 text-white/40" />
              <input
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void runSearch() }}
                placeholder="搜索 Apple Music 曲库（如：晴天 周杰伦）"
                className="w-full bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-white/35"
              />
            </div>
            <button
              type="button"
              onClick={() => void runSearch()}
              disabled={searching || !keyword.trim()}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-[#071018] transition-opacity disabled:opacity-40"
              style={{ background: accent }}
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : '搜索'}
            </button>
          </div>
          <div className="mt-4 space-y-0.5">
            {searchResults.map((song, index) => renderSongRow(song, index, accent))}
          </div>
        </div>
      ) : (
        <div>
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/40" />
            </div>
          ) : error ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] text-center">
              <p className="text-sm text-white/45">{error}</p>
              <button
                type="button"
                onClick={() => {
                  if (tab === 'albums') {
                    const key = `albums:${country}`
                    delete cacheRef.current[key]
                    void loadAlbums(country)
                  } else {
                    const key = `songs:${country}`
                    delete cacheRef.current[key]
                    void loadSongs(country)
                  }
                }}
                className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-[#071018]"
                style={{ background: accent }}
              >
                <RotateCw className="h-4 w-4" />
                重新加载
              </button>
            </div>
          ) : tab === 'songs' ? (
            <div className="space-y-0.5">
              {songs.map((song, index) => renderSongRow(song, index, accent))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {albums.map(album => (
                <div key={album.id} className="overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.04]">
                  <button
                    type="button"
                    onClick={() => void toggleAlbum(album)}
                    className="group block w-full text-left"
                  >
                    <span className="relative block aspect-square overflow-hidden bg-white/[0.05]">
                      {album.artworkUrl ? (
                        <img src={album.artworkUrl} alt={album.name} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                      ) : (
                        <span className="flex h-full items-center justify-center"><Music className="h-8 w-8 text-white/25" /></span>
                      )}
                    </span>
                    <span className="block px-3 pb-3 pt-2.5">
                      <span className="line-clamp-1 block text-sm font-semibold text-white/90">{album.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-white/45">{album.artistName}</span>
                      {album.releaseDate ? (
                        <span className="mt-1 block text-[10px] text-white/30">{album.releaseDate.slice(0, 10)}</span>
                      ) : null}
                    </span>
                  </button>
                  {expandedAlbumId === album.id && (
                    <div className="border-t border-white/[0.07] px-2 py-1.5">
                      {albumLoading === album.id ? (
                        <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-white/40" /></div>
                      ) : (albumTracks[album.id] || []).length === 0 ? (
                        <p className="py-2 text-center text-xs text-white/35">暂无曲目数据</p>
                      ) : (
                        (albumTracks[album.id] || []).map((track, index) => (
                          <button
                            key={`${album.id}-${track.id}-${index}`}
                            type="button"
                            onClick={() => void playSong(track)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                          >
                            <span className="w-5 shrink-0 text-center text-[10px] tabular-nums text-white/30">{index + 1}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-white/75">{track.name}</span>
                            {track.durationMs ? <span className="shrink-0 text-[10px] tabular-nums text-white/30">{formatDuration(track.durationMs)}</span> : null}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

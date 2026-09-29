// 官方 PC 客户端风格搜索页（两个平台共用）。
//
// 客户端搜索页 = 顶部大搜索框 + 历史/热搜 + 结果区（单曲/歌手/专辑/歌单 页签），
// 结果区单曲用客户端表格、其余用卡片网格。数据沿用既有 search* 服务，不再自造接口。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search as SearchIcon, X } from 'lucide-react'
import type { Album, Artist, Song } from '../../services/musicApi'
import { searchAlbums, searchArtists, searchPlaylists, searchSongs } from '../../services/musicApi'
import { getPlatformCapabilities, platformLabel, type MusicPlatform } from '../../services/platforms'
import {
  PcCardGrid, PcCover, PcEmpty, PcSongTable, PcTabs, pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import type { PcActions, PcAccount } from './types'

const HISTORY_KEY = 'waveforge:traditional-search-history:v1'
const HISTORY_LIMIT = 10

function readHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, HISTORY_LIMIT) : []
  } catch { return [] }
}

export interface PcSearchProps {
  initialKeyword?: string
  platform: MusicPlatform
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  account: PcAccount
  actions: PcActions
  /** 隐藏保活页为 false：不重复发请求 */
  active?: boolean
}

function PcSearch({ initialKeyword, platform, chrome, account, actions, active = true }: PcSearchProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const skin = chrome.skin
  const [keyword, setKeyword] = useState(initialKeyword || '')
  const [submitted, setSubmitted] = useState(initialKeyword || '')
  const [tab, setTab] = useState('songs')
  const [songs, setSongs] = useState<Song[]>([])
  const [songCount, setSongCount] = useState(0)
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [playlists, setPlaylists] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<string[]>(readHistory)
  const requestRef = useRef(0)
  const capabilities = getPlatformCapabilities(platform)

  const runSearch = useCallback(async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const requestId = ++requestRef.current
    setLoading(true)
    setError('')
    setSubmitted(trimmed)
    setTab('songs')
    setHistory(prev => {
      const next = [trimmed, ...prev.filter(item => item !== trimmed)].slice(0, HISTORY_LIMIT)
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* 忽略隐私模式下的写入失败 */ }
      return next
    })
    try {
      const [songResult, artistResult, albumResult, playlistResult] = await Promise.all([
        searchSongs(trimmed, 50, platform).catch(() => ({ songs: [], songCount: 0 }) as never),
        searchArtists(trimmed, platform).catch(() => [] as Artist[]),
        searchAlbums(trimmed, platform).catch(() => [] as Album[]),
        capabilities.searchPlaylists ? searchPlaylists(trimmed, platform).catch(() => ({ playlists: [] }) as never) : Promise.resolve({ playlists: [] } as never),
      ])
      if (requestId !== requestRef.current) return
      setSongs(songResult?.songs || [])
      setSongCount(songResult?.songCount || songResult?.songs?.length || 0)
      setArtists(Array.isArray(artistResult) ? artistResult : [])
      setAlbums(Array.isArray(albumResult) ? albumResult : [])
      setPlaylists((playlistResult as { playlists?: any[] })?.playlists || [])
    } catch (searchError) {
      if (requestId !== requestRef.current) return
      setError(searchError instanceof Error ? searchError.message : '搜索失败')
      setSongs([]); setArtists([]); setAlbums([]); setPlaylists([])
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [platform, capabilities.searchPlaylists])

  // 外部（歌单页的搜索框、侧栏搜索入口）带关键词进入时自动搜一次
  useEffect(() => {
    if (!active) return
    if (initialKeyword && initialKeyword !== submitted) void runSearch(initialKeyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKeyword, active])

  const tabs = useMemo(() => ([
    { key: 'songs', label: '单曲', count: songCount },
    { key: 'artists', label: '歌手', count: artists.length },
    { key: 'albums', label: '专辑', count: albums.length },
    ...(capabilities.searchPlaylists ? [{ key: 'playlists', label: '歌单', count: playlists.length }] : []),
  ]), [songCount, artists.length, albums.length, playlists.length, capabilities.searchPlaylists])

  const resultEmpty = !loading && !songs.length && !artists.length && !albums.length && !playlists.length

  return (
    <div className="pb-8">
      {/* 顶部大搜索框（客户端搜索页形态） */}
      <div className="mb-5 flex items-center gap-3">
        <label className={`flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border px-4 ${theme.divider} ${theme.surface}`}>
          <SearchIcon className={`h-4 w-4 shrink-0 ${theme.faint}`} />
          <input
            autoFocus
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void runSearch(keyword) }}
            placeholder={`在${platformLabel(platform)}中搜索歌曲、歌手、专辑`}
            className={`min-w-0 flex-1 bg-transparent text-[13px] outline-none ${theme.text}`}
          />
          {keyword && (
            <button type="button" onClick={() => setKeyword('')} aria-label="清空" className={`shrink-0 ${theme.faint}`}><X className="h-4 w-4" /></button>
          )}
        </label>
        <button type="button" onClick={() => void runSearch(keyword)} className="h-10 shrink-0 rounded-full px-6 text-[13px] font-medium text-white" style={{ background: accent }}>搜索</button>
      </div>

      {/* 未搜索时：历史记录 */}
      {!submitted && (
        <div>
          {history.length > 0 && (
            <div className="mb-6">
              <div className={`mb-2 flex items-center justify-between text-[13px] ${theme.subtle}`}>
                <span>搜索历史</span>
                <button type="button" onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY) } catch { /* 忽略 */ } }} className={`text-[12px] ${theme.faint} hover:underline`}>清空</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {history.map(item => (
                  <button key={item} type="button" onClick={() => { setKeyword(item); void runSearch(item) }} className={`rounded-full px-3 py-1.5 text-[12px] ${theme.chipIdle}`}>{item}</button>
                ))}
              </div>
            </div>
          )}
          <PcEmpty theme={theme} title="搜索音乐" description={`支持单曲、歌手、专辑${capabilities.searchPlaylists ? '、歌单' : ''}`} />
        </div>
      )}

      {submitted && (
        <>
          <div className={`mb-3 flex items-end justify-between gap-4 border-b ${theme.divider}`}>
            <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
            <span className={`pb-2 text-[12px] ${theme.faint}`}>“{submitted}” 的搜索结果</span>
          </div>

          {error ? <div className={`mb-3 rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>{error}</div> : null}

          {tab === 'songs' && (
            <PcSongTable
              songs={songs}
              skin={skin}
              theme={theme}
              accent={accent}
              loading={loading}
              columns={{ index: true, like: true, album: true, duration: true }}
              playingKey={actions.currentSongKey}
              isPlaying={actions.isPlaying}
              onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
              onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
              likedKeys={actions.likedKeys}
              onToggleLike={actions.onToggleLike}
              empty={resultEmpty ? <PcEmpty theme={theme} title="没有找到相关内容" description="换个关键词试试" /> : <PcEmpty theme={theme} title="暂无单曲结果" />}
            />
          )}

          {tab === 'artists' && (
            artists.length
              ? <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {artists.map(artist => (
                    <button key={`${artist.id || artist.mid}:${artist.name}`} type="button" onClick={() => actions.onOpenArtist?.(String(artist.mid || artist.id), platform)} className="group text-center">
                      <PcCover src={artist.picUrl || artist.avatarUrl} alt={artist.name} className="aspect-square w-full" rounded="rounded-full" />
                      <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{artist.name}</span>
                      <span className={`block truncate text-[11px] ${theme.faint}`}>{artist.albumSize ? `${artist.albumSize} 张专辑` : '歌手'}</span>
                    </button>
                  ))}
                </div>
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无歌手结果'} />
          )}

          {tab === 'albums' && (
            albums.length
              ? <PcCardGrid
                  items={albums.map(album => ({
                    key: `${album.id || album.mid}:${album.name}`,
                    coverUrl: album.picUrl,
                    title: album.name,
                    subtitle: album.artist?.name || '',
                    onClick: () => actions.onOpenAlbum?.(String(album.mid || album.id), platform),
                  }))}
                  theme={theme}
                  accent={accent}
                  columns={6}
                />
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无专辑结果'} />
          )}

          {tab === 'playlists' && (
            playlists.length
              ? <PcCardGrid
                  items={playlists.map(playlist => ({
                    key: `${playlist.platform || platform}:${playlist.id}`,
                    coverUrl: playlist.coverImgUrl || playlist.coverUrl,
                    title: playlist.name,
                    subtitle: playlist.creator?.nickname || '',
                    playCount: playlist.playCount,
                    onClick: () => actions.onOpenPlaylist(playlist),
                    onContextMenu: event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) },
                  }))}
                  theme={theme}
                  accent={accent}
                  columns={6}
                />
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无歌单结果'} />
          )}
        </>
      )}

      {!account.loggedIn && submitted && (
        <p className={`mt-6 text-center text-[12px] ${theme.faint}`}>登录后可获得更完整的搜索结果</p>
      )}
    </div>
  )
}

export default memo(PcSearch)

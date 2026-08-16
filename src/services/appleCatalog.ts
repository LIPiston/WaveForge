/**
 * Apple Music 目录服务（探索页数据源）
 *
 * - 热门歌曲 / 热门专辑：Apple RSS Feed Generator（most-played，按国家/地区）
 * - 专辑曲目：iTunes Lookup API（collectionId + entity=song）
 * - 目录搜索：复用 appleMusic.ts 的 iTunes Search
 * - 跨平台匹配：Apple 曲目 → 网易云/QQ 同款（WaveForge 播放 Apple 曲目的方式）
 */
import { searchSongs, type Song } from './musicApi'
import { searchAppleTracks, toHighResArtwork } from './appleMusic'
import { AMP_API, getAppleCredentials } from './appleAuth'

export interface AppleCatalogSong {
  id: string
  name: string
  artistName: string
  albumName?: string
  artworkUrl?: string
  releaseDate?: string
  durationMs?: number
}

export interface AppleCatalogAlbum {
  id: string
  name: string
  artistName: string
  artworkUrl?: string
  releaseDate?: string
  genres?: string[]
}

export const APPLE_EXPLORE_COUNTRIES = [
  { code: 'cn', label: '中国大陆' },
  { code: 'hk', label: '香港' },
  { code: 'tw', label: '台湾' },
  { code: 'us', label: '美国' },
  { code: 'jp', label: '日本' },
  { code: 'kr', label: '韩国' },
  { code: 'gb', label: '英国' },
]

const RSS_BASE = 'https://rss.marketingtools.apple.com/api/v2'
/** WaveForge 本地 API 服务提供的 Apple RSS 代理（见 local-server.mjs /api/apple/rss） */
const RSS_PROXY = 'http://localhost:3001/api/apple/rss'

/**
 * Apple 营销工具 RSS 无 CORS 头，浏览器直连会被拦截。
 * 依次尝试：本地代理（最可靠）→ 公共 CORS 代理 allorigins → 直连（部分 Electron 环境可用）。
 */
const rssGet = async (country: string, path: string): Promise<any[]> => {
  const directUrl = `${RSS_BASE}/${country}/${path}`
  const attempts = [
    { url: `${RSS_PROXY}?country=${encodeURIComponent(country)}&path=${encodeURIComponent(path)}`, label: '本地代理' },
    { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`, label: 'allorigins' },
    { url: directUrl, label: 'direct' },
  ]
  for (const attempt of attempts) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(attempt.url, { signal: controller.signal })
      if (!response.ok) continue
      const data = await response.json()
      const results = data?.feed?.results
      if (Array.isArray(results) && results.length > 0) return results
      // 兼容旧版 RSS 结构：feed.entry（单曲时可能是对象）
      const entry = data?.feed?.entry
      if (entry) return Array.isArray(entry) ? entry : [entry]
    } catch (error) {
      console.warn(`[AppleCatalog] RSS ${path} (${attempt.label}) 失败:`, error)
    } finally {
      window.clearTimeout(timeout)
    }
  }
  return []
}

const normalizeSong = (item: any): AppleCatalogSong => ({
  id: String(item.id ?? item.trackId ?? ''),
  name: item.name ?? item.trackName ?? '',
  artistName: item.artistName ?? '',
  albumName: item.collectionName ?? item.albumName ?? undefined,
  artworkUrl: toHighResArtwork(item.artworkUrl100 ?? ''),
  releaseDate: item.releaseDate,
  durationMs: item.durationMillis ?? item.trackTimeMillis ?? undefined,
})

export async function getAppleHotSongs(country = 'cn', limit = 20): Promise<AppleCatalogSong[]> {
  const items = await rssGet(country, `music/most-played/${Math.min(50, Math.max(1, limit))}/songs.json`)
  return items.map(normalizeSong).filter(song => song.name && song.id)
}

export async function getAppleHotAlbums(country = 'cn', limit = 20): Promise<AppleCatalogAlbum[]> {
  const items = await rssGet(country, `music/most-played/${Math.min(50, Math.max(1, limit))}/albums.json`)
  return items
    .map((item: any): AppleCatalogAlbum => ({
      id: String(item.id ?? ''),
      name: item.name ?? '',
      artistName: item.artistName ?? '',
      artworkUrl: toHighResArtwork(item.artworkUrl100 ?? ''),
      releaseDate: item.releaseDate,
      genres: Array.isArray(item.genres) ? item.genres : undefined,
    }))
    .filter(album => album.name && album.id)
}

export async function getAppleAlbumTracks(albumId: string, country = 'cn'): Promise<AppleCatalogSong[]> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song&country=${encodeURIComponent(country.toUpperCase())}&limit=200`,
      { signal: controller.signal },
    )
    if (!response.ok) return []
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .filter((item: any) => item && item.wrapperType === 'track')
      .map(normalizeSong)
  } catch (error) {
    console.warn('[AppleCatalog] 专辑曲目查询失败:', error)
    return []
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function searchAppleCatalog(title: string, artist = '', limit = 25): Promise<AppleCatalogSong[]> {
  if (!title.trim()) return []
  const tracks = await searchAppleTracks(title, artist, undefined, limit)
  return tracks.map(track => ({
    id: track.songId,
    name: track.trackName,
    artistName: track.artistName,
    albumName: track.albumName,
    artworkUrl: track.artworkUrl,
    durationMs: track.durationMs,
  }))
}

// ─────────────────────────── 跨平台匹配播放 ───────────────────────────

const normalizeMatch = (value: string) =>
  (value || '')
    .toLowerCase()
    .replace(/[\s·•\-–—()（）[\]【】「」『』〈〉《》"'`、，。！？!?,.&/\\|feat.]+/g, '')

/**
 * 在网易云/QQ 中寻找 Apple 曲目的可播放同款（标题+艺人+时长评分）。
 * 返回 WaveForge 可播放的 Song；找不到返回 null。
 */
export async function findPlayableAppleSong(track: {
  name: string
  artistName: string
  durationMs?: number
}): Promise<Song | null> {
  const normalizedTitle = normalizeMatch(track.name)
  const normalizedArtist = normalizeMatch(track.artistName)
  if (!normalizedTitle) return null

  const [neteaseRes, qqRes] = await Promise.allSettled([
    searchSongs(track.name, 15, 'netease'),
    searchSongs(track.name, 15, 'qq'),
  ])

  let best: Song | null = null
  let bestScore = 0

  const consider = (song: Song) => {
    const title = normalizeMatch(song.name)
    const artist = normalizeMatch((song.artists || []).map(artist => artist.name).join(' '))
    let score = 0
    if (title === normalizedTitle) score += 100
    else if (title && (title.includes(normalizedTitle) || normalizedTitle.includes(title))) score += 55
    if (normalizedArtist && artist === normalizedArtist) score += 40
    else if (normalizedArtist && artist && (artist.includes(normalizedArtist) || normalizedArtist.includes(artist))) score += 15
    if (track.durationMs && song.duration) {
      const diff = Math.abs(song.duration - track.durationMs)
      if (diff < 2000) score += 15
      else if (diff < 6000) score += 6
    }
    if (score > bestScore) {
      bestScore = score
      best = song
    }
  }

  ;[neteaseRes, qqRes].forEach(result => {
    if (result.status !== 'fulfilled') return
    const songs = result.value?.songs
    if (Array.isArray(songs)) songs.forEach(consider)
  })

  if (!best || bestScore < 60) return null
  return best
}

// ─────────────────────────── 用户资料库（需登录） ───────────────────────────

export interface AppleLibraryPlaylist {
  id: string
  name: string
  description?: string
  artworkUrl?: string
  curatorName?: string
  trackCount?: number
}

export interface AppleLibraryTrack {
  id: string
  name: string
  artistName: string
  albumName?: string
  artworkUrl?: string
  durationMs?: number
}

/** 带登录凭据的 amp-api「me」请求（需要 Developer Token + Media-User-Token） */
const appleMeFetch = async (path: string): Promise<any | null> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return null
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${AMP_API}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
        'Media-User-Token': credentials.mediaUserToken,
        Origin: 'https://music.apple.com',
        Referer: 'https://music.apple.com/',
        Accept: 'application/json',
      },
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        console.warn('[AppleCatalog] 资料库 401/403：token 无效或未授权')
      }
      return null
    }
    return await response.json()
  } catch (error) {
    console.warn('[AppleCatalog] 资料库请求失败:', path, error)
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

/** 当前登录用户的歌单列表 */
export async function getAppleLibraryPlaylists(limit = 100): Promise<AppleLibraryPlaylist[]> {
  const data = await appleMeFetch(`/v1/me/library/playlists?limit=${Math.min(200, Math.max(1, limit))}&include=tracks`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      description: item.attributes.description?.standard || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      curatorName: item.attributes.curatorName || undefined,
      trackCount: item.attributes.trackCount ?? item.relationships?.tracks?.data?.length,
    }))
    .filter(playlist => playlist.name)
}

/** 用户歌单的曲目 */
export async function getApplePlaylistTracks(playlistId: string, limit = 300): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${Math.min(500, Math.max(1, limit))}`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

/** 用户资料库全部歌曲（「我的音乐」） */
export async function getAppleLibrarySongs(limit = 200): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/library/songs?limit=${Math.min(500, Math.max(1, limit))}`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

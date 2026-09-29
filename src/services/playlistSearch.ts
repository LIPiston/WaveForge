/**
 * 歌单内搜索的匹配逻辑（纯函数，便于单测）。
 *
 * 匹配范围：歌名 / 歌手 / 专辑，大小写不敏感、去首尾空白；空查询原样返回（= 不过滤）。
 * 结构类型而非直接依赖 Song：这样单测不必拉起 musicApi 那一串浏览器侧依赖。
 */
export interface PlaylistSearchableSong {
  name?: string
  artists?: { name?: string }[]
  album?: { name?: string }
}

export function filterPlaylistSongs<T extends PlaylistSearchableSong>(songs: T[], query: string): T[] {
  const q = (query || '').trim().toLowerCase()
  if (!q) return songs
  return songs.filter(song =>
    (song.name || '').toLowerCase().includes(q)
    || (song.artists || []).some(artist => (artist?.name || '').toLowerCase().includes(q))
    || (song.album?.name || '').toLowerCase().includes(q),
  )
}

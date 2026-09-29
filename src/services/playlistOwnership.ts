import type { MusicPlatform } from './platforms'

export interface PlaylistOwnershipContext {
  neteaseUserId?: string | number
  qqUserId?: string | number
  spotifyUserId?: string | number
  kugouUserId?: string | number
  sodaUserId?: string | number
}

export function isSpecialPlaylist(playlist: any): boolean {
  const id = String(playlist?.id || playlist?.dirId || '')
  return Boolean(playlist?.isLike) || id === '__apple_library__' || id === '__apple_favorites__'
}

export function isPlaylistOwner(playlist: any, context: PlaylistOwnershipContext = {}): boolean {
  if (!playlist || isSpecialPlaylist(playlist) || playlist.isCollected || playlist.subscribed) return false
  const platform = (playlist.platform || 'netease') as MusicPlatform
  if (platform === 'apple') return playlist.ownedByMe === true
  if (playlist.ownedByMe === true) return true
  if (platform === 'spotify') return Boolean(playlist.owner && context.spotifyUserId && String(playlist.owner) === String(context.spotifyUserId))
  const ownerId = playlist.userId ?? playlist.creator?.userId ?? playlist.ownerId
  const currentUserId = platform === 'netease' ? context.neteaseUserId
    : platform === 'qq' ? context.qqUserId
      : platform === 'kugou' ? context.kugouUserId
        : platform === 'soda' ? context.sodaUserId : undefined
  return Boolean(ownerId !== undefined && ownerId !== null && currentUserId && String(ownerId) === String(currentUserId))
}

/**
 * 从 localStorage 读取各平台当前登录用户 id，作为归属判定上下文。
 *
 * 原本只写在 PlaybackAddToPlaylistModal 里；右键菜单「添加到」要复用同一套过滤
 * （addablePlaylists）时，必须用同一份归属上下文，否则两处判断会漂移
 * （2026-09-27 审计：菜单原来是另一套内联过滤，会把 Apple 资料库伪歌单列成可添加目标）。
 */
export function readPlaylistOwnersFromStorage(): PlaylistOwnershipContext {
  const read = (key: string): string | undefined => {
    try {
      return localStorage.getItem(key) || undefined
    } catch {
      return undefined
    }
  }
  return {
    neteaseUserId: read('netease_user_id'),
    qqUserId: read('qq_user_id'),
    spotifyUserId: read('spotify_user_id'),
    kugouUserId: read('kugou_user_id'),
    sodaUserId: read('soda_user_id'),
  }
}

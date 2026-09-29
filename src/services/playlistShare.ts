import type { MusicPlatform } from './platforms'
import { getPlatformCapabilities } from './platforms'

/**
 * 生成平台可靠的公开歌单分享链接。
 *
 * 2026-09-27 审计：HomeView / ProfileView 以前只区分 qq / netease，其它平台一律
 * 拼成网易云链接 —— 分享出来是错链。能力表 `sharePlaylist=false` 的平台（酷狗/汽水）
 * 没有可靠公开链接，这里返回空串，调用方据此隐藏入口或提示，绝不拼错域名。
 * （DesktopView 早先已有正确实现，这里抽成唯一来源。）
 */
export function buildPlaylistShareUrl(playlist: any, platform: MusicPlatform): string {
  if (!getPlatformCapabilities(platform).sharePlaylist) return ''
  const id = String(playlist?.dirId ?? playlist?.id ?? '')
  if (!id) return ''
  if (platform === 'qq') return `https://y.qq.com/n/ryqq/playlist/${id}`
  if (platform === 'spotify') return `https://open.spotify.com/playlist/${id}`
  if (platform === 'apple') {
    let storefront = 'cn'
    try { storefront = localStorage.getItem('appleStorefront') || 'cn' } catch { /* SSR/隐私模式 */ }
    return `https://music.apple.com/${encodeURIComponent(storefront)}/playlist/${encodeURIComponent(playlist?.name || 'playlist')}/${encodeURIComponent(id)}`
  }
  return `https://music.163.com/#/playlist?id=${id}`
}

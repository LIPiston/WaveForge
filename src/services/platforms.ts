/**
 * 音乐平台抽象层（第三平台：Apple Music）
 *
 * WaveForge 的"平台"曾长期是散落在 40+ 文件里的 'netease' | 'qq' 字面量。
 * 本模块集中定义：
 * 1. MusicPlatform —— 平台联合类型（新增平台只需在此加一个成员）
 * 2. PlatformCapabilities / PLATFORM_CAPABILITIES —— 平台能力注册表。
 *    UI 全部共享，按能力增减功能：对比某平台与网易云/QQ 的能力差，UI 自然增删。
 * 3. 平台级工具函数（标签 / cookie / 播放载体判定）
 */

export type MusicPlatform = 'netease' | 'qq' | 'apple'

export const MUSIC_PLATFORMS: readonly MusicPlatform[] = ['netease', 'qq', 'apple']

export const PLATFORM_LABELS: Record<MusicPlatform, string> = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  apple: 'Apple Music',
}

export function platformLabel(platform: MusicPlatform | string | undefined | null): string {
  if (platform && platform in PLATFORM_LABELS) return PLATFORM_LABELS[platform as MusicPlatform]
  return '未知平台'
}

/** 探索页区块 ID（与 ExploreSettingsPanel 的 ExploreSectionId 同构） */
export type ExploreSectionId = 'discover' | 'journey' | 'playlists' | 'charts' | 'newSongs' | 'albums' | 'channels'

export interface PlatformCapabilities {
  /** 是否提供登录能力 */
  login: boolean
  /** 个人中心（用户资料页） */
  profile: boolean
  /** 用户歌单（查看） */
  userPlaylists: boolean
  createPlaylist: boolean
  deletePlaylist: boolean
  /** 歌单加歌 */
  addTracksToPlaylist: boolean
  /** 收藏他人歌单 */
  subscribePlaylist: boolean
  /** 我喜欢 / 音乐库歌曲 */
  likedSongs: boolean
  /** 单曲喜欢/取消喜欢 */
  likeSong: boolean
  /** 探索页 */
  explore: boolean
  /** 探索页可用的区块（按能力增减） */
  exploreSections: readonly ExploreSectionId[]
  search: boolean
  searchSuggest: boolean
  lyrics: boolean
  comments: boolean
  /** 个性化每日推荐（未登录/不支持时可用公开榜单兜底） */
  dailyRecommend: boolean
  charts: boolean
  channels: boolean
  newSongs: boolean
  albums: boolean
  mv: boolean
  /** 每日签到 / 打卡 */
  signin: boolean
  /** 关注 / 粉丝 */
  social: boolean
  /** 听歌排行 */
  rank: boolean
  /** 云盘 */
  cloudDisk: boolean
  recentPlayed: boolean
  artistDetail: boolean
  albumDetail: boolean
  similarSongs: boolean
  /** 连续电台（FM / 猜你喜欢） */
  radio: boolean
  /** 是否可直接作为音频播放载体（apple 需跨平台匹配到 netease/qq 播放） */
  playAsCarrier: boolean
  audioQuality: boolean
}

const NETEASE_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  deletePlaylist: true,
  addTracksToPlaylist: true,
  subscribePlaylist: true,
  likedSongs: true,
  likeSong: true,
  explore: true,
  exploreSections: ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels'],
  search: true,
  searchSuggest: true,
  lyrics: true,
  comments: true,
  dailyRecommend: true,
  charts: true,
  channels: true,
  newSongs: true,
  albums: true,
  mv: true,
  signin: true,
  social: true,
  rank: true,
  cloudDisk: true,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: true,
  radio: true,
  playAsCarrier: true,
  audioQuality: true,
}

const QQ_CAPABILITIES: PlatformCapabilities = {
  ...NETEASE_CAPABILITIES,
  signin: true,
  social: true,
  // QQ 无听歌排行 / 云盘
  rank: false,
  cloudDisk: false,
}

const APPLE_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  deletePlaylist: true,
  addTracksToPlaylist: true,
  // Apple Music 无"收藏他人歌单"概念（资料库歌单即我的歌单）
  subscribePlaylist: false,
  likedSongs: true,
  likeSong: true,
  explore: true,
  // 探索页区块：无旅程 / 无声音频道（Apple 无公开的 FM/分类频道接口）
  exploreSections: ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
  search: true,
  searchSuggest: false,
  lyrics: true,
  comments: false,
  dailyRecommend: false,
  charts: true,
  channels: false,
  newSongs: true,
  albums: true,
  mv: false,
  signin: false,
  social: false,
  rank: false,
  cloudDisk: false,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: false,
  radio: false,
  playAsCarrier: false,
  audioQuality: false,
}

export const PLATFORM_CAPABILITIES: Record<MusicPlatform, PlatformCapabilities> = {
  netease: NETEASE_CAPABILITIES,
  qq: QQ_CAPABILITIES,
  apple: APPLE_CAPABILITIES,
}

export function getPlatformCapabilities(platform: MusicPlatform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform] || NETEASE_CAPABILITIES
}

// ─────────────────────────── 平台可见性（隐藏平台） ───────────────────────────

const HIDDEN_PLATFORMS_KEY = 'waveforge:hiddenPlatforms'
export const PLATFORM_VISIBILITY_EVENT = 'waveforge-platform-visibility-changed'

/** 用户手动隐藏的平台列表（默认空 = 全部显示） */
export function getHiddenPlatforms(): MusicPlatform[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PLATFORMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is MusicPlatform => MUSIC_PLATFORMS.includes(item as MusicPlatform))
      : []
  } catch {
    return []
  }
}

/** 当前应显示的平台列表（至少保留一个平台，防止切换器失效） */
export function getVisiblePlatforms(): MusicPlatform[] {
  const hidden = new Set(getHiddenPlatforms())
  const visible = MUSIC_PLATFORMS.filter(platform => !hidden.has(platform))
  return visible.length > 0 ? visible : ['netease']
}

export function isPlatformVisible(platform: MusicPlatform): boolean {
  return getVisiblePlatforms().includes(platform)
}

/** 设置某平台是否隐藏（hidden=true 隐藏）。禁止隐藏最后一个可见平台。 */
export function setPlatformHidden(platform: MusicPlatform, hidden: boolean): void {
  const current = new Set(getHiddenPlatforms())
  if (hidden) {
    current.add(platform)
  } else {
    current.delete(platform)
  }
  const nextHidden = [...current]
  // 至少保留一个平台
  if (MUSIC_PLATFORMS.every(item => nextHidden.includes(item))) return
  localStorage.setItem(HIDDEN_PLATFORMS_KEY, JSON.stringify(nextHidden))
  window.dispatchEvent(new CustomEvent(PLATFORM_VISIBILITY_EVENT, { detail: { hidden: nextHidden } }))
}

/** 平台 cookie（apple 无需 cookie，登录走 Developer Token / Media-User-Token） */
export function getPlatformCookie(platform: MusicPlatform): string {
  if (platform === 'qq') {
    return localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
  }
  if (platform === 'apple') return ''
  return localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
}

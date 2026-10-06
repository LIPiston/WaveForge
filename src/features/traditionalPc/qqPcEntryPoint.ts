// QQ 音乐 PC 客户端「常用功能入口」数据源（左栏功能位四宫格 + 添加面板）。
//
// 模块名从客户端 QQMusic_Protocol.dll 里挖出来：music.recommend.RecommendWidget.GetPCCommonEntryPoint。
// 返回 CommonFeatures（可用条目 + 官方图标 + 是否已选）/ CommonSingers（常听艺人）/
// RecentlyListening（最近常听的歌单）/ Selections（用户已选功能位）/ MaxSelectItemNum（=8）。
// 这些都不是手机端那套数据，而是 PC 客户端自己的入口配置。
import { getApiBase } from '../../services/apiConfig'
import { getPlatformCookie } from '../../services/platforms'

export interface QQPcEntryItem {
  id: string
  title: string
  cover?: string
  /** 官方 wk_v17 / entry 链接，用于解析目标（歌手 mid / 歌单 id 等） */
  link: string
  itemType: number
  itemSubType: number
  chosen: boolean
  /** 条目图标（客户端自带四态：普通/选中/深色/深色选中） */
  iconUrl?: string
  iconSelectedUrl?: string
  iconDarkUrl?: string
  iconDarkSelectedUrl?: string
  /** 最近常听歌单的最近播放时间（秒） */
  time?: number
}

export interface QQPcEntryPoint {
  features: QQPcEntryItem[]
  singers: QQPcEntryItem[]
  recents: QQPcEntryItem[]
  selections: QQPcEntryItem[]
  /** 官方上限（实测 8）：可添加位最多这么多（不含推荐与乐馆） */
  maxSelect: number
}

interface RawItem {
  Id?: string
  Title?: string
  Cover?: string
  Link?: string
  ItemType?: number
  ItemSubType?: number
  ChoseStatus?: number
  Ext?: Record<string, string>
}

const normalize = (raw: RawItem): QQPcEntryItem => ({
  id: String(raw?.Id ?? ''),
  title: String(raw?.Title ?? ''),
  cover: String(raw?.Cover ?? '').replace(/^http:/, 'https:'),
  link: String(raw?.Link ?? ''),
  itemType: Number(raw?.ItemType) || 0,
  itemSubType: Number(raw?.ItemSubType) || 0,
  chosen: Number(raw?.ChoseStatus) === 1,
  iconUrl: String(raw?.Ext?.iconUrl ?? '').replace(/^http:/, 'https:') || undefined,
  iconSelectedUrl: String(raw?.Ext?.iconSelectedUrl ?? '').replace(/^http:/, 'https:') || undefined,
  iconDarkUrl: String(raw?.Ext?.iconDarkUrl ?? '').replace(/^http:/, 'https:') || undefined,
  iconDarkSelectedUrl: String(raw?.Ext?.iconDarkSelectedUrl ?? '').replace(/^http:/, 'https:') || undefined,
  time: Number(raw?.Ext?.time) || undefined,
})

/** 从官方链接里取参数（singer_detail?singermid=xxx / playlist_detail/index?id=xxx） */
export function entryLinkParam(item: QQPcEntryItem, key: string): string {
  const match = new RegExp(`[?&]${key}=([^&#]+)`).exec(item.link)
  return match ? decodeURIComponent(match[1]) : ''
}

export async function fetchQQPcEntryPoint(): Promise<QQPcEntryPoint> {
  const cookie = getPlatformCookie('qq')
  if (!cookie) throw new Error('需要登录 QQ 音乐')
  const response = await fetch(`${getApiBase()}/qq/pc/entry-point`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.data) throw new Error(payload?.error || '常用功能入口加载失败')
  const data = payload.data
  const recents = (Array.isArray(data.RecentlyListening) ? data.RecentlyListening : []).map(normalize)
  // 最近常听按时间倒序（接口顺序不保证）
  recents.sort((a: QQPcEntryItem, b: QQPcEntryItem) => (b.time || 0) - (a.time || 0))
  return {
    features: (Array.isArray(data.CommonFeatures) ? data.CommonFeatures : []).map(normalize),
    singers: (Array.isArray(data.CommonSingers) ? data.CommonSingers : []).map(normalize),
    recents,
    selections: (Array.isArray(data.Selections) ? data.Selections : []).map(normalize),
    // 官方上限（实测 8）；接口没给就按 8
    maxSelect: Number(data.MaxSelectItemNum) > 0 ? Number(data.MaxSelectItemNum) : 8,
  }
}

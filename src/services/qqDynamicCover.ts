/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * QQ 音乐动态封面（专辑 dynamicCoverVid → 视频流）渲染端服务。
 * 机制与严格判定见 local-server.mjs /api/qq/animated-cover 注释：
 *   只有专辑真的下发了 dynamicCoverVid 且解析出真实视频 URL 才返回 cover；
 *   任何一步为空/失败 = null（界面回退静态封面，绝不拿静态图冒充动态封面）。
 * 优先级约定：QQ 动态封面 > Apple Music 动态封面（qq 有就用 qq 的）。
 */
export interface QQDynamicCoverData {
  /** 动态封面视频地址（mp4，1080×1080） */
  videoUrl: string
  posterUrl: string | null
  vid: string
  albumMid: string
  source: string
}

const API_ENDPOINT = 'http://localhost:3001/api/qq/animated-cover'
const CACHE_MAX = 80
const cache = new Map<string, QQDynamicCoverData | null>()

/**
 * 查询某首歌的 QQ 动态封面。songMid（QQ 平台直查）或 title+artist（跨平台
 * smartbox 匹配，歌手名必须命中）二选一；返回 null = 无/失败（调用方回退）。
 */
export async function getQQDynamicCover(query: {
  songMid?: string
  title?: string
  artist?: string
  album?: string
  signal?: AbortSignal
}): Promise<QQDynamicCoverData | null> {
  const songMid = query.songMid?.trim() || ''
  const title = query.title?.trim() || ''
  if (!songMid && !title) return null
  const cacheKey = `${songMid}|${title}|${query.artist || ''}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  try {
    const params = new URLSearchParams()
    if (songMid) params.set('songMid', songMid)
    if (title) params.set('title', title)
    if (query.artist) params.set('artist', query.artist)
    if (query.album) params.set('album', query.album)
    const resp = await fetch(`${API_ENDPOINT}?${params.toString()}`, { signal: query.signal })
    if (!resp.ok) return null
    const json = await resp.json()
    const result = json?.code === 0 && json.cover ? (json.cover as QQDynamicCoverData) : null
    cache.set(cacheKey, result)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return result
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return null
    console.warn('[QQDynamicCover] 查询失败:', (error as Error)?.message)
    return null
  }
}

export function clearQQDynamicCoverCache(): void {
  cache.clear()
}

import { getApiBase } from './apiConfig'

export type ArtworkRole = 'row' | 'compact' | 'card' | 'hero' | 'player' | 'background' | 'texture'
export type ArtworkPriority = 'critical' | 'visible' | 'deferred'

const SIZE_BUCKETS = [64, 128, 256, 512, 1024] as const
const DEFAULT_ROLE_SIZE: Record<ArtworkRole, number> = {
  row: 64,
  compact: 128,
  card: 256,
  hero: 512,
  player: 512,
  // 背景层永远以「全屏大幅模糊」呈现（blur 30~40px），源图细节完全看不到：
  // 用 1024 源图会让全屏模糊的光栅化成本放大十几倍——实测进入播放页单帧卡到 1.29s
  // 的主因之一（大图解码 + 整屏高斯模糊）。128（×DPR 后 ≤512 桶）已足够。
  background: 128,
  texture: 1024,
}

const NETEASE_IMAGE_HOST = /(^|\.)(music\.126\.net|music\.163\.com)$/i
const QQ_IMAGE_HOST = /(^|\.)(y\.gtimg\.cn|qqmusic\.qq\.com)$/i
const APPLE_IMAGE_HOST = /(^|\.)(mzstatic\.com|apple\.com)$/i
const KUGOU_IMAGE_HOST = /(^|\.)(kugou\.com|kgimg\.com)$/i

export function getArtworkSizeBucket(requested: number): number {
  const safe = Number.isFinite(requested) ? Math.max(1, requested) : 512
  return SIZE_BUCKETS.find(size => size >= safe) || SIZE_BUCKETS[SIZE_BUCKETS.length - 1]
}

/**
 * 背景层源图档位：与「实际模糊半径」挂钩。
 * 原先 background 固定 128（为省全屏高斯模糊成本），但模糊半径可被用户调到 0，
 * 此时 128 源图铺满 1920px 会糊成一片（像素块肉眼可见）。
 * 规则：模糊越大越不需要细节；blur<16（含 0）直接给 1024，QQ 封面由
 * resizeArtworkSource 兜底到平台上限 800。
 */
export function getBackgroundArtworkSize(blurPx: number): number {
  const blur = Number.isFinite(blurPx) ? Math.max(0, blurPx) : 0
  if (blur >= 32) return 256
  if (blur >= 16) return 512
  return 1024
}

export function getArtworkRoleSize(role: ArtworkRole, cssPixels?: number, dpr?: number): number {
  const pixelRatio = Number.isFinite(dpr) && Number(dpr) > 0
    ? Math.min(3, Number(dpr))
    : typeof window !== 'undefined'
      ? Math.min(3, Math.max(1, window.devicePixelRatio || 1))
      : 1
  return getArtworkSizeBucket((cssPixels || DEFAULT_ROLE_SIZE[role]) * pixelRatio)
}

function isCoverProxy(url: URL): boolean {
  try {
    const proxy = new URL(`${getApiBase()}/cover`)
    if (url.origin === proxy.origin && url.pathname === proxy.pathname) return true
  } catch {
    // Fall through to the stable local route check.
  }
  return /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)
    && url.port === '3001'
    && url.pathname === '/api/cover'
}

export function unwrapArtworkSource(input: string): string {
  let current = String(input || '').trim()
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const parsed = new URL(current)
      if (!isCoverProxy(parsed)) return current
      const nested = parsed.searchParams.get('url') || ''
      if (!/^https?:\/\//i.test(nested) || nested === current) return current
      current = nested
    } catch {
      return current
    }
  }
  return current
}

/**
 * 移除网易 query 型尺寸档位（param=NyN），得到「原始尺寸」地址。
 * 平台档位可能大于原图：网易 CDN 对部分封面 param=1024y1024 直接 404
 * （原图不足 1024px 时按档位放大请求会被拒，2026-09-28 实测），此时兜底
 * 加载原始尺寸。QQ/Apple/酷狗的档位在 pathname 里且缺省即原图，无需处理。
 */
export function stripArtworkRendition(sourceUrl: string): string {
  const queryStart = sourceUrl.indexOf('?')
  if (queryStart === -1) return sourceUrl
  const base = sourceUrl.slice(0, queryStart)
  const query = sourceUrl.slice(queryStart + 1)
  // 纯字符串拆分过滤，不做 URL 编解码往返（与 resizeArtworkSource 同样的考虑）
  const kept = query.split('&').filter(pair => !/^param=\d+y\d+$/i.test(pair))
  if (kept.length === query.split('&').length) return sourceUrl
  return kept.length ? `${base}?${kept.join('&')}` : base
}

/**
 * 档位 404 时的逐级降档候选（按优先级排序，调用方依次尝试）。
 * 背景：新档位请求（如背景层 1024 / QQ R800）在部分封面上游会 404——
 * 网易是 param 大于原图；QQ 是部分专辑未生成 R800 缩略图。降档总有一个档可用，
 * 比直接 404 黑块好。已失效封面（所有尺寸所有节点都 404）不在此解法范围内，
 * 由调用方的失败重试与占位符兜底。
 */
export function fallbackArtworkSources(sourceUrl: string): string[] {
  const candidates: string[] = []
  try {
    const host = new URL(sourceUrl).hostname
    if (NETEASE_IMAGE_HOST.test(host)) {
      const bare = stripArtworkRendition(sourceUrl)
      if (bare !== sourceUrl) candidates.push(bare)
    } else if (QQ_IMAGE_HOST.test(host)) {
      // 只降不升：解析当前档位，仅生成比它小的候选（R300 失败时降无可降 → 空候选）
      const current = /T002R(\d+)x\d+/i.exec(sourceUrl)
      const currentSize = current ? Number.parseInt(current[1], 10) : Number.MAX_SAFE_INTEGER
      for (const size of [500, 300]) {
        if (size >= currentSize) continue
        const downgraded = sourceUrl.replace(/T002R\d+x\d+/i, `T002R${size}x${size}`)
        if (downgraded !== sourceUrl && !candidates.includes(downgraded)) candidates.push(downgraded)
      }
    }
  } catch {
    // 非法 URL：无降档候选，调用方维持原有行为
  }
  return candidates
}

export function resizeArtworkSource(sourceUrl: string, size: number): string {
  const bucket = getArtworkSizeBucket(size)
  try {
    const url = new URL(sourceUrl)
    const host = url.hostname
    if (NETEASE_IMAGE_HOST.test(host)) {
      // 不能用 searchParams/new URL 往返重编码：网易云封面常带 `enlarge=1|imageView=1` 与无值参数
      // `watermark`，重编码会把 `=` 变 %3D、`watermark` 变 `watermark=`，上游直接 400
      // （实测「发现-音乐」大量频道封面因此加载失败）。改成纯字符串拼接，保留原始编码。
      //
      // 必须幂等：同一张图会被解析两次（CachedImage 先解析出渲染地址，preloadArtwork 再解析一次），
      // 已带 `param=NyN` 时必须替换而不是追加，否则两次解析结果不相等，组件会判定加载结果与
      // 当前地址不一致而一直停在空占位符（实测歌单详情封面整块空白）。
      const existing = /([?&])param=\d+y\d+/i
      if (existing.test(sourceUrl)) return sourceUrl.replace(existing, `$1param=${bucket}y${bucket}`)
      const joiner = sourceUrl.includes('?') ? '&' : '?'
      return `${sourceUrl}${joiner}param=${bucket}y${bucket}`
    }
    if (QQ_IMAGE_HOST.test(host)) {
      // QQ 图床实测档位：R300 / R500 / R800 可用，R1000 起 404（2026-09-27 复核）。
      // 背景层需要更大源图时给到 800，播放页封面等其余档位维持原值。
      const requested = bucket > 500 ? 800 : bucket > 300 ? 500 : 300
      url.pathname = url.pathname.replace(/T002R\d+x\d+/i, `T002R${requested}x${requested}`)
      return url.toString()
    }
    if (APPLE_IMAGE_HOST.test(host)) {
      // mzstatic 的占位符必须全部替换，否则整条 URL 直接 404/加载失败：
      // 实测 {f} 未替换 → 404；{c} 用 cc（居中方形裁切）——用 bb 会因原图是 4:1 只返回细条，拉伸后严重模糊。
      url.pathname = url.pathname
        .replace(/(?:\{w\}|%7Bw%7D)/gi, String(bucket))
        .replace(/(?:\{h\}|%7Bh%7D)/gi, String(bucket))
        .replace(/(?:\{c\}|%7Bc%7D)/gi, 'cc')
        .replace(/(?:\{f\}|%7Bf%7D)/gi, 'jpg')
        .replace(/\d+x\d+bb(?=\.[a-z]+$)/i, `${bucket}x${bucket}bb`)
      return url.toString()
    }
    if (KUGOU_IMAGE_HOST.test(host)) {
      url.pathname = url.pathname.replace(/\{size\}/gi, String(bucket))
      return url.toString()
    }
  } catch {
    return sourceUrl
  }
  return sourceUrl
}

export interface ResolveArtworkOptions {
  role?: ArtworkRole
  cssPixels?: number
  dpr?: number
  size?: number
  platform?: string
}

export function resolveArtworkUrl(input: string, options: ResolveArtworkOptions = {}): string {
  const source = unwrapArtworkSource(input)
  if (!/^https?:\/\//i.test(source)) return ''
  const size = options.size
    ? getArtworkSizeBucket(options.size)
    : getArtworkRoleSize(options.role || 'player', options.cssPixels, options.dpr)
  const rendition = resizeArtworkSource(source, size)
  return `${getApiBase()}/cover?url=${encodeURIComponent(rendition)}`
}

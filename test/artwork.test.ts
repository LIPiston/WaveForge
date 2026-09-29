import { describe, expect, it } from 'vitest'
import { fallbackArtworkSources, getArtworkRoleSize, getArtworkSizeBucket, resizeArtworkSource, resolveArtworkUrl, stripArtworkRendition, unwrapArtworkSource } from '../src/services/artwork'
import { getArtworkCacheKey, getColorThiefArtworkKey } from '../src/services/artworkLoader'

describe('artwork resolver', () => {
  it('uses stable rendition buckets for displayed slot sizes', () => {
    expect(getArtworkSizeBucket(1)).toBe(64)
    expect(getArtworkSizeBucket(80)).toBe(128)
    expect(getArtworkSizeBucket(300)).toBe(512)
    expect(getArtworkRoleSize('row', 40, 2)).toBe(128)
    expect(getArtworkRoleSize('background', 900, 2)).toBe(1024)
  })

  it('unwraps compatible proxy URLs before choosing a new rendition', () => {
    const source = 'https://p1.music.126.net/cover.jpg?foo=bar'
    const proxy = `http://localhost:3001/api/cover?url=${encodeURIComponent(source)}`
    expect(unwrapArtworkSource(proxy)).toBe(source)
    const resolved = new URL(resolveArtworkUrl(proxy, { size: 128 }))
    expect(resolved.pathname).toBe('/api/cover')
    expect(new URL(resolved.searchParams.get('url') || '').searchParams.get('param')).toBe('128y128')
  })

  it('builds versioned platform/rendition/source keys with an unknown namespace fallback', () => {
    const source = 'https://p1.music.126.net/cover.jpg'
    expect(getArtworkCacheKey(source, { platform: 'netease', size: 128 }))
      .toBe('artwork:v1:netease:128:https://p1.music.126.net/cover.jpg')
    expect(getArtworkCacheKey(source, { platform: 'qq', size: 256 }))
      .toBe('artwork:v1:qq:256:https://p1.music.126.net/cover.jpg')
    expect(getArtworkCacheKey('https://cdn.example.com/cover.jpg', { size: 128 }))
      .toBe('artwork:v1:unknown:128:https://cdn.example.com/cover.jpg')
  })

  /**
   * 回归：播放页封面（size:500→512 桶）与「下一首封面」预热必须落在同一档。
   *
   * 背景层用 background(128)、播放页封面用 getProxiedImageUrl 默认 size:500(→512)。
   * 缓存键与代理 URL 都带清晰度，所以此前只预热 background 时，切歌后封面 <img>
   * 仍要现下载 512 图；下载期间浏览器继续显示上一首已解码位图，
   * 表现为"背景已换新歌、封面还停在上一首 3~4 秒"。
   */
  it('播放页封面档位：size:500 与 displayCoverUrl 解析结果一致，且区别于背景档', () => {
    const source = 'https://p1.music.126.net/cover.jpg'
    const displayUrl = resolveArtworkUrl(source, { size: 500 })
    const preloadUrl = resolveArtworkUrl(source, { size: 500 })
    const backgroundUrl = resolveArtworkUrl(source, { role: 'background' })
    // 预热 URL 必须与展示 URL 完全相同，才能命中 HTTP 缓存 / 同一缓存键
    expect(preloadUrl).toBe(displayUrl)
    expect(displayUrl).not.toBe(backgroundUrl)
    expect(getArtworkSizeBucket(500)).toBe(512)
    expect(getArtworkCacheKey(source, { size: 500 }))
      .not.toBe(getArtworkCacheKey(source, { role: 'background' }))
  })

  it('only rewrites known provider artwork conventions', () => {
    expect(resizeArtworkSource('https://p1.music.126.net/a.jpg?param=500y500', 64))
      .toContain('param=64y64')
    expect(resizeArtworkSource('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg', 128))
      .toContain('T002R300x300')
    // QQ 图床实测 R300/R500/R800 可用（R1000+ 404），512 桶请求兜底到平台上限 800
    expect(resizeArtworkSource('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg', 512))
      .toContain('T002R800x800')
    expect(resizeArtworkSource('https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg', 256))
      .toContain('/256x256bb.jpg')
    const signed = 'https://cdn.example.com/image.jpg?signature=a%2Bb&expires=1'
    expect(resizeArtworkSource(signed, 64)).toBe(signed)
  })

  /**
   * 回归：CachedImage 必须在「解析后的地址」上推导缓存键。
   *
   * CachedImage 把 normalizedSrc（解析后）交给 preloadArtwork，后者按解析后地址算键。
   * 若组件改用原始 src 算键，两次推导的 rendition 不同——网易云原图常带旧尺寸
   * （如 param=300y300，本次要 512），原始 src 的键会落在 512 档之外，
   * 于是 imageCache 永远查不中，重挂载时先渲染占位符再异步补图。
   */
  it('缓存键按解析后地址推导（与 preloadArtwork 一致）', () => {
    const withOldSize = 'https://p1.music.126.net/cover.jpg?param=300y300'
    const plain = 'https://p1.music.126.net/cover.jpg'
    for (const source of [withOldSize, plain]) {
      const resolved = resolveArtworkUrl(source, { role: 'player', size: 512 })
      expect(getArtworkCacheKey(resolved, { role: 'player', size: 512 }))
        .toBe(getArtworkCacheKey(resolveArtworkUrl(source, { role: 'player', size: 512 }), { role: 'player', size: 512 }))
      // 原始 src 与解析后地址的键确实不同 —— 这正是必须用解析后地址的原因
      expect(getArtworkCacheKey(source, { role: 'player', size: 512 }))
        .not.toBe(getArtworkCacheKey(resolved, { role: 'player', size: 512 }))
    }
  })

  /**
   * 档位 404 降档兜底（2026-09-28 播放页背景黑屏回归）：
   * 背景 blur=0 时请求 1024 档，网易 CDN 对部分封面 404；QQ 部分专辑未生成 R800。
   * 加载失败时 artworkLoader 会按 fallbackArtworkSources 逐级降档重试。
   */
  it('stripArtworkRendition 移除网易 param 档位得到原始尺寸地址', () => {
    expect(stripArtworkRendition('https://p1.music.126.net/a.jpg?param=1024y1024'))
      .toBe('https://p1.music.126.net/a.jpg')
    // param 不在首位：移除后其余参数保留且不残留 ?/&
    expect(stripArtworkRendition('https://p1.music.126.net/a.jpg?param=1024y1024&other=1'))
      .toBe('https://p1.music.126.net/a.jpg?other=1')
    expect(stripArtworkRendition('https://p1.music.126.net/a.jpg?other=1&param=1024y1024'))
      .toBe('https://p1.music.126.net/a.jpg?other=1')
    // 无 param：原样返回
    expect(stripArtworkRendition('https://p1.music.126.net/a.jpg')).toBe('https://p1.music.126.net/a.jpg')
    expect(stripArtworkRendition('https://p1.music.126.net/a.jpg?enlarge=1')).toBe('https://p1.music.126.net/a.jpg?enlarge=1')
    // 非网易 URL 不受影响（QQ 档位在 pathname 里，不属于 param 体系）
    expect(stripArtworkRendition('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg'))
      .toBe('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg')
  })

  it('fallbackArtworkSources 按平台给出降档候选', () => {
    // 网易：唯一候选 = 原始尺寸
    expect(fallbackArtworkSources('https://p1.music.126.net/a.jpg?param=1024y1024'))
      .toEqual(['https://p1.music.126.net/a.jpg'])
    // 网易无 param：无候选（当前档即原图）
    expect(fallbackArtworkSources('https://p1.music.126.net/a.jpg')).toEqual([])
    // QQ：R800 失败 → R500 → R300 逐级降档
    expect(fallbackArtworkSources('https://y.gtimg.cn/music/photo_new/T002R800x800M000abc.jpg'))
      .toEqual([
        'https://y.gtimg.cn/music/photo_new/T002R500x500M000abc.jpg',
        'https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg',
      ])
    // QQ R300 已是最低档：只给更低……无 → 空候选（R300 失败交给直连兜底）
    expect(fallbackArtworkSources('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg'))
      .toEqual([])
    // 其他平台：无候选，维持原行为
    expect(fallbackArtworkSources('https://is1-ssl.mzstatic.com/image/thumb/256x256bb.jpg')).toEqual([])
  })

  /** 解析后地址已经是代理包装，重复解析必须幂等，否则每次渲染都会生成新键。 */
  it('对已包装的代理地址重复解析保持幂等', () => {
    const source = 'https://p1.music.126.net/cover.jpg?param=300y300'
    const once = resolveArtworkUrl(source, { role: 'player', size: 512 })
    const twice = resolveArtworkUrl(once, { role: 'player', size: 512 })
    expect(twice).toBe(once)
    expect(getArtworkCacheKey(once, { role: 'player', size: 512 }))
      .toBe(getArtworkCacheKey(twice, { role: 'player', size: 512 }))
  })

  /**
   * 全链路收敛回归：预加载 / 渲染 / 取色三条路径必须命中同一条缓存记录。
   *
   * 三者拿到的入参形态不同——App 预加载拿原始地址、CachedImage 拿解析后地址、
   * 取色拿的是已代理的 displayCoverUrl。此前 preloadArtwork 按「入参 src」算键、
   * CachedImage 也按原始 src 算键，同一张封面会派生出多个键：
   * 预加载的图无法被渲染复用（切歌后仍要现下载），取色还要再下载一遍。
   */
  it('预加载 / 渲染 / 取色收敛到同一缓存键', () => {
    const cases = [
      'https://p1.music.126.net/abc==/cover.jpg',
      'https://p1.music.126.net/abc==/cover.jpg?param=300y300',
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg',
      'https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg',
    ]
    for (const raw of cases) {
      // App.tsx 预热：preloadArtwork(raw, { size: 500 }) 内部按键来源
      const preload = getArtworkCacheKey(resolveArtworkUrl(raw, { size: 500 }), { size: 500 })
      // CachedImage(role="player", size={512})
      const rendered = getArtworkCacheKey(
        resolveArtworkUrl(raw, { role: 'player', size: 512 }),
        { role: 'player', size: 512 },
      )
      // 取色：入参是 displayCoverUrl = resolveArtworkUrl(raw, { size: 500 })
      const colorThief = getColorThiefArtworkKey(resolveArtworkUrl(raw, { size: 500 }))
      expect(rendered).toBe(preload)
      expect(colorThief).toBe(preload)
    }
  })
})

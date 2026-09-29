/**
 * Apple Music 动态封面图层（React 版）。
 *
 * 静态封面由调用方始终打底；本组件只负责叠加动态媒体。HLS 实例在
 * URL 变化、组件卸载、或 retainMedia 置 false（离屏/面板冻结）时销毁。
 * 离屏、页面隐藏等 inactive 状态只暂停播放；调用方需要真正回收内存时
 * 传 retainMedia=false，那会连带清掉 MSE 缓冲与解码器（只留 poster）。
 */
import { useEffect, useRef, useState } from 'react'

interface AnimatedArtworkCoverProps {
  videoUrl: string | null
  posterUrl?: string | null
  staticCoverUrl?: string | null
  active?: boolean
  className?: string
  style?: React.CSSProperties
  onError?: () => void
  objectFit?: 'cover' | 'contain'
  /**
   * 等真正有画面可播时再淡入（默认关闭，保持既有调用方行为）。
   * 关闭时该层是"就绪即显"，在动态封面晚到/切换歌单的场景会硬闪一下；
   * 歌单详情面板需要平滑过渡，故显式开启。
   */
  fadeInOnReady?: boolean
  /**
   * 是否保留媒体管线（HLS 实例 + MSE 缓冲 + 解码器 + GPU 纹理）。
   *
   * 置 false 会销毁 HLS 引擎、清空 src 并 load()，只留 poster / 下层静态封面。
   * 单条动态封面约 768×768，缓冲与解码资源是「封面一多就卡」的主要来源：
   * 面板被冻结（切到别的平台）、卡片被滚出视口很远时都不该继续留着。
   * 重新置 true 时按 videoUrl 重建管线（首帧到达前显示 poster，允许一次闪替）。
   * 默认 true，保持既有调用方行为不变。
   */
  retainMedia?: boolean
}

const isHlsSource = (source: string) => /\.m3u8(?:$|[?#])/i.test(source)

export default function AnimatedArtworkCover({
  videoUrl,
  posterUrl,
  staticCoverUrl,
  active = true,
  className,
  style,
  onError,
  objectFit = 'cover',
  fadeInOnReady = false,
  retainMedia = true,
}: AnimatedArtworkCoverProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [failed, setFailed] = useState(false)
  // 有了可显示的画面（首帧解码完成或开始播放）才淡入：避免视频元素一挂上就显黑框。
  const [ready, setReady] = useState(false)
  const activeRef = useRef(active)
  // onError 用 ref 持有：调用方常传内联箭头函数，若进依赖数组会导致
  // 父组件每次重渲染都销毁重建 HLS 引擎（封面闪烁、播放永远卡在首帧）。
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onErrorRef.current = onError
  })

  useEffect(() => {
    activeRef.current = active
    const video = videoRef.current
    if (!video || failed || !videoUrl || !retainMedia) return
    if (active) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [active, failed, videoUrl, retainMedia])

  useEffect(() => {
    setFailed(false)
    setReady(false)
    const video = videoRef.current
    // retainMedia=false：媒体已回收（或从未建立），只留 poster/静态封面。
    // 这里必须早于创建逻辑返回，否则刚销毁又会立刻重建。
    if (!video || !videoUrl || !retainMedia) return

    let cancelled = false
    let engine: { destroy: () => void } | null = null
    const fail = (stage: string) => {
      if (cancelled) return
      console.warn(`[AppleMotion] 动态封面失败 stage=${stage}`)
      setFailed(true)
      onErrorRef.current?.()
    }
    const playWhenActive = () => {
      // play() 的偶发 rejection（src 交换窗口期等）不应永久判死整个封面；
      // 致命问题由 Hls ERROR 事件与 video 元素 onError 兜底（与 DynamicCover 行为一致）。
      if (!cancelled && activeRef.current) void video.play().catch(() => undefined)
    }

    if (!isHlsSource(videoUrl)) {
      video.src = videoUrl
      playWhenActive()
    } else {
      // ⚠️ 不要走 canPlayType 原生 HLS 捷径：新版 Chromium 对 vnd.apple.mpegurl
      // 返回 "maybe" 但实际不解复用，直接 src=m3u8 必然 MEDIA_ERR_SRC_NOT_SUPPORTED。
      // 一律 hls.js（MSE）——与验证可用的 DynamicCover 一致；仅真无 MSE 时才直连兜底。
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return
        if (!Hls.isSupported()) {
          video.src = videoUrl
          playWhenActive()
          return
        }
          // 缓冲压到 8s：封面是短循环无声视频，12s 缓冲在「几十条同时存在」时
          // 只是白白占内存；backBufferLength=0 已保证不回放历史片段。
          const instance = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 8, backBufferLength: 0 })
          engine = instance
          instance.on(Hls.Events.ERROR, (_event: string, data: { fatal?: boolean }) => {
            if (data.fatal) fail('hls-fatal')
          })
        instance.on(Hls.Events.MANIFEST_PARSED, playWhenActive)
        instance.loadSource(videoUrl)
        instance.attachMedia(video)
      }).catch(() => fail('hls-import'))
    }

    return () => {
      cancelled = true
      engine?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoUrl, retainMedia])

  if (!videoUrl || failed) return null
  const fading = fadeInOnReady && !ready
  return (
    <video
      ref={videoRef}
      key={videoUrl}
      className={className}
      style={{
        ...style,
        objectFit,
        ...(fadeInOnReady ? { opacity: fading ? 0 : 1, transition: 'opacity 0.32s ease-out' } : null),
      }}
      poster={posterUrl || staticCoverUrl || undefined}
      muted
      loop
      playsInline
      preload={retainMedia ? 'auto' : 'none'}
      disablePictureInPicture
      onLoadedData={() => setReady(true)}
      onPlaying={() => setReady(true)}
      onError={() => {
        console.warn('[AppleMotion] 动态封面失败 stage=video-element')
        setFailed(true)
        onError?.()
      }}
    />
  )
}

import { motion } from 'framer-motion'
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getResolvedArtworkUrl, preloadArtwork } from '../services/artworkLoader'
import type { ArtworkLoadOptions } from '../services/artworkLoader'

interface CrossfadeBackgroundProps {
  coverUrl: string
  transitionFromUrl?: string
  transitionToUrl?: string
  isTransitioning: boolean
  transitionProgress: number
  imageStyle: CSSProperties
  /**
   * 背景源图目标尺寸（px）。不传时按 background 档位（128）取图；
   * 播放页按「实际模糊半径」传入更大尺寸，模糊为 0 时避免 128 源图铺满全屏的糊。
   */
  artworkSize?: number
}

function isUsableCover(url?: string): url is string {
  return Boolean(url?.trim() && !url.includes('picsum.photos'))
}

function CrossfadeBackground({
  coverUrl,
  transitionFromUrl,
  transitionToUrl,
  isTransitioning,
  transitionProgress,
  imageStyle,
  artworkSize,
}: CrossfadeBackgroundProps) {
  // 解析与预加载必须用同一组档位参数，否则 artworkLoader 的缓存键会分裂成两条。
  // useMemo 保持引用稳定：下面两个 effect 依赖它，每次渲染新建对象会导致无限预加载。
  const resolveOptions: ArtworkLoadOptions = useMemo(
    () => (artworkSize ? { size: artworkSize } : { role: 'background' }),
    [artworkSize],
  )
  const resolvedCoverUrl = isUsableCover(coverUrl) ? getResolvedArtworkUrl(coverUrl, resolveOptions) : ''
  const resolvedTransitionFromUrl = isUsableCover(transitionFromUrl) ? getResolvedArtworkUrl(transitionFromUrl, resolveOptions) : ''
  const resolvedTransitionToUrl = isUsableCover(transitionToUrl) ? getResolvedArtworkUrl(transitionToUrl, resolveOptions) : ''
  const [visibleUrl, setVisibleUrl] = useState('')
  const [incomingUrl, setIncomingUrl] = useState('')
  const [readyTransitionToUrl, setReadyTransitionToUrl] = useState('')
  const requestSerialRef = useRef(0)
  // 失败自愈：preload 失败（如平台档位 404/瞬时限流）时若只把 incomingUrl 复位为 ''，
  // 依赖不会有任何 state 变化 → effect 不再重跑 → 背景永远黑屏（实测表现为"过 1 分钟
  // 等切歌/过渡才突然有背景"）。这里按退避定时强制重跑，最多 3 次。
  const [retryNonce, setRetryNonce] = useState(0)
  const retryStateRef = useRef<{ url: string; attempts: number }>({ url: '', attempts: 0 })
  const retryTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
  }, [])

  useEffect(() => {
    if (!resolvedCoverUrl || isTransitioning) return
    if (resolvedCoverUrl === visibleUrl || resolvedCoverUrl === incomingUrl) return
    // 换歌后重置退避计数（同一次挂载内按 URL 记）
    if (retryStateRef.current.url !== resolvedCoverUrl) {
      retryStateRef.current = { url: resolvedCoverUrl, attempts: 0 }
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
    const serial = ++requestSerialRef.current
    void preloadArtwork(resolvedCoverUrl, { ...resolveOptions, priority: 'critical', retries: 1 }).then(() => {
      if (serial === requestSerialRef.current) {
        setIncomingUrl(resolvedCoverUrl)
        retryStateRef.current.attempts = 0
      }
    }).catch(() => {
      if (serial !== requestSerialRef.current) return
      setIncomingUrl('')
      const attempts = retryStateRef.current.attempts
      if (attempts >= 3 || retryTimerRef.current !== null) return
      retryStateRef.current = { url: resolvedCoverUrl, attempts: attempts + 1 }
      // 前两次短退避会被 artworkLoader 的 15s 失败 TTL 立刻拒绝，属预期内的廉价探测
      const RETRY_DELAYS_MS = [4_000, 16_000, 30_000]
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        setRetryNonce(value => value + 1)
      }, RETRY_DELAYS_MS[attempts])
    })
  }, [incomingUrl, isTransitioning, resolvedCoverUrl, resolveOptions, visibleUrl, retryNonce])

  // 兜底提升：淡入动画完成回调（onAnimationComplete）在快速连续切歌/动画中断时
  // 可能不触发，incomingUrl 永远不晋升为 visibleUrl → 封面停留在旧歌。这里用定时器
  // 强制在动画时长 + 余量后完成晋升（与动画回调幂等：先到者生效，后到者 no-op）。
  useEffect(() => {
    if (!incomingUrl) return
    const t = window.setTimeout(() => {
      setVisibleUrl(incomingUrl)
      setIncomingUrl('')
    }, 1200)
    return () => window.clearTimeout(t)
  }, [incomingUrl])


  const explicitTransition = Boolean(
    isTransitioning
      && resolvedTransitionFromUrl
      && resolvedTransitionToUrl
  )
  useEffect(() => {
    let cancelled = false
    if (!resolvedTransitionToUrl) {
      setReadyTransitionToUrl('')
      return
    }
    setReadyTransitionToUrl('')
    void preloadArtwork(resolvedTransitionToUrl, { ...resolveOptions, priority: 'critical', retries: 1 }).then(() => {
      if (!cancelled) setReadyTransitionToUrl(resolvedTransitionToUrl)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [resolvedTransitionToUrl, resolveOptions])
  const clampedProgress = Math.max(0, Math.min(1, transitionProgress))

  useEffect(() => {
    if (
      explicitTransition
      && readyTransitionToUrl
      && (resolvedCoverUrl === readyTransitionToUrl || clampedProgress >= 0.995)
    ) {
      setVisibleUrl(readyTransitionToUrl)
      setIncomingUrl('')
    }
  }, [clampedProgress, explicitTransition, readyTransitionToUrl, resolvedCoverUrl])

  const layerStyle = (url: string): CSSProperties => ({
    ...imageStyle,
    backgroundImage: `url(${url})`,
  })

  return (
    <div className="absolute inset-0 overflow-hidden">
      {visibleUrl && (
        <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(visibleUrl)} />
      )}

      {explicitTransition
        && resolvedTransitionFromUrl
        && resolvedTransitionFromUrl !== visibleUrl
        && (
          <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(resolvedTransitionFromUrl)} />
        )}

      {explicitTransition && readyTransitionToUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            ...layerStyle(readyTransitionToUrl),
            opacity: clampedProgress,
            transition: `${imageStyle.transition || ''}, opacity 80ms linear`,
          }}
        />
      ) : incomingUrl ? (
        <motion.div
          key={incomingUrl}
          className="absolute inset-0 bg-cover bg-center"
          style={layerStyle(incomingUrl)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          onAnimationComplete={() => {
            setVisibleUrl(incomingUrl)
            setIncomingUrl('')
          }}
        />
      ) : null}
    </div>
  )
}

// memo 包装：transitionProgress 变化时仍会重渲染（背景过渡依赖），
// 但父级其他重渲染且 props 未变时可跳过。注意：App.tsx 中 imageStyle 为内联对象，
// 每次父渲染都会新建引用，会削弱 memo 命中率（transitionProgress 变化时本组件本就该渲染）。
export default memo(CrossfadeBackground)

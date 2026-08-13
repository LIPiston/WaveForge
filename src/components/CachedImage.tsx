import { useState, useEffect, useMemo, useRef } from 'react'
import { imageCache } from '../utils/imageCache'
import { getProxiedImageUrl } from '../services/musicApi'

interface CachedImageProps {
  src: string
  alt: string
  className?: string
  fallback?: React.ReactNode
  onError?: (e: React.SyntheticEvent<HTMLImageElement, Event>) => void
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  draggable?: boolean
  lazy?: boolean // 是否启用懒加载，默认 true
}

/**
 * 带懒加载功能的图片组件
 * 1. 使用 IntersectionObserver 实现懒加载
 * 2. 通过代理服务器获取图片（解决跨域问题）
 * 3. 使用浏览器内存缓存，不使用 IndexedDB
 */
export default function CachedImage({ src, alt, className, fallback, onError, onLoad, draggable, lazy = true }: CachedImageProps) {
  const normalizedSrc = useMemo(() => {
    if (!src || src.trim() === '') return ''
    return getProxiedImageUrl(src) || src
  }, [src])
  const initialCachedSrc = normalizedSrc ? imageCache.get(normalizedSrc) || '' : ''
  const [imageSrc, setImageSrc] = useState<string>(initialCachedSrc)
  const [loading, setLoading] = useState(!initialCachedSrc)
  const [error, setError] = useState(false)
  const [isVisible, setIsVisible] = useState(!lazy)
  const cachedImageSrc = normalizedSrc ? imageCache.get(normalizedSrc) : null
  const displaySrc = normalizedSrc ? (cachedImageSrc || (imageSrc === normalizedSrc ? imageSrc : '')) : ''
  
  // 使用 ref 跟踪当前请求的 URL，避免竞态条件
  const currentLoadingUrlRef = useRef<string>('')
  // 图片容器的 ref，用于 IntersectionObserver
  const containerRef = useRef<HTMLDivElement>(null)
  // 🔧 修复内存泄漏：跟踪预加载的 Image 对象
  const preloadImageRef = useRef<HTMLImageElement | null>(null)

  // 懒加载：只在元素可见时才加载图片（可选）
  useEffect(() => {
    if (!lazy) {
      // 如果禁用懒加载，立即标记为可见
      setIsVisible(true)
      return
    }

    if (!containerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            // 一旦可见就不再观察
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前50px开始加载
        threshold: 0.01
      }
    )

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
    }
  }, [lazy])

  useEffect(() => {
    // 只有在可见时才加载图片
    if (!isVisible) return

    // 验证 URL 是否有效
    if (!normalizedSrc || normalizedSrc.trim() === '') {
      setImageSrc('') // 清空旧图片
      setLoading(false)
      setError(true)
      return
    }

    // 跳过无效的 QQ 音乐封面 URL（包含 M000.jpg 的是无效 URL）
    if (normalizedSrc.includes('M000.jpg') || normalizedSrc.endsWith('M000.jpg')) {
      setImageSrc('') // 清空旧图片
      setLoading(false)
      setError(true)
      return
    }

    const loadImage = async () => {
      // 标记当前正在加载的 URL
      currentLoadingUrlRef.current = normalizedSrc
      setError(false)

      // 🔧 修复内存泄漏：清理之前的预加载图片
      if (preloadImageRef.current) {
        preloadImageRef.current.onload = null
        preloadImageRef.current.onerror = null
        preloadImageRef.current.src = ''
        preloadImageRef.current = null
      }

      try {
        // 先检查缓存
        const cachedUrl = imageCache.get(normalizedSrc)
        if (cachedUrl) {
          // 检查是否还是当前请求
          if (currentLoadingUrlRef.current !== normalizedSrc) return
          
          // 缓存命中 - 立即显示，不设置 loading 状态
          setImageSrc(cachedUrl)
          setLoading(false)
          return
        }

        // 缓存未命中 - 立即清空旧图片，避免显示错误的封面
        if (!lazy) {
          // 对于非懒加载的图片（如播放器封面），立即清空
          setImageSrc('')
        }
        setLoading(true)

        // src 已经是代理后的 URL，直接使用
        const imageUrl = normalizedSrc

        // 使用 Image() 预加载，确保图片完全加载后再显示
        const img = new Image()
        preloadImageRef.current = img
        
        img.onload = () => {
          // 检查是否还是当前请求（防止竞态条件）
          if (currentLoadingUrlRef.current !== normalizedSrc) {
            return
          }
          
          // 缓存这个 URL
          imageCache.set(normalizedSrc, imageUrl)
          // 图片加载完成后才更新显示
          setImageSrc(imageUrl)
          setLoading(false)
          
          // 🔧 清理预加载图片
          if (preloadImageRef.current === img) {
            preloadImageRef.current = null
          }
        }
        img.onerror = () => {
          if (currentLoadingUrlRef.current !== normalizedSrc) {
            return
          }
          console.error('❌ 加载图片失败:', normalizedSrc)
          setImageSrc('') // 加载失败时才清空
          setError(true)
          setLoading(false)
          
          // 🔧 清理预加载图片
          if (preloadImageRef.current === img) {
            preloadImageRef.current = null
          }
        }
        img.src = imageUrl
      } catch (error) {
        if (currentLoadingUrlRef.current !== normalizedSrc) {
          return
        }
        console.error('加载图片失败:', error)
        setImageSrc('') // 加载失败时才清空
        setError(true)
        setLoading(false)
      }
    }

    loadImage()
    
    // 🔧 修复内存泄漏：组件卸载时清理预加载图片
    return () => {
      if (preloadImageRef.current) {
        preloadImageRef.current.onload = null
        preloadImageRef.current.onerror = null
        preloadImageRef.current.src = ''
        preloadImageRef.current = null
      }
    }
  }, [normalizedSrc, isVisible, lazy])

  const handleError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    setError(true)
    if (onError) {
      onError(e)
    }
  }

  // 如果出错且没有图片，显示 fallback
  if (error && !displaySrc && fallback) {
    return <div ref={containerRef}>{fallback}</div>
  }

  // 如果正在加载且还没有图片，显示 fallback（如果有）或占位符
  if (loading && !displaySrc) {
    if (fallback) {
      return <div ref={containerRef}>{fallback}</div>
    }
    return (
      <div ref={containerRef} className={className}>
        <div className="w-full h-full flex items-center justify-center bg-white/10">
          {/* 加载占位 */}
        </div>
      </div>
    )
  }

  // 如果 displaySrc 为空，显示 fallback 或占位符
  if (!displaySrc || displaySrc.trim() === '') {
    if (fallback) {
      return <div ref={containerRef}>{fallback}</div>
    }
    return (
      <div ref={containerRef} className={className}>
        <div className="w-full h-full flex items-center justify-center bg-white/10">
          {/* 空占位 */}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`${className} overflow-hidden`}>
      <img
        draggable={draggable}
        onLoad={onLoad}
        src={displaySrc}
        alt={alt}
        loading={lazy ? 'lazy' : 'eager'}
        decoding="async"
        className="w-full h-full object-cover"
        onError={handleError}
        style={{
          opacity: 1,
          transition: 'opacity 0.2s ease-in-out'
        }}
      />
    </div>
  )
}





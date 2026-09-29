import { useEffect, useState } from 'react'
import type { NeteaseNativeResource } from './model'
import type { ResourceCallbacks } from './NeteaseResourceView'

/**
 * 网易云精选页顶部的官方 banner 大图轮播（对齐官方客户端）：
 * 自动轮播（4.5s）+ 指示点 + 悬停暂停；资源复用原生链路的广告过滤结果。
 */
export default function NeteaseBannerCarousel({ resources, callbacks }: {
  resources: NeteaseNativeResource[]
  callbacks: ResourceCallbacks
}) {
  const slides = resources.slice(0, 8)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused || slides.length <= 1) return
    const timer = window.setInterval(() => setIndex(i => (i + 1) % slides.length), 4500)
    return () => window.clearInterval(timer)
  }, [paused, slides.length])

  // 资源集变化（频道切换/翻页）时收敛到合法下标
  if (index >= slides.length) setIndex(0)

  if (slides.length === 0) return null

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.03]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="推荐轮播"
    >
      <div className="flex transition-transform duration-500 ease-out" style={{ transform: `translateX(-${index * 100}%)` }}>
        {slides.map((resource, i) => {
          const image = resource.purePictureUrl || resource.coverUrl
          return (
            <button
              key={`${resource.id}-${i}`}
              type="button"
              onClick={() => callbacks.onExecute(resource, slides)}
              className="relative block aspect-[21/9] w-full shrink-0 text-left"
              aria-hidden={i !== index}
              tabIndex={i === index ? 0 : -1}
            >
              {image ? (
                <img src={image} alt={resource.title || 'banner'} className="h-full w-full object-cover" loading={i === 0 ? 'eager' : 'lazy'} />
              ) : (
                <span className="flex aspect-[21/9] w-full items-center justify-center bg-white/[0.06] text-sm text-white/50">{resource.title || '推荐内容'}</span>
              )}
              {resource.title && (
                <span className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-10 text-left text-sm font-medium text-white/90">
                  {resource.title}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {slides.length > 1 && (
        <div className="absolute bottom-3 right-4 flex gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`跳到第 ${i + 1} 张`}
              aria-current={i === index}
              className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-white' : 'w-1.5 bg-white/45 hover:bg-white/70'}`}
            />
          ))}
        </div>
      )}
    </section>
  )
}

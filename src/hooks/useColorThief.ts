import { useState, useEffect } from 'react'
import { indexedDBCache } from '../services/indexedDBCache'

interface ColorPalette {
  dominantColor: string | null
  palette: string[]
}

interface CoverSource {
  url: string
  isObjectUrl: boolean
}

/**
 * 以对象 URL 形式加载封面，避免生成长期驻留的 base64 DataURL 大字符串。
 * 返回的 isObjectUrl 为 true 时，调用方使用完毕后必须 revokeObjectURL。
 */
async function loadCoverAsObjectUrl(imageUrl: string): Promise<CoverSource> {
  try {
    const cachedBlob = await indexedDBCache.getCoverBlob(imageUrl)
    if (cachedBlob) return { url: URL.createObjectURL(cachedBlob), isObjectUrl: true }
  } catch {
    // 缓存读取失败时直接走代理下载
  }
  const proxyUrl = `http://localhost:3001/api/proxy-image?url=${encodeURIComponent(imageUrl)}`
  try {
    const response = await fetch(proxyUrl)
    if (!response.ok) return { url: proxyUrl, isObjectUrl: false }
    const blob = await response.blob()
    await indexedDBCache.cacheCover(imageUrl, blob)
    return { url: URL.createObjectURL(blob), isObjectUrl: true }
  } catch {
    return { url: proxyUrl, isObjectUrl: false }
  }
}

/** 释放采样用的小 Canvas，让像素缓冲尽快被 GC 回收。 */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

export function useColorThief(imageUrl: string): ColorPalette {
  const [dominantColor, setDominantColor] = useState<string | null>(null)
  const [palette, setPalette] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    let image: HTMLImageElement | null = null
    let objectUrl: string | null = null

    const releaseSource = () => {
      if (image) {
        image.onload = null
        image.onerror = null
        image.src = ''
        image = null
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
    }

    if (!imageUrl) {
      setDominantColor(null)
      setPalette([])
      return
    }

    void (async () => {
      try {
        const source = await loadCoverAsObjectUrl(imageUrl)
        if (cancelled) {
          if (source.isObjectUrl) URL.revokeObjectURL(source.url)
          return
        }
        if (source.isObjectUrl) objectUrl = source.url
        image = new Image()
        image.crossOrigin = 'Anonymous'
        image.onload = () => {
          if (cancelled || !image) return
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          canvas.width = 50
          canvas.height = 50
          ctx.drawImage(image, 0, 0, 50, 50)
          const data = ctx.getImageData(0, 0, 50, 50).data
          // 采样完成后立即释放解码后的封面图、Canvas 与对象 URL，避免残留占用内存
          releaseSource()
          releaseCanvas(canvas)
          let red = 0
          let green = 0
          let blue = 0
          const buckets = new Map<string, { red: number; green: number; blue: number; count: number }>()
          for (let index = 0; index < data.length; index += 4) {
            const pixelRed = data[index]
            const pixelGreen = data[index + 1]
            const pixelBlue = data[index + 2]
            red += pixelRed
            green += pixelGreen
            blue += pixelBlue

            const luminance = pixelRed * 0.2126 + pixelGreen * 0.7152 + pixelBlue * 0.0722
            if (data[index + 3] < 180 || luminance < 18 || luminance > 242) continue
            const key = `${Math.round(pixelRed / 28)}-${Math.round(pixelGreen / 28)}-${Math.round(pixelBlue / 28)}`
            const bucket = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 }
            bucket.red += pixelRed
            bucket.green += pixelGreen
            bucket.blue += pixelBlue
            bucket.count += 1
            buckets.set(key, bucket)
          }
          const pixelCount = data.length / 4
          const color = `rgb(${Math.floor(red / pixelCount * 0.5)}, ${Math.floor(green / pixelCount * 0.5)}, ${Math.floor(blue / pixelCount * 0.5)})`
          const candidates = [...buckets.values()]
            .map(bucket => ({
              red: Math.round(bucket.red / bucket.count),
              green: Math.round(bucket.green / bucket.count),
              blue: Math.round(bucket.blue / bucket.count),
              count: bucket.count,
            }))
            .sort((left, right) => right.count - left.count)
          const selected: typeof candidates = []

          for (const candidate of candidates) {
            const sufficientlyDifferent = selected.every(existing => {
              const distance = Math.hypot(
                candidate.red - existing.red,
                candidate.green - existing.green,
                candidate.blue - existing.blue
              )
              return distance >= 54
            })
            if (!sufficientlyDifferent) continue
            selected.push(candidate)
            if (selected.length >= 4) break
          }

          setDominantColor(color)
          setPalette(selected.length > 0
            ? selected.map(item => `rgb(${item.red}, ${item.green}, ${item.blue})`)
            : [color])
        }
        image.onerror = () => {
          if (cancelled) return
          setDominantColor(null)
          setPalette([])
        }
        image.src = source.url
      } catch (error) {
        if (cancelled) return
        console.error('提取颜色失败:', error)
        setDominantColor(null)
        setPalette([])
      }
    })()

    return () => {
      cancelled = true
      releaseSource()
    }
  }, [imageUrl])

  return { dominantColor, palette }
}

// 独立的颜色提取函数，用于异步提取
export async function extractDominantColor(imageUrl: string): Promise<string | null> {
  if (!imageUrl) return null

  let source: CoverSource | null = null
  try {
    source = await loadCoverAsObjectUrl(imageUrl)
    const loadedSource = source

    return await new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'Anonymous'

      const finish = () => {
        // 释放解码后的封面图与对象 URL
        img.onload = null
        img.onerror = null
        img.src = ''
        if (loadedSource.isObjectUrl) URL.revokeObjectURL(loadedSource.url)
      }

      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          finish()
          resolve(null)
          return
        }

        // 缩小图片以提高性能
        canvas.width = 50
        canvas.height = 50
        ctx.drawImage(img, 0, 0, 50, 50)

        const imageData = ctx.getImageData(0, 0, 50, 50).data

        // 简单的颜色提取算法
        let r = 0, g = 0, b = 0
        const pixelCount = imageData.length / 4

        for (let i = 0; i < imageData.length; i += 4) {
          r += imageData[i]
          g += imageData[i + 1]
          b += imageData[i + 2]
        }

        r = Math.floor(r / pixelCount)
        g = Math.floor(g / pixelCount)
        b = Math.floor(b / pixelCount)

        // 调暗颜色以适应背景
        const darkenFactor = 0.5
        r = Math.floor(r * darkenFactor)
        g = Math.floor(g * darkenFactor)
        b = Math.floor(b * darkenFactor)

        finish()
        releaseCanvas(canvas)
        resolve(`rgb(${r}, ${g}, ${b})`)
      }

      img.onerror = () => {
        finish()
        resolve(null)
      }

      img.src = loadedSource.url
    })
  } catch (error) {
    console.error('提取颜色失败:', error)
    if (source?.isObjectUrl) URL.revokeObjectURL(source.url)
    return null
  }
}

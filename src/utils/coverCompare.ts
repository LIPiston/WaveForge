/**
 * 封面差异判定：对比两张封面是否"显著不同"（用于判断 Apple Music 是否为特殊封面）。
 * 方法：各缩到 16x16 后逐像素比较平均通道差，超过阈值视为特殊封面。
 * 任一图片加载失败（CORS/网络）返回 false（保守：不替换，保持平台封面）。
 */

async function loadThumb(url: string): Promise<ImageData | null> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, 16, 16)
  return ctx.getImageData(0, 0, 16, 16)
}

export async function coversDifferSignificantly(a: string, b: string, threshold = 30): Promise<boolean> {
  try {
    const [pa, pb] = await Promise.all([loadThumb(a), loadThumb(b)])
    if (!pa || !pb) return false
    let diff = 0
    let samples = 0
    for (let i = 0; i < pa.data.length; i += 4) {
      diff +=
        Math.abs(pa.data[i] - pb.data[i]) +
        Math.abs(pa.data[i + 1] - pb.data[i + 1]) +
        Math.abs(pa.data[i + 2] - pb.data[i + 2])
      samples += 3
    }
    return samples > 0 && diff / samples > threshold
  } catch {
    return false
  }
}

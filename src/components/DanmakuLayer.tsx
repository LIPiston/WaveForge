/**
 * B 站弹幕渲染层（canvas，覆盖在视频之上、控件之下）
 *
 * - 时间轴跟随视频 currentTime（音频时钟驱动的视频同步后自动对齐）
 * - 支持滚动/顶部/底部三种模式，轨道分配按活跃弹幕实时位置避免重叠
 * - 设置：不透明度/字号/显示区域/同屏上限/速度/模式开关/屏蔽词
 */

import { useEffect, useRef } from 'react'
import type { BilibiliDanmakuItem, DanmakuSettings } from '../services/bilibiliApi'

interface DanmakuLayerProps {
  items: BilibiliDanmakuItem[]
  settings: DanmakuSettings
  isPlaying: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
}

interface ActiveDanmaku {
  text: string
  mode: number
  color: number
  fontSize: number
  x: number
  y: number
  vx: number
  width: number
  lane: number
  bornAt: number
}

const SCROLL_CROSS_SECONDS = 9 // 滚动弹幕横穿画布基准秒数（速度 1 时）
const FIXED_DURATION_MS = 4000 // 顶部/底部弹幕停留时长
const LANE_GAP = 6

export default function DanmakuLayer({ items, settings, isPlaying, videoRef }: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      const rect = parent.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)

    // 屏蔽词
    const shieldWords = settings.shieldKeywords.split(/[,，\s]+/).filter(Boolean)
    const filtered = items.filter((it) => !shieldWords.some((k) => it.text.includes(k)))

    const cssWidth = () => parent.getBoundingClientRect().width
    const cssHeight = () => parent.getBoundingClientRect().height
    const fontSizeAt = () => Math.max(12, Math.min(36, settings.fontSize * (cssWidth() / 1920)))
    const laneCountAt = () => {
      const h = cssHeight()
      const fs = fontSizeAt()
      return Math.max(1, Math.floor((h * settings.displayArea) / 100 / (fs + LANE_GAP)))
    }

    const active: ActiveDanmaku[] = []

    let raf = 0
    let last = performance.now()
    let spawnIndex = 0

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const video = videoRef.current
      if (!video) {
        raf = requestAnimationFrame(tick)
        return
      }
      const w = cssWidth()
      const h = cssHeight()
      const fs = fontSizeAt()
      const laneCount = laneCountAt()
      ctx.clearRect(0, 0, w, h)

      const time = video.currentTime || 0
      const alpha = Math.max(0, Math.min(1, settings.opacity / 100))
      // 暂停时不推进：不生成新弹幕、滚动/停留计时冻结
      const effDt = isPlaying ? dt : 0

      // 生成新弹幕
      while (spawnIndex < filtered.length && filtered[spawnIndex].time <= time) {
        const item = filtered[spawnIndex]
        spawnIndex++
        const isScroll = item.mode === 1 || item.mode === 6
        const isTop = item.mode === 5
        const isBottom = item.mode === 4
        if (!isScroll && !isTop && !isBottom) continue
        if (isScroll && !settings.showScroll) continue
        if (isTop && !settings.showTop) continue
        if (isBottom && !settings.showBottom) continue
        if (active.length >= settings.maxOnScreen) continue

        ctx.font = `bold ${fs}px sans-serif`
        const width = ctx.measureText(item.text).width
        const lane = pickLane(isScroll, item.mode, laneCount, active, w, width, fs + LANE_GAP)
        if (lane < 0) continue

        const y = isBottom
          ? h - (h * settings.displayArea) / 100 + (lane + 1) * (fs + LANE_GAP) - LANE_GAP
          : isTop
            ? lane * (fs + LANE_GAP)
            : lane * (fs + LANE_GAP)
        active.push({
          text: item.text,
          mode: item.mode,
          color: item.color,
          fontSize: fs,
          x: isScroll ? w : 0,
          y,
          vx: isScroll ? -((w + width) / (SCROLL_CROSS_SECONDS / settings.speed)) : 0,
          width,
          lane,
          bornAt: now,
        })
      }

      // 更新 + 绘制
      const nowAlive: ActiveDanmaku[] = []
      for (const a of active) {
        if (a.mode === 1 || a.mode === 6) {
          a.x += a.vx * effDt * 1000
          if (a.x + a.width < -20) continue // 滚出屏幕
        } else {
          if (effDt > 0 && now - a.bornAt > FIXED_DURATION_MS) continue // 停留结束
        }
        ctx.font = `bold ${a.fontSize}px sans-serif`
        ctx.globalAlpha = alpha
        ctx.fillStyle = `#${a.color.toString(16).padStart(6, '0')}`
        ctx.fillText(a.text, a.x, a.y + a.fontSize)
        nowAlive.push(a)
      }
      active.length = 0
      active.push(...nowAlive)
      ctx.globalAlpha = 1

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // 依赖 items 引用：loadVideo 每次成功会替换新列表
  }, [items, settings, isPlaying, videoRef])

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-20" aria-hidden="true" />
}

/**
 * 选轨道：
 * - 顶部/底部：找一条当前没有同模式活跃弹幕的道
 * - 滚动：找一条"最右弹幕已让出足够空间"的道（按活跃弹幕实时 x 判断，避免只出几条后全部丢弃）
 */
function pickLane(
  isScroll: boolean,
  mode: number,
  laneCount: number,
  active: ActiveDanmaku[],
  canvasWidth: number,
  itemWidth: number,
  minLeading: number,
): number {
  if (!isScroll) {
    for (let i = 0; i < laneCount; i++) {
      const occupied = active.some((a) => a.lane === i && (a.mode === 4 || a.mode === 5))
      if (!occupied) return i
    }
    return -1
  }
  const laneRightmost = (lane: number): number => {
    let maxX = 0
    for (const a of active) {
      if ((a.mode === 1 || a.mode === 6) && a.lane === lane && a.x > maxX) maxX = a.x
    }
    return maxX
  }
  for (let i = 0; i < laneCount; i++) {
    const rightmost = laneRightmost(i)
    if (rightmost === 0 || rightmost < canvasWidth - itemWidth - minLeading) return i
  }
  return -1
}

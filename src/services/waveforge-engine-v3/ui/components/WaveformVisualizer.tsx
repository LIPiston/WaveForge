/**
 * 系统音效波形可视化 —— Apple 风格
 *
 * 设计：中央对称的圆角频谱条（从中心线向上下伸展），琥珀金渐变 + 顶部高光，
 * 目标值经惯性平滑（lerp）产生缓慢流动感；背景中央径向光晕。
 * 无音效时以柔和正弦缓慢起伏，有音效时幅度与速度提升。
 */

import { useEffect, useRef } from 'react'
import type { HSETheme } from '../hse-theme'

const BAR_COUNT = 44

export function WaveformVisualizer({ theme, active }: { theme: HSETheme; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const phaseRef = useRef(0)
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0.06))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, rect.width * dpr)
      canvas.height = Math.max(1, rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      const accent = theme.accentColor

      // 背景中央光晕（径向渐变）
      const glowR = Math.min(width, height) * 0.55
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR)
      glow.addColorStop(0, `${accent}1f`)
      glow.addColorStop(1, `${accent}00`)
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, width, height)

      // 中央基准线
      ctx.strokeStyle = `${accent}33`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, cy)
      ctx.lineTo(width, cy)
      ctx.stroke()

      // 相位推进（有音效更快）
      phaseRef.current += active ? 0.055 : 0.012

      const gap = 3
      const barW = Math.max(3, (width - gap * (BAR_COUNT + 1)) / BAR_COUNT)
      const maxH = height * 0.46

      for (let i = 0; i < BAR_COUNT; i++) {
        // 目标振幅：多层正弦叠加（偶/奇谐波 + 慢速包络），有音效时更强
        const t = phaseRef.current
        const target = active
          ? 0.28 +
            Math.abs(Math.sin(i * 0.42 + t * 1.4)) * 0.34 +
            Math.abs(Math.sin(i * 0.19 - t * 0.9)) * 0.2 +
            Math.sin(i * 0.07 + t * 0.5) * 0.12
          : 0.05 + Math.abs(Math.sin(i * 0.5 + t * 0.8)) * 0.06 + Math.sin(i * 0.13 + t * 0.35) * 0.03
        const clamped = Math.min(1, Math.max(0.03, target))

        // 惯性平滑（缓慢流动，Apple 风格）
        const levels = levelsRef.current
        levels[i] += (clamped - levels[i]) * (active ? 0.16 : 0.05)
        const v = levels[i]

        const barH = Math.max(3, v * maxH)
        const x = gap + i * (barW + gap)
        const y0 = cy - barH / 2

        // 渐变填充：顶部亮琥珀 → 底部半透明
        const grad = ctx.createLinearGradient(0, y0, 0, y0 + barH)
        grad.addColorStop(0, `${accent}dd`)
        grad.addColorStop(0.45, `${accent}77`)
        grad.addColorStop(1, `${accent}2e`)
        ctx.fillStyle = grad

        // 圆角矩形
        const r = Math.min(barW / 2, 3)
        ctx.beginPath()
        ctx.moveTo(x + r, y0)
        ctx.lineTo(x + barW - r, y0)
        ctx.quadraticCurveTo(x + barW, y0, x + barW, y0 + r)
        ctx.lineTo(x + barW, y0 + barH - r)
        ctx.quadraticCurveTo(x + barW, y0 + barH, x + barW - r, y0 + barH)
        ctx.lineTo(x + r, y0 + barH)
        ctx.quadraticCurveTo(x, y0 + barH, x, y0 + barH - r)
        ctx.lineTo(x, y0 + r)
        ctx.quadraticCurveTo(x, y0, x + r, y0)
        ctx.closePath()
        ctx.fill()

        // 顶部高光细线
        ctx.fillStyle = `${accent}99`
        ctx.fillRect(x + 1, y0, barW - 2, 1.5)
      }

      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [theme.accentColor, active])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

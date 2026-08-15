import { useEffect, useRef } from 'react'
import type { EqPoint } from '../services/audio-effects-v3/curve'
import { evaluateCurveAt } from '../services/audio-effects-v3/curve'
import { logAxis128 } from '../services/audio-effects-v3/constants'

/**
 * 频响曲线可视化（对应原应用 EqCurveView / SpeakerResponseGraphView 的 Windows 版）
 *
 * canvas 绘制：20Hz-20kHz 对数频率轴 × ±12dB 增益网格，
 * 当前 EQ 曲线（实线，128 点高斯叠加求值）+ 可选叠加曲线（虚线，如机型实测频响）。
 */

interface ResponseCurveGraphProps {
  /** 当前 EQ 曲线点 */
  curve: EqPoint[]
  /** 叠加曲线（128 点，20Hz-20kHz 对数轴）；null = 不叠加 */
  overlay?: number[] | null
  /** 叠加曲线名称（图例用） */
  overlayLabel?: string
  height?: number
  accentColor?: string
}

const F_MIN = 20
const F_MAX = 20000
const G_MIN = -12
const G_MAX = 12
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

function freqToX(f: number, w: number): number {
  const lo = Math.log10(F_MIN)
  const hi = Math.log10(F_MAX)
  return ((Math.log10(Math.max(F_MIN, Math.min(F_MAX, f))) - lo) / (hi - lo)) * w
}

function gainToY(g: number, h: number): number {
  const clamped = Math.max(G_MIN, Math.min(G_MAX, g))
  return h - ((clamped - G_MIN) / (G_MAX - G_MIN)) * h
}

export default function ResponseCurveGraph({
  curve, overlay, overlayLabel, height = 160, accentColor = '#8b5cf6',
}: ResponseCurveGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth || 600
    const h = height
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    // 网格
    ctx.strokeStyle = 'rgba(128, 128, 160, 0.18)'
    ctx.lineWidth = 1
    ctx.font = '9px sans-serif'
    ctx.fillStyle = 'rgba(128, 128, 160, 0.55)'
    for (const f of GRID_FREQS) {
      const x = freqToX(f, w)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x + 2, h - 3)
    }
    // 0dB 参考线
    ctx.strokeStyle = 'rgba(128, 128, 160, 0.35)'
    ctx.beginPath()
    ctx.moveTo(0, gainToY(0, h))
    ctx.lineTo(w, gainToY(0, h))
    ctx.stroke()
    for (let g = -12; g <= 12; g += 6) {
      const y = gainToY(g, h)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      ctx.fillText(String(g), 2, y - 2)
    }

    // 叠加曲线（虚线）
    if (overlay && overlay.length > 0) {
      ctx.strokeStyle = 'rgba(255, 150, 80, 0.75)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      const axis = logAxis128()
      overlay.forEach((g, i) => {
        const x = freqToX(axis[i]!, w)
        const y = gainToY(g, h)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.setLineDash([])
      if (overlayLabel) {
        ctx.fillStyle = 'rgba(255, 150, 80, 0.9)'
        ctx.fillText(overlayLabel, w - 90, 12)
      }
    }

    // 当前曲线（实线）
    ctx.strokeStyle = accentColor
    ctx.lineWidth = 2
    ctx.beginPath()
    const axis2 = logAxis128()
    axis2.forEach((f, i) => {
      const x = freqToX(f, w)
      const y = gainToY(evaluateCurveAt(curve, f), h)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }, [curve, overlay, overlayLabel, height, accentColor])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
      aria-label="频响曲线"
    />
  )
}

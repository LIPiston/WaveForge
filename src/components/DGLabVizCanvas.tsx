/**
 * DG-LAB 实时波形：A=左声道、B=右声道的「音量包络波形」，**自右向左滚动**，
 * 体现 低-平-高 动态（安静段落平、主歌中等、副歌/鼓点高）。每帧仅取一次峰值
 * （性能友好），无分析器时回退为强度曲线。右侧数字为各通道当前强度。
 */

import { useEffect, useRef } from 'react'
import type { DGLabStatus } from '../plugins/clients/DGLabClient'
import { getGlobalAudioAnalysers } from '../plugins/clients/DGLabClient'

const GOLD = '#FFE89C'
const CYAN = '#22d3ee'
const BG = '#0b0b0e'

interface DGLabVizCanvasProps {
  status: DGLabStatus
  height?: number
}

export default function DGLabVizCanvas({ status, height = 190 }: DGLabVizCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const envARef = useRef<number[]>([])
  const envBRef = useRef<number[]>([])
  const timeBufRef = useRef<Uint8Array | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let raf = 0

    const draw = () => {
      raf = 0
      const cw = canvas.clientWidth || 320
      const ch = canvas.clientHeight || height
      const targetW = Math.round(cw * dpr)
      const targetH = Math.round(ch * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      ctx.clearRect(0, 0, cw, ch)
      ctx.fillStyle = BG
      ctx.fillRect(0, 0, cw, ch)

      const { left, right } = getGlobalAudioAnalysers()
      if (left && !timeBufRef.current) timeBufRef.current = new Uint8Array(left.frequencyBinCount)
      const out = statusRef.current.out

      // 每帧取一次通道峰值（绝对幅度），作为「低-平-高」包络值，右进左出滚动
      const samplePeak = (analyser: AnalyserNode | null): number => {
        if (analyser && timeBufRef.current) {
          analyser.getByteTimeDomainData(timeBufRef.current)
          let peak = 0
          const buf = timeBufRef.current
          for (let i = 0; i < buf.length; i += 1) {
            const v = Math.abs(buf[i] - 128) / 128
            if (v > peak) peak = v
          }
          return peak
        }
        return 0
      }
      const laneH = ch / 2
      const padX = 40
      const waveW = cw - padX - 8

      const drawLane = (label: 'A' | 'B', analyser: AnalyserNode | null, env: number[], getInt: () => number, color: string) => {
        const y0 = label === 'A' ? 0 : laneH
        const baseline = y0 + laneH * 0.62
        // 每次移动 2px（平滑右→左滚动）
        env.push(samplePeak(analyser) || (getInt() / 200))
        const cols = Math.max(1, Math.floor(waveW / 2))
        while (env.length > cols) env.shift()

        // 填充面积 + 描边（右→左：数组尾部 = 最新/最右）
        const step = waveW / Math.max(1, cols - 1)
        ctx.beginPath()
        env.forEach((v, i) => {
          const x = padX + i * step
          const y = baseline - clamp01(v) * (laneH * 0.9)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.lineTo(padX + (env.length - 1) * step, baseline)
        ctx.lineTo(padX, baseline)
        ctx.closePath()
        const grad = ctx.createLinearGradient(0, baseline - laneH * 0.9, 0, baseline)
        grad.addColorStop(0, `${color}66`)
        grad.addColorStop(1, `${color}05`)
        ctx.fillStyle = grad
        ctx.fill()
        ctx.beginPath()
        env.forEach((v, i) => {
          const x = padX + i * step
          const y = baseline - clamp01(v) * (laneH * 0.9)
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = color
        ctx.lineWidth = 1.6
        ctx.shadowColor = color
        ctx.shadowBlur = 5
        ctx.stroke()
        ctx.shadowBlur = 0

        ctx.fillStyle = color
        ctx.font = 'bold 11px system-ui, sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(label === 'A' ? 'A·左' : 'B·右', 4, y0 + 14)
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.font = 'bold 12px system-ui, sans-serif'
        ctx.fillText(String(Math.round(getInt())), 4, y0 + 30)
      }

      drawLane('A', left, envARef.current, () => out?.A ?? 0, GOLD)
      drawLane('B', right, envBRef.current, () => out?.B ?? 0, CYAN)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      envARef.current = []
      envBRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height])

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-xl border border-white/10"
      style={{ background: BG, display: 'block', height }}
    />
  )
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
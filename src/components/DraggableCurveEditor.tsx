import { useEffect, useRef } from 'react'
import type { EqPoint } from '../services/audio-effects-v3/curve'
import { sortCurve } from '../services/audio-effects-v3/curve'
import { quantizeFreq, quantizeGain } from '../services/audio-effects-v3/constants'

/**
 * EQ 曲线拖拽编辑器（对应原应用 EqCurveView 的 PEQ 编辑模式）
 *
 * 受控组件：父组件持有曲线点状态，本组件只负责绘制与交互事件。
 * 任何修改（新增 / 拖拽 / 删除）都通过 onChange 回传新的点数组，
 * 由父组件决定调用 setBand / addBandAt / removeBandAt 与持久化。
 *
 * 坐标系统与 ResponseCurveGraph 一致：20Hz-20kHz 对数横轴 × ±12dB 纵轴。
 * 交互使用 pointer 事件（Pointer Events），拖拽状态保存在 useRef 中。
 */

interface DraggableCurveEditorProps {
  /** 当前曲线点（受控：父组件持有状态） */
  points: EqPoint[]
  /** 任意修改后回调（父组件负责 setBand/addBandAt/removeBandAt 与持久化） */
  onChange: (points: EqPoint[]) => void
  height?: number
  accentColor?: string
  /** 禁用交互（EQ 锁定时用） */
  disabled?: boolean
}

const F_MIN = 20
const F_MAX = 20000
const G_MIN = -12
const G_MAX = 12
/** 曲线点数量上限（与原应用一致，最多 50 点） */
const MAX_POINTS = 50
/** 命中判定半径（px）：拖拽 / 双击 / 空白点击判定的距离阈值 */
const HIT_RADIUS = 14
/** 移动判定阈值（px）：按下后位移超过该值视为拖拽而非点击 */
const MOVE_THRESHOLD = 4
/** 网格频率刻度（Hz） */
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

/** 频率 → 横坐标（对数轴，20Hz-20kHz 归一化，越界钳制） */
function freqToX(f: number, w: number): number {
  const lo = Math.log10(F_MIN)
  const hi = Math.log10(F_MAX)
  return ((Math.log10(Math.max(F_MIN, Math.min(F_MAX, f))) - lo) / (hi - lo)) * w
}

/** 增益 → 纵坐标（±12dB，超出显示范围时钳制到边缘） */
function gainToY(g: number, h: number): number {
  const clamped = Math.max(G_MIN, Math.min(G_MAX, g))
  return h - ((clamped - G_MIN) / (G_MAX - G_MIN)) * h
}

/** 横坐标 → 频率（对数反算） */
function xToFreq(x: number, w: number): number {
  const lo = Math.log10(F_MIN)
  const hi = Math.log10(F_MAX)
  return Math.pow(10, lo + (x / w) * (hi - lo))
}

/** 纵坐标 → 增益（反算，输出范围为 ±12dB） */
function yToGain(y: number, h: number): number {
  return G_MIN + (1 - y / h) * (G_MAX - G_MIN)
}

/** 找距离指定位置最近的点索引；超过 HIT_RADIUS 返回 null */
function findNearestIndex(
  x: number,
  y: number,
  points: EqPoint[],
  w: number,
  h: number,
): number | null {
  let best: number | null = null
  let bestDist = Infinity
  points.forEach((p, i) => {
    const px = freqToX(p.freq, w)
    const py = gainToY(p.gain, h)
    const d = Math.hypot(x - px, y - py)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return bestDist <= HIT_RADIUS ? best : null
}

export default function DraggableCurveEditor({
  points,
  onChange,
  height = 180,
  accentColor = '#8b5cf6',
  disabled = false,
}: DraggableCurveEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 拖拽状态：当前拖拽的点索引 + 是否已移动（用于区分点击与拖拽） */
  const dragStateRef = useRef<{ index: number | null; moved: boolean }>({
    index: null,
    moved: false,
  })
  /** 按下时的画布坐标（用于移动判定与空白点击判定） */
  const downPosRef = useRef<{ x: number; y: number } | null>(null)
  /** 空白点击候选：按下位置（抬起时若未移动且远离所有点则新增） */
  const pendingAddRef = useRef<{ x: number; y: number } | null>(null)

  // 受控组件：每次渲染直接用 props.points 重绘（不做内部缓存/克隆）
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

    // ---- 网格与坐标标签 ----
    ctx.lineWidth = 1
    ctx.font = '9px sans-serif'
    ctx.fillStyle = 'rgba(128, 128, 160, 0.55)'
    // 垂直网格：频率刻度
    ctx.strokeStyle = 'rgba(128, 128, 160, 0.18)'
    for (const f of GRID_FREQS) {
      const x = freqToX(f, w)
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, h - 3)
    }
    // 水平网格：增益刻度（±12 / ±6 / 0），0dB 参考线稍深
    for (let g = -12; g <= 12; g += 6) {
      const y = gainToY(g, h)
      ctx.strokeStyle = g === 0 ? 'rgba(128, 128, 160, 0.4)' : 'rgba(128, 128, 160, 0.18)'
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      ctx.fillText(String(g), 2, y - 2)
    }

    // ---- 曲线连线（按频率升序的折线，2px，accentColor） ----
    const sorted = sortCurve(points)
    if (sorted.length > 0) {
      ctx.strokeStyle = accentColor
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      sorted.forEach((p, i) => {
        const x = freqToX(p.freq, w)
        const y = gainToY(p.gain, h)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }

    // ---- 频段控制点（小圆点，半径 4px） ----
    for (const p of points) {
      const x = freqToX(p.freq, w)
      const y = gainToY(p.gain, h)
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = accentColor
      ctx.fill()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [points, height, accentColor, disabled])

  /** 取画布内坐标（相对左上角，PointerEvent 与 MouseEvent 通用） */
  function getPos(e: {
    clientX: number
    clientY: number
    currentTarget: HTMLCanvasElement
  }): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  /** 按下：命中点则开始拖拽；否则记为空白点击候选 */
  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    const canvas = e.currentTarget
    const w = canvas.clientWidth || 600
    const pos = getPos(e)
    downPosRef.current = pos
    const nearest = findNearestIndex(pos.x, pos.y, points, w, height)
    if (nearest !== null) {
      dragStateRef.current = { index: nearest, moved: false }
      canvas.style.cursor = 'grabbing'
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        // 忽略指针捕获失败（仍可继续拖拽）
      }
    } else {
      pendingAddRef.current = pos
    }
  }

  /** 移动：拖拽中实时更新点；未拖拽时更新光标并判定是否已移动 */
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    const canvas = e.currentTarget
    const w = canvas.clientWidth || 600
    const pos = getPos(e)
    const down = downPosRef.current
    const dragging = dragStateRef.current

    if (dragging.index !== null) {
      // 位移超过阈值记为拖拽（区分"点在原地点击"与"拖拽"）
      if (!dragging.moved && down && Math.hypot(pos.x - down.x, pos.y - down.y) > MOVE_THRESHOLD) {
        dragging.moved = true
      }
      // 实时更新该点：freq 钳制 20-20000、gain 钳制 ±15dB（量化函数自带钳制）
      // 拖拽过程中每帧都回调 onChange，父组件实时预览；为简单全程量化
      const cur = points[dragging.index]
      if (cur) {
        const freq = quantizeFreq(xToFreq(pos.x, w))
        const gain = quantizeGain(yToGain(pos.y, height))
        if (freq !== cur.freq || gain !== cur.gain) {
          const next = points.map((p, i) => (i === dragging.index ? { ...p, freq, gain } : p))
          onChange(next)
        }
      }
    } else {
      // 空白按下后位移超过阈值：取消点击新增候选
      if (pendingAddRef.current && down && Math.hypot(pos.x - down.x, pos.y - down.y) > MOVE_THRESHOLD) {
        pendingAddRef.current = null
      }
      // 悬停光标反馈：命中点可抓取，空白处为十字
      const nearest = findNearestIndex(pos.x, pos.y, points, w, height)
      canvas.style.cursor = nearest !== null ? 'grab' : 'crosshair'
    }
  }

  /** 抬起：释放拖拽；空白点击未移动且远离所有点则新增 */
  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    const canvas = e.currentTarget
    const w = canvas.clientWidth || 600
    const dragging = dragStateRef.current
    if (dragging.index !== null) {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      dragStateRef.current = { index: null, moved: false }
      canvas.style.cursor = 'crosshair'
    }
    const add = pendingAddRef.current
    pendingAddRef.current = null
    downPosRef.current = null
    if (add) {
      const pos = getPos(e)
      // 距离任何点 > 14px 才算空白点击；点数量已达 50 上限则不新增
      if (points.length < MAX_POINTS && findNearestIndex(pos.x, pos.y, points, w, height) === null) {
        const freq = quantizeFreq(xToFreq(pos.x, w))
        const gain = quantizeGain(yToGain(pos.y, height))
        // 新增点：freq 量化到整数、gain 量化到 0.5dB、q 取 1.0
        onChange([...points, { freq, gain, q: 1 }])
      }
    }
  }

  /** 取消（如触摸被系统接管）：清空拖拽与点击候选状态 */
  function handlePointerCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    const canvas = e.currentTarget
    if (dragStateRef.current.index !== null && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId)
    }
    dragStateRef.current = { index: null, moved: false }
    pendingAddRef.current = null
    downPosRef.current = null
    canvas.style.cursor = 'crosshair'
  }

  /** 双击：删除命中的点（点数 > 1 才允许删） */
  function handleDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (disabled) return
    if (points.length <= 1) return
    const canvas = e.currentTarget
    const w = canvas.clientWidth || 600
    const pos = getPos(e)
    const nearest = findNearestIndex(pos.x, pos.y, points, w, height)
    if (nearest !== null) {
      onChange(points.filter((_, i) => i !== nearest))
    }
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block', touchAction: 'none' }}
      aria-label="EQ 曲线拖拽编辑器"
      aria-disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onDoubleClick={handleDoubleClick}
    />
  )
}

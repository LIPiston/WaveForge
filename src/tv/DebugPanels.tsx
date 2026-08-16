/**
 * TV 调试模式面板（developerMode 开启后显示）：
 *  - 后端日志：左下角（轮询 /api/tv/logs）
 *  - 前端日志：左下角（后端面板上方，两个都开时一上一下）
 *  - 性能信息：右上角（简约/详细两档）
 *
 * 特性：弹窗样式、半透明、内容 pointer-events:none、整体 data-tv-skip——
 * 遥控器空间导航与手机远程光标都不会选中/阻塞这三个框。
 */
import { useEffect, useRef, useState } from 'react'
import {
  useDebugMode,
  useFrontendLogs,
  useBackendLogs,
  usePerf,
  startPerfMeasurement,
  stopPerfMeasurement,
  startBackendLogPolling,
  stopBackendLogPolling,
  type LogLine,
} from './debugStore'

const PANEL_BG = 'rgba(8, 12, 20, 0.72)'
const PANEL_BORDER = 'rgba(255,255,255,0.14)'

const levelColor: Record<LogLine['level'], string> = {
  log: '#9cdcfe',
  info: '#7ee787',
  warn: '#ffd28a',
  error: '#ff7b72',
  debug: '#8b949e',
}

function LogView({ lines, label, height }: { lines: LogLine[]; label: string; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div
      ref={ref}
      className="overflow-auto font-mono text-[11px] leading-4"
      style={{ height, color: '#e6edf3' }}
    >
      {lines.length === 0 && <div style={{ color: '#8b949e' }}>{label}（暂无日志）</div>}
      {lines.map((line, i) => (
        <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#8b949e' }}>{line.time} </span>
          <span style={{ color: levelColor[line.level] || '#e6edf3' }}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

export default function DebugPanels() {
  const debug = useDebugMode()
  const frontendLogs = useFrontendLogs()
  const backendLogs = useBackendLogs()
  const perf = usePerf()
  const [perfDetailed, setPerfDetailed] = useState(false)
  const [showBackend, setShowBackend] = useState(true)
  const [showFrontend, setShowFrontend] = useState(true)

  useEffect(() => {
    if (debug) {
      startPerfMeasurement()
      startBackendLogPolling()
    } else {
      stopPerfMeasurement()
      stopBackendLogPolling()
    }
  }, [debug])

  if (!debug) return null

  const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`
  const fmtGB = (b?: number) => (b ? `${b.toFixed(1)}GB` : '—')
  const stackBottom = showBackend ? 216 : 14

  const headerBtn = {
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    color: '#fff',
    borderRadius: 6,
    fontSize: 11,
    padding: '2px 8px',
    cursor: 'pointer',
  } as const

  return (
    <div data-tv-skip style={{ pointerEvents: 'none' }}>
      {/* 后端日志（左下） */}
      {showBackend && (
        <div
          className="fixed bottom-3 left-3 z-[9000] rounded-lg border"
          style={{ background: PANEL_BG, borderColor: PANEL_BORDER, width: 460, maxHeight: 200, backdropFilter: 'blur(6px)' }}
        >
          <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: '#7ee787', fontSize: 11, fontWeight: 600 }}>后端日志</span>
            <button
              style={headerBtn}
              onClick={() => setShowBackend(false)}
              className="tv-debug-btn"
              aria-label="关闭后端日志"
            >
              ×
            </button>
          </div>
          <div style={{ padding: 4 }}>
            <LogView lines={backendLogs} label="后端" height={150} />
          </div>
        </div>
      )}

      {/* 前端日志（左下，后端面板上方） */}
      {showFrontend && (
        <div
          className="fixed bottom-3 left-3 z-[9000] rounded-lg border"
          style={{
            background: PANEL_BG,
            borderColor: PANEL_BORDER,
            width: 460,
            maxHeight: 200,
            bottom: stackBottom,
            backdropFilter: 'blur(6px)',
          }}
        >
          <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: '#9cdcfe', fontSize: 11, fontWeight: 600 }}>前端日志</span>
            <button style={headerBtn} onClick={() => setShowFrontend(false)} className="tv-debug-btn" aria-label="关闭前端日志">
              ×
            </button>
          </div>
          <div style={{ padding: 4 }}>
            <LogView lines={frontendLogs} label="前端" height={150} />
          </div>
        </div>
      )}

      {/* 性能信息（右上） */}
      <div
        className="fixed right-3 top-3 z-[9000] rounded-lg border"
        style={{ background: PANEL_BG, borderColor: PANEL_BORDER, minWidth: 150, backdropFilter: 'blur(6px)' }}
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <span style={{ color: '#ffd28a', fontSize: 11, fontWeight: 600 }}>性能</span>
          <div className="flex items-center gap-1">
            <button style={headerBtn} onClick={() => setPerfDetailed((v) => !v)} className="tv-debug-btn" aria-label="切换性能显示模式">
              {perfDetailed ? '简约' : '详细'}
            </button>
            <button style={headerBtn} onClick={() => setPerfDetailed(false)} className="tv-debug-btn" aria-label="关闭性能面板">
              ×
            </button>
          </div>
        </div>
        <div className="px-2 py-1.5 font-mono text-[11px] leading-4" style={{ color: '#e6edf3' }}>
          {perfDetailed ? (
            <>
              <div>帧率: {perf.fps} FPS（{perf.frameMs}ms/帧）</div>
              <div>内存: {fmtMB(perf.heapUsed)} / {fmtMB(perf.heapTotal)}</div>
              <div>设备内存: {fmtGB(perf.deviceMemory)} · CPU {perf.cores} 核</div>
              <div>DOM 节点: {perf.domNodes}</div>
            </>
          ) : (
            <div>⚡ {perf.fps} FPS · {fmtMB(perf.heapUsed)}</div>
          )}
        </div>
      </div>
    </div>
  )
}

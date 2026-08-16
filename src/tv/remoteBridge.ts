/**
 * TV 端远程遥控器桥接（仅 Android）。
 *
 * 链路：手机控制页 → 设备内置 Node 的 remote-server(:25567, 复用 PC 端同一套)
 *  → remote-server 把控制/光标命令 broadcast 给所有 WS 客户端
 *  → 本桥作为 WS 客户端接入（token 从 /api/tv/remote-status 读取，本机接口不外泄）
 *  → 控制命令 → waveforge:remote-control（App 的 desktopControlHandlerRef 执行）
 *  → 光标命令 → waveforge:remote-cursor（RemoteCursor 虚拟鼠标驱动 hover UI）
 *
 * 另外轮询 /api/tv/remote-status：手机连上（clientCount>0）时切换为"光标模式"，
 * TV 的 hover 驱动 UI 与 PC 一致、焦点环隐藏。
 */
import { isAndroid } from '../platform'
import { setRemoteCursorMode } from './tvCore'

let installed = false
let ws: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null
let closed = false
const DEFAULT_PORT = 25567 // TV 端遥控端口（PC 端固定 25566，TV 用 25567 避免同网段冲突）

async function fetchRemoteStatus(): Promise<{
  running?: boolean
  port?: number
  token?: string
  clientCount?: number
} | null> {
  try {
    const res = await fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as {
      running?: boolean
      port?: number
      token?: string
      clientCount?: number
    }
  } catch {
    return null
  }
}

function scheduleRetry(delayMs: number): void {
  if (closed) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => void connect(), delayMs)
}

/** 轮询遥控状态：维持光标模式（clientCount>0 = 手机已连上） */
function startStatusPolling(): void {
  if (statusTimer) return
  const poll = async () => {
    const st = await fetchRemoteStatus()
    if (st) setRemoteCursorMode((st.clientCount || 0) > 0)
  }
  void poll()
  statusTimer = setInterval(poll, 5000)
}

async function connect(): Promise<void> {
  if (closed) return
  try {
    ws?.close()
  } catch {
    // ignore
  }
  const st = await fetchRemoteStatus()
  if (!st?.running || !st?.token) {
    scheduleRetry(5000)
    return
  }
  const port = st.port || DEFAULT_PORT
  try {
    ws = new WebSocket(`ws://localhost:${port}/ws?t=${encodeURIComponent(st.token)}`)
  } catch {
    scheduleRetry(5000)
    return
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        type?: string
        action?: string
        value?: unknown
        cmd?: string
      }
      if (!msg?.type) return
      if (msg.type === 'control' && msg.action) {
        window.dispatchEvent(
          new CustomEvent('waveforge:remote-control', { detail: { action: msg.action, payload: msg.value } })
        )
      } else if (msg.type === 'cursor' && msg.cmd) {
        // 光标命令原样转给 RemoteCursor（虚拟鼠标 + hover 事件）
        window.dispatchEvent(new CustomEvent('waveforge:remote-cursor', { detail: msg }))
      }
    } catch {
      // ignore
    }
  }
  ws.onclose = () => scheduleRetry(5000)
  ws.onerror = () => {
    try {
      ws?.close()
    } catch {
      // ignore
    }
  }
}

/** 仅 Android（TV/平板）启动；桌面走 Electron 的 remote 桥，不需要。 */
export function installRemoteBridge(): void {
  if (installed || !isAndroid() || typeof WebSocket === 'undefined') return
  installed = true
  void connect()
  startStatusPolling()
}

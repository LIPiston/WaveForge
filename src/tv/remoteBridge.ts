/**
 * TV 端远程遥控器桥接（仅 Android）。
 *
 * 链路：手机控制页 → 设备内置 Node 的 remote-server(:25566, 复用 PC 端同一套)
 *  → remote-server 把控制命令 broadcast 给所有 WS 客户端
 *  → 本桥作为 WS 客户端接入（token 从 /api/tv/remote-status 读取，本机接口不外泄）
 *  → 收到 {type:'control'} 后派发 DOM 事件 waveforge:remote-control
 *  → App.tsx 的 desktopControlHandlerRef 执行（播放/切歌/seek/音量/切模式等，与桌面遥控一致）
 */
import { isAndroid } from '../platform'

let installed = false
let ws: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let closed = false

async function fetchRemoteStatus(): Promise<{ running?: boolean; port?: number; token?: string } | null> {
  try {
    const res = await fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as { running?: boolean; port?: number; token?: string }
  } catch {
    return null
  }
}

function scheduleRetry(delayMs: number): void {
  if (closed) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => void connect(), delayMs)
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
  const port = st.port || 25566
  try {
    ws = new WebSocket(`ws://localhost:${port}/ws?t=${encodeURIComponent(st.token)}`)
  } catch {
    scheduleRetry(5000)
    return
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; action?: string; value?: unknown }
      if (msg?.type === 'control' && msg.action) {
        window.dispatchEvent(
          new CustomEvent('waveforge:remote-control', { detail: { action: msg.action, payload: msg.value } })
        )
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
}

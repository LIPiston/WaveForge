/**
 * TV 遥控器媒体键桥接（仅 tv-mode）。
 *
 * Android TV 遥控器的媒体键由原生壳转发为 DOM keydown（keyCode 85-88/126/127），
 * 但页面里 navigator.mediaSession 的处理器只响应系统媒体会话事件、不响应 DOM 键。
 * 这里把 DOM 媒体键桥接到应用已有的交互：
 *  - 播放/暂停：合成 Space 键（PlayerControls 的全局快捷键）；
 *  - 上一首/下一首：按 lucide 图标路径匹配播放控制条上的按钮并 click()。
 * 若设备上 WebView 已把媒体键原生路由到 mediaSession（handler 已注册），
 * 本桥接的合成事件与应用自身去重逻辑不冲突（Space 仅在播放页生效）。
 */
import { isTvMode } from './tvCore'

// lucide-react 0.546 中播放控制图标的标准 path data
const ICON_PATHS = {
  play: 'M6 3l14 9-14 9V3z',
  pause: 'M14 4h4v16h-4z',
  next: 'm5 4 10 8-10 8V4z',
  prev: 'm19 20-10-8 10-8v16z',
} as const

type ControlType = 'playpause' | 'next' | 'prev'

function findControlButton(type: ControlType): HTMLElement | null {
  // 优先按 aria-label 匹配（ModengPlayerPage 等组件有标注）
  const labels: Record<ControlType, string[]> = {
    playpause: ['播放/暂停', '播放', '暂停'],
    next: ['下一首'],
    prev: ['上一首'],
  }
  for (const label of labels[type]) {
    const byLabel = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
    if (byLabel && byLabel.isConnected && byLabel.getBoundingClientRect().width > 0) {
      return byLabel
    }
  }

  // 回退：按 lucide 图标 path 匹配播放控制条里的按钮
  const pathsToMatch: string[] =
    type === 'playpause'
      ? [ICON_PATHS.play, ICON_PATHS.pause]
      : type === 'next'
        ? [ICON_PATHS.next]
        : [ICON_PATHS.prev]

  const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'))
  for (const btn of buttons) {
    if (!btn.isConnected || btn.getBoundingClientRect().width === 0) continue
    const svgPaths = Array.from(btn.querySelectorAll('svg path')).map((p) =>
      (p.getAttribute('d') || '').replace(/\s+/g, ' ')
    )
    if (svgPaths.some((d) => pathsToMatch.includes(d))) return btn
  }
  return null
}

let installed = false

export function installMediaKeyBridge(): void {
  if (installed) return
  installed = true
  document.addEventListener('keydown', (e) => {
    if (!isTvMode()) return
    const code = e.keyCode
    const isPlayPause =
      code === 85 || code === 126 || code === 127 || code === 86 || code === 179 // 179=PC 媒体播放/暂停
    const isNext = code === 87 || code === 176 // 176=PC 下一首
    const isPrev = code === 88 || code === 177 // 177=PC 上一首
    if (!isPlayPause && !isNext && !isPrev) return

    // 输入框聚焦时不拦截（避免把媒体键当文本输入）
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return

    e.preventDefault()
    e.stopPropagation()

    if (isPlayPause) {
      // 合成 Space：PlayerControls 的全局快捷键（播放页生效）
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true, cancelable: true })
      )
      return
    }

    const btn = findControlButton(isNext ? 'next' : 'prev')
    btn?.click()
  })
}

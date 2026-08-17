import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI, setTvModeForced } from './platform'
import { installElectronShim } from './electronShim'
import { startTv } from './tv/tvCore'
import { initPerfMode } from './tv/perfMode'
import { captureFrontendConsole, initDebugMode } from './tv/debugStore'
import { installDebugRemote } from './tv/debugRemote'
import DebugPanels from './tv/DebugPanels'
import { installMediaKeyBridge } from './tv/mediaKeyBridge'
import { installRemoteBridge } from './tv/remoteBridge'
import TvKeyboard from './tv/TvKeyboard'

// 平台初始化：标记 html[data-platform]/tv-mode（供 CSS 焦点适配），
// 并给非 Electron 环境（Android WebView / 纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()

// TV DPI 适配：Android TV 系统 density 因设备而异（4K 投影可能报高 density，
// 导致 CSS 视口过小、整个 UI 被放大）。统一以 1920 CSS 宽为设计基准缩放。
// 注意：zoom 会改变 innerWidth 并触发 resize，必须只应用一次（applied 防振荡）。
let tvDpiApplied = false
function applyTvDpiScale(): void {
  if (tvDpiApplied) return
  if (!document.documentElement.classList.contains('tv-mode')) return
  const innerW = window.innerWidth
  if (!innerW) return
  tvDpiApplied = true
  // CSS zoom: 小于 1 缩小（视口 640 时缩小 1/3，等效 1920 设计宽度，UI 恢复正常大小）
  const scale = innerW / 1920
  if (Math.abs(scale - 1) < 0.02) {
    console.log(`[TV DPI] innerWidth=${innerW} 视口已达标，不缩放`)
    return
  }
  ;(document.documentElement.style as unknown as { zoom: string }).zoom = String(scale)
  console.log(`[TV DPI] innerWidth=${innerW} → zoom=${scale.toFixed(3)}（目标视口 1920）`)
}

// TV 遥控器交互层（仅 html.tv-mode 生效）：空间导航/焦点环/软键盘。
// 组件挂载后再调用一次（见 TvKeyboard），确保 React 首帧渲染完就有候选可聚焦。
startTv()

// TV 性能模式：按内存自动选默认档，打上 wf-perf-* 类
initPerfMode()

// 调试模式：捕获前端日志 + 初始化开关状态（面板组件 DebugPanels 按需挂载）
captureFrontendConsole()
initDebugMode()

// TV DPI 适配（在 captureFrontendConsole 之后执行，DPI 日志才能上报到调试台）
applyTvDpiScale()

// 局域网调试桥（跟随开发者模式，默认关闭）：:3002 日志/崩溃/远程控制
installDebugRemote()

// 遥控器媒体键 → 应用播放控制桥接（仅 tv-mode 生效）。
installMediaKeyBridge()

// TV 端远程遥控器（手机控制电视）：仅 Android 启动（桌面走 Electron remote 桥）。
installRemoteBridge()

// PC 模拟测试：Ctrl+Alt+T 在「TV 遥控器模式 / 鼠标模式」间切换（刷新生效）。
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.code === 'KeyT') {
    e.preventDefault()
    setTvModeForced(!document.documentElement.classList.contains('tv-mode'))
    window.location.reload()
  }
})

// 内存观察哨：仅当 localStorage 中设置了 waveforge:memory-debug=1 时生效，
// 用于定位播放期间内存持续增长的来源（控制台执行 localStorage.setItem('waveforge:memory-debug','1') 后重启）。
startMemoryWatchdog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <TvKeyboard />
    <DebugPanels />
  </StrictMode>,
)

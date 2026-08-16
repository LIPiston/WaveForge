import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI } from './platform'
import { installElectronShim } from './electronShim'
import { startTv } from './tv/tvCore'
import { installMediaKeyBridge } from './tv/mediaKeyBridge'
import TvKeyboard from './tv/TvKeyboard'

// 平台初始化：标记 html[data-platform]/tv-mode（供 CSS 焦点适配），
// 并给非 Electron 环境（Android WebView / 纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()

// TV 遥控器交互层（仅 html.tv-mode 生效）：空间导航/焦点环/软键盘。
// 组件挂载后再调用一次（见 TvKeyboard），确保 React 首帧渲染完就有候选可聚焦。
startTv()

// 遥控器媒体键 → 应用播放控制桥接（仅 tv-mode 生效）。
installMediaKeyBridge()

// 内存观察哨：仅当 localStorage 中设置了 waveforge:memory-debug=1 时生效，
// 用于定位播放期间内存持续增长的来源（控制台执行 localStorage.setItem('waveforge:memory-debug','1') 后重启）。
startMemoryWatchdog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <TvKeyboard />
  </StrictMode>,
)

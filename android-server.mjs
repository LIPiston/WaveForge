/**
 * Android 端后端入口（由 nodejs-mobile 以 node <nodejs-project>/main.cjs 启动）。
 *
 * local-server.mjs 在 import 时即绑定 127.0.0.1:3001 并注册全部 API 路由，
 * 这里拿到同一个 express 实例后追加前端静态资源托管：
 *   - API 路由先注册，/api/* 优先命中；
 *   - 其余 GET 请求回退到打包好的 SPA（dist/）。
 * 页面与 API 同源（http://localhost:3001），无需 CORS，也没有 http 音频 CDN 的混合内容问题。
 *
 * 桌面端不受影响：桌面直接 `node local-server.mjs`，本文件不会被引用。
 * 注意：打包为 CJS（nodejs-mobile 以 require 方式加载），不能用 import.meta.url；
 * 资源根目录由进程入口参数 argv[1]（main.cjs 路径）推导。
 */
import localApp from './local-server.mjs'
import express from 'express'
import { dirname, join } from 'path'
import { createRemoteServer, getLanIPv4Addresses } from './desktop/remote-server.cjs'

const serverRoot = dirname(process.argv[1] || process.cwd())
const distDir = join(serverRoot, 'dist')
const indexPath = join(distDir, 'index.html')

localApp.use(express.static(distDir))

// SPA 回退：非 /api/ 的 GET 请求交给前端路由。
localApp.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next()
  }
  res.sendFile(indexPath)
})

// ── TV 远程遥控器（复用 PC 端同一套 remote-server：手机控制页 + WS 命令） ──
// 命令链路：手机 → remote-server(:25567) → broadcast → SPA 控制器(WebView 内 WS 客户端)
// → DOM 事件 waveforge:remote-control → App 的 desktopControlHandlerRef 执行。
// 端口用 25567 而非 PC 端的 25566：同一局域网内 PC 与 TV 同时开遥控时不冲突。
const tvRemoteServer = createRemoteServer({
  getComputerName: () => 'WaveForge TV',
  getSettings: () => ({ theme: 'dark' }),
  getState: () => ({}), // 播放状态由 SPA 侧自行维护，v1 不推送到手机页
  sendControl: () => {}, // 命令经 broadcast 直达 SPA 控制器
  sendCursor: () => {}, // 光标命令同样经 broadcast 直达 SPA（remoteBridge → RemoteCursor）
  onClientsChange: () => {},
})
tvRemoteServer.start(25567).catch((err) => {
  console.error('[WaveForge TV] 遥控器服务启动失败:', err?.message || err)
})

// SPA 读取遥控状态（token/端口/IP 列表），用于展示二维码与连接地址。
// local-server.mjs 只绑定 127.0.0.1，该接口仅本机 WebView 可访问，token 不外泄到局域网。
localApp.get('/api/tv/remote-status', (req, res) => {
  res.json(tvRemoteServer.status())
})

console.log('[WaveForge Android] API + SPA 已就绪: http://localhost:3001')
console.log(`[WaveForge Android] 远程遥控器: http://0.0.0.0:25567（${getLanIPv4Addresses().length} 个网卡）`)

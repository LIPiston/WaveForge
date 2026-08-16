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

console.log('[WaveForge Android] API + SPA 已就绪: http://localhost:3001')

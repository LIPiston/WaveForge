/**
 * TV 扩展端点（壁纸扫码上传 + 远程遥控器），供不同后端复用：
 *  - android-server.mjs（真机）：壁纸存设备存储，25567 遥控；
 *  - dev-tv-server.mjs（dev 测试后端）：壁纸存项目根，让浏览器 ?tv=1 也能测扫码上传/遥控。
 *
 * 端口用 25567 而非 PC 端的 25566：同一局域网内 PC 与 TV 同时开遥控时不冲突。
 *
 * 注意：本文件会被 esbuild 打包进 android 的 CJS bundle，不能用 import.meta.url；
 * 所有路径（壁纸目录）由调用方传入。
 */
import { createRemoteServer, getLanIPv4Addresses } from './desktop/remote-server.cjs'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

// ── TV 壁纸扫码上传：手机浏览器 → 25567 上传页 → 存本地/设备存储 ──
// 手机上传的图片由 SPA 从 /api/tv/wallpapers 拉回并导入 wallpaperManager（IndexedDB）。
const UPLOAD_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>上传壁纸</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0a0f14; color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100dvh; margin: 0; padding: 24px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 6px; }
  p { color: rgba(255,255,255,.6); font-size: 14px; }
  input[type=file] { margin: 20px 0; }
  button { background: #4fc3f7; color: #06222e; border: none; border-radius: 999px;
    padding: 12px 28px; font-size: 16px; font-weight: 700; cursor: pointer; }
  #status { margin-top: 16px; font-size: 14px; min-height: 20px; }
  .ok { color: #31e68b; } .err { color: #ff6b81; }
</style></head><body>
<h1>上传壁纸</h1>
<p>选择一张图片，上传后会出现在壁纸列表中</p>
<input type="file" id="file" accept="image/*">
<button id="btn">上传</button>
<div id="status"></div>
<script>
  document.getElementById('btn').addEventListener('click', async function () {
    var f = document.getElementById('file').files[0];
    var st = document.getElementById('status');
    if (!f) { st.className = 'err'; st.textContent = '请先选择图片'; return; }
    var fd = new FormData();
    fd.append('file', f);
    st.className = ''; st.textContent = '上传中…';
    try {
      var r = await fetch('/wallpaper/upload', { method: 'POST', body: fd });
      var j = await r.json();
      if (j.ok) { st.className = 'ok'; st.textContent = '上传成功，可在壁纸列表查看'; }
      else { st.className = 'err'; st.textContent = '上传失败：' + (j.error || '未知'); }
    } catch (e) { st.className = 'err'; st.textContent = '上传失败：' + e.message; }
  });
</script></body></html>`

function sanitizeFileName(name) {
  return String(name || 'wallpaper.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(-80)
}

function makeWallpaperHttpHandler(wallpapersDir) {
  return function handleWallpaperHttp(req, res, url) {
    if (url.pathname === '/wallpaper') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(UPLOAD_PAGE)
      return true
    }
    if (url.pathname === '/wallpaper/upload' && req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks)
          const contentType = req.headers['content-type'] || ''
          const boundary = String(contentType).match(/boundary=(.+)$/)?.[1]
          if (!boundary) throw new Error('请求格式错误')
          const delimiter = Buffer.from('--' + boundary)
          let start = buf.indexOf(delimiter)
          if (start === -1) throw new Error('请求格式错误')
          start += delimiter.length
          let headerEnd = buf.indexOf('\r\n\r\n', start)
          if (headerEnd === -1) throw new Error('请求格式错误')
          const headerStr = buf.subarray(start, headerEnd).toString('utf8')
          const filenameMatch = headerStr.match(/filename="([^"]*)"/)
          let dataStart = headerEnd + 4
          let dataEnd = buf.indexOf('\r\n--' + boundary, dataStart)
          if (dataEnd === -1) dataEnd = buf.length
          const image = buf.subarray(dataStart, dataEnd)
          if (!image || image.length < 100) throw new Error('未收到有效图片')
          mkdirSync(wallpapersDir, { recursive: true })
          const name = Date.now() + '-' + sanitizeFileName(filenameMatch?.[1] || 'wallpaper.jpg')
          writeFileSync(join(wallpapersDir, name), image)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, name }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: err?.message || '上传失败' }))
        }
      })
      return true
    }
    if (url.pathname.startsWith('/wallpapers/')) {
      const name = url.pathname.split('/').pop() || ''
      const file = join(wallpapersDir, name)
      if (!existsSync(file)) {
        res.writeHead(404)
        res.end('Not Found')
        return true
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      createReadStream(file).pipe(res)
      return true
    }
    return false
  }
}

/**
 * 在 express app 上安装 TV 扩展：
 *  - 25567 远程遥控器（WS 命令广播 → SPA 控制器）
 *  - 25567 壁纸扫码上传页（手机浏览器直接上传）
 *  - /api/tv/remote-status、/api/tv/wallpapers、/api/tv/wallpapers/:name
 *  - /api/tv/logs（提供 serverLogs 环形缓冲时）
 */
export function installTvExtensions({
  app,
  wallpapersDir,
  serverName = 'WaveForge TV',
  serverLogs = null,
  remotePort = 25567,
}) {
  const handleWallpaperHttp = makeWallpaperHttpHandler(wallpapersDir)

  // TV 远程遥控器（复用 PC 端同一套 remote-server：手机控制页 + WS 命令）
  // 命令链路：手机 → remote-server(:25567) → broadcast → SPA 控制器(WS 客户端)
  // → DOM 事件 waveforge:remote-control → App 的 desktopControlHandlerRef 执行。
  const tvRemoteServer = createRemoteServer({
    getComputerName: () => serverName,
    getSettings: () => ({ theme: 'dark' }),
    getState: () => ({}), // 播放状态由 SPA 侧自行维护，v1 不推送到手机页
    sendControl: () => {}, // 命令经 broadcast 直达 SPA 控制器
    sendCursor: () => {}, // 光标命令同样经 broadcast 直达 SPA（remoteBridge → RemoteCursor）
    onClientsChange: () => {},
    onHttpRequest: handleWallpaperHttp, // 25567 上同时承载壁纸扫码上传
  })
  tvRemoteServer.start(remotePort).catch((err) => {
    console.error('[WaveForge TV] 遥控器服务启动失败:', err?.message || err)
  })

  // SPA 读取遥控状态（token/端口/IP 列表），用于展示二维码与连接地址。
  // local-server.mjs 只绑定 127.0.0.1，该接口仅本机可访问，token 不外泄到局域网。
  app.get('/api/tv/remote-status', (req, res) => {
    res.json(tvRemoteServer.status())
  })

  // SPA 读取已上传壁纸列表（手机上传 → 本地存储 → 这里列出，SPA 导入 IndexedDB）
  app.get('/api/tv/wallpapers', (req, res) => {
    try {
      if (!existsSync(wallpapersDir)) {
        res.json({ wallpapers: [] })
        return
      }
      const wallpapers = readdirSync(wallpapersDir)
        .filter((name) => /\.(jpe?g|png|webp|gif)$/i.test(name))
        .map((name) => ({
          name,
          url: '/api/tv/wallpapers/' + encodeURIComponent(name),
          uploadTime: statSync(join(wallpapersDir, name)).mtimeMs,
        }))
        .sort((a, b) => a.uploadTime - b.uploadTime)
      res.json({ wallpapers })
    } catch (err) {
      res.status(500).json({ wallpapers: [], error: err?.message })
    }
  })

  // SPA 读取已上传壁纸图片内容（导入 IndexedDB 用）
  app.get('/api/tv/wallpapers/:name', (req, res) => {
    const name = req.params.name || ''
    const file = join(wallpapersDir, name)
    if (!existsSync(file) || !/\.(jpe?g|png|webp|gif)$/i.test(name)) {
      res.status(404).end('Not Found')
      return
    }
    res.type('image/jpeg')
    createReadStream(file).pipe(res)
  })

  // 后端日志环形缓冲（TV 调试面板轮询展示，本机接口）
  if (serverLogs) {
    app.get('/api/tv/logs', (req, res) => {
      res.json({ lines: serverLogs.slice(-100), total: serverLogs.length })
    })
  }

  return tvRemoteServer
}

export { getLanIPv4Addresses }

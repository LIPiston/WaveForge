import { spawn } from 'child_process'
import { build, createServer, preview } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import net from 'net'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const launcherStartedAt = performance.now()
const startupLogDir = resolve(__dirname, '../logs')
const startupLogFile = resolve(startupLogDir, 'startup-timing.log')
mkdirSync(startupLogDir, { recursive: true })
writeFileSync(startupLogFile, '', 'utf8')
const logStartup = message => {
  const line = '[Startup +' + Math.round(performance.now() - launcherStartedAt) + 'ms] ' + message
  console.log(line)
  appendFileSync(startupLogFile, line + '\n', 'utf8')
}

const projectRoot = resolve(__dirname, '..')
const viteConfigFile = resolve(projectRoot, 'vite.config.ts')
const distDir = resolve(projectRoot, 'dist')

function getNewestMtime(targetPath) {
  if (!existsSync(targetPath)) return 0
  const stats = statSync(targetPath)
  if (!stats.isDirectory()) return stats.mtimeMs

  let newest = stats.mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    newest = Math.max(newest, getNewestMtime(resolve(targetPath, entry.name)))
  }
  return newest
}

function isRendererBuildFresh() {
  const outputFiles = [
    resolve(distDir, 'index.html'),
    resolve(distDir, 'desktop-player.html'),
    resolve(distDir, 'desktop-lyrics.html'),
  ]
  if (outputFiles.some(outputFile => !existsSync(outputFile))) return false

  const rendererInputs = [
    resolve(projectRoot, 'src'),
    viteConfigFile,
    resolve(projectRoot, 'package.json'),
    resolve(projectRoot, 'package-lock.json'),
    ...readdirSync(projectRoot)
      .filter(file => file.endsWith('.html'))
      .map(file => resolve(projectRoot, file)),
  ]
  const newestInput = Math.max(...rendererInputs.map(getNewestMtime))
  const oldestOutput = Math.min(...outputFiles.map(outputFile => statSync(outputFile).mtimeMs))
  return oldestOutput >= newestInput
}

async function ensureRendererBuild() {
  if (isRendererBuildFresh()) {
    logStartup('Using cached renderer build')
    return
  }

  logStartup('Renderer sources changed; refreshing cached build')
  await build({ configFile: viteConfigFile })
  logStartup('Renderer build cache refreshed')
}

function isPortOpen(port, host = 'localhost') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })

    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })

    socket.once('error', () => resolve(false))

    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 10000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  return false
}

async function startDev() {
  logStartup('Development launcher started')
  let apiProcess = null
  let pythonProcess = null

  // 并行启动所有服务
  const startPython = async () => {
    if (await isPortOpen(3002)) {
      console.log('Python Beat Service already running on http://localhost:3002')
      return null
    }
    
    console.log('Starting Python Beat Service...')
    const pythonExe = resolve(__dirname, '../resources/python-embed/python.exe')
    const beatAnalyzer = resolve(__dirname, '../python-beat-service/beat_analyzer.py')
    
    const pythonProc = spawn(
      pythonExe,
      [beatAnalyzer],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        }
      }
    )
    
    // 后台等待，不阻塞主流程
    waitForPort(3002, 15000).then(success => {
      if (success) {
        console.log('Python Beat Service started successfully on http://localhost:3002')
      } else {
        console.warn('Python Beat Service did not open port 3002 within 15 seconds')
      }
    })
    
    return pythonProc
  }

  const startAPI = async () => {
    if (await isPortOpen(3001)) {
      console.log('Local API server already running on http://localhost:3001')
      return null
    }
    
    console.log('Starting Local API Server...')
    const apiProc = spawn(
      process.execPath,
      [resolve(__dirname, '../local-server.mjs')],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...process.env,
          FORCE_COLOR: '1'
        }
      }
    )
    
    waitForPort(3001, 10000).then(success => {
      if (success) {
        console.log('Local API server started successfully on http://localhost:3001')
      } else {
        console.warn('Local API server did not open port 3001 within 10 seconds')
      }
    })
    
    return apiProc
  }

  const startRendererServer = async () => {
    const useLiveRenderer = process.env.WAVEFORGE_LIVE_UI === '1'

    if (useLiveRenderer) {
      logStartup('Creating live Vite renderer server')
      const server = await createServer({
        configFile: viteConfigFile,
        server: {
          host: '127.0.0.1',
          port: 3000,
          strictPort: true,
        },
      })
      await server.listen()
      logStartup('Live Vite renderer server is listening')
      server.printUrls()
      return server
    }

    await ensureRendererBuild()
    logStartup('Creating cached renderer server')
    const server = await preview({
      configFile: viteConfigFile,
      preview: {
        host: '127.0.0.1',
        port: 3000,
        strictPort: true,
      },
    })
    logStartup('Cached renderer server is listening')
    server.printUrls()
    return server
  }

  // Start backends and the renderer in parallel. The cached production renderer is
  // the default fast path; set WAVEFORGE_LIVE_UI=1 to restore full Vite HMR.
  const [python, api, server] = await Promise.all([
    startPython(),
    startAPI(),
    startRendererServer()
  ])
  
  pythonProcess = python
  apiProcess = api
  
  logStartup('Backend launch tasks dispatched')
  const devServerUrl = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:3000/'
  console.log(`Electron loading ${devServerUrl}`)

  logStartup('Spawning Electron')
  const electronProcess = spawn(
    electron,
    [resolve(__dirname, '../desktop/main.cjs')],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        WAVEFORGE_DEV_SERVER_URL: devServerUrl,
        WAVEFORGE_STARTUP_LOG: startupLogFile,
        PYTHONIOENCODING: 'utf-8',
      },
    }
  )

  const cleanup = () => {
    server.close()

    if (apiProcess && !apiProcess.killed) {
      apiProcess.kill()
    }

    if (pythonProcess && !pythonProcess.killed) {
      pythonProcess.kill()
    }
  }

  electronProcess.on('close', () => {
    cleanup()
    process.exit()
  })

  process.on('SIGINT', () => {
    cleanup()
    process.exit()
  })
}

startDev()

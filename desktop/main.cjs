const electronProcessStartedAt = performance.now()

// 强制设置 Node.js 输出编码为 UTF-8
if (process.stdout && typeof process.stdout.setDefaultEncoding === 'function') {
  process.stdout.setDefaultEncoding('utf8')
}
if (process.stderr && typeof process.stderr.setDefaultEncoding === 'function') {
  process.stderr.setDefaultEncoding('utf8')
}

// Avoid spawning chcp/cmd.exe here. Electron is a GUI process, and the child
// console can flash visibly whenever the main process is initialized.
const { app, BrowserWindow, ipcMain, protocol, shell, session, safeStorage, dialog, globalShortcut, clipboard, utilityProcess } = require('electron')
const path = require('path')
const fs = require('fs')
const startupTimingLogPath = process.env.WAVEFORGE_STARTUP_LOG || ''
function logStartupTiming(message) {
  const line = '[Electron +' + Math.round(performance.now() - electronProcessStartedAt) + 'ms] ' + message
  console.log(line)
  if (startupTimingLogPath) {
    try { fs.appendFileSync(startupTimingLogPath, line + '\n', 'utf8') } catch {}
  }
}

const performanceSettingsPath = path.join(app.getPath('userData'), 'performance-settings.json')
const shortcutSettingsPath = path.join(app.getPath('userData'), 'shortcut-settings.json')

function readPerformanceSettings() {
  const defaults = { hardwareAcceleration: true, gpuPreference: 'discrete' }
  try {
    const parsed = JSON.parse(fs.readFileSync(performanceSettingsPath, 'utf8'))
    const gpuPreference = ['auto', 'discrete', 'integrated'].includes(parsed?.gpuPreference)
      ? parsed.gpuPreference
      : defaults.gpuPreference
    return {
      hardwareAcceleration: parsed?.hardwareAcceleration !== false,
      gpuPreference,
    }
  } catch {
    return { ...defaults }
  }
}

function writePerformanceSettings(settings) {
  const temporaryPath = `${performanceSettingsPath}.tmp`
  fs.mkdirSync(path.dirname(performanceSettingsPath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify(settings), 'utf8')
  fs.renameSync(temporaryPath, performanceSettingsPath)
}

const performanceSettings = readPerformanceSettings()
if (!performanceSettings.hardwareAcceleration) {
  app.disableHardwareAcceleration()
} else if (performanceSettings.gpuPreference === 'discrete') {
  // 强制使用独立显卡（高性能 GPU）
  app.commandLine.appendSwitch('force_high_performance_gpu')
} else if (performanceSettings.gpuPreference === 'integrated') {
  // 强制使用核显/集成显卡（低功耗 GPU）
  app.commandLine.appendSwitch('force_low_power_gpu')
}

app.on('child-process-gone', (_event, details) => {
  const processType = String(details?.type || '').toLowerCase()
  if (processType === 'gpu' || processType === 'renderer') {
    console.error('[ProcessHealth] Electron child process exited:', {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName,
      name: details?.name,
    })
  }
})

// 立即设置应用名称（必须在app.ready之前）
app.setName('WaveForge 澜音工坊')
app.setAppUserModelId('com.waveforge.desktop')

const { execFile, execFileSync, spawn } = require('child_process')
const os = require('os')
const { pathToFileURL } = require('url')
const { createAnalysisRuntime } = require('./analysis-runtime.cjs')
const { setupRenderIPC, cleanup: cleanupRender } = require('./render-runtime.cjs')
const { ConfigManager } = require('./config-manager.cjs')
const deviceLicense = require('./device-license.cjs')
logStartupTiming('Main-process modules loaded')

let desktopWidgetCpuSample = null
const DESKTOP_WIDGET_DISK_CACHE_MS = 60_000
let desktopWidgetDiskCache = []
let desktopWidgetDiskCacheExpiresAt = 0
let desktopWidgetDiskRequest = null

function readCpuTimes() {
  return os.cpus().reduce((total, cpu) => {
    const idle = total.idle + cpu.times.idle
    const all = total.all + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    return { idle, all }
  }, { idle: 0, all: 0 })
}

function readMediaKeysEnabled() {
  try {
    const parsed = JSON.parse(fs.readFileSync(shortcutSettingsPath, 'utf8'))
    return parsed?.mediaKeysEnabled !== false
  } catch {
    return true
  }
}

function writeMediaKeysEnabled(enabled) {
  const temporaryPath = `${shortcutSettingsPath}.tmp`
  fs.mkdirSync(path.dirname(shortcutSettingsPath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify({ mediaKeysEnabled: enabled === true }), 'utf8')
  fs.renameSync(temporaryPath, shortcutSettingsPath)
}

function readDesktopWidgetDisks() {
  if (process.platform !== 'win32') return Promise.resolve([])

  const now = Date.now()
  if (now < desktopWidgetDiskCacheExpiresAt) {
    return Promise.resolve(desktopWidgetDiskCache)
  }
  if (desktopWidgetDiskRequest) return desktopWidgetDiskRequest

  const script = "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"
  desktopWidgetDiskRequest = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error || !String(stdout || '').trim()) return resolve([])
      try {
        const parsed = JSON.parse(stdout)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map(disk => {
          const total = Number(disk.Size) || 0
          const free = Number(disk.FreeSpace) || 0
          const used = Math.max(0, total - free)
          return { name: disk.DeviceID || '磁盘', used, total, percent: total ? used / total * 100 : 0 }
        }))
      } catch { resolve([]) }
    })
  }).then(disks => {
    desktopWidgetDiskCache = disks
    desktopWidgetDiskCacheExpiresAt = Date.now() + DESKTOP_WIDGET_DISK_CACHE_MS
    return disks
  }).finally(() => {
    desktopWidgetDiskRequest = null
  })

  return desktopWidgetDiskRequest
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const devServerUrl = process.env.WAVEFORGE_DEV_SERVER_URL || 'http://127.0.0.1:3000'

// 导航白名单：只允许应用自身的地址（开发模式 Vite 服务器 / 生产模式打包产物），
// 阻止同窗口被任意外部页面导航——特权 preload 桥一旦跟到外部站点就会被滥用。
const ALLOWED_DEV_SERVER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
])
const ALLOWED_APP_FILE_URLS = new Set([
  pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-player.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-lyrics.html')).href,
])

function isAllowedNavigationTarget(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol === 'file:') {
      return ALLOWED_APP_FILE_URLS.has(parsed.href)
    }
    if (isDev && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return ALLOWED_DEV_SERVER_ORIGINS.has(parsed.origin)
    }
  } catch {
    // 无法解析的 URL 一律不放行
  }
  return false
}

function guardAgainstExternalNavigation(webContents) {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault()
    }
  })
}

let mainWindow = null
let wallpaperWatcher = null
let qqLoginWindow = null
let qqSkillKeyWindow = null
let analysisRuntime = null
let mediaKeysEnabled = readMediaKeysEnabled()

const mediaKeyAccelerators = {
  MediaPlayPause: 'toggle',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'prev',
}

function setGlobalMediaKeysEnabled(enabled) {
  mediaKeysEnabled = enabled === true
  writeMediaKeysEnabled(mediaKeysEnabled)
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))

  const registrations = {}
  if (mediaKeysEnabled) {
    Object.entries(mediaKeyAccelerators).forEach(([accelerator, action]) => {
      registrations[accelerator] = globalShortcut.register(accelerator, () => {
        safeSendToWindow(mainWindow, 'global-media-key', action)
      })
    })
  }

  return { success: true, enabled: mediaKeysEnabled, registrations }
}
let configManager = null

const QQMUSIC_SKILL_CREDENTIAL = 'qqmusicSkillApiKey'
const allowedMediaFiles = new Set()
const MAX_ALLOWED_MEDIA_FILES = 256

// ===== 桌面播放器：独立置顶小窗口（card 悬浮卡片 / bar 紧凑条状） =====
let desktopPlayerWindow = null
let desktopPlayerEnabled = false
let desktopPlayerForm = 'card'
const desktopPlayerState = {
  song: null, // { name, artists, coverUrl }
  lyric: null, // { line, translation, words, lineStart }
  playing: false,
  spectrum: [0, 0, 0, 0, 0],
  accentColor: '',
  playlist: [],
  currentIndex: -1,
  progress: 0,
  hasTranslation: false,
  hasRomaji: false,
}
const DESKTOP_PLAYER_FORMS = new Set(['card', 'bar'])
const DESKTOP_PLAYER_BASE_SIZE = {
  card: { width: 380, height: 150 },
  bar: { width: 480, height: 80 },
}
let desktopPlayerExpansionDirection = 'down'
let desktopPlayerDragSession = null
let desktopPlayerResizeSession = null
let desktopPlayerBoundsAnimation = null

// ===== 桌面歌词：独立透明置顶窗口 =====
let desktopLyricsWindow = null
let desktopLyricsDragSession = null
let desktopLyricsResizeSession = null
let desktopLyricsSavedBounds = null
let desktopLyricsPanelRestoreBounds = null
let desktopLyricsMousePassthrough = false
const DESKTOP_LYRICS_DEFAULTS = Object.freeze({
  enabled: false,
  fontSize: 58,
  colorMode: 'auto',
  orientation: 'horizontal',
  doubleLine: false,
  translationEnabled: false,
  romajiEnabled: false,
  traditionalEnabled: false,
  locked: false,
})
const DESKTOP_LYRICS_COLORS = new Set(['auto', 'rose', 'sky', 'gold', 'mint', 'white'])
const DESKTOP_LYRICS_ORIENTATIONS = new Set(['horizontal', 'vertical'])
let desktopLyricsSettings = { ...DESKTOP_LYRICS_DEFAULTS }

function getDesktopPlayerWorkArea(bounds) {
  const { screen } = require('electron')
  return screen.getDisplayMatching(bounds).workArea
}

function clampDesktopPlayerBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, bounds.x)),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, bounds.y)),
    width,
    height,
  }
}

function animateDesktopPlayerBounds(targetBounds, duration = 240) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) clearInterval(desktopPlayerBoundsAnimation)
  const startBounds = desktopPlayerWindow.getBounds()
  const startedAt = Date.now()
  desktopPlayerBoundsAnimation = setInterval(() => {
    if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    const interpolate = key => Math.round(startBounds[key] + (targetBounds[key] - startBounds[key]) * eased)
    desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({
      x: interpolate('x'), y: interpolate('y'), width: interpolate('width'), height: interpolate('height'),
    }))
    if (progress >= 1) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
    }
  }, 16)
}

function getDesktopPlayerSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-player-settings.json')
}

function loadDesktopPlayerSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopPlayerSettingsPath(), 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      form: DESKTOP_PLAYER_FORMS.has(parsed?.form) ? parsed.form : 'card',
    }
  } catch {
    return { enabled: false, form: 'card' }
  }
}

function saveDesktopPlayerSettings() {
  try {
    const settingsPath = getDesktopPlayerSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ enabled: desktopPlayerEnabled, form: desktopPlayerForm }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面播放器] 保存设置失败:', error)
  }
}

function getDesktopPlayerSnapshot() {
  return { ...desktopPlayerState, enabled: desktopPlayerEnabled, form: desktopPlayerForm }
}

function broadcastDesktopPlayerState() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', getDesktopPlayerSnapshot())
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:state', getDesktopPlayerSnapshot())
  }
}

function broadcastDesktopPlayerPartial(partial) {
  if (!partial || Object.keys(partial).length === 0) return
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', partial)
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    const lyricsPartial = {}
    for (const key of ['song', 'lyric', 'playing', 'accentColor', 'progress', 'hasTranslation', 'hasRomaji']) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) lyricsPartial[key] = partial[key]
    }
    if (Object.keys(lyricsPartial).length > 0) {
      desktopLyricsWindow.webContents.send('desktop-lyrics:state', lyricsPartial)
    }
  }
}

function desktopPlayerSetExpanded(expanded) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  const bounds = desktopPlayerWindow.getBounds()
  if (expanded) {
    const workArea = getDesktopPlayerWorkArea(bounds)
    const roomAbove = bounds.y - workArea.y
    const roomBelow = workArea.y + workArea.height - (bounds.y + bounds.height)
    desktopPlayerExpansionDirection = roomBelow >= 260 || roomBelow >= roomAbove ? 'down' : 'up'
  }
  return desktopPlayerExpansionDirection
}

function createDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) return desktopPlayerWindow
  const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm] || DESKTOP_PLAYER_BASE_SIZE.card
  desktopPlayerWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'WaveForge 桌面播放器',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-player-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) {
    desktopPlayerWindow.loadURL(`${devServerUrl}/desktop-player.html`)
  } else {
    desktopPlayerWindow.loadFile(path.join(__dirname, '../dist/desktop-player.html'))
  }

  desktopPlayerWindow.once('ready-to-show', () => {
    if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
      // 首次创建：卡片位于右上角，紧凑条状位于顶部居中。
      try {
        const { screen } = require('electron')
        const workArea = screen.getPrimaryDisplay().workArea
        const bounds = desktopPlayerWindow.getBounds()
        const x = desktopPlayerForm === 'bar'
          ? Math.round(workArea.x + (workArea.width - bounds.width) / 2)
          : Math.round(workArea.x + workArea.width - bounds.width - 24)
        const y = Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24))
        desktopPlayerWindow.setBounds({ x, y, width: bounds.width, height: bounds.height })
      } catch (positionError) {
        console.warn('[桌面播放器] 初始定位失败:', positionError)
      }
      desktopPlayerWindow.show()
      desktopPlayerWindow.moveTop()
    }
  })
  desktopPlayerWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
  })
  guardAgainstExternalNavigation(desktopPlayerWindow.webContents)
  desktopPlayerWindow.on('closed', () => {
    desktopPlayerWindow = null
  })
  return desktopPlayerWindow
}

function closeDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.close()
  }
  desktopPlayerWindow = null
}

function getDesktopLyricsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-lyrics-settings.json')
}

function sanitizeDesktopLyricsSettings(input = {}, base = DESKTOP_LYRICS_DEFAULTS) {
  return {
    enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
    fontSize: input.fontSize === undefined
      ? base.fontSize
      : Math.round(Math.min(120, Math.max(26, Number(input.fontSize) || DESKTOP_LYRICS_DEFAULTS.fontSize))),
    colorMode: input.colorMode === undefined
      ? base.colorMode
      : (DESKTOP_LYRICS_COLORS.has(input.colorMode) ? input.colorMode : 'auto'),
    orientation: input.orientation === undefined
      ? base.orientation
      : (DESKTOP_LYRICS_ORIENTATIONS.has(input.orientation) ? input.orientation : 'horizontal'),
    doubleLine: input.doubleLine === undefined ? base.doubleLine === true : input.doubleLine === true,
    translationEnabled: input.translationEnabled === undefined ? base.translationEnabled === true : input.translationEnabled === true,
    romajiEnabled: input.romajiEnabled === undefined ? base.romajiEnabled === true : input.romajiEnabled === true,
    traditionalEnabled: input.traditionalEnabled === undefined ? base.traditionalEnabled === true : input.traditionalEnabled === true,
    locked: input.locked === undefined ? base.locked === true : input.locked === true,
  }
}

function loadDesktopLyricsSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopLyricsSettingsPath(), 'utf8'))
    desktopLyricsSavedBounds = parsed?.bounds && Number.isFinite(parsed.bounds.x) && Number.isFinite(parsed.bounds.y)
      ? parsed.bounds
      : null
    return sanitizeDesktopLyricsSettings(parsed)
  } catch {
    desktopLyricsSavedBounds = null
    return { ...DESKTOP_LYRICS_DEFAULTS }
  }
}

function saveDesktopLyricsSettings() {
  try {
    const settingsPath = getDesktopLyricsSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    const bounds = desktopLyricsPanelRestoreBounds || (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()
      ? desktopLyricsWindow.getBounds()
      : desktopLyricsSavedBounds)
    desktopLyricsSavedBounds = bounds || desktopLyricsSavedBounds
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ ...desktopLyricsSettings, bounds }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面歌词] 保存设置失败:', error)
  }
}

function getDesktopLyricsSettings() {
  return { ...desktopLyricsSettings }
}

function broadcastDesktopLyricsSettings() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:settings', getDesktopLyricsSettings())
  }
}

function setDesktopLyricsMousePassthrough(passthrough) {
  const next = desktopLyricsSettings.locked === true && passthrough === true
  desktopLyricsMousePassthrough = next
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    try {
      if (next) desktopLyricsWindow.setIgnoreMouseEvents(true, { forward: true })
      else desktopLyricsWindow.setIgnoreMouseEvents(false)
    } catch (error) {
      console.warn('[\u684c\u9762\u6b4c\u8bcd] \u5207\u6362\u9f20\u6807\u7a7f\u900f\u5931\u8d25:', error)
    }
  }
  return desktopLyricsMousePassthrough
}

function getDesktopLyricsDefaultBounds(orientation = desktopLyricsSettings.orientation) {
  const { screen } = require('electron')
  const workArea = screen.getPrimaryDisplay().workArea
  const size = orientation === 'vertical'
    ? { width: 300, height: Math.min(720, workArea.height - 48) }
    : { width: Math.min(980, workArea.width - 48), height: 180 }
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: orientation === 'vertical'
      ? Math.round(workArea.y + (workArea.height - size.height) / 2)
      : Math.round(workArea.y + workArea.height - size.height - 54),
    ...size,
  }
}

function clampDesktopLyricsBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const vertical = desktopLyricsSettings.orientation === 'vertical'
  const minimumWidth = vertical ? 240 : 480
  const minimumHeight = vertical ? 340 : 116
  const width = Math.min(workArea.width, Math.max(minimumWidth, Math.round(bounds.width)))
  const height = Math.min(workArea.height, Math.max(minimumHeight, Math.round(bounds.height)))
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(bounds.x))),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, Math.round(bounds.y))),
    width,
    height,
  }
}

function createDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) return desktopLyricsWindow
  const initialBounds = desktopLyricsSavedBounds || getDesktopLyricsDefaultBounds()
  desktopLyricsWindow = new BrowserWindow({
    ...initialBounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'WaveForge 桌面歌词',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-lyrics-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) desktopLyricsWindow.loadURL(`${devServerUrl}/desktop-lyrics.html`)
  else desktopLyricsWindow.loadFile(path.join(__dirname, '../dist/desktop-lyrics.html'))

  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsWindow.getBounds()))
    desktopLyricsWindow.showInactive()
    desktopLyricsWindow.moveTop()
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  })
  desktopLyricsWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
    broadcastDesktopLyricsSettings()
  })
  guardAgainstExternalNavigation(desktopLyricsWindow.webContents)
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null
    desktopLyricsPanelRestoreBounds = null
    desktopLyricsMousePassthrough = false
  })
  return desktopLyricsWindow
}

function closeDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) desktopLyricsWindow.close()
  desktopLyricsWindow = null
  desktopLyricsPanelRestoreBounds = null
  desktopLyricsMousePassthrough = false
}

ipcMain.handle('desktop-lyrics:get-settings', () => getDesktopLyricsSettings())

ipcMain.handle('desktop-lyrics:set-enabled', (_event, enabled) => {
  desktopLyricsSettings = { ...desktopLyricsSettings, enabled: enabled === true }
  saveDesktopLyricsSettings()
  if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  else closeDesktopLyricsWindow()
  // 回广播启用状态，让主窗口据此门控频谱推送
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-lyrics:enabled-changed', desktopLyricsSettings.enabled)
  }
  return { success: true, enabled: desktopLyricsSettings.enabled }
})

ipcMain.handle('desktop-lyrics:update-settings', (_event, partial) => {
  const previousOrientation = desktopLyricsSettings.orientation
  desktopLyricsSettings = sanitizeDesktopLyricsSettings(partial, desktopLyricsSettings)
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'locked')) {
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  }
  if (desktopLyricsSettings.enabled && !desktopLyricsWindow) createDesktopLyricsWindow()
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed() && previousOrientation !== desktopLyricsSettings.orientation) {
    const baseTarget = getDesktopLyricsDefaultBounds(desktopLyricsSettings.orientation)
    if (desktopLyricsPanelRestoreBounds) {
      desktopLyricsPanelRestoreBounds = baseTarget
      const workArea = getDesktopPlayerWorkArea(baseTarget)
      const targetHeight = Math.min(workArea.height, Math.max(baseTarget.height, 500))
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
        ...baseTarget,
        y: Math.max(workArea.y, baseTarget.y + baseTarget.height - targetHeight),
        height: targetHeight,
      }))
    } else {
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(baseTarget))
    }
  }
  saveDesktopLyricsSettings()
  broadcastDesktopLyricsSettings()
  return getDesktopLyricsSettings()
})

ipcMain.handle('desktop-lyrics:set-panel-open', (_event, open) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return { open: false }
  if (open === true && !desktopLyricsPanelRestoreBounds) {
    const bounds = desktopLyricsWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    desktopLyricsPanelRestoreBounds = bounds
    const targetHeight = Math.min(workArea.height, Math.max(bounds.height, 500))
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
      x: bounds.x,
      y: Math.max(workArea.y, bounds.y + bounds.height - targetHeight),
      width: bounds.width,
      height: targetHeight,
    }))
  } else if (open !== true && desktopLyricsPanelRestoreBounds) {
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsPanelRestoreBounds))
    desktopLyricsPanelRestoreBounds = null
  }
  return { open: open === true }
})

ipcMain.handle('desktop-lyrics:set-mouse-passthrough', (_event, passthrough) => ({
  passthrough: setDesktopLyricsMousePassthrough(passthrough === true),
}))

ipcMain.on('desktop-lyrics:control', (_event, action) => {
  if (action === 'close') {
    desktopLyricsSettings = { ...desktopLyricsSettings, enabled: false }
    saveDesktopLyricsSettings()
    closeDesktopLyricsWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:enabled-changed', false)
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-player:control', action)
})

ipcMain.on('desktop-lyrics:drag-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  desktopLyricsDragSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-lyrics:drag-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsDragSession) return
  const start = desktopLyricsDragSession
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    ...start.bounds,
    x: start.bounds.x + (Number(point?.x) - start.x),
    y: start.bounds.y + (Number(point?.y) - start.y),
  }))
})

ipcMain.on('desktop-lyrics:drag-end', () => {
  desktopLyricsDragSession = null
  saveDesktopLyricsSettings()
})

ipcMain.on('desktop-lyrics:resize-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  const edge = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(point?.edge) ? point.edge : 'se'
  desktopLyricsResizeSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge,
  }
})

ipcMain.on('desktop-lyrics:resize-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsResizeSession) return
  const start = desktopLyricsResizeSession
  const dx = Number(point?.x) - start.x
  const dy = Number(point?.y) - start.y
  const fromLeft = start.edge.includes('w')
  const fromRight = start.edge.includes('e')
  const fromTop = start.edge.includes('n')
  const fromBottom = start.edge.includes('s')
  const width = start.bounds.width + (fromLeft ? -dx : fromRight ? dx : 0)
  const height = start.bounds.height + (fromTop ? -dy : fromBottom ? dy : 0)
  const nextWidth = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 240 : 480, width)
  const nextHeight = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 340 : 116, height)
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    x: fromLeft ? start.bounds.x + start.bounds.width - nextWidth : start.bounds.x,
    y: fromTop ? start.bounds.y + start.bounds.height - nextHeight : start.bounds.y,
    width: nextWidth,
    height: nextHeight,
  }))
})

ipcMain.on('desktop-lyrics:resize-end', () => {
  desktopLyricsResizeSession = null
  saveDesktopLyricsSettings()
})

ipcMain.handle('desktop-player:set-enabled', (_event, enabled) => {
  desktopPlayerEnabled = enabled === true
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled) {
    createDesktopPlayerWindow()
  } else {
    closeDesktopPlayerWindow()
  }
  // 回广播启用状态，让主窗口据此门控频谱推送（无消费者时跳过 IPC 与数组分配）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:enabled-changed', desktopPlayerEnabled)
  }
  return { success: true, enabled: desktopPlayerEnabled }
})

ipcMain.handle('desktop-player:set-form', (_event, form) => {
  if (!DESKTOP_PLAYER_FORMS.has(form)) return { success: false, form: desktopPlayerForm }
  const changed = desktopPlayerForm !== form
  desktopPlayerForm = form
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled && desktopPlayerWindow && !desktopPlayerWindow.isDestroyed() && changed) {
    const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm]
    const bounds = desktopPlayerWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    const centerX = workArea.x + workArea.width / 2
    desktopPlayerWindow.setBounds({
      x: desktopPlayerForm === 'bar'
        ? Math.round(centerX - size.width / 2)
        : Math.round(workArea.x + workArea.width - size.width - 24),
      y: Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24)),
      width: size.width,
      height: size.height,
    })
  }
  broadcastDesktopPlayerState()
  return { success: true, form: desktopPlayerForm }
})

ipcMain.handle('desktop-player:get-state', () => getDesktopPlayerSnapshot())

ipcMain.handle('media-keys:set-enabled', (_event, enabled) => {
  if (!app.isReady()) return { success: false, enabled: false, registrations: {} }
  return setGlobalMediaKeysEnabled(enabled)
})

// 主窗口推送播放状态（歌曲 / 歌词 / 播放中 / 频谱）
ipcMain.on('desktop-player:state-update', (_event, partial) => {
  if (!partial || typeof partial !== 'object') return
  const changed = {}

  if (partial.song !== undefined) {
    const next = partial.song || null
    if (desktopPlayerState.song !== next) {
      desktopPlayerState.song = next
      changed.song = next
    }
  }
  if (partial.lyric !== undefined) {
    const next = partial.lyric || null
    if (desktopPlayerState.lyric !== next) {
      desktopPlayerState.lyric = next
      changed.lyric = next
    }
  }
  if (partial.playing !== undefined) {
    const next = partial.playing === true
    if (desktopPlayerState.playing !== next) {
      desktopPlayerState.playing = next
      changed.playing = next
    }
  }
  for (const key of ['hasTranslation', 'hasRomaji']) {
    if (partial[key] === undefined) continue
    const next = partial[key] === true
    if (desktopPlayerState[key] !== next) {
      desktopPlayerState[key] = next
      changed[key] = next
    }
  }
  if (partial.accentColor !== undefined) {
    const next = String(partial.accentColor || '')
    if (desktopPlayerState.accentColor !== next) {
      desktopPlayerState.accentColor = next
      changed.accentColor = next
    }
  }
  if (Array.isArray(partial.playlist)) {
    const next = partial.playlist.slice(0, 500).map(item => ({
      index: Number(item?.index) || 0,
      name: String(item?.name || ''),
      artists: String(item?.artists || ''),
    }))
    desktopPlayerState.playlist = next
    changed.playlist = next
  }
  if (partial.currentIndex !== undefined) {
    const value = Number(partial.currentIndex)
    const next = Number.isInteger(value) ? value : -1
    if (desktopPlayerState.currentIndex !== next) {
      desktopPlayerState.currentIndex = next
      changed.currentIndex = next
    }
  }
  if (typeof partial.progress === 'number' && Number.isFinite(partial.progress)) {
    desktopPlayerState.progress = partial.progress
    changed.progress = partial.progress
  }
  if (Array.isArray(partial.spectrum)) {
    const next = partial.spectrum.slice(0, 5).map(value => Math.max(0, Math.min(1, Number(value) || 0)))
    desktopPlayerState.spectrum = next
    changed.spectrum = next
  }
  broadcastDesktopPlayerPartial(changed)
})

// 小窗口内的播放控制指令，转发给主窗口执行
ipcMain.on('desktop-player:control', (_event, action, payload) => {
  // close 由主进程直接处理：关闭小窗口并同步开关状态
  if (action === 'close') {
    desktopPlayerEnabled = false
    saveDesktopPlayerSettings()
    closeDesktopPlayerWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop-player:enabled-changed', false)
    }
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:control', action, payload)
  }
})

ipcMain.on('desktop-player:resize-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerForm !== 'card') return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerResizeSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge: ['nw', 'ne', 'sw', 'se'].includes(point?.edge) ? point.edge : 'se',
  }
})

ipcMain.on('desktop-player:resize-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerResizeSession) return
  const start = desktopPlayerResizeSession
  const workArea = getDesktopPlayerWorkArea(start.bounds)
  const dx = Number(point?.x) - start.x
  const dy = Number(point?.y) - start.y
  const fromLeft = start.edge.endsWith('w')
  const fromTop = start.edge.startsWith('n')
  const width = Math.min(720, Math.max(300, Math.round(start.bounds.width + (fromLeft ? -dx : dx))))
  const height = Math.min(workArea.height, Math.max(112, Math.round(start.bounds.height + (fromTop ? -dy : dy))))
  const x = fromLeft ? start.bounds.x + start.bounds.width - width : start.bounds.x
  const y = fromTop ? start.bounds.y + start.bounds.height - height : start.bounds.y
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({ x, y, width, height }))
})

ipcMain.on('desktop-player:resize-end', () => {
  desktopPlayerResizeSession = null
})

ipcMain.handle('desktop-player:set-expanded', (_event, expanded) => {
  return { direction: desktopPlayerSetExpanded(expanded === true) || desktopPlayerExpansionDirection }
})


// 内容高度同步：根据屏幕剩余空间保持顶边或底边不动，避免面板跑出屏幕。
ipcMain.on('desktop-player:content-height', (_event, height) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerResizeSession) return
  const minimum = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm].height
  const bounds = desktopPlayerWindow.getBounds()
  const workArea = getDesktopPlayerWorkArea(bounds)
  const target = Math.min(workArea.height, Math.max(minimum, Math.ceil(Number(height) || 0)))
  if (bounds.height === target) return
  const y = desktopPlayerExpansionDirection === 'up' ? bounds.y + bounds.height - target : bounds.y
  animateDesktopPlayerBounds(clampDesktopPlayerBounds({ x: bounds.x, y, width: bounds.width, height: target }))
})

// 使用拖动开始时的绝对窗口坐标，避免高频 IPC 延迟造成位移累计误差和窗口抽搐。
ipcMain.on('desktop-player:drag-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerDragSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-player:drag-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerDragSession) return
  const start = desktopPlayerDragSession
  const next = {
    ...start.bounds,
    x: Math.round(start.bounds.x + (Number(point?.x) - start.x)),
    y: Math.round(start.bounds.y + (Number(point?.y) - start.y)),
  }
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds(next))
})

ipcMain.on('desktop-player:drag-end', () => {
  desktopPlayerDragSession = null
})

function getSecureCredentialsPath() {
  return path.join(app.getPath('userData'), 'secure-credentials.json')
}

function readSecureCredentials() {
  const credentialsPath = getSecureCredentialsPath()
  if (!fs.existsSync(credentialsPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSecureCredentials(credentials) {
  const credentialsPath = getSecureCredentialsPath()
  const temporaryPath = `${credentialsPath}.tmp`
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, credentialsPath)
}

function readQQMusicSkillKey() {
  if (!safeStorage.isEncryptionAvailable()) return ''
  const encrypted = readSecureCredentials()[QQMUSIC_SKILL_CREDENTIAL]
  if (typeof encrypted !== 'string' || !encrypted) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

// 开发者模式状态（默认关闭）
let developerMode = false

// 日志辅助函数，仅在开发者模式下输出壁纸相关日志
function logWallpaper(...args) {
  if (developerMode) {
    console.log(...args)
  }
}

function safeSendToWindow(targetWindow, channel, ...args) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false
  }

  const contents = targetWindow.webContents
  if (!contents || contents.isDestroyed()) {
    return false
  }

  try {
    contents.send(channel, ...args)
    return true
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (!message.includes('Render frame was disposed')) {
      console.warn(`[IPC] Failed to send "${channel}":`, message)
    }
    return false
  }
}

function getWindowsSystemLocation() {
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Devices.Geolocation.Geolocator, Windows, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
$accessOperation = [Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()
$accessTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.GeolocationAccessStatus]).Invoke($null, @($accessOperation))
$access = $accessTask.GetAwaiter().GetResult()
if ([string]$access -ne 'Allowed') {
  throw "Windows location permission is $access"
}
$geolocator = New-Object Windows.Devices.Geolocation.Geolocator
$positionOperation = $geolocator.GetGeopositionAsync()
$positionTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($positionOperation))
$position = $positionTask.GetAwaiter().GetResult()
$point = $position.Coordinate.Point.Position
[pscustomobject]@{
  latitude = $point.Latitude
  longitude = $point.Longitude
  accuracy = $position.Coordinate.Accuracy
} | ConvertTo-Json -Compress
`

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || '无法读取 Windows 系统定位'))
          return
        }
        try {
          const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
          const location = JSON.parse(jsonLine || '{}')
          const latitude = Number(location.latitude)
          const longitude = Number(location.longitude)
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw new Error('Windows 系统定位没有返回有效坐标')
          }
          resolve({
            latitude,
            longitude,
            accuracy: Number(location.accuracy) || null,
            source: 'windows',
          })
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}


protocol.registerSchemesAsPrivileged([
  {
    scheme: 'waveforge-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
])

function createWindow() {
  // 开发模式下主页面加载很快，必须让启动画面先完成绘制并保持可见，
  // 否则 splash 的淡入和音波动画还没显示就会被主窗口关闭。
  const splashMinVisibleMs = isDev ? 1800 : 1200
  let splashShownAt = 0

  const splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0a0f14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  const showSplash = () => {
    if (splashWindow.isDestroyed() || splashWindow.isVisible()) return
    splashShownAt = Date.now()
    splashWindow.show()
    splashWindow.focus()
    logStartupTiming(`Splash animation shown (minimum ${splashMinVisibleMs}ms)`)
  }

  const splashReady = splashWindow.loadFile(path.join(__dirname, 'splash.html'))
    .then(() => {
      showSplash()
      return true
    })
    .catch(error => {
      console.warn('[Startup] Failed to load splash animation:', error.message)
      return false
    })
  // 创建主窗口
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: '#000000',
    transparent: false,
    titleBarStyle: 'hidden',
    title: 'WaveForge 澜音工坊',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    roundedCorners: true,
    show: false, // 初始隐藏窗口
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // 阻止同窗口被导航到外部站点（特权 preload 桥只允许停留在应用自身地址）
  guardAgainstExternalNavigation(mainWindow.webContents)

  // 开发模式加载 Vite 服务器
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[ProcessHealth] Main renderer exited:', {
      reason: details?.reason,
      exitCode: details?.exitCode,
    })
  })

  mainWindow.webContents.once('dom-ready', () => {
    logStartupTiming('Main renderer DOM ready')
  })
  mainWindow.webContents.once('did-finish-load', async () => {
    logStartupTiming('Main renderer finished loading')
    try {
      const rendererMetrics = await mainWindow.webContents.executeJavaScript(`(() => {
        const resources = performance.getEntriesByType('resource')
          .map(entry => ({
            name: entry.name.replace(location.origin, ''),
            duration: Math.round(entry.duration),
            startTime: Math.round(entry.startTime),
            transferSize: entry.transferSize || 0,
          }))
          .sort((left, right) => right.duration - left.duration)
        return {
          resourceCount: resources.length,
          slowestResources: resources.slice(0, 12),
        }
      })()`)
      logStartupTiming(`Renderer resources: ${rendererMetrics.resourceCount}; slowest: ${JSON.stringify(rendererMetrics.slowestResources)}`)
    } catch (error) {
      logStartupTiming(`Renderer performance metrics unavailable: ${error.message}`)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logStartupTiming(`Main renderer failed to load (${errorCode}: ${errorDescription}) ${validatedURL}`)
    }
  })

  if (isDev) {
    mainWindow.loadURL(devServerUrl)
    if (process.env.WAVEFORGE_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools()
    }
  } else {
    // 生产模式加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  // 主页面与启动动画都准备好后再切换，并保证动画有完整的可见时间。
  mainWindow.once('ready-to-show', async () => {
    const splashLoaded = await splashReady
    const visibleForMs = splashShownAt > 0 ? Date.now() - splashShownAt : 0
    const remainingMs = splashLoaded
      ? Math.max(0, splashMinVisibleMs - visibleForMs)
      : 0

    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.show()
      mainWindow.focus()
      if (!splashWindow.isDestroyed()) splashWindow.close()
      logStartupTiming('Main window shown')
    }, remainingMs)
  })
  // 阻止 window.open 创建新的 Electron 窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 使用系统默认浏览器打开外部链接
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (wallpaperWatcher) {
      clearInterval(wallpaperWatcher)
      wallpaperWatcher = null
    }
  })

  // 监听窗口最大化/取消最大化事件
  mainWindow.on('maximize', () => {
    safeSendToWindow(mainWindow, 'window-maximized', true)
  })

  mainWindow.on('unmaximize', () => {
    safeSendToWindow(mainWindow, 'window-maximized', false)
  })

  // 监听进入/退出 Kiosk 模式
  mainWindow.on('enter-full-screen', () => {
    safeSendToWindow(mainWindow, 'window-fullscreen-change', true)
  })

  mainWindow.on('leave-full-screen', () => {
    safeSendToWindow(mainWindow, 'window-fullscreen-change', false)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      safeSendToWindow(mainWindow, 'window-maximized', mainWindow.isMaximized())
      safeSendToWindow(mainWindow, 'window-fullscreen-change', mainWindow.isKiosk() || mainWindow.isFullScreen())
    }
  })

  // F12 快捷键：开发者模式下打开开发者工具
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (developerMode) {
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools()
        } else {
          mainWindow.webContents.openDevTools()
        }
      }
    }
  })
}

// ========== 壁纸功能 ==========

// 获取 Windows 当前桌面壁纸路径
function detectImageMime(buffer, filePath) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

let wallpaperPayloadCache = null

function buildWallpaperPayload(wallpaperPath) {
  const stats = fs.statSync(wallpaperPath)
  const cacheKey = `${path.resolve(wallpaperPath)}:${stats.size}:${stats.mtimeMs}`
  if (wallpaperPayloadCache?.key === cacheKey) {
    return { ...wallpaperPayloadCache.payload }
  }

  const buffer = fs.readFileSync(wallpaperPath)
  const mimeType = detectImageMime(buffer, wallpaperPath)
  const payload = {
    path: wallpaperPath,
    fileUrl: pathToFileURL(wallpaperPath).href,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  }
  wallpaperPayloadCache = { key: cacheKey, payload }
  return { ...payload }
}

function toMediaUrl(filePath) {
  const resolved = path.resolve(filePath)
  allowedMediaFiles.delete(resolved)
  allowedMediaFiles.add(resolved)
  while (allowedMediaFiles.size > MAX_ALLOWED_MEDIA_FILES) {
    const oldest = allowedMediaFiles.values().next().value
    if (!oldest) break
    allowedMediaFiles.delete(oldest)
  }
  return `waveforge-media://local/${encodeURIComponent(resolved)}`
}

function registerMediaProtocol() {
  protocol.registerFileProtocol('waveforge-media', (request, callback) => {
    try {
      const url = new URL(request.url)
      const encodedPath = url.pathname.replace(/^\/+/, '')
      const filePath = path.resolve(decodeURIComponent(encodedPath))

      if (!filePath || !allowedMediaFiles.has(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        callback({ error: -6 })
        return
      }

      callback({ path: filePath })
    } catch (error) {
      console.warn('[MediaProtocol] Failed to resolve media URL:', error.message)
      callback({ error: -2 })
    }
  })
}

const WALLPAPER_ENGINE_CONFIG_CACHE_MS = 60_000
let wallpaperEngineConfigPathCache = null
let wallpaperEngineConfigPathCacheExpiresAt = 0

function getWallpaperEngineConfigPath() {
  const now = Date.now()
  if (now < wallpaperEngineConfigPathCacheExpiresAt) {
    return wallpaperEngineConfigPathCache
  }

  const candidates = []
  try {
    const processPath = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 }
    ).trim()

    if (processPath) candidates.push(path.join(path.dirname(processPath), 'config.json'))
  } catch (error) {
    console.warn('[WallpaperEngine] Process lookup failed:', error.message)
  }

  candidates.push(
    path.join(process.env.ProgramFiles || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
    'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\config.json'
  )

  wallpaperEngineConfigPathCache = candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
  wallpaperEngineConfigPathCacheExpiresAt = now + WALLPAPER_ENGINE_CONFIG_CACHE_MS
  return wallpaperEngineConfigPathCache
}

function getWallpaperEngineSourceType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video'
  if (['.html', '.htm'].includes(ext)) return 'web'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (ext === '.json' || ext === '.pkg') return 'scene'
  if (ext === '.exe') return 'application'
  return 'unknown'
}

function findWallpaperEngineUserConfig(config) {
  return Object.values(config).find((value) => (
    value &&
    typeof value === 'object' &&
    value.general &&
    value.general.wallpaperconfig &&
    value.general.wallpaperconfig.selectedwallpapers
  ))
}

function getWallpaperEngineSource() {
  try {
    const configPath = getWallpaperEngineConfigPath()
    if (!configPath) return null

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const userConfig = findWallpaperEngineUserConfig(config)
    const selected = userConfig?.general?.wallpaperconfig?.selectedwallpapers
    if (!selected || typeof selected !== 'object') return null

    const monitor = selected.Monitor0 ? 'Monitor0' : Object.keys(selected)[0]
    const wallpaper = selected[monitor]
    const wallpaperPath = wallpaper?.file
    if (!wallpaperPath || !fs.existsSync(wallpaperPath)) return null

    const stats = fs.statSync(wallpaperPath)
    const sourceType = getWallpaperEngineSourceType(wallpaperPath)

    // 对于 Scene 类型壁纸，标记为不支持
    if (sourceType === 'scene') {
      logWallpaper('[WallpaperEngine] Scene wallpaper detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'scene',
        path: wallpaperPath
      }
    }
    
    // 对于 Web 类型壁纸，尝试提取视频文件
    if (sourceType === 'web') {
      const wallpaperDir = path.dirname(wallpaperPath)
      logWallpaper('[WallpaperEngine] Web wallpaper detected, searching for video files in:', wallpaperDir)
      
      // 搜索目录中的视频文件
      const videoExtensions = ['.mp4', '.webm', '.mov', '.m4v']
      let foundVideo = null
      
      try {
        const files = fs.readdirSync(wallpaperDir)
        for (const file of files) {
          const ext = path.extname(file).toLowerCase()
          if (videoExtensions.includes(ext)) {
            foundVideo = path.join(wallpaperDir, file)
            logWallpaper('[WallpaperEngine] Found video file:', foundVideo)
            break
          }
        }
        
        // 如果找到视频文件，返回视频源
        if (foundVideo && fs.existsSync(foundVideo)) {
          const videoStats = fs.statSync(foundVideo)
          logWallpaper('[WallpaperEngine] Using extracted video from web wallpaper:', foundVideo)
          
          return {
            path: foundVideo,
            fileUrl: pathToFileURL(foundVideo).href,
            mediaUrl: toMediaUrl(foundVideo),
            sourceType: 'video', // 改为 video 类型
            monitor,
            local: Boolean(wallpaper.local),
            title: path.basename(wallpaperDir), // 使用目录名作为标题
            size: videoStats.size,
            mtimeMs: videoStats.mtimeMs,
            configPath,
          }
        }
      } catch (err) {
        console.warn('[WallpaperEngine] Failed to search for video files:', err.message)
      }
      
      // 如果没有找到视频，标记为不支持
      logWallpaper('[WallpaperEngine] Web wallpaper has no extractable video, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'web',
        path: wallpaperPath
      }
    }
    
    // 对于 unknown 类型壁纸，标记为不支持
    if (sourceType === 'unknown') {
      logWallpaper('[WallpaperEngine] Unknown wallpaper type detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'unknown',
        path: wallpaperPath
      }
    }

    return {
      path: wallpaperPath,
      fileUrl: pathToFileURL(wallpaperPath).href,
      mediaUrl: toMediaUrl(wallpaperPath),
      sourceType,
      monitor,
      local: Boolean(wallpaper.local),
      title: path.basename(wallpaperPath),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      configPath,
    }
  } catch (error) {
    console.warn('[WallpaperEngine] Source lookup failed:', error.message)
    return null
  }
}

let windowsWallpaperRequest = null

function getWindowsWallpaper() {
  if (windowsWallpaperRequest) return windowsWallpaperRequest

  logWallpaper('🔍 [Wallpaper] 开始获取壁纸路径..')
  windowsWallpaperRequest = new Promise((resolve, reject) => {
    if (os.platform() !== 'win32') {
      console.error('❌ [Wallpaper] 不支持的操作系统:', os.platform())
      reject(new Error('此功能仅支持 Windows 系统'))
      return
    }
    logWallpaper('✅ [Wallpaper] 系统检查通过: Windows')

    execFile(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { encoding: null, maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          console.error('❌ [Wallpaper] 注册表查询失败:', error.message)
          if (stderr?.length) console.error('❌ [Wallpaper] 错误输出:', new TextDecoder('gbk').decode(stderr))
          reject(error)
          return
        }

        const output = stdout?.length ? new TextDecoder('gbk').decode(stdout) : ''
        const match = output.match(/^\s*Wallpaper\s+REG_\w+\s+(.+?)\s*$/mi)
        const wallpaperPath = match?.[1]?.trim() || ''
        logWallpaper('📁 [Wallpaper] 壁纸路径:', wallpaperPath)

        if (wallpaperPath && fs.existsSync(wallpaperPath)) {
          logWallpaper('✓ [Wallpaper] 文件存在验证通过')
          const wallpaper = buildWallpaperPayload(wallpaperPath)
          const wallpaperEngine = getWallpaperEngineSource()
          if (wallpaperEngine) wallpaper.wallpaperEngine = wallpaperEngine
          logWallpaper('🔗 [Wallpaper] 转换后的URL:', wallpaper.fileUrl)
          logWallpaper('📊 [Wallpaper] 壁纸数据:', {
            mimeType: wallpaper.mimeType,
            size: wallpaper.size,
            mtimeMs: wallpaper.mtimeMs,
          })
          logWallpaper('✓ [Wallpaper] 壁纸获取成功')
          resolve(wallpaper)
        } else {
          console.error('❌ [Wallpaper] 文件不存在:', wallpaperPath)
          reject(new Error('壁纸文件不存在: ' + wallpaperPath))
        }
      }
    )
  }).finally(() => {
    windowsWallpaperRequest = null
  })

  return windowsWallpaperRequest
}

// IPC 处理：获取当前壁纸
ipcMain.handle('get-current-wallpaper', async () => {
  logWallpaper('📞 [IPC] 收到获取壁纸请求')
  try {
    const wallpaper = await getWindowsWallpaper()
    logWallpaper('✓ [IPC] 返回壁纸:', wallpaper.fileUrl)
    return { success: true, ...wallpaper }
  } catch (error) {
    console.error('❌ [IPC] 获取壁纸失败:', error.message)
    return { success: false, error: error.message }
  }
})

// IPC 处理：打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  logWallpaper('📞 [IPC] 收到打开外部链接请求:', url)
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: '只允许打开 HTTP 或 HTTPS 链接' }
    }
    await shell.openExternal(parsed.href)
    logWallpaper('✓ [IPC] 成功在默认浏览器中打开链接')
    return { success: true }
  } catch (error) {
    console.error('❌ [IPC] 打开外部链接失败:', error.message)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('desktop-widgets:get-system-status', async () => {
  const current = readCpuTimes()
  const previous = desktopWidgetCpuSample
  desktopWidgetCpuSample = current
  const totalDelta = previous ? current.all - previous.all : 0
  const idleDelta = previous ? current.idle - previous.idle : 0
  const cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
  const memoryTotal = os.totalmem()
  const memoryUsed = Math.max(0, memoryTotal - os.freemem())
  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal ? memoryUsed / memoryTotal * 100 : 0,
    disks: await readDesktopWidgetDisks(),
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`,
  }
})

ipcMain.handle('desktop-widgets:pick-launcher-target', async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: kind === 'folder' ? '选择文件夹' : '选择应用或文件',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
  })
  return result.canceled ? null : result.filePaths[0] || null
})

// 启动器组件合法的可执行/快捷方式类型；扩展名不在白名单内的一律拒绝打开。
const ALLOWED_LAUNCHER_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.lnk', '.url', '.msi', '.appref-ms',
])

ipcMain.handle('desktop-widgets:open-launcher-target', async (_event, target, kind) => {
  const value = String(target || '').trim()
  if (!value) return { success: false, error: '目标为空' }
  if (kind === 'url') {
    let parsed
    try { parsed = new URL(value) } catch { return { success: false, error: '网址无效' } }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: '仅支持 HTTP/HTTPS 地址' }
    await shell.openExternal(parsed.href)
    return { success: true }
  }
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved)) return { success: false, error: '文件或目录不存在' }
  // 仅允许启动器组件合法的可执行/快捷方式类型，阻止任意文件被当作程序启动。
  const extension = path.extname(resolved).toLowerCase()
  if (!ALLOWED_LAUNCHER_EXTENSIONS.has(extension)) {
    return { success: false, error: '不支持的文件类型' }
  }
  const error = await shell.openPath(resolved)
  return error ? { success: false, error } : { success: true }
})

// 启动壁纸监听（每10秒检查一次）
let lastWallpaperSignature = null
let wallpaperWatcherBusy = false

function startWallpaperWatcher() {
  logWallpaper('[Watcher] Starting wallpaper watcher')
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
  }

  wallpaperWatcher = setInterval(async () => {
    logWallpaper('🔧 [Watcher] 检查壁纸变化..')
    try {
      const wallpaper = await getWindowsWallpaper()
      const engineSignature = wallpaper.wallpaperEngine
        ? `${wallpaper.wallpaperEngine.path}:${wallpaper.wallpaperEngine.mtimeMs}:${wallpaper.wallpaperEngine.size}:${wallpaper.wallpaperEngine.sourceType}`
        : 'no-engine'
      const isLiveEngineWallpaper = wallpaper.wallpaperEngine &&
        (wallpaper.wallpaperEngine.sourceType === 'video' || wallpaper.wallpaperEngine.sourceType === 'web')
      const currentSignature = isLiveEngineWallpaper
        ? engineSignature
        : `${wallpaper.path}:${wallpaper.mtimeMs}:${wallpaper.size}:${engineSignature}`
      
      // 如果壁纸路径发生变化，通知渲染进程
      if (currentSignature !== lastWallpaperSignature) {
        logWallpaper('🎨 [Watcher] 检测到壁纸变化！')
        logWallpaper('   旧壁纸:', lastWallpaperSignature)
        logWallpaper('   新壁纸:', currentSignature)
        lastWallpaperSignature = currentSignature
        if (mainWindow && !mainWindow.isDestroyed()) {
          logWallpaper('📡 [Watcher] 发送壁纸变化事件到渲染进程')
          safeSendToWindow(mainWindow, 'wallpaper-changed', wallpaper)
        } else {
          console.warn('⚠️ [Watcher] 主窗口不存在或已销毁')
        }
      } else {
        logWallpaper('✅ [Watcher] 壁纸未变化')
      }
    } catch (error) {
      console.error('❌ [Watcher] 壁纸监听出错:', error.message)
    }
  }, 10000) // 每10秒检查一次
  
  logWallpaper('✓ [Watcher] 壁纸监听器已启动（10秒间隔）')
}

// ========== QQ音乐登录窗口 ==========

async function createQQLoginWindow() {
  return new Promise((resolve) => {
    if (qqLoginWindow) {
      qqLoginWindow.focus()
      resolve({ success: false, error: 'QQ 音乐登录窗口已打开' })
      return
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // 清理 QQ 音乐相关的缓存和 Cookie
    void (async () => {
    try {
      const session = mainWindow.webContents.session
      
      console.log('🔧 [QQ登录] 清理 QQ 音乐缓存和 Cookie...')
      
      // 清理 Cookie
      const cookies = await session.cookies.get({ domain: '.qq.com' })
      for (const cookie of cookies) {
        await session.cookies.remove(`https://${cookie.domain}`, cookie.name)
      }
      
      // 登录窗口与主应用共用 session，不能清空全部 localStorage/indexDB，
      // 否则会连带删除 WaveForge 自身设置。QQ 域 Cookie 已在上面精准清理。
      console.log('✓ [QQ登录] QQ 域 Cookie 清理完成')
    } catch (err) {
      console.error('❌ [QQ登录] 清理缓存失败:', err)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
    
    qqLoginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: mainWindow,
      modal: true,
      frame: false, // 无边框
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'WaveForge 澜音工坊 - QQ音乐登录',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: mainWindow.webContents.session, // 共享 session 以保留 Cookie
      },
    })

    // 加载 QQ 音乐喜欢的歌曲页面（需要登录）
    qqLoginWindow.loadURL('https://y.qq.com/n/ryqq_v2/profile/like/song')

    // 页面加载完成后注入关闭按钮
    qqLoginWindow.webContents.on('did-finish-load', () => {
      qqLoginWindow.webContents.executeJavaScript(`
        (function() {
          // 创建关闭按钮容器
          const closeBtn = document.createElement('div');
          closeBtn.id = 'waveforge-close-btn';
          closeBtn.innerHTML = \`
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          \`;
          
          // 样式
          closeBtn.style.cssText = \`
            position: fixed;
            top: 20px;
            right: 20px;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 999999;
            color: white;
            opacity: 0;
            transition: all 0.3s ease;
            pointer-events: auto;
          \`;
          
          // 鼠标悬停显示
          let hideTimer = null;
          
          function showButton() {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
          }
          
          function scheduleHide() {
            hideTimer = setTimeout(() => {
              closeBtn.style.opacity = '0';
            }, 3000);
          }
          
          closeBtn.addEventListener('mouseenter', () => {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
            closeBtn.style.background = 'rgba(255, 0, 0, 0.7)';
          });
          
          closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(0, 0, 0, 0.5)';
            scheduleHide();
          });
          
          closeBtn.addEventListener('click', () => {
            window.close();
          });
          
          // 监听鼠标移动，靠近右上角时显示
          document.addEventListener('mousemove', (e) => {
            const distanceFromTopRight = Math.sqrt(
              Math.pow(window.innerWidth - e.clientX, 2) + 
              Math.pow(e.clientY, 2)
            );
            
            if (distanceFromTopRight < 150) {
              showButton();
              scheduleHide();
            }
          });
          
          // 添加到页面
          document.body.appendChild(closeBtn);
          
          // 初始显示3秒
          showButton();
          scheduleHide();
        })();
      `).catch(err => {
        console.error('❌ [QQ登录] 注入关闭按钮失败:', err)
      })
    })

    // 定期检查是否登录成功
    const checkLoginInterval = setInterval(async () => {
      if (!qqLoginWindow || qqLoginWindow.isDestroyed()) {
        clearInterval(checkLoginInterval)
        return
      }

      try {
        const cookies = await qqLoginWindow.webContents.session.cookies.get({ 
          domain: '.qq.com' 
        })

        // 检查关键 Cookie 是否存在
        const hasUserId = cookies.some(cookie =>
          cookie.name === 'uin' || cookie.name === 'wxuin'
        )
        const hasMusicKey = cookies.some(cookie =>
          cookie.name === 'qm_keyst' ||
          cookie.name === 'qqmusic_key'
        )
        const hasLogin = hasUserId && hasMusicKey

        if (hasLogin) {
        // 构建 Cookie 字符串
          const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ')

        console.log('✓ [QQ登录] 登录成功，获取到 Cookie')

          // 先完成 Promise，再关闭窗口，避免 closed 事件误报为取消。
          clearInterval(checkLoginInterval)
          finish({ success: true, cookie: cookieString })
          qqLoginWindow.close()
        }
      } catch (err) {
        console.error('❌ [QQ登录] 检查登录状态失败:', err)
      }
    }, 2000) // 每2秒检查一次

    qqLoginWindow.on('closed', () => {
      clearInterval(checkLoginInterval)
      qqLoginWindow = null
      finish({ success: false, error: '用户取消登录' })
    })
    })().catch(error => {
      console.error('[QQ Login] failed to initialize login window:', error)
      if (qqLoginWindow && !qqLoginWindow.isDestroyed()) qqLoginWindow.destroy()
      qqLoginWindow = null
      finish({ success: false, error: error?.message || 'QQ login window initialization failed' })
    })
  })
}

// 监听打开 QQ 登录窗口的请求
ipcMain.handle('open-qq-login-window', async () => {
  try {
    const result = await createQQLoginWindow()
    return result
  } catch (err) {
    console.error('❌[QQ登录] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// ── QQ 音乐官方增强：内置窗口领取 qmk API Key ──────────────────────────────
const QMK_OFFICIAL_KEY_URL = 'https://y.qq.com/n/ryqq_v2/qqmusic_skills'
// Dedicated isolated session for the claim window, wiped on every open so
// cached QQ login state from the app/browser is never reused.
const QMK_SESSION_PARTITION = 'waveforge-qq-skill-key'

// 注入：自动滚动到「获取 API Key」区块，并用动画引导点击「登录QQ音乐」按钮
const QMK_GUIDE_JS = `
(function () {
  if (window.__waveforgeQmkGuideDismissed) return;
  var old = document.getElementById('waveforge-skill-guide');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  function findElByText(text) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf(text) !== -1) {
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 60 && guard < 8) {
          el = el.parentElement;
          guard++;
        }
        return el;
      }
    }
    return null;
  }

  var heading = findElByText('获取 API Key');
  if (heading) {
    setTimeout(function () {
      try { heading.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }, 350);
  }

  var loginBtn = findElByText('登录QQ音乐');
  if (!loginBtn) return;

  var overlay = document.createElement('div');
  overlay.id = 'waveforge-skill-guide';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';

  var style = document.createElement('style');
  style.textContent = '@keyframes wf-guide-pulse{0%{box-shadow:0 0 0 0 rgba(49,230,139,.75)}70%{box-shadow:0 0 0 26px rgba(49,230,139,0)}100%{box-shadow:0 0 0 0 rgba(49,230,139,0)}}@keyframes wf-guide-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}';
  (document.head || document.documentElement).appendChild(style);

  var ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;border-radius:14px;border:3px solid #31e68b;background:rgba(49,230,139,.16);animation:wf-guide-pulse 1.6s infinite;pointer-events:none;';

  var arrow = document.createElement('div');
  arrow.style.cssText = 'position:fixed;width:44px;height:44px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));animation:wf-guide-bounce 1s infinite;pointer-events:none;';
  arrow.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="#31e68b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;padding:8px 14px;border-radius:10px;background:rgba(7,16,24,.92);color:#31e68b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(49,230,139,.4);pointer-events:none;white-space:nowrap;';
  tip.textContent = '请点击「登录QQ音乐」领取 API Key';

  function reposition() {
    var rect = loginBtn.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    ring.style.left = (rect.left - 8) + 'px';
    ring.style.top = (rect.top - 8) + 'px';
    ring.style.width = (rect.width + 16) + 'px';
    ring.style.height = (rect.height + 16) + 'px';
    arrow.style.left = (rect.left + rect.width / 2 - 22) + 'px';
    arrow.style.top = (rect.top - 60) + 'px';
    tip.style.left = (rect.left + rect.width / 2 - 125) + 'px';
    tip.style.top = (rect.top - 106) + 'px';
  }

  overlay.appendChild(ring);
  overlay.appendChild(arrow);
  overlay.appendChild(tip);
  document.body.appendChild(overlay);
  reposition();
  var moveTimer = setInterval(reposition, 600);

  var dismissed = false;
  function dismissGuide() {
    if (dismissed) return;
    dismissed = true;
    window.__waveforgeQmkGuideDismissed = true;
    clearInterval(moveTimer);
    clearInterval(goneTimer);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  loginBtn.addEventListener('click', dismissGuide);

  var goneTimer = setInterval(function () {
    if (!loginBtn.isConnected || !loginBtn.getBoundingClientRect().width) {
      clearInterval(moveTimer);
      clearInterval(goneTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  }, 1000);
})();
`

// 注入：右上角悬浮关闭按钮（鼠标靠近右上角出现）
const QMK_CLOSE_BTN_JS = `
(function () {
  if (document.getElementById('waveforge-close-btn')) return;
  var closeBtn = document.createElement('div');
  closeBtn.id = 'waveforge-close-btn';
  closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  closeBtn.style.cssText = 'position:fixed;top:20px;right:20px;width:40px;height:40px;background:rgba(0,0,0,.5);backdrop-filter:blur(10px);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;color:white;opacity:0;transition:all .3s ease;pointer-events:auto;';
  var hideTimer = null;
  function showButton() { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; }
  function scheduleHide() { hideTimer = setTimeout(function () { closeBtn.style.opacity = '0'; }, 3000); }
  closeBtn.addEventListener('mouseenter', function () { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; closeBtn.style.background = 'rgba(255,0,0,.7)'; });
  closeBtn.addEventListener('mouseleave', function () { closeBtn.style.background = 'rgba(0,0,0,.5)'; scheduleHide(); });
  closeBtn.addEventListener('click', function () { window.close(); });
  document.addEventListener('mousemove', function (e) {
    var d = Math.sqrt(Math.pow(window.innerWidth - e.clientX, 2) + Math.pow(e.clientY, 2));
    if (d < 150) { showButton(); scheduleHide(); }
  });
  document.body.appendChild(closeBtn);
  showButton();
  scheduleHide();
})();
`

// 从官方页抓取 qmk- 开头的 API Key（输入框值 / 元素属性 / 文本节点）
const QMK_DETECT_KEY_JS = `
(function () {
  var fullRe = /qmk-[A-Za-z0-9._-]{8,}/;
  var maskedRe = /qmk-[A-Za-z0-9.*_-]{8,}/;
  var full = '';
  var masked = '';
  function hit(value, re) {
    if (!value) return '';
    var m = re.exec(String(value));
    return m ? m[0] : '';
  }
  function consider(value) {
    if (!full) full = hit(value, fullRe);
    if (!masked && value) {
      var mm = hit(value, maskedRe);
      if (mm) masked = mm;
    }
  }
  var inputs = document.querySelectorAll('input, textarea');
  for (var i = 0; i < inputs.length; i++) {
    consider(inputs[i].value);
  }
  var attrs = ['data-key', 'data-apikey', 'data-clipboard', 'title', 'placeholder', 'aria-label', 'value'];
  var els = document.querySelectorAll('[data-key],[data-apikey],[data-clipboard],[title],[placeholder],[aria-label],[value]');
  for (var j = 0; j < els.length && !full; j++) {
    for (var a = 0; a < attrs.length; a++) {
      consider(els[j].getAttribute(attrs[a]));
    }
  }
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var count = 0;
  while (walker.nextNode() && count < 30000 && !full) {
    count++;
    consider(walker.currentNode.nodeValue);
  }
  return JSON.stringify({ full: full, masked: masked });
})()
`
const QMK_CLICK_COPY_JS = `
(function () {
  function findElByText(text) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf(text) !== -1) {
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 40 && guard < 8) {
          el = el.parentElement;
          guard++;
        }
        return el;
      }
    }
    return null;
  }
  var btn = findElByText('\u590d\u5236') || findElByText('Copy');
  if (!btn) return false;
  var clickable = (btn.closest && btn.closest('button, a, [role=button]')) || btn;
  try { clickable.click(); return true; } catch (e) { return false; }
})()
`


async function createQQSkillKeyWindow() {
  // Wipe the dedicated qmk session before opening so the login is always fresh.
  const qmkSession = session.fromPartition(QMK_SESSION_PARTITION)
  // Allow clipboard write so the official copy button can put the key on the clipboard.
  qmkSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  })
  qmkSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  try {
    await qmkSession.clearStorageData()
    await qmkSession.clearCache()
    await qmkSession.clearAuthCache()
    const qmkCookies = await qmkSession.cookies.get({})
    for (const cookie of qmkCookies) {
      await qmkSession.cookies.remove(`https://${cookie.domain}`, cookie.name)
    }
  } catch (err) {
    console.error('[QQ Skill Key] clear session failed:', err)
  }

  return new Promise((resolve) => {
    if (qqSkillKeyWindow && !qqSkillKeyWindow.isDestroyed()) {
      qqSkillKeyWindow.focus()
      resolve({ success: false, error: 'QQ 音乐官方增强领取窗口已打开' })
      return
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')

    qqSkillKeyWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      parent: mainWindow,
      modal: true,
      frame: false,
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'WaveForge 波音工坊 - QQ音乐官方增强',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: qmkSession,
      },
    })

    qqSkillKeyWindow.loadURL(QMK_OFFICIAL_KEY_URL)

    const injectGuide = () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) return
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_GUIDE_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入引导失败:', err)
      })
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLOSE_BTN_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入关闭按钮失败:', err)
      })
    }

    qqSkillKeyWindow.webContents.on('did-finish-load', injectGuide)
    qqSkillKeyWindow.webContents.on('did-navigate', () => setTimeout(injectGuide, 350))
    qqSkillKeyWindow.webContents.on('did-navigate-in-page', () => setTimeout(injectGuide, 350))

    // 轮询抓取页面上出现的 qmk- API Key
        let copyRequested = false
    const keyPoll = setInterval(async () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) {
        clearInterval(keyPoll)
        return
      }
      try {
        const raw = await qqSkillKeyWindow.webContents.executeJavaScript(QMK_DETECT_KEY_JS, true)
        let info = null
        try { info = JSON.parse(raw) } catch (e) { info = null }
        let key = info && info.full ? info.full : ''
        if (!key && info && info.masked) {
          if (!copyRequested) {
            copyRequested = true
            await qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLICK_COPY_JS, true).catch(() => {})
            await new Promise((r) => setTimeout(r, 400))
          }
          const cb = clipboard.readText() || ''
          const m = cb.match(/qmk-[A-Za-z0-9._-]{8,}/)
          if (m) {
            const star = info.masked.indexOf('*')
            const prefix = star > 0 ? info.masked.slice(0, star) : ''
            const lastStar = info.masked.lastIndexOf('*')
            const suffix = lastStar >= 0 && lastStar < info.masked.length - 1 ? info.masked.slice(lastStar + 1) : ''
            if ((!prefix || m[0].startsWith(prefix)) && (!suffix || m[0].endsWith(suffix))) key = m[0]
          }
        }
        if (key) {
          clearInterval(keyPoll)
          console.log('[QQ Skill Key] auto captured API Key')
          finish({ success: true, apiKey: key })
          qqSkillKeyWindow.close()
        }
      } catch (err) {
        // page navigating; skip this tick
      }
    }, 1500)

    qqSkillKeyWindow.on('closed', () => {
      clearInterval(keyPoll)
      qqSkillKeyWindow = null
      finish({ success: false, error: '用户取消了领取' })
    })
  })
}

// 监听打开 QQ 音乐官方增强领取窗口的请求
ipcMain.handle('open-qq-skill-key-window', async () => {
  try {
    return await createQQSkillKeyWindow()
  } catch (err) {
    console.error('[QQ Skill Key] 打开领取窗口失败:', err)
    return { success: false, error: err.message }
  }
})


// IPC 处理：设置开发者模式
ipcMain.handle('set-developer-mode', (event, enabled) => {
  developerMode = enabled
  console.log(`🔧 [DevMode] 开发者模式已${enabled ? '启用' : '禁用'}`)
  return { success: true }
})

// IPC 处理：获取开发者模式状态
ipcMain.handle('get-developer-mode', () => {
  return { enabled: developerMode }
})

// Device ID is stored in HKCU\Software\WaveForge; file storage is only a fallback.
ipcMain.handle('device-license:get-state', () => {
  try {
    return { success: true, ...deviceLicense.getState(app) }
  } catch (error) {
    console.error('[DeviceLicense] Failed to read state:', error)
    return { success: false, error: error?.message || 'Unable to copy device ID' }
  }
})

ipcMain.handle('device-license:copy-id', () => {
  try {
    const identity = deviceLicense.getOrCreateDeviceId(app)
    clipboard.writeText(identity.deviceId)
    return { success: true, ...identity }
  } catch (error) {
    console.error('[DeviceLicense] Failed to copy device ID:', error)
    return { success: false, error: error?.message || 'Unable to copy device ID' }
  }
})

ipcMain.handle('device-license:read-clipboard', () => {
  try {
    return { success: true, text: clipboard.readText() }
  } catch (error) {
    console.error('[DeviceLicense] Failed to read clipboard:', error)
    return { success: false, error: error?.message || 'Unable to read clipboard' }
  }
})

ipcMain.handle('device-license:redeem', (_event, code) => {
  try {
    return deviceLicense.redeem(app, code)
  } catch (error) {
    console.warn('[DeviceLicense] Redemption failed:', error?.message || error)
    return { success: false, error: error?.message || 'Unable to redeem code' }
  }
})

ipcMain.handle('get-hardware-acceleration', async () => {
  let gpuInfo = null
  try {
    gpuInfo = await app.getGPUInfo('basic')
  } catch (error) {
    console.warn('[GPU] Failed to read GPU information:', error?.message || error)
  }

  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : []
  const activeGpu = devices.find(device => device?.active) || devices[0] || null

  return {
    enabled: performanceSettings.hardwareAcceleration,
    gpuPreference: performanceSettings.gpuPreference,
    actualEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: app.getGPUFeatureStatus(),
    gpu: activeGpu ? {
      active: Boolean(activeGpu.active),
      vendorId: activeGpu.vendorId,
      deviceId: activeGpu.deviceId,
      vendorString: activeGpu.vendorString || '',
      deviceString: activeGpu.deviceString || '',
      driverVendor: activeGpu.driverVendor || '',
      driverVersion: activeGpu.driverVersion || '',
    } : null,
  }
})

ipcMain.handle('set-hardware-acceleration', (_event, enabled) => {
  performanceSettings.hardwareAcceleration = enabled !== false
  writePerformanceSettings(performanceSettings)
  return { success: true, enabled: performanceSettings.hardwareAcceleration, requiresRestart: true }
})

ipcMain.handle('set-gpu-preference', (_event, preference) => {
  const next = ['auto', 'discrete', 'integrated'].includes(preference) ? preference : 'discrete'
  performanceSettings.gpuPreference = next
  writePerformanceSettings(performanceSettings)
  return { success: true, gpuPreference: next, requiresRestart: true }
})

// IPC 处理：窗口控制
ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window-maximize', async () => {
  if (mainWindow) {
    // 检查当前是否已经是某种全屏状态
    const isInFullscreen = mainWindow.isKiosk() || mainWindow.isFullScreen()
    
    if (isInFullscreen || mainWindow.isMaximized()) {
      // 如果是全屏或最大化状态，则还原窗口
      if (mainWindow.isKiosk()) {
        mainWindow.setKiosk(false)
      }
      if (mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false)
      }
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      }
    } else {
      // 如果是正常窗口，则根据用户设置进入全屏或最大化
      try {
        // 从渲染进程读取全屏模式设置
        const fullscreenMode = await mainWindow.webContents.executeJavaScript(`
          (() => {
            try {
              return localStorage.getItem('fullscreenMode') || 'kiosk';
            } catch {
              return 'kiosk';
            }
          })()
        `)
        
        console.log('[窗口最大化] 读取到的全屏模式设置:', fullscreenMode)
        
        if (fullscreenMode === 'kiosk') {
          // 全屏模式 - 覆盖任务栏?
          console.log('[窗口最大化] 进入全屏模式（覆盖任务栏）')
          mainWindow.setKiosk(true)
        } else {
          // 全屏无边框模式 - 保留任务栏
          console.log('[窗口最大化] 进入全屏无边框模式（保留任务栏）')
          mainWindow.maximize()
        }
      } catch (error) {
        console.error('[窗口最大化] 读取设置失败，使用默认全屏模式', error)
        mainWindow.setKiosk(true)
      }
    }
  }
})

ipcMain.handle('window-close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

// IPC 处理：获取窗口最大化状态?
ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

// IPC 处理：全屏控制?
ipcMain.handle('window-set-fullscreen', (event, fullscreen, kiosk = false) => {
  console.log('[全屏控制] fullscreen=', fullscreen, ', kiosk=', kiosk)
  console.log('[全屏控制] 当前状态: isKiosk=', mainWindow?.isKiosk(), ', isFullScreen=', mainWindow?.isFullScreen(), ', isMaximized=', mainWindow?.isMaximized())
  
  if (mainWindow) {
    if (fullscreen) {
      if (kiosk) {
        // 全屏模式（kiosk=true）- 覆盖任务栏
        console.log('[全屏控制] 启用全屏模式（覆盖任务栏）')
        // 先退出其他模式
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize()
        }
        // 使用 setKiosk 来覆盖任务栏（Windows 上最可靠的方式）
        mainWindow.setKiosk(true)
      } else {
        // 全屏无边框模式（kiosk=false）- 保留任务栏
        console.log('[全屏控制] 启用全屏无边框模式（保留任务栏，使用最大化）')
        // 先退出其他模式
        if (mainWindow.isKiosk()) {
          mainWindow.setKiosk(false)
        }
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        // 使用最大化来保留任务栏
        mainWindow.maximize()
      }
    } else {
      // 退出所有全屏模式
      console.log('[全屏控制] 退出全屏')
      if (mainWindow.isKiosk()) {
        console.log('[全屏控制] 退出 Kiosk 模式')
        mainWindow.setKiosk(false)
      }
      if (mainWindow.isFullScreen()) {
        console.log('[全屏控制] 退出原生全屏')
        mainWindow.setFullScreen(false)
      }
      if (mainWindow.isMaximized()) {
        console.log('[全屏控制] 取消最大化')
        mainWindow.unmaximize()
      }
    }
    
    console.log(`[全屏控制] 执行后状态: isKiosk=${mainWindow.isKiosk()}, isFullScreen=${mainWindow.isFullScreen()}, isMaximized=${mainWindow.isMaximized()}`)
  }
})

// IPC 处理：获取全屏状态?
ipcMain.handle('window-is-fullscreen', () => {
  if (!mainWindow) return { fullscreen: false, kiosk: false, maximized: false }
  return {
    fullscreen: mainWindow.isFullScreen(),
    kiosk: mainWindow.isKiosk(),
    maximized: mainWindow.isMaximized()
  }
})

ipcMain.handle('get-system-location', async () => {
  try {
    return { success: true, ...(await getWindowsSystemLocation()) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * 启动本地后端服务（仅打包版需要；开发模式由 scripts/dev-electron.mjs 负责）。
 * 1) Express API（local-server.mjs，端口 3001）——通过 utilityProcess.fork 启动，
 *    传入开发模式 API 进程会用到的同款缓存路径参数（app.getPath('userData')/cache）。
 * 2) Python 节拍服务（beat_analyzer.py，端口 3002）——优先使用嵌入式 python，
 *    启动失败仅告警（应用会自动降级到 Fixed Crossfade）。
 */
let localApiChild = null
let localPythonChild = null

function startLocalBackend() {
  if (!app.isPackaged) return // 开发模式由 dev-electron.mjs 启动
  if (process.env.WAVEFORGE_DISABLE_LOCAL_BACKEND === '1') return

  // 1) Express API（3001）
  try {
    const serverEntry = path.join(process.resourcesPath, 'app.asar', 'local-server.mjs')
    localApiChild = utilityProcess.fork(serverEntry, [], {
      env: {
        ...process.env,
        WAVEFORGE_USERDATA: app.getPath('userData'),
      },
      stdio: 'pipe',
    })
    localApiChild.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.log('[LocalAPI]', text)
    })
    localApiChild.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.error('[LocalAPI:err]', text)
    })
    localApiChild.on('exit', (code) => {
      console.error('[LocalAPI] exited with code', code)
      localApiChild = null
    })
    console.log('[LocalAPI] starting local-server.mjs via utilityProcess')
  } catch (error) {
    console.error('[LocalAPI] failed to start:', error)
  }

  // 2) Python 节拍服务（3002）——仅当嵌入式 python 存在时启动
  try {
    const pythonExe = path.join(process.resourcesPath, 'python-embed', 'python.exe')
    const beatAnalyzer = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-beat-service', 'beat_analyzer.py')
    if (!fs.existsSync(pythonExe)) {
      console.warn('[BeatService] 未找到嵌入式 Python，跳过节拍服务（将使用 Fixed Crossfade 降级）')
      return
    }
    if (!fs.existsSync(beatAnalyzer)) {
      console.warn('[BeatService] 未找到 beat_analyzer.py，跳过节拍服务')
      return
    }
    localPythonChild = spawn(pythonExe, [beatAnalyzer], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })
    localPythonChild.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.log('[BeatService]', text)
    })
    localPythonChild.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.error('[BeatService:err]', text)
    })
    localPythonChild.on('exit', (code) => {
      console.warn('[BeatService] exited with code', code)
      localPythonChild = null
    })
    console.log('[BeatService] starting beat_analyzer.py on port 3002')
  } catch (error) {
    console.error('[BeatService] failed to start:', error)
  }
}

// 应用退出时一并结束本地子进程
app.on('will-quit', () => {
  try { localApiChild?.kill() } catch {}
  try { localPythonChild?.kill() } catch {}
})

app.whenReady().then(() => {
  logStartupTiming('Electron app ready')
  // Electron 默认不会自动放行渲染进程的定位权限。
  // 放行后，天气组件才能优先使用 Windows/Chromium 的设备定位，再回退到公网 IP。
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'geolocation')
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'geolocation')
  })

  // 初始化配置管理器
  configManager = new ConfigManager(app)
  const cachePath = configManager.getCachePath()
  console.log('📁 [Config] 缓存路径:', cachePath)
  
  // 创建缓存目录结构
  const requiredDirs = [
    cachePath,
    path.join(cachePath, 'temp'),           // 音频缓存
    path.join(cachePath, 'beat_analysis'),  // 节拍分析缓存
    path.join(cachePath, 'tracks'),         // 音轨缓存
    path.join(cachePath, 'transition-renders') // 过渡渲染
  ]
  
  requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log('📁 [Config] 创建目录:', dir)
    }
  })
  
  // 启动本地后端 API 服务（端口 3001）与 Python 节拍服务（端口 3002）。
  // 开发模式下由 scripts/dev-electron.mjs 启动；打包版必须由主进程自行启动，
  // 否则渲染进程请求 localhost:3001 全部失败，应用只剩空壳 UI。
  startLocalBackend()
  
  // 传入缓存路径给 analysis runtime
  analysisRuntime = createAnalysisRuntime(app, ipcMain, () => mainWindow, cachePath)
  
  // Setup render runtime IPC handlers
  setupRenderIPC(ipcMain, configManager.getCachePath(), toMediaUrl)
  
  // Setup audio download IPC handlers
  ipcMain.handle('audio-download:prepare', async (_event, urlOrPath, trackKey) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      throw new Error('Audio download service not initialized')
    }
    return await analysisRuntime.audioDownload.prepareAudioFile(urlOrPath, trackKey)
  })
  
  ipcMain.handle('audio-download:cleanup', () => {
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.cleanupOldFiles()
    }
    return { success: true }
  })
  
  ipcMain.handle('audio-download:get-stats', () => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      return { fileCount: 0, totalSize: 0, maxSize: 2 * 1024 * 1024 * 1024, cachePath: '' }
    }
    const stats = analysisRuntime.audioDownload.getCacheStats()
    const cachePath = path.join(configManager.getCachePath(), 'temp')
    return { ...stats, cachePath }
  })
  
  ipcMain.handle('audio-download:clear-cache', () => {
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.cleanupAll()
      return { success: true }
    }
    return { success: false }
  })
  
  // 配置管理 IPC 处理器
  ipcMain.handle('config:get-cache-path', () => {
    return configManager.getCachePath()
  })

  // QQ 音乐官方 Skills Key 使用系统安全存储（Windows 上为 DPAPI）加密后再落盘。
  // 不写入项目配置、环境文件或日志。
  ipcMain.handle('credentials:get-qqmusic-skill-key', () => ({
    success: true,
    configured: Boolean(readQQMusicSkillKey()),
    key: readQQMusicSkillKey(),
    secure: safeStorage.isEncryptionAvailable()
  }))

  ipcMain.handle('credentials:set-qqmusic-skill-key', (_event, value) => {
    const key = String(value || '').trim()
    if (!/^qmk-[A-Za-z0-9._-]+$/.test(key)) {
      return { success: false, error: 'API Key 格式应为 qmk-…' }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '当前系统安全存储不可用，密钥不会被明文保存' }
    }
    try {
      const credentials = readSecureCredentials()
      credentials[QQMUSIC_SKILL_CREDENTIAL] = safeStorage.encryptString(key).toString('base64')
      writeSecureCredentials(credentials)
      return { success: true, configured: true, secure: true }
    } catch (error) {
      return { success: false, error: error.message || '保存 API Key 失败' }
    }
  })

  ipcMain.handle('credentials:delete-qqmusic-skill-key', () => {
    try {
      const credentials = readSecureCredentials()
      delete credentials[QQMUSIC_SKILL_CREDENTIAL]
      writeSecureCredentials(credentials)
      return { success: true, configured: false }
    } catch (error) {
      return { success: false, error: error.message || '删除 API Key 失败' }
    }
  })
  
  ipcMain.handle('config:set-cache-path', (event, newPath) => {
    try {
      // 验证路径是否有效
      if (typeof newPath !== 'string' || !newPath.trim() || !path.isAbsolute(newPath.trim())) {
        return { success: false, error: '路径必须是绝对路径' }
      }
      
      // 保存配置
      const success = configManager.setCachePath(newPath.trim())
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', newPath)
        console.log('⚠️ [Config] 需要重启应用以生效')
        return { success: true, needRestart: true }
      } else {
        return { success: false, error: '保存配置失败' }
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
  
  ipcMain.handle('config:select-cache-path', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: '选择缓存存储路径',
        buttonLabel: '选择'
      })
      
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      
      const selectedPath = result.filePaths[0]
      
      // 自动保存选择的路径
      const success = configManager.setCachePath(selectedPath)
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', selectedPath)
        return selectedPath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to select cache path:', error)
      return null
    }
  })
  
  ipcMain.handle('config:reset-cache-path', () => {
    try {
      const defaultCachePath = configManager.getDefaultCachePath()
      
      // 保存配置
      const success = configManager.setCachePath(defaultCachePath)
      if (success) {
        console.log('📁 [Config] 缓存路径已重置为默认值:', defaultCachePath)
        return defaultCachePath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to reset cache path:', error)
      throw error
    }
  })
  
  registerMediaProtocol()

  // 桌面播放器：读取上次的开关与形态设置
  const desktopPlayerSaved = loadDesktopPlayerSettings()
  desktopPlayerEnabled = desktopPlayerSaved.enabled
  desktopPlayerForm = desktopPlayerSaved.form
  desktopLyricsSettings = loadDesktopLyricsSettings()

  // 若上次退出时开启了桌面播放器，等主窗口起来后再显示小窗口，避免抢占启动焦点
  setTimeout(() => {
    if (desktopPlayerEnabled) createDesktopPlayerWindow()
    if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  }, 1500)
  logStartupTiming('Creating main and splash windows')
  createWindow()
  setGlobalMediaKeysEnabled(mediaKeysEnabled)
  
  // 移除默认菜单栏
  if (mainWindow) {
    mainWindow.setMenu(null)
  }
  
  // 等待渲染进程加载完成后读取开发者模式设置
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const saved = localStorage.getItem('developerMode');
          return saved !== null ? JSON.parse(saved) : false;
        } catch {
          return false;
        }
      })()
    `).then(enabled => {
      developerMode = enabled
      console.log(`🔧 [DevMode] 从设置中加载开发者模式 ${enabled ? '启用' : '禁用'}`)
    }).catch(() => {
      console.log('🔧 [DevMode] 无法读取开发者模式设置，使用默认值: 禁用')
    })
  })
  
  startWallpaperWatcher()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
    wallpaperWatcher = null
  }
  // Cleanup render runtime
  cleanupRender()
})


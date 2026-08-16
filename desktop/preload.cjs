const { contextBridge, ipcRenderer } = require('electron')

// 向渲染进程暴露经过限制的安全 API。
contextBridge.exposeInMainWorld('electronAPI', {
  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
})

contextBridge.exposeInMainWorld('electron', {
  // System controls
  system: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized)
      ipcRenderer.on('window-maximized', listener)
      return () => ipcRenderer.removeListener('window-maximized', listener)
    },
    setFullscreen: (fullscreen, kiosk = false) => ipcRenderer.invoke('window-set-fullscreen', fullscreen, kiosk),
    isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    onFullscreenChange: (callback) => {
      const listener = (_event, isFullscreen) => callback(isFullscreen)
      ipcRenderer.on('window-fullscreen-change', listener)
      return () => ipcRenderer.removeListener('window-fullscreen-change', listener)
    },
    getLocation: () => ipcRenderer.invoke('get-system-location'),
    getHardwareAcceleration: () => ipcRenderer.invoke('get-hardware-acceleration'),
    setHardwareAcceleration: (enabled) => ipcRenderer.invoke('set-hardware-acceleration', enabled),
    setGpuPreference: (preference) => ipcRenderer.invoke('set-gpu-preference', preference),
    confirmGpuChange: () => ipcRenderer.invoke('confirm-gpu-change'),
    revertGpuChange: () => ipcRenderer.invoke('revert-gpu-change'),
  },

  mediaKeys: {
    setEnabled: (enabled) => ipcRenderer.invoke('media-keys:set-enabled', enabled),
    onControl: (callback) => {
      const listener = (_event, action) => callback(action)
      ipcRenderer.on('global-media-key', listener)
      return () => ipcRenderer.removeListener('global-media-key', listener)
    },
  },

  // 系统音量（频响补偿 / 低音量提示）
  audio: {
    getSystemVolume: () => ipcRenderer.invoke('audio:get-system-volume'),
  },

  desktopWidgets: {
    getSystemStatus: () => ipcRenderer.invoke('desktop-widgets:get-system-status'),
    pickLauncherTarget: (kind) => ipcRenderer.invoke('desktop-widgets:pick-launcher-target', kind),
    openLauncherTarget: (target, kind) => ipcRenderer.invoke('desktop-widgets:open-launcher-target', target, kind),
  },
  
  // 壁纸相关
  wallpaper: {
    getCurrentWallpaper: () => ipcRenderer.invoke('get-current-wallpaper'),
    onWallpaperChange: (callback) => {
      const listener = (_event, wallpaper) => callback(wallpaper)
      ipcRenderer.on('wallpaper-changed', listener)
      return () => ipcRenderer.removeListener('wallpaper-changed', listener)
    },
  },
  
  // 开发者模式
  developerMode: {
    set: (enabled) => ipcRenderer.invoke('set-developer-mode', enabled),
    get: () => ipcRenderer.invoke('get-developer-mode'),
  },

  // Device-bound identifier and signed redemption codes
  deviceLicense: {
    getState: () => ipcRenderer.invoke('device-license:get-state'),
    copyDeviceId: () => ipcRenderer.invoke('device-license:copy-id'),
    readClipboard: () => ipcRenderer.invoke('device-license:read-clipboard'),
    redeem: (code) => ipcRenderer.invoke('device-license:redeem', code),
  },
  
  // AutoMix 本地分析与缓存
  analysis: {
    startTrackAnalysis: (input) => ipcRenderer.invoke('analysis:start-track', input),
    getTrackAnalysis: (trackKey) => ipcRenderer.invoke('analysis:get-track', trackKey),
    saveTrackAnalysis: (analysis) => ipcRenderer.invoke('analysis:save-track', analysis),
    cancelJob: (jobId) => ipcRenderer.invoke('analysis:cancel-job', jobId),
    getStatus: () => ipcRenderer.invoke('analysis:get-status'),
    getCacheStats: () => ipcRenderer.invoke('analysis:get-cache-stats'),
    clearCache: () => ipcRenderer.invoke('analysis:clear-cache'),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('analysis:progress', listener)
      return () => ipcRenderer.removeListener('analysis:progress', listener)
    },
  },
  
  // Seamless transition rendering
  render: {
    transition: (plan, sourceAudioPath, targetAudioPath) => 
      ipcRenderer.invoke('render:transition', plan, sourceAudioPath, targetAudioPath),
    getAudioUrl: (filePath) => ipcRenderer.invoke('render:getAudioUrl', filePath),

    readAudioFile: (filePath) => ipcRenderer.invoke('render:readAudioFile', filePath),
    clearCache: () => ipcRenderer.invoke('render:clearCache'),
    getCacheStats: () => ipcRenderer.invoke('render:getCacheStats'),
  },
  
  // Audio download for rendering
  audioDownload: {
    prepare: (urlOrPath, trackKey) => 
      ipcRenderer.invoke('audio-download:prepare', urlOrPath, trackKey),
    cleanupOldFiles: () => ipcRenderer.invoke('audio-download:cleanup'),
    getStats: () => ipcRenderer.invoke('audio-download:get-stats'),
    clearCache: () => ipcRenderer.invoke('audio-download:clear-cache'),
  },

  // 应用更新：多源下载安装包 → sha256 校验 → 打开安装向导
  update: {
    downloadAndInstall: (urls, sha256) =>
      ipcRenderer.invoke('update:download-and-install', urls, sha256),
  },
  
  // 配置管理
  config: {
    getCachePath: () => ipcRenderer.invoke('config:get-cache-path'),
    setCachePath: (path) => ipcRenderer.invoke('config:set-cache-path', path),
    selectCachePath: () => ipcRenderer.invoke('config:select-cache-path'),
    resetCachePath: () => ipcRenderer.invoke('config:reset-cache-path'),
  },

  // 账号绑定的 QQ 音乐官方 Skills Key（由主进程使用系统安全存储加密）
  credentials: {
    getQQMusicSkillKey: () => ipcRenderer.invoke('credentials:get-qqmusic-skill-key'),
    setQQMusicSkillKey: (key) => ipcRenderer.invoke('credentials:set-qqmusic-skill-key', key),
    deleteQQMusicSkillKey: () => ipcRenderer.invoke('credentials:delete-qqmusic-skill-key'),
  },
  
  // QQ 音乐登录
  openQQLoginWindow: () => ipcRenderer.invoke('open-qq-login-window'),

  // QQ 音乐官方 Skills Key 领取窗口（内置 Electron 窗口，登录后自动抓取 API Key）
  openQQSkillKeyWindow: () => ipcRenderer.invoke('open-qq-skill-key-window'),

  // 桌面播放器：主窗口侧桥接（状态上报 + 接收小窗口的控制指令 + 开关/形态设置）
  desktopPlayer: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-player:set-enabled', enabled),
    setForm: (form) => ipcRenderer.invoke('desktop-player:set-form', form),
    getInitialState: () => ipcRenderer.invoke('desktop-player:get-state'),
    pushState: (partial) => ipcRenderer.send('desktop-player:state-update', partial),
    onControl: (callback) => {
      const listener = (_event, action, payload) => callback(action, payload)
      ipcRenderer.on('desktop-player:control', listener)
      return () => ipcRenderer.removeListener('desktop-player:control', listener)
    },
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-player:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-player:enabled-changed', listener)
    },
  },

  // 桌面歌词：独立透明置顶窗口的开关与外观设置。
  desktopLyrics: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-lyrics:set-enabled', enabled),
    getSettings: () => ipcRenderer.invoke('desktop-lyrics:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('desktop-lyrics:update-settings', partial),
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-lyrics:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-lyrics:enabled-changed', listener)
    },
  },

  // 遥控器：局域网 Web 服务（手机扫码连接）+ 虚拟鼠标桥接
  remote: {
    start: (port) => ipcRenderer.invoke('remote:start', port),
    stop: () => ipcRenderer.invoke('remote:stop'),
    getStatus: () => ipcRenderer.invoke('remote:get-status'),
    getSettings: () => ipcRenderer.invoke('remote:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('remote:update-settings', partial),
    onCursor: (callback) => {
      const listener = (_event, command) => callback(command)
      ipcRenderer.on('remote:cursor', listener)
      return () => ipcRenderer.removeListener('remote:cursor', listener)
    },
    onClientsChange: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('remote:clients', listener)
      return () => ipcRenderer.removeListener('remote:clients', listener)
    },
  },
})




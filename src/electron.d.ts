import type { TrackAnalysis, TransitionPlan, RenderedTransition } from './audio/types'

// Electron API 类型声明
export interface WallpaperPayload {
  path: string
  fileUrl: string
  dataUrl: string
  mimeType: string
  size: number
  mtimeMs: number
  wallpaperEngine?: WallpaperEngineSource
}

export type WallpaperEngineSourceType = 'video' | 'web' | 'image' | 'scene' | 'application' | 'unknown'

export interface WallpaperEngineSource {
  path?: string
  fileUrl?: string
  mediaUrl?: string
  sourceType: WallpaperEngineSourceType
  unsupported?: boolean // 标记为不支持的壁纸类型
  monitor?: string
  local?: boolean
  title?: string
  size?: number
  mtimeMs?: number
  configPath?: string
}

export interface FullscreenStatus {
  fullscreen: boolean
  kiosk: boolean
  maximized: boolean
}

export type WallpaperResult =
  | ({ success: true } & WallpaperPayload)
  | { success: false; error?: string }


export interface AnalysisRuntimeStatus {
  available: boolean
  provider: string
  model?: string
  version: string
  reason?: string
  cacheRoot?: string
  pythonAvailable?: boolean
}

export interface AnalysisJobHandle {
  jobId: string
  status: string
  reason?: string
  result?: TrackAnalysis
  cached?: boolean
}

export interface AnalysisAPI {
  startTrackAnalysis: (input: { trackKey: string; audioPath: string; duration?: number; sourceSignature?: string }) => Promise<AnalysisJobHandle>
  getTrackAnalysis: (trackKey: string) => Promise<TrackAnalysis | null>
  saveTrackAnalysis: (analysis: TrackAnalysis) => Promise<{ success: boolean; error?: string }>
  cancelJob: (jobId: string) => Promise<{ success: boolean }>
  getStatus: () => Promise<AnalysisRuntimeStatus>
  getCacheStats: () => Promise<{ fileCount: number; totalSize: number; cachePath: string }>
  clearCache: () => Promise<{ success: boolean; error?: string }>
  onProgress: (callback: (progress: { jobId: string; trackKey?: string; stage: string; progress: number; message?: string }) => void) => () => void
}
export interface DeviceLicenseGrant {
  feature: string
  label: string
  issuedAt: number
  expiresAt: number | null
  note?: string
}

export type DeviceIdentityResult =
  | { success: true; deviceId: string; storage: 'registry' | 'file' }
  | { success: false; error: string }

export type DeviceLicenseStateResult =
  | { success: true; deviceId: string; storage: 'registry' | 'file'; grants: DeviceLicenseGrant[] }
  | { success: false; error: string }

export type DeviceRedeemResult =
  | { success: true; message: string; storage: 'registry' | 'file'; grant: DeviceLicenseGrant; grants: DeviceLicenseGrant[] }
  | { success: false; error: string }

export interface HardwareAccelerationStatus {
  enabled: boolean
  gpuPreference: 'auto' | 'discrete' | 'integrated'
  actualEnabled: boolean
  featureStatus: Record<string, string>
  gpu: {
    active: boolean
    vendorId?: number
    deviceId?: number
    vendorString?: string
    deviceString?: string
    driverVendor?: string
    driverVersion?: string
  } | null
  gpus: Array<{
    active: boolean
    vendorId?: number
    deviceId?: number
    vendorString: string
    deviceString: string
    driverVersion?: string
    kind: 'discrete' | 'integrated' | 'unknown'
  }>
}

export interface ElectronAPI {
  analysis: AnalysisAPI
  system: {
    minimize: () => Promise<any> | void
    maximize: () => Promise<any> | void
    close: () => Promise<any> | void
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
    setFullscreen: (fullscreen: boolean, kiosk?: boolean) => Promise<any>
    isFullscreen: () => Promise<FullscreenStatus>
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void
    getLocation: () => Promise<{
      success: boolean
      latitude?: number
      longitude?: number
      accuracy?: number | null
      source?: string
      error?: string
    }>
    getHardwareAcceleration: () => Promise<HardwareAccelerationStatus>
    setHardwareAcceleration: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean; requiresRestart: boolean }>
    setGpuPreference: (preference: 'auto' | 'discrete' | 'integrated') => Promise<{ success: boolean; gpuPreference: 'auto' | 'discrete' | 'integrated'; requiresRestart: boolean }>
  }
  mediaKeys: {
    setEnabled: (enabled: boolean) => Promise<{
      success: boolean
      enabled: boolean
      registrations: Record<string, boolean>
    }>
    onControl: (callback: (action: 'toggle' | 'next' | 'prev') => void) => () => void
  }
  desktopWidgets: {
    getSystemStatus: () => Promise<{
      cpuUsage: number
      memoryUsed: number
      memoryTotal: number
      memoryPercent: number
      disks: Array<{ name: string; used: number; total: number; percent: number }>
      uptime: number
      platform: string
    }>
    pickLauncherTarget: (kind: 'app' | 'folder') => Promise<string | null>
    openLauncherTarget: (target: string, kind: 'app' | 'folder' | 'url') => Promise<{ success: boolean; error?: string }>
  }
  openQQLoginWindow: () => Promise<{ success: boolean; cookie?: string; error?: string }>
  openQQSkillKeyWindow: () => Promise<{ success: boolean; apiKey?: string; error?: string }>
  wallpaper: {
    getCurrentWallpaper: () => Promise<WallpaperResult>
    onWallpaperChange: (callback: (wallpaper: WallpaperPayload | string) => void) => () => void
  }
  developerMode: {
    set: (enabled: boolean) => Promise<{ success: boolean }>
    get: () => Promise<{ enabled: boolean }>
  }
  deviceLicense: {
    getState: () => Promise<DeviceLicenseStateResult>
    copyDeviceId: () => Promise<DeviceIdentityResult>
    readClipboard?: () => Promise<{ success: true; text: string } | { success: false; error: string }>
    redeem: (code: string) => Promise<DeviceRedeemResult>
  }
  render: {
    transition: (plan: TransitionPlan, sourceAudioPath: string, targetAudioPath: string) => Promise<{ 
      success: boolean
      outputPath?: string
      duration?: number
      sampleRate?: number
      channels?: number
      size?: number
      cached?: boolean
      stretchApplied?: boolean
      djEffectsApplied?: boolean
      targetResumeTime?: number
      rendererVersion?: string
      error?: string
    }>
    getAudioUrl?: (filePath: string) => Promise<string>

    readAudioFile: (filePath: string) => Promise<ArrayBuffer>
    clearCache: () => Promise<{ success: boolean }>
    getCacheStats: () => Promise<{ count: number; size: number }>
  }
  audioDownload: {
    prepare: (urlOrPath: string, trackKey: string) => Promise<string>
    cleanupOldFiles: () => Promise<{ success: boolean }>
    getStats: () => Promise<{ fileCount: number; totalSize: number; maxSize: number; cachePath: string }>
    clearCache: () => Promise<{ success: boolean }>
  }
  config: {
    getCachePath: () => Promise<string>
    setCachePath: (path: string) => Promise<{ success: boolean; error?: string }>
    selectCachePath: () => Promise<string | null>
    resetCachePath: () => Promise<string>
  }
  credentials: {
    getQQMusicSkillKey: () => Promise<{ success: boolean; configured: boolean; key?: string; secure?: boolean; error?: string }>
    setQQMusicSkillKey: (key: string) => Promise<{ success: boolean; configured?: boolean; secure?: boolean; error?: string }>
    deleteQQMusicSkillKey: () => Promise<{ success: boolean; configured?: boolean; error?: string }>
  }
  desktopPlayer: {
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
    setForm: (form: 'card' | 'bar') => Promise<{ success: boolean; form: 'card' | 'bar' }>
    getInitialState: () => Promise<DesktopPlayerSnapshot>
    pushState: (
      partial: Partial<
        Pick<
          DesktopPlayerSnapshot,
          'song' | 'lyric' | 'playing' | 'spectrum' | 'accentColor' | 'playlist' | 'currentIndex' | 'progress' | 'hasTranslation' | 'hasRomaji'
        >
      >
    ) => void
    onControl: (callback: (action: string, payload?: number) => void) => () => void
    onEnabledChanged: (callback: (enabled: boolean) => void) => () => void
  }
  desktopLyrics: {
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
    getSettings: () => Promise<DesktopLyricsSettings>
    updateSettings: (partial: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
    onEnabledChanged: (callback: (enabled: boolean) => void) => () => void
  }
}

export interface DesktopPlayerSongInfo {
  name: string
  artists: string
  coverUrl: string
}

export interface DesktopPlayerLyricWord {
  word: string
  startTime: number
  duration: number
}

export interface DesktopPlayerLyric {
  line: string
  translation: string
  romaji?: string
  nextLine?: string
  nextTranslation?: string
  nextRomaji?: string
  words: DesktopPlayerLyricWord[]
  romanWords?: DesktopPlayerLyricWord[]
  lineStart: number
  lineDuration: number
  isInterlude?: boolean
  interludeStartTime?: number
  interludeEndTime?: number
}

export type DesktopLyricsColorMode = 'auto' | 'rose' | 'sky' | 'gold' | 'mint' | 'white'
export type DesktopLyricsOrientation = 'horizontal' | 'vertical'

export interface DesktopLyricsSettings {
  enabled: boolean
  fontSize: number
  colorMode: DesktopLyricsColorMode
  orientation: DesktopLyricsOrientation
  doubleLine: boolean
  translationEnabled: boolean
  romajiEnabled: boolean
  traditionalEnabled: boolean
  locked: boolean
}

export interface DesktopPlayerPlaylistItem {
  index: number
  name: string
  artists: string
}

export interface DesktopPlayerSnapshot {
  song: DesktopPlayerSongInfo | null
  lyric: DesktopPlayerLyric | null
  playing: boolean
  spectrum: number[]
  enabled: boolean
  form: 'card' | 'bar'
  accentColor: string
  playlist: DesktopPlayerPlaylistItem[]
  currentIndex: number
  progress: number
  hasTranslation: boolean
  hasRomaji: boolean
}

export type DesktopPlayerControlAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'close'
  | 'select-index'

export interface DesktopPlayerBridgeAPI {
  getState: () => Promise<DesktopPlayerSnapshot>
  onState: (callback: (state: Partial<DesktopPlayerSnapshot>) => void) => () => void
  sendControl: (action: DesktopPlayerControlAction, payload?: number) => void
  startResize: (point: { x: number; y: number; edge: 'nw' | 'ne' | 'sw' | 'se' }) => void
  resizeTo: (point: { x: number; y: number }) => void
  endResize: () => void
  startDrag: (point: { x: number; y: number }) => void
  dragTo: (point: { x: number; y: number }) => void
  endDrag: () => void
  reportContentHeight: (height: number) => void
  setExpanded: (expanded: boolean) => Promise<{ direction: 'up' | 'down' }>
}

export interface DesktopLyricsBridgeAPI {
  getState: () => Promise<DesktopPlayerSnapshot>
  getSettings: () => Promise<DesktopLyricsSettings>
  onState: (callback: (state: Partial<DesktopPlayerSnapshot>) => void) => () => void
  onSettings: (callback: (settings: DesktopLyricsSettings) => void) => () => void
  updateSettings: (partial: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
  setPanelOpen: (open: boolean) => Promise<{ open: boolean }>
  setMousePassthrough: (passthrough: boolean) => Promise<{ passthrough: boolean }>
  sendControl: (action: DesktopPlayerControlAction) => void
  startResize: (point: { x: number; y: number; edge: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' }) => void
  resizeTo: (point: { x: number; y: number }) => void
  endResize: () => void
  startDrag: (point: { x: number; y: number }) => void
  dragTo: (point: { x: number; y: number }) => void
  endDrag: () => void
}

declare global {
  interface Window {
    electron?: ElectronAPI
    desktopPlayer?: DesktopPlayerBridgeAPI
    desktopLyrics?: DesktopLyricsBridgeAPI
    electronAPI?: {
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      openQQLoginWindow: () => Promise<void>
      onQQLoginResult: (callback: (cookie: string) => void) => void
    }
  }
}

export {}







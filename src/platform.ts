/**
 * 平台检测：区分桌面（Electron/Windows）、Android TV、Android 平板、纯浏览器。
 * 桌面端专属能力（桌面小组件、壁纸、遥控、GPU 设置等）按平台隐藏。
 */
export type PlatformKind = 'desktop' | 'android-tv' | 'android-tablet' | 'web'

let cachedKind: PlatformKind | null = null

export function detectPlatform(): PlatformKind {
  if (cachedKind) return cachedKind
  if (typeof navigator === 'undefined') {
    cachedKind = 'desktop'
    return cachedKind
  }
  const ua = navigator.userAgent
  const hasElectron = typeof window !== 'undefined' && Boolean((window as any).electron?.system)
  if (/Android/i.test(ua)) {
    // Android TV / Google TV / Fire TV 的 UA 通常带 TV/Leanback/AFT/GoogleTV 标记。
    // 当前移植目标是 TV 优先；平板触摸适配后续再做，届时在这里区分。
    cachedKind = /TV|Leanback|GoogleTV|AFT|Tablet/i.test(ua) ? 'android-tv' : 'android-tv'
  } else if (hasElectron) {
    cachedKind = 'desktop'
  } else {
    cachedKind = 'web'
  }
  return cachedKind
}

export const getPlatform = detectPlatform
export const isDesktop = () => detectPlatform() === 'desktop'
export const isAndroid = () => detectPlatform() === 'android-tv' || detectPlatform() === 'android-tablet'
export const isTv = () => detectPlatform() === 'android-tv'

/**
 * 在 <html> 上标记平台：CSS 通过 html.tv-mode / html[data-platform] 选择器做
 * 焦点交互适配（显示焦点环、把 hover 揭示的 UI 改为 focus 揭示等）。
 */
export function initPlatformUI(): void {
  const kind = detectPlatform()
  const root = document.documentElement
  root.dataset.platform = kind
  // 安卓端当前只面向 TV 遥控器，统一启用 tv-mode 焦点交互；
  // 平板触摸适配到位后再收敛到 android-tv 才启用。
  if (kind === 'android-tv' || kind === 'android-tablet') {
    root.classList.add('tv-mode')
  }
}

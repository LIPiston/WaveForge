/**
 * 非 Electron 环境（Android WebView / 纯浏览器）下给 window.electron 提供最小桩，
 * 保证：
 *  - TransitionRenderer 的智能过渡（smart-rendered）拿到 reject 后自动回退固定交叉淡化；
 *  - 系统窗口/GPU 查询等桌面接口为安全 no-op；
 *  - 桌面小组件/壁纸/遥控/授权等桌面专属桥保持 undefined（业务侧可选链即视为不可用）。
 */
import { isDesktop } from './platform'

export function installElectronShim(): void {
  if (isDesktop()) return
  if ((window as any).electron) return

  const unavailable = (name: string) => async () => {
    throw new Error(`[${name}] 仅桌面版可用（当前环境不支持）`)
  }

  ;(window as any).electron = {
    system: {
      isMaximized: async () => true,
      isFullscreen: async () => false,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      setFullscreen: () => {},
      getHardwareAcceleration: async () => ({
        enabled: true,
        gpuFeatureStatus: { gpu_compositing: 'enabled' },
        gpuList: [],
      }),
    },
    audioDownload: {
      prepare: unavailable('audioDownload'),
      clearCache: async () => {},
      getStats: async () => ({ count: 0, size: 0 }),
    },
    render: {
      transition: unavailable('render'),
      getAudioUrl: unavailable('render'),
      readAudioFile: unavailable('render'),
      clearCache: async () => {},
      getCacheStats: async () => ({ count: 0, size: 0 }),
    },
    mediaKeys: {
      setEnabled: () => {},
    },
    developerMode: {
      set: () => {},
    },
  }
}

/**
 * 音效引擎版本入口
 *
 * v1：远程原版音效引擎（src/services/audioEffects/，5 效果互斥 + 老式调音室 UI）——默认
 * v2：本地增强版（src/services/audio-effects-v2/，可叠加 + 场景方案 + 混响类型 + 压缩/夜间/频响补偿 + 响度归一化）
 *
 * （v3 引擎已整体移除：机型预设版听感不达标，相关代码与本地存储设置一并清除。）
 *
 * 切换记录在 localStorage，App 启动时据此实例化对应引擎；切换接口提供热切换（暂停音乐后
 * 替换音频图效果链）与冷切换（仅保存配置，下次启动生效）两条路径。
 */

export type AudioEngineVersion = 'v1' | 'v2'

const VERSION_KEY = 'waveforge:audio-engine-version'
/** v3 引擎已移除——其本地存储键一并清除，避免残留设置/版本号干扰 v1/v2 */
const V3_STORAGE_KEYS = [
  'waveforge:audio-effects-v3-settings',
  'waveforge:audio-effects-v3-scenes',
]

export function getAudioEngineVersion(): AudioEngineVersion {
  try {
    const v = localStorage.getItem(VERSION_KEY)
    if (v === 'v3') {
      // 用户本地残留 v3 版本号：清除 v3 存储并回退 v1
      localStorage.removeItem(VERSION_KEY)
      for (const k of V3_STORAGE_KEYS) localStorage.removeItem(k)
      return 'v1'
    }
    return v === 'v2' ? 'v2' : 'v1'
  } catch {
    return 'v1'
  }
}

export function setAudioEngineVersion(version: AudioEngineVersion): void {
  try {
    localStorage.setItem(VERSION_KEY, version)
  } catch {
    // 忽略存储失败
  }
}

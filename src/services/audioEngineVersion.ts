/**
 * 音效引擎版本入口
 *
 * v1：远程原版音效引擎（src/services/audioEffects/，5 效果互斥 + 老式调音室 UI）——默认
 * v2：本地增强版（src/services/audio-effects-v2/，可叠加 + 场景方案 + 混响类型 + 压缩/夜间/频响补偿 + 响度归一化）
 *
 * 切换记录在 localStorage，App 启动时据此实例化对应引擎；切换接口提供热切换（暂停音乐后
 * 替换音频图效果链）与冷切换（仅保存配置，下次启动生效）两条路径。
 */

export type AudioEngineVersion = 'v1' | 'v2'

const VERSION_KEY = 'waveforge:audio-engine-version'

export function getAudioEngineVersion(): AudioEngineVersion {
  try {
    return localStorage.getItem(VERSION_KEY) === 'v2' ? 'v2' : 'v1'
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

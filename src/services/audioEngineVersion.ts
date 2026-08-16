/**
 * 音效引擎版本入口
 *
 * v1：远程原版音效引擎（src/services/audioEffects/，5 效果互斥 + 老式调音室 UI）——默认
 * v2：本地增强版（src/services/audio-effects-v2/，可叠加 + 场景方案 + 混响类型 + 压缩/夜间/频响补偿 + 响度归一化）
 * v3：纯 TS DSP 内核引擎（src/services/waveforge-engine-v3/，14 级处理链 + worklet/script 双模式 + 11 场景 + 分享串）
 *
 * v3 与 v1/v2 完全独立：不做参数迁移、不做兼容层，切换只保证音频能正常切到 v3 处理
 * （见 src/services/waveforge-engine-v3/docs/FUSION_GUIDE.md）。
 *
 * 切换记录在 localStorage，App 启动时据此实例化对应引擎；切换接口提供热切换（暂停音乐后
 * 替换音频图效果链）与冷切换（仅保存配置，下次启动生效）两条路径。
 */

export type AudioEngineVersion = 'v1' | 'v2' | 'v3'

const VERSION_KEY = 'waveforge:audio-engine-version'
/** 已移除的旧版 v3（机型预设版）残留存储键：与新 v3（waveforge:v3-*）无关联，顺带清理 */
const LEGACY_V3_STORAGE_KEYS = [
  'waveforge:audio-effects-v3-settings',
  'waveforge:audio-effects-v3-scenes',
]

export function getAudioEngineVersion(): AudioEngineVersion {
  try {
    const v = localStorage.getItem(VERSION_KEY)
    if (v === 'v3') {
      // 合法的 v3（新引擎）；顺带清掉旧机型预设版的残留存储
      for (const k of LEGACY_V3_STORAGE_KEYS) localStorage.removeItem(k)
      return 'v3'
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

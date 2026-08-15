/**
 * 音效引擎版本入口（v3 支持版）
 *
 * v1：远程原版音效引擎（src/services/audioEffects/，5 效果互斥 + 老式调音室 UI）——默认
 * v2：本地增强版（src/services/audio-effects-v2/，可叠加 + 场景方案 + 混响类型 + 压缩/夜间/频响补偿 + 响度归一化）
 * v3：机型预设版（src/services/audio-effects-v3/，机型基础预设 + 输出设备自动适配 + 20 段 EQ +
 *     设备档案 + 设备频响库 + 频响合并 + 64 阶 IIR PEQ + 低频增强/虚拟低频 + 齿音抑制 +
 *     卷积互斥 + 智能响度 + App 独立音效 + 听力分析）
 *
 * 切换记录在 localStorage，App 启动时据此实例化对应引擎；切换接口提供热切换（暂停音乐后
 * 替换音频图效果链）与冷切换（仅保存配置，下次启动生效）两条路径。
 */

export type AudioEngineVersion = 'v1' | 'v2' | 'v3'

const VERSION_KEY = 'waveforge:audio-engine-version'

export function getAudioEngineVersion(): AudioEngineVersion {
  try {
    const v = localStorage.getItem(VERSION_KEY)
    return v === 'v2' || v === 'v3' ? v : 'v1'
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

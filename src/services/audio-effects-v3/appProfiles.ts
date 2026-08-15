/**
 * 按曲目/来源独立音效档案（源：原应用"App 独立音效"）
 *
 * 原应用 文案："为指定 App 独立调节音效参数，调节后进入前台界面时自动生效"、
 * "可添加多个第三方 App，并进行独立的 DSP 音效处理"。
 *
 * WaveForge 播放器没有"前台 App"概念，等价物是"曲目来源/播放器会话"，
 * 因此 v3 将 原应用 的 per-app 档案映射为 per-source-key 档案：
 *   - sourceKey：曲目标识（trackId / 来源 + id），播放时由播放器告知引擎
 *   - 每个档案保存独立的 20 段增益数组 + 设备档案 + PEQ 曲线串
 *   - 切换曲目时引擎自动加载对应档案（无档案则用全局设置）
 */

import type { EqPoint } from './curve'
import { EQ_BANDS_20, quantizeGain } from './constants'

export interface AppAudioProfile {
  /** 档案标识（曲目 key，如 "qq:123456" / "netease:789"） */
  sourceKey: string
  /** 显示名 */
  name: string
  /** 20 段增益（dB），null = 不覆盖 EQ */
  bandGains: number[] | null
  /** 设备档案 id（DEVICE_PROFILES），null = 不覆盖 */
  deviceProfileId: string | null
  /** PEQ 曲线串（fp 格式），null = 不覆盖 */
  peqCurve: string | null
  /** 启用的效果键集合（bass/deesser/virtualBass/convolution） */
  enabledEffects: string[]
}

const PROFILES_KEY = 'waveforge:audio-effects-v3:app-profiles'

/** 加载档案列表（localStorage 持久化，与 WaveForge 其他设置同风格） */
export function loadAppProfiles(): AppAudioProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AppAudioProfile[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveAppProfiles(profiles: AppAudioProfile[]): void {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
  } catch {
    // 忽略存储失败
  }
}

/** 按 sourceKey 查档案 */
export function findAppProfile(profiles: AppAudioProfile[], sourceKey: string): AppAudioProfile | null {
  return profiles.find(p => p.sourceKey === sourceKey) ?? null
}

/** 保存或更新档案 */
export function upsertAppProfile(profiles: AppAudioProfile[], profile: AppAudioProfile): AppAudioProfile[] {
  const idx = profiles.findIndex(p => p.sourceKey === profile.sourceKey)
  if (idx < 0) return [...profiles, profile]
  const next = [...profiles]
  next[idx] = profile
  return next
}

/** 删除档案 */
export function deleteAppProfile(profiles: AppAudioProfile[], sourceKey: string): AppAudioProfile[] {
  return profiles.filter(p => p.sourceKey !== sourceKey)
}

/** 把档案转成可直接应用的曲线点（20 段增益 → 曲线，Q=1） */
export function profileToCurve(profile: AppAudioProfile): EqPoint[] | null {
  if (!profile.bandGains) return null
  return EQ_BANDS_20.map((freq, i) => ({
    freq,
    gain: quantizeGain(profile.bandGains![i] ?? 0),
    q: 1,
  }))
}

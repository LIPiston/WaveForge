export type AudioQualityPreference =
  | 'auto'
  | 'standard'
  | 'high'
  | 'very-high'
  | 'lossless'
  | 'hi-res'

export interface AudioQualitySettings {
  netease: AudioQualityPreference
  qq: AudioQualityPreference
}

export const AUDIO_QUALITY_SETTINGS_KEY = 'audioQualitySettings'
export const AUDIO_QUALITY_SETTINGS_EVENT = 'waveforge-audio-quality-changed'

export const DEFAULT_AUDIO_QUALITY_SETTINGS: AudioQualitySettings = {
  netease: 'auto',
  qq: 'auto',
}

const QUALITY_VALUES: AudioQualityPreference[] = [
  'auto',
  'standard',
  'high',
  'very-high',
  'lossless',
  'hi-res',
]

const isQualityPreference = (value: unknown): value is AudioQualityPreference => (
  typeof value === 'string' && QUALITY_VALUES.includes(value as AudioQualityPreference)
)

export function loadAudioQualitySettings(): AudioQualitySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_QUALITY_SETTINGS_KEY) || '{}') as Partial<AudioQualitySettings>
    return {
      netease: isQualityPreference(parsed.netease) ? parsed.netease : DEFAULT_AUDIO_QUALITY_SETTINGS.netease,
      qq: isQualityPreference(parsed.qq) ? parsed.qq : DEFAULT_AUDIO_QUALITY_SETTINGS.qq,
    }
  } catch {
    return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }
  }
}

export function saveAudioQualitySettings(patch: Partial<AudioQualitySettings>): AudioQualitySettings {
  const next = {
    ...loadAudioQualitySettings(),
    ...patch,
  }
  if (!isQualityPreference(next.netease)) next.netease = DEFAULT_AUDIO_QUALITY_SETTINGS.netease
  if (!isQualityPreference(next.qq)) next.qq = DEFAULT_AUDIO_QUALITY_SETTINGS.qq

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUDIO_QUALITY_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(AUDIO_QUALITY_SETTINGS_EVENT, { detail: next }))
  }
  return next
}

export function getAudioQualityPreference(platform: 'netease' | 'qq'): AudioQualityPreference {
  return loadAudioQualitySettings()[platform]
}

export function getPlatformVipState(platform: 'netease' | 'qq'): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
}

/**
 * 返回会传给本地 API 的设置快照。服务端仍会按实际接口返回结果逐级降级，
 * 这里的 VIP 状态只用于选择合理的候选顺序，避免反复请求明显不可用的音质。
 */
export function getAudioQualityRequest(platform: 'netease' | 'qq'): {
  preference: AudioQualityPreference
  isVip: boolean
} {
  return {
    preference: getAudioQualityPreference(platform),
    isVip: getPlatformVipState(platform),
  }
}

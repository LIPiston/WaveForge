import type { MusicPlatform } from './platforms'
import type { EntitlementTier } from '../utils/musicEntitlements'

export type AudioQualityPreference =
  | 'auto'
  | 'standard'
  | 'high'
  | 'very-high'
  | 'lossless'
  | 'hi-res'

export type AppleAudioQualityPreference =
  | 'auto'
  | 'aac'
  | 'lossless'
  | 'hi-res-lossless'
  | 'atmos'

export interface AudioQualitySettings {
  netease: AudioQualityPreference
  qq: AudioQualityPreference
  spotify: AudioQualityPreference
  kugou: AudioQualityPreference
  soda: AudioQualityPreference
  apple: AppleAudioQualityPreference
}

export const AUDIO_QUALITY_SETTINGS_KEY = 'audioQualitySettings'
export const AUDIO_QUALITY_SETTINGS_EVENT = 'waveforge-audio-quality-changed'

export const DEFAULT_AUDIO_QUALITY_SETTINGS: AudioQualitySettings = {
  netease: 'auto',
  qq: 'auto',
  spotify: 'auto',
  kugou: 'auto',
  soda: 'auto',
  apple: 'auto',
}

const QUALITY_VALUES: AudioQualityPreference[] = [
  'auto',
  'standard',
  'high',
  'very-high',
  'lossless',
  'hi-res',
]

const APPLE_QUALITY_VALUES: AppleAudioQualityPreference[] = [
  'auto',
  'aac',
  'lossless',
  'hi-res-lossless',
  'atmos',
]

const isQualityPreference = (value: unknown): value is AudioQualityPreference => (
  typeof value === 'string' && QUALITY_VALUES.includes(value as AudioQualityPreference)
)

const isAppleQualityPreference = (value: unknown): value is AppleAudioQualityPreference => (
  typeof value === 'string' && APPLE_QUALITY_VALUES.includes(value as AppleAudioQualityPreference)
)

export function loadAudioQualitySettings(): AudioQualitySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_QUALITY_SETTINGS_KEY) || '{}') as Partial<AudioQualitySettings>
    return {
      netease: isQualityPreference(parsed.netease) ? parsed.netease : DEFAULT_AUDIO_QUALITY_SETTINGS.netease,
      qq: isQualityPreference(parsed.qq) ? parsed.qq : DEFAULT_AUDIO_QUALITY_SETTINGS.qq,
      spotify: isQualityPreference(parsed.spotify) ? parsed.spotify : DEFAULT_AUDIO_QUALITY_SETTINGS.spotify,
      kugou: isQualityPreference(parsed.kugou) ? parsed.kugou : DEFAULT_AUDIO_QUALITY_SETTINGS.kugou,
      soda: isQualityPreference(parsed.soda) ? parsed.soda : DEFAULT_AUDIO_QUALITY_SETTINGS.soda,
      apple: isAppleQualityPreference(parsed.apple) ? parsed.apple : DEFAULT_AUDIO_QUALITY_SETTINGS.apple,
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
  if (!isQualityPreference(next.spotify)) next.spotify = DEFAULT_AUDIO_QUALITY_SETTINGS.spotify
  if (!isQualityPreference(next.kugou)) next.kugou = DEFAULT_AUDIO_QUALITY_SETTINGS.kugou
  if (!isQualityPreference(next.soda)) next.soda = DEFAULT_AUDIO_QUALITY_SETTINGS.soda
  if (!isAppleQualityPreference(next.apple)) next.apple = DEFAULT_AUDIO_QUALITY_SETTINGS.apple

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUDIO_QUALITY_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(AUDIO_QUALITY_SETTINGS_EVENT, { detail: next }))
  }
  return next
}

export function getAudioQualityPreference(platform: MusicPlatform): AudioQualityPreference | AppleAudioQualityPreference {
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.apple
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}

export function getPlatformVipState(platform: MusicPlatform): boolean {
  if (typeof localStorage === 'undefined') return false
  if (platform === 'apple' || platform === 'spotify' || platform === 'soda') return false
  if (platform === 'kugou') return localStorage.getItem('kugou_vip') === 'true'
  return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
}

export function getAudioQualityRequest(platform: MusicPlatform): {
  preference: AudioQualityPreference | AppleAudioQualityPreference
  isVip: boolean
} {
  return {
    preference: getAudioQualityPreference(platform),
    isVip: getPlatformVipState(platform),
  }
}

// ── 音质档位选项表（设置弹窗与播放条快捷切换共用同一份事实源）──
// shortLabel 供播放条小按钮/弹层使用（短名，如 杜比全景声 →「杜比」）；
// label/description 供设置弹窗使用。

export type QualityOptionValue = AudioQualityPreference | AppleAudioQualityPreference

export interface QualityOption {
  value: QualityOptionValue
  label: string
  shortLabel: string
  description: string
  requiresVip?: boolean
  disabled?: boolean
}

const NETEASE_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', shortLabel: '标准', description: '兼容性最好，流量占用较低' },
  { value: 'high', label: '高品质', shortLabel: '高品质', description: '网易云 exhigh，通常约 320 kbps' },
  { value: 'lossless', label: '无损音质', shortLabel: '无损', description: '优先请求 FLAC 无损音质', requiresVip: true },
  { value: 'hi-res', label: 'Hi-Res', shortLabel: 'Hi-Res', description: '优先请求网易云 Hi-Res 音质', requiresVip: true },
]

const QQ_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', shortLabel: '标准', description: '优先使用 128 kbps MP3 / AAC 备用音源' },
  { value: 'high', label: '高品质', shortLabel: '高品质', description: '优先使用 320 kbps MP3' },
  { value: 'lossless', label: '无损音质', shortLabel: '无损', description: '优先使用 FLAC 无损音质', requiresVip: true },
]

/** 新平台音质选项（自身直源受限时走网易云/QQ 载体音质） */
const GENERIC_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', shortLabel: '标准', description: '优先使用标准码率音源' },
  { value: 'high', label: '高品质', shortLabel: '高品质', description: '优先使用高码率音源' },
  { value: 'lossless', label: '无损音质', shortLabel: '无损', description: '优先请求无损音质', requiresVip: true },
]

const APPLE_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动', shortLabel: '自动', description: '优先使用当前设备和账号实际可播放的最佳 Apple Music 音频' },
  { value: 'aac', label: '高品质 AAC', shortLabel: 'AAC', description: '使用 Apple 网页播放当前稳定支持的 AAC HLS 音频' },
  { value: 'lossless', label: '无损音频', shortLabel: '无损', description: '当前网页 Widevine 播放链路尚未检测到可用的 Apple Lossless 资产', disabled: true },
  { value: 'hi-res-lossless', label: '高解析度无损', shortLabel: '高解析无损', description: '需要 Apple 提供兼容资产和当前设备具备对应解码能力', disabled: true },
  { value: 'atmos', label: '杜比全景声与空间音频', shortLabel: '杜比', description: '曲目标签不等于可播放流；检测到兼容 Atmos 资产后才会开放', disabled: true },
]

/**
 * 汽水音质选项（按会员档位禁用不可用档）：
 * - 后端 /api/soda/song/url 的选档枚举为 standard|high|lossless|hires（free<vip<svip 闸门内就近落档）；
 * - 偏好值仍存 AudioQualityPreference（'hi-res'），下发时经 mapSodaQualityParam 映射为 'hires'；
 * - 会员状态读 localStorage['soda_entitlement']（App 登录流程落盘的 EntitlementTier）：
 *   free → 无损/Hi-Res 禁用（明确不可用）；vip/svip → 全开放；unknown（未登录/档位未知）→
 *   不禁用（未知 ≠ 不可用，后端会自动落低档），仅以皇冠标注会员档。
 */
const buildSodaOptions = (isVip: boolean, tierKnown: boolean): QualityOption[] => [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按账号会员档位和歌曲可用性就近选档，无需手动切换' },
  { value: 'standard', label: '标准音质', shortLabel: '标准', description: '优先使用标准码率音源，流量占用较低' },
  { value: 'high', label: '高品质', shortLabel: '高品质', description: '优先使用高码率音源（约 320 kbps 档）' },
  { value: 'lossless', label: '无损音质', shortLabel: '无损', description: '优先请求无损音质；非会员自动落低档', requiresVip: true, disabled: tierKnown && !isVip },
  { value: 'hi-res', label: 'Hi-Res', shortLabel: 'Hi-Res', description: '优先请求 Hi-Res 音质；非会员自动落低档', requiresVip: true, disabled: tierKnown && !isVip },
]

/** 读取汽水会员档位（App 登录流程落盘） */
export function getSodaEntitlementTier(): EntitlementTier {
  if (typeof localStorage === 'undefined') return 'unknown'
  return (localStorage.getItem('soda_entitlement') as EntitlementTier | null) || 'unknown'
}

/** 按平台取音质档位选项（设置弹窗 / 播放条快捷切换共用） */
export function getQualityOptions(platform: MusicPlatform): QualityOption[] {
  if (platform === 'apple') return APPLE_OPTIONS
  if (platform === 'qq') return QQ_OPTIONS
  if (platform === 'netease') return NETEASE_OPTIONS
  if (platform === 'soda') {
    const tier = getSodaEntitlementTier()
    return buildSodaOptions(tier === 'vip' || tier === 'svip', tier !== 'unknown')
  }
  return GENERIC_OPTIONS
}

/** 当前偏好在某平台下的短标签（播放条按钮显示用；未知档按自动处理） */
export function getQualityShortLabel(platform: MusicPlatform, preference: QualityOptionValue): string {
  const options = getQualityOptions(platform)
  return options.find(option => option.value === preference)?.shortLabel ?? options[0].shortLabel
}

/** 读取某平台当前偏好值（音质快捷按钮显示用；键映射与 getAudioQualityPreference 相同） */
export function getPlatformQualityPreference(platform: MusicPlatform): QualityOptionValue {
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.apple
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}

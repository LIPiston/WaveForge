/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  DEFAULT_AUDIO_QUALITY_SETTINGS,
  getAudioQualityPreference,
  getPlatformVipState,
  getQualityOptions,
  isVipOnlyResolvedQuality,
  loadAudioQualitySettings,
  resolvedQualityDisplayName,
  resolvedQualityShortLabel,
  saveAudioQualitySettings,
} from '../src/services/audioQualitySettings'
import { getLastResolvedQuality, getSongUrl } from '../src/services/musicApi'

describe('audioQualitySettings Apple preference', () => {
  beforeEach(() => localStorage.clear())

  it('gives Apple an independent auto preference', () => {
    expect(loadAudioQualitySettings()).toEqual(DEFAULT_AUDIO_QUALITY_SETTINGS)
    expect(getAudioQualityPreference('apple')).toBe('auto')
  })

  it('does not borrow the Netease preference for Apple', () => {
    saveAudioQualitySettings({ netease: 'hi-res', apple: 'aac' })
    expect(getAudioQualityPreference('netease')).toBe('hi-res')
    expect(getAudioQualityPreference('apple')).toBe('aac')
  })

  it('rejects unsupported persisted Apple values', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ apple: 'fake-atmos', qq: 'high' }))
    const settings = loadAudioQualitySettings()
    expect(settings.apple).toBe('auto')
    expect(settings.qq).toBe('high')
  })

  it('emits the complete updated settings snapshot', () => {
    const listener = vi.fn()
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
    const settings = saveAudioQualitySettings({ apple: 'aac' })
    expect(settings.apple).toBe('aac')
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(settings)
    window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
  })
})

describe('audioQualitySettings QQ AAC tiers', () => {
  beforeEach(() => localStorage.clear())

  it('persists QQ-only AAC tiers for qq', () => {
    const settings = saveAudioQualitySettings({ qq: '192aac' })
    expect(settings.qq).toBe('192aac')
    expect(loadAudioQualitySettings().qq).toBe('192aac')
    expect(getAudioQualityPreference('qq')).toBe('192aac')
  })

  it('resets AAC tiers written to non-QQ platforms', () => {
    const settings = saveAudioQualitySettings({ netease: '96aac', kugou: '48aac', soda: '192aac' } as never)
    expect(settings.netease).toBe('auto')
    expect(settings.kugou).toBe('auto')
    expect(settings.soda).toBe('auto')
  })

  it('sanitizes persisted AAC tiers on non-QQ platforms on load', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ qq: '48aac', netease: '192aac', spotify: '96aac' }))
    const settings = loadAudioQualitySettings()
    expect(settings.qq).toBe('48aac')
    expect(settings.netease).toBe('auto')
    expect(settings.spotify).toBe('auto')
  })

  it('exposes the AAC tiers in QQ options only', () => {
    const qqValues = getQualityOptions('qq').map(option => option.value)
    expect(qqValues).toContain('192aac')
    expect(qqValues).toContain('96aac')
    expect(qqValues).toContain('48aac')
    const neteaseValues = getQualityOptions('netease').map(option => option.value)
    expect(neteaseValues).not.toContain('192aac')
    expect(neteaseValues).not.toContain('96aac')
    expect(neteaseValues).not.toContain('48aac')
  })
})

describe('resolved quality display names', () => {
  it('maps QQ raw quality values to official tier names (本曲列表补挂漏档用)', () => {
    expect(resolvedQualityDisplayName('qq', 'flac')).toBe('SQ 无损（1024k）')
    expect(resolvedQualityDisplayName('qq', 'ape')).toBe('SQ 无损（1024k）')
    expect(resolvedQualityDisplayName('qq', '320')).toBe('HQ 高品（320k）')
    expect(resolvedQualityDisplayName('qq', '192aac')).toBe('HQ 高品（192k）')
    expect(resolvedQualityDisplayName('qq', '128')).toBe('标准（128k）')
    expect(resolvedQualityDisplayName('qq', '96aac')).toBe('流畅（96k）')
    expect(resolvedQualityDisplayName('qq', '48aac')).toBe('省流（48k）')
  })

  it('maps resolved tiers to player-bar short labels (自动括号/徽标短名)', () => {
    expect(resolvedQualityShortLabel('qq', 'flac')).toBe('SQ')
    expect(resolvedQualityShortLabel('qq', '320')).toBe('HQ')
    expect(resolvedQualityShortLabel('qq', '192aac')).toBe('HQ')
    expect(resolvedQualityShortLabel('qq', '128')).toBe('标准')
    expect(resolvedQualityShortLabel('qq', '96aac')).toBe('流畅')
    expect(resolvedQualityShortLabel('qq', 'm4a')).toBe('流畅')
    expect(resolvedQualityShortLabel('qq', '48aac')).toBe('省流')
    expect(resolvedQualityShortLabel('qq', 'whatever-unknown')).toBe('自动')
    expect(resolvedQualityShortLabel('netease', 'hires')).toBe('Hi-Res')
    expect(resolvedQualityShortLabel('netease', 'lossless')).toBe('无损')
    expect(resolvedQualityShortLabel('netease', 'jymaster')).toBe('母带')
  })

  it('flags vip-only resolved tiers (自动行金字判定)', () => {
    expect(isVipOnlyResolvedQuality('qq', 'flac')).toBe(true)
    expect(isVipOnlyResolvedQuality('qq', '192aac')).toBe(true)
    expect(isVipOnlyResolvedQuality('qq', '320')).toBe(false)
    expect(isVipOnlyResolvedQuality('qq', '128')).toBe(false)
    expect(isVipOnlyResolvedQuality('netease', 'lossless')).toBe(true)
    expect(isVipOnlyResolvedQuality('netease', 'jymaster')).toBe(true)
    expect(isVipOnlyResolvedQuality('netease', 'exhigh')).toBe(false)
  })
})

describe('per-song resolved quality record', () => {
  it('keys the resolved quality by song id (换歌后不残留上一首的档位)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'https://dl.stream.qqmusic.qq.com/M800per-song-test.mp3', actualQuality: '320' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const url = await getSongUrl('per-song-a', 'qq')
      expect(url).toBe('https://dl.stream.qqmusic.qq.com/M800per-song-test.mp3')
      expect(getLastResolvedQuality('qq', 'per-song-a')).toBe('320')
      // 本曲没有的档位不再从其它歌曲泄漏（此前按平台记录：上一首的 SQ 会残留给只有 HQ 的新歌）
      expect(getLastResolvedQuality('qq', 'per-song-b')).toBeNull()
      expect(getLastResolvedQuality('netease', 'per-song-a')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('platform vip state detection', () => {
  beforeEach(() => localStorage.clear())

  it('reads qq/netease vip flags maintained by the login flow', () => {
    localStorage.setItem('qq_vip', 'true')
    localStorage.setItem('netease_vip', 'false')
    expect(getPlatformVipState('qq')).toBe(true)
    expect(getPlatformVipState('netease')).toBe(false)
    expect(getPlatformVipState('apple')).toBe(false)
    expect(getPlatformVipState('spotify')).toBe(false)
  })

  it('derives soda vip from the entitlement tier', () => {
    localStorage.setItem('soda_entitlement', 'svip')
    expect(getPlatformVipState('soda')).toBe(true)
    localStorage.setItem('soda_entitlement', 'free')
    expect(getPlatformVipState('soda')).toBe(false)
    localStorage.setItem('soda_entitlement', 'unknown')
    expect(getPlatformVipState('soda')).toBe(false)
  })
})

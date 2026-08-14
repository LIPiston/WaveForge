import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Settings as SettingsIcon, User, Palette, Sparkles, Info, ExternalLink, Github, ChevronRight, Trash2, ChevronLeft, Heart, Copy, ClipboardPaste, KeyRound, Code2, Users, BadgeCheck, CheckCircle2, Gift, Headphones, MonitorSmartphone } from 'lucide-react'
import LoginButton from './LoginButton'
import HomeCustomizeModal from './HomeCustomizeModal'
import AudioQualitySettingsModal from './AudioQualitySettingsModal'
import RemoteControlSettingsModal from './RemoteControlSettingsModal'
import CacheClearModal from './CacheClearModal'
import packageInfo from '../../package.json'
import sponsorData from '../data/afdianSponsors.generated.json'
import {
  loadPlaybackShortcutSettings,
  savePlaybackShortcutSettings,
  type PlaybackShortcutSettings,
} from '../services/playbackShortcutSettings'
import type { DesktopLyricsColorMode, DesktopLyricsSettings } from '../electron'
import { parseStoredBoolean } from '../utils/storage'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  loadAudioQualitySettings,
  type AudioQualityPreference,
} from '../services/audioQualitySettings'

type UpdateCheckState = { status: 'idle' | 'checking' | 'current' | 'available' | 'error'; message?: string; url?: string }
type DeviceGrant = { feature: string; label: string; issuedAt: number; expiresAt: number | null; note?: string }
type DeviceState = { status: 'idle' | 'loading' | 'ready' | 'error'; deviceId: string; storage?: 'registry' | 'file'; grants: DeviceGrant[]; message?: string }

const audioQualityLabel = (quality: AudioQualityPreference) => ({
  auto: '自动最高',
  standard: '标准',
  high: '高品质',
  'very-high': '超高品质',
  lossless: '无损',
  'hi-res': 'Hi-Res',
}[quality])

const appLogoUrl = new URL('../../logo.png', import.meta.url).href
const afdianLogoUrl = new URL('../assets/afdian-logo.png', import.meta.url).href
type SponsorEntry = { id: string; name: string; avatar?: string; tier: string; tierName?: string; firstSponsoredAt?: number }
const sponsorSupporters = sponsorData.supporters as SponsorEntry[]

const compareVersions = (left: string, right: string) => {
  const parse = (value: string) => value.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

interface SettingsPanelProps {
  show: boolean
  onClose: () => void
  // 登录状态
  neteaseLoggedIn: boolean
  neteaseUsername: string
  onNeteaseLogin: (cookie: string) => void
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  neteaseVip: boolean
  qqVip: boolean
  onQQLogin: (cookie: string) => void
  onQQLogout: () => void
  playerTheme?: 'light' | 'dark'
}

export default function SettingsPanel({
  show,
  onClose,
  neteaseLoggedIn,
  neteaseUsername,
  onNeteaseLogin,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  neteaseVip,
  qqVip,
  onQQLogin,
  onQQLogout,
  playerTheme = 'dark',
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'account' | 'advanced' | 'personalization' | 'about'>('account')
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const switchTab = (tab: 'account' | 'advanced' | 'personalization' | 'about') => {
    setActiveTab(tab)
    requestAnimationFrame(() => contentScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }))
  }
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'
  
  const [wordByWordLyrics, setWordByWordLyrics] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return parseStoredBoolean(saved, true)
  })
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showUpNextOutsidePlayer, setShowUpNextOutsidePlayer] = useState(() => {
    const saved = localStorage.getItem('showUpNextOutsidePlayer')
    return parseStoredBoolean(saved, false)
  })
  
  const [upNextSeconds, setUpNextSeconds] = useState(() => {
    const saved = localStorage.getItem('upNextSeconds')
    return saved !== null ? parseInt(saved) : 10
  })
  
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6' // 默认蓝色
  })
  // 远程遥控器设置（二级菜单弹窗）
  const [showRemoteSettings, setShowRemoteSettings] = useState(false)
  const [playbackShortcutSettings, setPlaybackShortcutSettings] = useState(loadPlaybackShortcutSettings)
  
  // 第三方歌词源设置
  const [thirdPartyLyricsEnabled, setThirdPartyLyricsEnabled] = useState(() => {
    const saved = localStorage.getItem('thirdPartyLyricsEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const [adaptiveLyrics, setAdaptiveLyrics] = useState(() => {
    const saved = localStorage.getItem('adaptiveLyrics')
    return parseStoredBoolean(saved, true)
  })
  
  const [primaryLyricsSource, setPrimaryLyricsSource] = useState<string>(() => {
    const saved = localStorage.getItem('primaryLyricsSource')
    return saved || 'AMLL'
  })

  const [crossPlatformFallbackEnabled, setCrossPlatformFallbackEnabled] = useState(() => {
    const saved = localStorage.getItem('crossPlatformFallbackEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [hideHomeAccountId, setHideHomeAccountId] = useState(() => (
    parseStoredBoolean(localStorage.getItem('hideHomeAccountId'), false)
  ))

  const handleHideHomeAccountIdChange = () => {
    const nextValue = !hideHomeAccountId
    setHideHomeAccountId(nextValue)
    localStorage.setItem('hideHomeAccountId', String(nextValue))
    window.dispatchEvent(new CustomEvent('privacy-settings-changed', {
      detail: { hideHomeAccountId: nextValue },
    }))
  }
  
  // 首页自定义弹窗状态
  const [showHomeCustomize, setShowHomeCustomize] = useState(false)
  const [showAudioQuality, setShowAudioQuality] = useState(false)
  const [audioQualitySettings, setAudioQualitySettings] = useState(loadAudioQualitySettings)

  useEffect(() => {
    const handleAudioQualityChange = () => setAudioQualitySettings(loadAudioQualitySettings())
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
    return () => window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
  }, [])

  // 桌面播放器（独立置顶小窗口）设置
  const [desktopPlayerEnabled, setDesktopPlayerEnabled] = useState(false)
  const [desktopPlayerForm, setDesktopPlayerForm] = useState<'card' | 'bar'>('card')
  const [desktopLyricsSettings, setDesktopLyricsSettings] = useState<DesktopLyricsSettings>({
    enabled: false,
    fontSize: 58,
    colorMode: 'auto',
    orientation: 'horizontal',
    doubleLine: false,
    translationEnabled: false,
    romajiEnabled: false,
    traditionalEnabled: false,
    locked: false,
  })

  useEffect(() => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.getInitialState === 'function'
    if (!hasBridge) return
    ;(window as any).electron.desktopPlayer
      .getInitialState()
      .then((snapshot: any) => {
        setDesktopPlayerEnabled(Boolean(snapshot?.enabled))
        setDesktopPlayerForm(snapshot?.form === 'bar' ? 'bar' : 'card')
      })
      .catch(() => undefined)
  }, [])

  // 小窗口点 X 关闭后同步开关状态
  useEffect(() => {
    const syncEnabled = (event: Event) => {
      setDesktopPlayerEnabled(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener('desktopPlayerEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopPlayerEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopPlayerToggle = async (enabled: boolean) => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setEnabled === 'function'
    setDesktopPlayerEnabled(enabled)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setEnabled(enabled)
      setDesktopPlayerEnabled(Boolean(result?.enabled ?? enabled))
    } catch {
      setDesktopPlayerEnabled(false)
    }
  }

  const handleDesktopPlayerFormChange = async (form: 'card' | 'bar') => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setForm === 'function'
    setDesktopPlayerForm(form)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setForm(form)
      setDesktopPlayerForm(result?.form === 'bar' ? 'bar' : 'card')
    } catch {
      // 保留当前选择
    }
  }

  useEffect(() => {
    const api = window.electron?.desktopLyrics
    if (!api) return
    void api.getSettings().then(setDesktopLyricsSettings).catch(() => undefined)
    const syncEnabled = (event: Event) => {
      setDesktopLyricsSettings(previous => ({
        ...previous,
        enabled: Boolean((event as CustomEvent<boolean>).detail),
      }))
    }
    window.addEventListener('desktopLyricsEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopLyricsEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopLyricsToggle = async (enabled: boolean) => {
    setDesktopLyricsSettings(previous => ({ ...previous, enabled }))
    try {
      const result = await window.electron?.desktopLyrics?.setEnabled(enabled)
      if (result) setDesktopLyricsSettings(previous => ({ ...previous, enabled: result.enabled }))
    } catch {
      setDesktopLyricsSettings(previous => ({ ...previous, enabled: false }))
    }
  }

  const updateDesktopLyrics = async (partial: Partial<DesktopLyricsSettings>) => {
    setDesktopLyricsSettings(previous => ({ ...previous, ...partial }))
    try {
      const result = await window.electron?.desktopLyrics?.updateSettings(partial)
      if (result) setDesktopLyricsSettings(result)
    } catch {
      // Electron 桥接不可用时保留界面预览值。
    }
  }
  
  // 缓存清理弹窗状态
  const [showCacheClear, setShowCacheClear] = useState(false)
  
  // 法律声明弹窗状态
  const [showLegalModal, setShowLegalModal] = useState(false)
  const [showDeviceIdModal, setShowDeviceIdModal] = useState(false)
  const [showRedeemModal, setShowRedeemModal] = useState(false)
  const [deviceIdForModal, setDeviceIdForModal] = useState('')
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({ status: 'idle' })
  const [deviceState, setDeviceState] = useState<DeviceState>({ status: 'idle', deviceId: '', grants: [] })
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemMessage, setRedeemMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const loadDeviceState = async () => {
    const api = window.electron?.deviceLicense
    if (!api) {
      setDeviceState({ status: 'error', deviceId: '', grants: [], message: '当前环境不支持设备授权功能' })
      return
    }
    setDeviceState(previous => ({ ...previous, status: 'loading', message: undefined }))
    try {
      const result = await api.getState()
      if (result.success) {
        setDeviceState({ status: 'ready', deviceId: result.deviceId, storage: result.storage, grants: result.grants })
      } else {
        setDeviceState({ status: 'error', deviceId: '', grants: [], message: result.error })
      }
    } catch (error) {
      setDeviceState({ status: 'error', deviceId: '', grants: [], message: error instanceof Error ? error.message : '设备识别码读取失败' })
    }
  }

  useEffect(() => {
    if (show && activeTab === 'about' && deviceState.status === 'idle') void loadDeviceState()
  }, [show, activeTab, deviceState.status])

  const copyDeviceId = async () => {
    setDeviceState(previous => ({ ...previous, status: 'loading', message: undefined }))
    try {
      const result = await window.electron?.deviceLicense?.copyDeviceId()
      if (!result) {
        throw new Error('Device license bridge is unavailable')
      }
      if (!result.success) {
        throw new Error(result.error)
      }

      setDeviceState(previous => ({
        ...previous,
        status: 'ready',
        deviceId: result.deviceId,
        storage: result.storage,
      }))
      setDeviceIdForModal(result.deviceId)
      setShowDeviceIdModal(true)
      setRedeemMessage(null)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: {
          message: '设备识别码已自动复制到剪贴板',
          type: 'success',
        },
      }))
    } catch (error) {
      console.error('获取设备识别码失败:', error)
      setDeviceState(previous => ({ ...previous, status: 'error', message: '设备识别码获取失败' }))
      setRedeemMessage(null)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: {
          message: '设备识别码获取失败，请重启 WaveForge 后重试',
          type: 'error',
        },
      }))
    }
  }

  const pasteRedeemCode = async () => {
    setRedeemMessage(null)
    let clipboardText = ''

    try {
      const readClipboard = window.electron?.deviceLicense?.readClipboard
      if (readClipboard) {
        try {
          const result = await readClipboard()
          if (result.success) clipboardText = result.text
        } catch (error) {
          console.warn('通过 Electron 读取剪贴板失败，尝试浏览器接口:', error)
        }
      }

      if (!clipboardText && navigator.clipboard?.readText) {
        clipboardText = await navigator.clipboard.readText()
      }

      const code = clipboardText.trim()
      if (!code) {
        setRedeemMessage({ type: 'error', text: '剪贴板中没有可粘贴的内容' })
        return
      }

      setRedeemCode(code)
      setRedeemMessage(null)
    } catch (error) {
      console.error('读取剪贴板失败:', error)
      setRedeemMessage({ type: 'error', text: '无法读取剪贴板，请手动粘贴' })
    }
  }

  const redeemDeviceCode = async () => {
    if (!redeemCode.trim()) {
      setRedeemMessage({ type: 'error', text: '请输入兑换码' })
      return
    }
    setRedeemMessage({ type: 'info', text: '正在验证兑换码…' })
    try {
      const result = await window.electron?.deviceLicense?.redeem(redeemCode.trim())
      if (!result) {
        setRedeemMessage({ type: 'error', text: '暂时无法提交兑换码' })
      } else if (result.success) {
        setDeviceState(previous => ({ ...previous, status: 'ready', grants: result.grants }))
        setRedeemCode('')
        setRedeemMessage(null)
        setShowRedeemModal(false)
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: {
            message: result.message || '兑换码验证成功',
            type: 'success',
          },
        }))
      } else {
        setRedeemMessage({ type: 'error', text: result.error })
      }
    } catch (error) {
      console.error('兑换码验证失败:', error)
      setRedeemMessage({ type: 'error', text: '兑换码验证失败，请重试' })
    }
  }

  const checkForUpdates = async () => {
    setUpdateCheck({ status: 'checking', message: '正在检查…' })
    try {
      const releaseResponse = await fetch('https://api.github.com/repos/YoshinoRinn/WaveForge/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      })
      let remoteVersion = ''
      let releaseUrl = 'https://github.com/YoshinoRinn/WaveForge/releases'
      if (releaseResponse.ok) {
        const release = await releaseResponse.json()
        remoteVersion = String(release.tag_name || '')
        releaseUrl = String(release.html_url || releaseUrl)
      } else if (releaseResponse.status === 404) {
        const tagsResponse = await fetch('https://api.github.com/repos/YoshinoRinn/WaveForge/tags?per_page=1', {
          headers: { Accept: 'application/vnd.github+json' },
          cache: 'no-store',
        })
        if (tagsResponse.ok) {
          const tags = await tagsResponse.json()
          remoteVersion = String(tags?.[0]?.name || '')
        } else throw new Error(`GitHub 返回 ${tagsResponse.status}`)
      } else {
        throw new Error(`GitHub 返回 ${releaseResponse.status}`)
      }

      if (!remoteVersion) throw new Error('仓库没有可比较的版本标签')
      if (compareVersions(remoteVersion, packageInfo.version) <= 0) {
        setUpdateCheck({ status: 'current', message: '当前已是最新版本' })
      } else {
        setUpdateCheck({ status: 'available', message: `发现新版本 ${remoteVersion}`, url: releaseUrl })
      }
    } catch (error) {
      setUpdateCheck({ status: 'error', message: `检查失败：${error instanceof Error ? error.message : '网络不可用'}` })
    }
  }
  
  const [gpuAcceleration, setGpuAcceleration] = useState(() => {
    const saved = localStorage.getItem('gpuAcceleration')
    return parseStoredBoolean(saved, true)
  })
  const [gpuStatus, setGpuStatus] = useState<{
    actualEnabled: boolean
    featureStatus: Record<string, string>
    gpu: { deviceString?: string; vendorString?: string; driverVersion?: string } | null
    gpus: Array<{ deviceString: string; vendorString: string; active: boolean; kind: 'discrete' | 'integrated' | 'unknown' }>
  } | null>(null)
  const [gpuPreference, setGpuPreference] = useState<'auto' | 'discrete' | 'integrated'>('auto')

  useEffect(() => {
    let cancelled = false
    void window.electron?.system.getHardwareAcceleration().then(result => {
      if (cancelled) return
      setGpuAcceleration(result.enabled)
      setGpuPreference(result.gpuPreference || 'discrete')
      setGpuStatus({
        actualEnabled: result.actualEnabled,
        featureStatus: result.featureStatus,
        gpu: result.gpu,
        gpus: result.gpus || [],
      })
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
    }).catch(error => console.warn('读取硬件加速设置失败:', error))
    return () => { cancelled = true }
  }, [])

  const [audioAnalyzerEnabled, setAudioAnalyzerEnabled] = useState(() => {
    const saved = localStorage.getItem('audioAnalyzerEnabled')
    return parseStoredBoolean(saved, true)
  })

  // 开发者模式
  const [developerMode, setDeveloperMode] = useState(() => {
    const saved = localStorage.getItem('developerMode')
    return parseStoredBoolean(saved, false)
  })

  // 全屏模式设置
  const [fullscreenMode, setFullscreenMode] = useState<'kiosk' | 'normal'>(() => {
    const saved = localStorage.getItem('fullscreenMode')
    return (saved as 'kiosk' | 'normal') || 'kiosk'
  })

  // 视频播放完毕行为设置
  const [videoEndBehavior, setVideoEndBehavior] = useState<'next' | 'close' | 'replay'>(() => {
    const saved = localStorage.getItem('videoEndBehavior')
    return (saved as 'next' | 'close' | 'replay') || 'close'
  })

  // 监听开发者模式变化，实现跨组件同步
  useEffect(() => {
    const handleDeveloperModeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      const enabled = customEvent.detail
      setDeveloperMode(enabled)
    }

    window.addEventListener('developerModeChanged', handleDeveloperModeChange)
    return () => {
      window.removeEventListener('developerModeChanged', handleDeveloperModeChange)
    }
  }, [])
  
  // 预设主题色
  const presetColors = [
    { name: '天空蓝', value: '#3B82F6' },
    { name: '翡翠绿', value: '#10B981' },
    { name: '紫罗兰', value: '#8B5CF6' },
    { name: '玫瑰红', value: '#EC4899' },
    { name: '橙黄色', value: '#F59E0B' },
    { name: '珊瑚红', value: '#EF4444' },
    { name: '青色', value: '#06B6D4' },
    { name: '石板灰', value: '#64748B' },
  ]

  // 保存逐字歌词设置
  const handleWordByWordToggle = (enabled: boolean) => {
    setWordByWordLyrics(enabled)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(enabled))
    // 触发自定义事件，通知其他组件
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  // 保存即将播放提示设置
  const handleUpNextToggle = (enabled: boolean) => {
    setUpNextEnabled(enabled)
    localStorage.setItem('upNextEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('upNextEnabledChanged'))
  }

  const handleShowUpNextOutsidePlayerToggle = (enabled: boolean) => {
    setShowUpNextOutsidePlayer(enabled)
    localStorage.setItem('showUpNextOutsidePlayer', JSON.stringify(enabled))
    window.dispatchEvent(new Event('showUpNextOutsidePlayerChanged'))
  }
  
  const handleUpNextSecondsChange = (seconds: number) => {
    const newSeconds = Math.max(5, Math.min(30, seconds))
    setUpNextSeconds(newSeconds)
    localStorage.setItem('upNextSeconds', newSeconds.toString())
    window.dispatchEvent(new CustomEvent('upNextSecondsChanged', { detail: newSeconds }))
  }

  // 保存翻译设置
  const handleTranslationToggle = (enabled: boolean) => {
    setTranslationEnabled(enabled)
    localStorage.setItem('translationEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleTranslationPositionChange = (position: 'traditional' | 'bottom-right') => {
    setTranslationPosition(position)
    localStorage.setItem('translationPosition', position)
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }
  
  // 保存主题色设置
  const handleAccentColorChange = (color: string) => {
    setAccentColor(color)
    localStorage.setItem('accentColor', color)
    window.dispatchEvent(new CustomEvent('accentColorChanged', { detail: color }))
  }

  const updatePlaybackShortcutSettings = (patch: Partial<PlaybackShortcutSettings>) => {
    setPlaybackShortcutSettings(savePlaybackShortcutSettings(patch))
  }
  
  const handleGpuAccelerationToggle = async (enabled: boolean) => {
    try {
      const result = await window.electron?.system.setHardwareAcceleration(enabled)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuAcceleration(result.enabled)
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result.enabled ? 'GPU 加速已打开，重启软件后生效' : 'GPU 加速已关闭，重启软件后生效', type: 'info' }
      }))
    } catch (error) {
      console.error('保存硬件加速设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '硬件加速设置保存失败', type: 'error' }
      }))
    }
  }

  const handleGpuPreferenceChange = async (preference: 'auto' | 'discrete' | 'integrated') => {
    try {
      const result = await window.electron?.system.setGpuPreference(preference)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuPreference(result.gpuPreference)
      const labels: Record<'auto' | 'discrete' | 'integrated', string> = {
        auto: '自动',
        discrete: '独立显卡',
        integrated: '核显',
      }
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: `已切换为${labels[result.gpuPreference]}，重启软件后生效`, type: 'info' }
      }))
    } catch (error) {
      console.error('保存显卡偏好设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '显卡偏好设置保存失败', type: 'error' }
      }))
    }
  }

  const handleAudioAnalyzerToggle = (enabled: boolean) => {
    setAudioAnalyzerEnabled(enabled)
    localStorage.setItem('audioAnalyzerEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('audioAnalyzerEnabledChanged', { detail: enabled }))
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '音频频谱分析已启用' : '音频频谱分析已禁用（性能模式）', type: 'success' }
    }))
  }

  // 开发者模式切换
  const handleDeveloperModeToggle = (enabled: boolean) => {
    setDeveloperMode(enabled)
    localStorage.setItem('developerMode', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('developerModeChanged', { detail: enabled }))
    
    // 通知 Electron 后端
    if (window.electron?.developerMode) {
      window.electron.developerMode.set(enabled).catch((err: Error) => {
        console.error('Failed to set developer mode:', err)
      })
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '开发者模式已启用' : '开发者模式已禁用', type: 'info' }
    }))
  }

  // 全屏模式切换
  const handleFullscreenModeChange = async (mode: 'kiosk' | 'normal') => {
    setFullscreenMode(mode)
    localStorage.setItem('fullscreenMode', mode)
    window.dispatchEvent(new CustomEvent('fullscreenModeChanged', { detail: mode }))
    
    // 如果当前已经是全屏状态，立即应用新的全屏模式
    if (window.electron?.system?.isFullscreen) {
      const status = await window.electron.system.isFullscreen()
      if (status.fullscreen || status.kiosk) {
        // 先退出全屏
        await window.electron.system.setFullscreen(false, false)
        // 再使用新的模式进入全屏
        await window.electron.system.setFullscreen(true, mode === 'kiosk')
        
        window.dispatchEvent(new CustomEvent('showToast', { 
          detail: { 
            message: mode === 'kiosk' ? '已切换到全屏模式（覆盖任务栏）' : '已切换到全屏无边框模式（保留任务栏）', 
            type: 'success' 
          }
        }))
      }
    }
  }
  
  // 视频播放完毕行为设置
  const handleVideoEndBehaviorChange = (behavior: 'next' | 'close' | 'replay') => {
    setVideoEndBehavior(behavior)
    localStorage.setItem('videoEndBehavior', behavior)
    window.dispatchEvent(new CustomEvent('videoEndBehaviorChanged', { detail: behavior }))
    
    const messages = {
      close: '视频播放完毕后将显示重播按钮',
      replay: '视频播放完毕后将自动重播',
      next: '视频播放完毕后将自动续播下一个'
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { 
        message: messages[behavior], 
        type: 'success' 
      }
    }))
  }
  
  // Crossfade 和 Gapless 设置
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(() => {
    const saved = localStorage.getItem('crossfadeEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = localStorage.getItem('crossfadeDuration')
    return saved ? parseFloat(saved) : 4
  })
  
  const [gaplessEnabled, setGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('gaplessEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [albumGaplessEnabled, setAlbumGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('albumGaplessEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const [autoMixEnabled, setAutoMixEnabled] = useState(() => {
    const saved = localStorage.getItem('autoMixEnabled')
    return parseStoredBoolean(saved, false)
  })

  const [autoMixBeatMatching, setAutoMixBeatMatching] = useState(() => {
    const saved = localStorage.getItem('autoMixBeatMatching')
    return parseStoredBoolean(saved, true)
  })

  const [autoMixSkipSilence, setAutoMixSkipSilence] = useState(() => {
    const saved = localStorage.getItem('autoMixSkipSilence')
    return parseStoredBoolean(saved, true)
  })

  const [autoMixMinDuration, setAutoMixMinDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMinDuration')
    return saved ? parseFloat(saved) : 2
  })

  const [autoMixMaxDuration, setAutoMixMaxDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMaxDuration')
    return saved ? parseFloat(saved) : 12
  })
  
  const handleCrossfadeToggle = (enabled: boolean) => {
    // Crossfade 和 AutoMix、Gapless 互斥
    if (enabled) {
      if (autoMixEnabled) {
        setAutoMixEnabled(false)
        localStorage.setItem('autoMixEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
      }
      if (gaplessEnabled) {
        setGaplessEnabled(false)
        localStorage.setItem('gaplessEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
      }
    }
    setCrossfadeEnabled(enabled)
    localStorage.setItem('crossfadeEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleCrossfadeDurationChange = (duration: number) => {
    const newDuration = Math.max(1, Math.min(12, duration))
    setCrossfadeDuration(newDuration)
    localStorage.setItem('crossfadeDuration', newDuration.toString())
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleGaplessToggle = (enabled: boolean) => {
    // Gapless 和 Crossfade、AutoMix 互斥
    if (enabled) {
      if (crossfadeEnabled) {
        setCrossfadeEnabled(false)
        localStorage.setItem('crossfadeEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      }
      if (autoMixEnabled) {
        setAutoMixEnabled(false)
        localStorage.setItem('autoMixEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
      }
    }
    setGaplessEnabled(enabled)
    localStorage.setItem('gaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('gaplessSettingsChanged'))
  }
  
  const handleAlbumGaplessToggle = (enabled: boolean) => {
    setAlbumGaplessEnabled(enabled)
    localStorage.setItem('albumGaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('albumGaplessSettingsChanged'))
  }

  const handleAutoMixToggle = (enabled: boolean) => {
    // AutoMix 和 Crossfade、Gapless 互斥
    if (enabled) {
      if (crossfadeEnabled) {
        setCrossfadeEnabled(false)
        localStorage.setItem('crossfadeEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      }
      if (gaplessEnabled) {
        setGaplessEnabled(false)
        localStorage.setItem('gaplessEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
      }
    }
    setAutoMixEnabled(enabled)
    localStorage.setItem('autoMixEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixBeatMatchingToggle = (enabled: boolean) => {
    setAutoMixBeatMatching(enabled)
    localStorage.setItem('autoMixBeatMatching', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixSkipSilenceToggle = (enabled: boolean) => {
    setAutoMixSkipSilence(enabled)
    localStorage.setItem('autoMixSkipSilence', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixMinDurationChange = (duration: number) => {
    const newDuration = Math.max(1, Math.min(autoMixMaxDuration - 1, duration))
    setAutoMixMinDuration(newDuration)
    localStorage.setItem('autoMixMinDuration', newDuration.toString())
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixMaxDurationChange = (duration: number) => {
    const newDuration = Math.max(autoMixMinDuration + 1, Math.min(20, duration))
    setAutoMixMaxDuration(newDuration)
    localStorage.setItem('autoMixMaxDuration', newDuration.toString())
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  // 深浅色主题：与播放页快捷设置共用同一存储与事件，App 监听后统一更新
  const handlePlayerThemeChange = (newTheme: 'dark' | 'light') => {
    localStorage.setItem('playerTheme', newTheme)
    window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: newTheme }))
  }

  return (
    <AnimatePresence>
      {show && (
        <React.Fragment key="settings-modal">
          {/* 背景遮罩 */}
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          onClick={onClose}
          className={`fixed inset-0 backdrop-blur-sm z-40 ${playerTheme === 'dark' ? 'bg-black/60' : 'bg-white/40'}`}
        />

        {/* 设置面板 */}
        <motion.div
            key="settings-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-md z-50 shadow-2xl overflow-hidden"
          >
            {/* 液态玻璃背景层 - 增强版 */}
            <div className="absolute inset-0">
              {/* 主背景 - 根据主题变化 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(15,15,25,0.85) 30%, rgba(25,15,35,0.8) 70%, rgba(0,0,0,0.75) 100%)'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(245,245,250,0.85) 30%, rgba(250,245,255,0.8) 70%, rgba(255,255,255,0.75) 100%)',
                  backdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                  WebkitBackdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                }}
              />
              
              {/* 多层光泽效果 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.15) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.08) 0%, transparent 40%)'
                    : 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.9) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.5) 0%, transparent 40%)',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 细微噪点纹理 */}
              <div 
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\' opacity=\'0.05\'/%3E%3C/svg%3E")',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 左边框高光 - 增强版 */}
              <div 
                className="absolute inset-y-0 left-0 w-px"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent)'
                    : 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.2), transparent)',
                }}
              />
              
              {/* 边框高光 */}
              <div 
                className="absolute inset-0"
                style={{
                  border: playerTheme === 'dark' 
                    ? '1.5px solid rgba(255,255,255,0.2)'
                    : '1.5px solid rgba(0,0,0,0.15)',
                  boxShadow: playerTheme === 'dark'
                    ? '0 20px 60px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.2), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.2)'
                    : '0 20px 60px rgba(0,0,0,0.2), 0 0 1px rgba(255,255,255,0.8), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 -1px 1px rgba(0,0,0,0.05)',
                  pointerEvents: 'none',
                  borderRadius: '0',
                }}
              />
            </div>
            
            {/* Content area */}
            <div className="relative z-10 h-full flex flex-col">
            {/* 头部 */}
            <div className={`flex items-center justify-between p-6 border-b ${
              playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
            }`}>
              <div className="flex items-center gap-3">
                <SettingsIcon className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                <h2 className={`text-2xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>设置</h2>
              </div>
              <button
                onClick={onClose}
                className="relative p-2 rounded-full transition-all duration-300 group overflow-hidden"
                style={{
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                }}
              >
                {/* 液态玻璃背景层 */}
                <div 
                  className="absolute inset-0 transition-all duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)'
                      : 'linear-gradient(135deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.04) 100%)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* Hover 效果层 */}
                <div 
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'radial-gradient(circle at center, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.1) 100%)'
                      : 'radial-gradient(circle at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.08) 100%)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* 边框光泽 */}
                <div 
                  className="absolute inset-0"
                  style={{
                    border: playerTheme === 'dark' 
                      ? '1px solid rgba(255,255,255,0.2)'
                      : '1px solid rgba(0,0,0,0.15)',
                    borderRadius: '9999px',
                    boxShadow: playerTheme === 'dark'
                      ? 'inset 0 1px 1px rgba(255,255,255,0.2), 0 2px 8px rgba(0,0,0,0.2)'
                      : 'inset 0 1px 1px rgba(255,255,255,0.5), 0 2px 8px rgba(0,0,0,0.1)',
                  }}
                />
                
                <ChevronLeft className={`w-6 h-6 relative z-10 transition-transform duration-300 group-hover:scale-110 ${
                  playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'
                }`} />
              </button>
            </div>

            {/* Tabs：激活项下方为蓝色指示条（layoutId 共享布局动画，切换时丝滑滑到选中 tab 下方） */}
            <div className={`relative flex border-b ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
              <button
                onClick={() => switchTab('account')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'account'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <User className="w-5 h-5" />
                账号
                {activeTab === 'account' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('personalization')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'personalization'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Sparkles className="w-5 h-5" />
                个性化
                {activeTab === 'personalization' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('advanced')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'advanced'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Palette className="w-5 h-5" />
                高级
                {activeTab === 'advanced' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('about')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'about'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Info className="w-5 h-5" />
                关于
                {activeTab === 'about' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
            </div>

            {/* Content area */}
            <div ref={contentScrollRef} className="p-6 overflow-y-auto h-[calc(100vh-140px)]">
              {activeTab === 'account' && (
                <div className="space-y-6">
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>音乐平台账号</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      登录后可以播放VIP歌曲、获取个人歌单
                    </p>
                    
                    <div className="space-y-4">
                      {/* NetEase login */}
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-red-600 flex items-center justify-center">
                              <img 
                                src="https://s1.music.126.net/style/favicon.ico"
                                alt="网易云音乐"
                                className="w-6 h-6"
                                onError={(e) => {
                                  e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='70' text-anchor='middle' fill='white' font-size='50' font-weight='bold'%3E网%3C/text%3E%3C/svg%3E"
                                }}
                              />
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>网易云音乐</div>
                              <div className={`${textTertiary} text-xs`}>使用手机扫码登录</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <LoginButton
                            platform="netease"
                            isLoggedIn={neteaseLoggedIn}
                            username={neteaseUsername}
                            onLogin={onNeteaseLogin}
                            onLogout={onNeteaseLogout}
                            playerTheme={playerTheme}
                          />
                        </div>
                      </div>

                      {/* QQ音乐登录 */}
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-green-600 flex items-center justify-center">
                              <img 
                                src="https://y.qq.com/favicon.ico"
                                alt="QQ音乐"
                                className="w-6 h-6"
                                onError={(e) => {
                                  e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='70' text-anchor='middle' fill='white' font-size='45' font-weight='bold'%3EQQ%3C/text%3E%3C/svg%3E"
                                }}
                              />
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>QQ音乐</div>
                              <div className={`${textTertiary} text-xs`}>使用网页扫码登录</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <LoginButton
                            platform="qq"
                            isLoggedIn={qqLoggedIn}
                            username={qqUsername}
                            onLogin={onQQLogin}
                            onLogout={onQQLogout}
                            playerTheme={playerTheme}
                          />
                        </div>
                      </div>
                    </div>

                    <div className={`${bgCard} mt-6 rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium`}>隐藏主页账号ID信息</div>
                          <div className={`${textTertiary} text-xs mt-1`}>隐藏个人信息中的 QQ号和网易云ID，录制视频时保护账号隐私</div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={hideHomeAccountId}
                          aria-label="隐藏主页账号ID信息"
                          onClick={handleHideHomeAccountIdChange}
                          className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${hideHomeAccountId ? '' : playerTheme === 'dark' ? 'bg-white/15' : 'bg-black/15'}`}
                          style={hideHomeAccountId ? { backgroundColor: accentColor } : undefined}
                        >
                          <span className={`pointer-events-none absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ${hideHomeAccountId ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'personalization' && (
                <div className="space-y-6">
                  {/* 外观主题 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>外观主题</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium mb-1`}>主题色</div>
                          <div className={`${textSecondary} text-sm`}>切换播放页、简约模式与探索模式的深浅色显示</div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          {(['dark', 'light'] as const).map((themeOption) => (
                            <button
                              key={themeOption}
                              onClick={() => handlePlayerThemeChange(themeOption)}
                              className="px-4 py-1.5 rounded-lg text-xs font-medium transition-all"
                              style={{
                                backgroundColor:
                                  playerTheme === themeOption
                                    ? accentColor
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.1)'
                                    : 'rgba(0,0,0,0.1)',
                                color:
                                  playerTheme === themeOption
                                    ? '#fff'
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.6)'
                                    : 'rgba(0,0,0,0.6)',
                                boxShadow: playerTheme === themeOption ? `0 0 8px ${accentColor}30` : 'none',
                              }}
                            >
                              {themeOption === 'dark' ? '深色' : '浅色'}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 首页自定义 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>自定义首页</h3>
                    <button
                      onClick={() => setShowHomeCustomize(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Sparkles className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left">
                          <div className={`${textPrimary} font-medium`}>自定义首页显示内容</div>
                          <div className={`${textSecondary} text-sm`}>
                            分别配置网易云和QQ音乐的推荐模块
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放音质 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放音质</h3>
                    <button
                      onClick={() => setShowAudioQuality(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <Headphones className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                          <div className={`${textPrimary} font-medium`}>QQ音乐与网易云播放音质</div>
                          <div className={`${textSecondary} text-sm truncate`}>
                            QQ音乐：{audioQualityLabel(audioQualitySettings.qq)} · 网易云：{audioQualityLabel(audioQualitySettings.netease)}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放快捷键 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放快捷键</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} space-y-4`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>播放页快捷键</div>
                          <div className={`${textSecondary} text-sm`}>在播放页使用方向键调节进度，并可用空格键播放或暂停</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.playbackPageEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ playbackPageEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.playbackPageEnabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {playbackShortcutSettings.playbackPageEnabled && (
                        <div className="pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          {([
                            ['右方向键快进', 'seekForwardSeconds'],
                            ['左方向键快退', 'seekBackwardSeconds'],
                          ] as const).map(([label, key]) => {
                            const seconds = playbackShortcutSettings[key]
                            const percent = ((seconds - 1) / 14) * 100
                            return (
                              <div key={key} className="flex items-center justify-between gap-5">
                                <div className={`${textPrimary} text-sm font-medium`}>{label}</div>
                                <div className="flex items-center gap-3">
                                  <input
                                    type="range"
                                    min="1"
                                    max="15"
                                    step="1"
                                    value={seconds}
                                    onChange={(event) => updatePlaybackShortcutSettings({ [key]: Number(event.target.value) })}
                                    className="w-36 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                    style={{
                                      background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`,
                                    }}
                                  />
                                  <span className={`${textPrimary} text-sm font-semibold w-12 text-right`}>{seconds} 秒</span>
                                </div>
                              </div>
                            )
                          })}

                          <div className="flex items-center justify-between gap-6 pt-1">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>空格键播放 / 暂停</div>
                              <div className={`${textTertiary} text-xs`}>关闭后，在播放页按空格键不会触发播放控制</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                              <input
                                type="checkbox"
                                checked={playbackShortcutSettings.spacePlayPauseEnabled}
                                onChange={(event) => updatePlaybackShortcutSettings({ spacePlayPauseEnabled: event.target.checked })}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.spacePlayPauseEnabled ? accentColor : '' }} />
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="pt-4 border-t flex items-center justify-between gap-6" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>键盘多媒体键支持</div>
                          <div className={`${textSecondary} text-sm`}>软件打开时，全局响应播放 / 暂停、上一曲和下一曲媒体键</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.mediaKeysEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ mediaKeysEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.mediaKeysEnabled ? accentColor : '' }} />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* 即将播放提示 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放提示</h3>
                    
                    {/* 即将播放提示开关 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>即将播放提示</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前显示下一首歌曲信息
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={upNextEnabled}
                            onChange={(e) => handleUpNextToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: upNextEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 秒数设置 */}
                      {upNextEnabled && (
                        <div className="space-y-4 pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between gap-6">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>在播放页外显示播放提示</div>
                              <div className={`${textSecondary} text-xs`}>
                                在探索、简约首页和桌面模式的右上角显示提示
                              </div>
                            </div>
                            <label className="relative inline-flex shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={showUpNextOutsidePlayer}
                                onChange={(e) => handleShowUpNextOutsidePlayerToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: showUpNextOutsidePlayer ? accentColor : '' }} />
                            </label>
                          </div>
                          <div className="border-t pt-4" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between">
                            <div className={`${textPrimary} text-sm font-medium`}>提前显示时间</div>
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min="5"
                                max="30"
                                value={upNextSeconds}
                                onChange={(e) => handleUpNextSecondsChange(parseInt(e.target.value))}
                                className="w-32 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                style={{
                                  background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                                }}
                              />
                              <span className={`${textPrimary} text-sm font-medium w-12 text-right`}>{upNextSeconds}秒</span>
                            </div>
                          </div>
                          <div className={`${textTertiary} text-xs mt-2`}>
                            在歌曲结束前 {upNextSeconds} 秒显示下一首歌曲信息
                          </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* 歌词翻译位置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>歌词翻译</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>翻译显示位置</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择歌词翻译在播放界面的显示位置
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={() => {
                            setTranslationPosition('traditional')
                            localStorage.setItem('translationPosition', 'traditional')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'traditional' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'traditional'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'traditional' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'traditional' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>传统</div>
                              <div className={`${textTertiary} text-xs mt-1`}>显示于歌词下方</div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => {
                            setTranslationPosition('bottom-right')
                            localStorage.setItem('translationPosition', 'bottom-right')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'bottom-right' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'bottom-right'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'bottom-right' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'bottom-right' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>现代</div>
                              <div className={`${textTertiary} text-xs mt-1`}>右下角浮动显示</div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 桌面歌词 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面歌词</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用桌面歌词</div>
                          <div className={`${textSecondary} text-sm`}>将当前歌词显示在桌面上，悬停后可拖动、缩放并快速调整样式</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={desktopLyricsSettings.enabled}
                            onChange={(event) => handleDesktopLyricsToggle(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopLyricsSettings.enabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {desktopLyricsSettings.enabled && (
                        <div className="mt-4 pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`${textPrimary} text-sm font-medium`}>字体大小</span>
                              <span className={`${textTertiary} text-xs tabular-nums`}>{desktopLyricsSettings.fontSize}</span>
                            </div>
                            <input
                              type="range"
                              min="26"
                              max="120"
                              step="2"
                              value={desktopLyricsSettings.fontSize}
                              onChange={(event) => updateDesktopLyrics({ fontSize: Number(event.target.value) })}
                              className="w-full"
                              style={{ accentColor }}
                            />
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>字体颜色</div>
                            <div className="flex flex-wrap gap-3">
                              {([
                                ['auto', '随歌曲', 'linear-gradient(135deg,#67e8f9,#f9a8d4,#fde68a)'],
                                ['rose', '樱粉', '#f9a8d4'],
                                ['sky', '晴蓝', '#7dd3fc'],
                                ['gold', '暖金', '#fde68a'],
                                ['mint', '薄荷', '#86efac'],
                                ['white', '月白', '#f8fafc'],
                              ] as Array<[DesktopLyricsColorMode, string, string]>).map(([value, label, color]) => (
                                <button key={value} type="button" onClick={() => updateDesktopLyrics({ colorMode: value })} className="flex flex-col items-center gap-1.5">
                                  <span className="w-8 h-8 rounded-full p-1 transition-shadow" style={{ boxShadow: desktopLyricsSettings.colorMode === value ? `0 0 0 2px ${accentColor}` : '0 0 0 1px rgba(127,127,127,.22)' }}>
                                    <i className="block w-full h-full rounded-full" style={{ background: color }} />
                                  </span>
                                  <span className={`${textTertiary} text-[10px]`}>{label}</span>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-3">
                            {([
                              ['orientation', desktopLyricsSettings.orientation === 'vertical', '竖排显示'],
                              ['doubleLine', desktopLyricsSettings.doubleLine, '双行显示'],
                              ['traditionalEnabled', desktopLyricsSettings.traditionalEnabled, '繁体歌词'],
                            ] as const).map(([key, active, label]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => updateDesktopLyrics(key === 'orientation'
                                  ? { orientation: active ? 'horizontal' : 'vertical' }
                                  : { [key]: !active })}
                                className="rounded-xl border px-3 py-2.5 text-xs transition-colors"
                                style={{
                                  color: active ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                  borderColor: active ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                  background: active ? `${accentColor}18` : 'transparent',
                                }}
                              >{label}</button>
                            ))}
                          </div>
                          <p className={`${textTertiary} text-xs leading-5`}>翻译与罗马音按钮会在当前整首歌曲包含对应歌词时，自动显示在桌面歌词工具栏中。</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 桌面播放器 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面播放器</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>桌面播放器</div>
                          <div className={`${textSecondary} text-sm`}>
                            独立置顶小窗口，支持右上角悬浮卡片与顶部居中的紧凑条状
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={desktopPlayerEnabled}
                            onChange={(e) => handleDesktopPlayerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopPlayerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {desktopPlayerEnabled && (
                        <div className="pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className={`${textPrimary} text-sm font-medium mb-3`}>显示形态</div>
                          <div className="grid grid-cols-2 gap-3">
                            <button
                              onClick={() => handleDesktopPlayerFormChange('card')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'card' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'card'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v11H4z M8 9h5 M8 12h3 M16 9v4 M18 10v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>悬浮卡片</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>可拖动摆放，拖角调整大小</div>
                                </div>
                              </div>
                            </button>

                            <button
                              onClick={() => handleDesktopPlayerFormChange('bar')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'bar' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'bar'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15h18v4H3z M5 17h6 M17 16.5v1.5 M19 16v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>紧凑条状</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>默认显示在屏幕顶部中央，支持完整控制</div>
                                </div>
                              </div>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 全屏窗口模式设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>窗口设置</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>全屏化窗口模式</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择全屏时的窗口行为
                        </div>
                      </div>
                      
                      {/* 全屏模式选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleFullscreenModeChange('kiosk')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'kiosk'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'kiosk' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'kiosk' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                覆盖整个屏幕包括任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleFullscreenModeChange('normal')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'normal'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'normal' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'normal' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏无边框</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                保留系统任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 视频播放设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>视频播放</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>视频播放完毕行为</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择MV视频播放结束后的行为
                        </div>
                      </div>
                      
                      {/* 视频结束行为选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleVideoEndBehaviorChange('close')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'close'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'close' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'close' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>不重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后显示重播按钮
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('replay')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'replay'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'replay' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'replay' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动回到开头重播
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('next')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'next'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'next' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'next' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动续播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动播放下一个视频
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 主题色设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>主题色</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>选择主题色</div>
                        <div className={`${textSecondary} text-sm`}>
                          自定义应用的强调色
                        </div>
                      </div>
                      
                      {/* 色板 */}
                      <div className="grid grid-cols-4 gap-3">
                        {presetColors.map((color) => (
                          <button
                            key={color.value}
                            onClick={() => handleAccentColorChange(color.value)}
                            className={`relative p-3 rounded-xl transition-all ${
                              accentColor === color.value 
                                ? 'ring-2 ring-offset-2 scale-105' 
                                : 'hover:scale-105'
                            }`}
                            style={{
                              backgroundColor: color.value,
                              '--tw-ring-color': color.value,
                              ringOffsetColor: playerTheme === 'dark' ? '#000' : '#fff',
                            } as React.CSSProperties}
                          >
                            <div className="aspect-square rounded-lg" />
                            {accentColor === color.value && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                      
                      {/* 色块下方显示颜色名称 */}
                      <div className={`mt-3 text-center ${textSecondary} text-sm`}>
                        当前：{presetColors.find(c => c.value === accentColor)?.name || '自定义'}
                      </div>
                    </div>
                  </div>

                  {/* 远程遥控器设置（卡片 → 二级菜单弹窗） */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>远程遥控器</h3>
                    <button
                      onClick={() => setShowRemoteSettings(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <MonitorSmartphone className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                          <div className={`${textPrimary} font-medium`}>遥控器个性化</div>
                          <div className={`${textSecondary} text-sm truncate`}>外观 · 右上角按钮 · 触摸板手势</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>
                </div>
              )}

              {/* 高级标签页 */}
              {activeTab === 'advanced' && (
                <div className="space-y-6">
                  {/* 播放过渡效果 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放过渡</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      选择歌曲切换时的过渡效果，提升听感体验
                    </p>
                    
                    {/* Crossfade 渐入渐出 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>渐入渐出 (Crossfade)</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前开始淡出，同时淡入下一首
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossfadeEnabled}
                            onChange={(e) => handleCrossfadeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossfadeEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* Crossfade 时长调节 */}
                      {crossfadeEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10">
                          <div className="flex items-center justify-between mb-2">
                            <span className={`${textSecondary} text-sm`}>过渡时长</span>
                            <span className={`${textPrimary} text-sm font-medium`}>{crossfadeDuration} 秒</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="12"
                            step="1"
                            value={crossfadeDuration}
                            onChange={(e) => handleCrossfadeDurationChange(parseInt(e.target.value))}
                            className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                            }}
                          />
                        </div>
                      )}
                    </div>
                    
                    {/* Gapless 无缝衔接 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>无缝衔接 (Gapless)</div>
                          <div className={`${textSecondary} text-sm`}>
                            预加载下一首并在歌曲边界连续切换；节拍分析由独立的 AutoMix 负责
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gaplessEnabled}
                            onChange={(e) => handleGaplessToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gaplessEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {gaplessEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
                          {/* 专辑融合 */}
                          <div className="flex items-center justify-between">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>专辑融合</div>
                              <div className={`${textSecondary} text-xs`}>
                                仅在同一专辑的相邻歌曲间使用尾部检测与 Equal Power 融合
                              </div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={albumGaplessEnabled}
                                onChange={(e) => handleAlbumGaplessToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: albumGaplessEnabled ? accentColor : '' }}></div>
                            </label>
                          </div>

                        </div>
                      )}
                    </div>

                    {/* AutoMix 智能混音 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mt-4`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1 flex items-center gap-2`}>
                            <Sparkles className="w-4 h-4" />
                            智能混音 (AutoMix)
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: accentColor + '20', color: accentColor }}>AI</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">Beta</span>
                          </div>
                          <div className={`${textSecondary} text-sm`}>
                            自动分析上下歌曲BPM节拍与能量进行混音过渡
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoMixEnabled}
                            onChange={(e) => handleAutoMixToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {autoMixEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>节拍匹配</div>
                              <div className={`${textSecondary} text-xs`}>对齐重拍，并使用保留音高的渐进变速</div>
                            </div>
                            <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoMixBeatMatching}
                                onChange={(event) => handleAutoMixBeatMatchingToggle(event.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixBeatMatching ? accentColor : '' }}></div>
                            </label>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>跳过首尾静音</div>
                              <div className={`${textSecondary} text-xs`}>选择混音点时避开前奏与尾部的静音区</div>
                            </div>
                            <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoMixSkipSilence}
                                onChange={(event) => handleAutoMixSkipSilenceToggle(event.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixSkipSilence ? accentColor : '' }}></div>
                            </label>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <div className={`${textPrimary} text-sm font-medium`}>过渡时长范围</div>
                              <div className={`${textSecondary} text-xs tabular-nums`}>{autoMixMinDuration}–{autoMixMaxDuration} 秒</div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                              <label className={`${textSecondary} text-xs`}>
                                最短
                                <input
                                  type="range"
                                  min="1"
                                  max="19"
                                  step="1"
                                  value={autoMixMinDuration}
                                  onChange={(event) => handleAutoMixMinDurationChange(Number(event.target.value))}
                                  className="mt-2 w-full accent-current"
                                  style={{ color: accentColor }}
                                />
                              </label>
                              <label className={`${textSecondary} text-xs`}>
                                最长
                                <input
                                  type="range"
                                  min="2"
                                  max="20"
                                  step="1"
                                  value={autoMixMaxDuration}
                                  onChange={(event) => handleAutoMixMaxDurationChange(Number(event.target.value))}
                                  className="mt-2 w-full accent-current"
                                  style={{ color: accentColor }}
                                />
                              </label>
                            </div>
                            <div className={`${textSecondary} text-xs mt-2`}>实际时长会吸附到完整的 8 / 16 / 24 / 32 拍。</div>
                          </div>

                          <div className={`${bgCard} rounded-lg p-3 border ${borderColor}`}>
                            <div className="flex items-start gap-2">
                              <Info className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
                              <div className="text-xs">
                                <p className={`${textPrimary} font-medium mb-1`}>开发阶段提示</p>
                                <p className={`${textSecondary}`}>
                                  本功能当前处于开发阶段，可能会影响播放体验。我们正在持续优化算法，以提供更流畅的混音效果。
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 网易云不可用歌曲补全 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>网易云可用性增强</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      当网易云官方没有返回播放链接时，可尝试从其他公开音乐源匹配同一首歌
                    </p>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1 flex items-center gap-2`}>
                            灰色歌曲跨平台补全
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>Enhanced</span>
                          </div>
                          <div className={`${textSecondary} text-sm`}>
                            仅补全免费但受版权或地区影响的歌曲；VIP 与付费专辑不会绕过平台权限
                          </div>
                        </div>
                        <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossPlatformFallbackEnabled}
                            onChange={(event) => {
                              const enabled = event.target.checked
                              setCrossPlatformFallbackEnabled(enabled)
                              localStorage.setItem('crossPlatformFallbackEnabled', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossPlatformFallbackEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        使用本地服务完成匹配，不会开启系统代理、安装证书或修改网络设置。关闭后立即恢复仅使用网易云官方链接。
                      </div>
                    </div>
                  </div>
                  
                  {/* 第三方歌词源 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>第三方歌词源</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      启用后将从社区歌词库获取更丰富的歌词内容，包括逐字歌词和翻译
                    </p>
                    
                    {/* 启用第三方歌词源 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用第三方歌词源</div>
                          <div className={`${textSecondary} text-sm`}>
                            从 AMLL TTML DB 和 Lrclib 等社区歌词库获取高质量歌词
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={thirdPartyLyricsEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setThirdPartyLyricsEnabled(enabled)
                              localStorage.setItem('thirdPartyLyricsEnabled', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: thirdPartyLyricsEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* 自适应最佳歌词 */}
                    {thirdPartyLyricsEnabled && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>自适应最佳歌词</div>
                            <div className={`${textSecondary} text-sm`}>
                              自动适配最佳歌词源，若关闭将使用当前平台源
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={adaptiveLyrics}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setAdaptiveLyrics(enabled)
                                localStorage.setItem('adaptiveLyrics', JSON.stringify(enabled))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: adaptiveLyrics ? accentColor : '' }}></div>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* 歌词库选择 */}
                    {thirdPartyLyricsEnabled && adaptiveLyrics && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className={`${textPrimary} font-medium mb-3`}>首要歌词库</div>
                        <div className={`${textSecondary} text-sm mb-4`}>
                          仅请求当前歌曲平台及第三方来源，优先使用有逐字的歌词
                        </div>
                        
                        <div className="space-y-2">
                          {[
                            { key: 'AMLL', name: 'AMLL TTML DB', desc: '社区逐字歌词库（可含翻译与罗马音，以收录为准）' },
                            { key: 'NetEase', name: '网易云音乐', desc: '仅网易云歌曲使用，其他平台自动回退' },
                            { key: 'QQMusic', name: 'QQ音乐', desc: '仅QQ歌曲使用，其他平台自动回退' },
                            { key: 'Platform', name: '当前平台', desc: '使用正在播放的平台' }
                          ].map((source) => (
                            <button
                              key={source.key}
                              onClick={() => {
                                setPrimaryLyricsSource(source.key)
                                localStorage.setItem('primaryLyricsSource', source.key)
                              }}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors border-2 ${
                                primaryLyricsSource === source.key
                                  ? playerTheme === 'dark'
                                    ? 'bg-white/5 hover:bg-white/10'
                                    : 'bg-black/5 hover:bg-black/10'
                                  : playerTheme === 'dark'
                                  ? 'bg-white/5 hover:bg-white/10 border-transparent'
                                  : 'bg-black/5 hover:bg-black/10 border-transparent'
                              }`}
                              style={{
                                borderColor: primaryLyricsSource === source.key ? accentColor : 'transparent',
                                backgroundColor: primaryLyricsSource === source.key 
                                  ? `${accentColor}20`
                                  : ''
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center`}
                                style={{
                                  borderColor: primaryLyricsSource === source.key 
                                    ? accentColor 
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                                  backgroundColor: primaryLyricsSource === source.key ? accentColor : 'transparent'
                                }}
                              >
                                {primaryLyricsSource === source.key && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className={`${textPrimary} text-sm font-medium`}>{source.name}</div>
                                <div className={`${textTertiary} text-xs`}>{source.desc}</div>
                              </div>
                              {primaryLyricsSource === source.key && (
                                <div 
                                  className={`px-2 py-1 rounded ${textPrimary} text-xs font-medium`}
                                  style={{ backgroundColor: `${accentColor}50` }}
                                >
                                  首选
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* 性能优化 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>性能优化</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>GPU 硬件加速</div>
                          <div className={`${textSecondary} text-sm`}>使用显卡加速渲染动画，提升流畅度</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gpuAcceleration}
                            onChange={(e) => void handleGpuAccelerationToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gpuAcceleration ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        <div>建议保持开启。动态壁纸、歌词动画和界面合成依赖 GPU；关闭后界面可能明显卡顿。仅建议在显卡驱动兼容故障时关闭，重启后生效。</div>
                        {gpuStatus && (
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                            <span>{gpuStatus.actualEnabled ? '当前已启用 GPU 合成' : '当前使用软件渲染'}</span>
                            {gpuStatus.gpu && <span>{gpuStatus.gpu.deviceString || gpuStatus.gpu.vendorString || '已检测显卡'}{gpuStatus.gpu.driverVersion ? ` | 驱动 ${gpuStatus.gpu.driverVersion}` : ''}</span>}
                            {gpuStatus.actualEnabled !== gpuAcceleration && <span className="text-amber-400">当前设置尚未生效，请重启软件</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="mb-3">
                        <div className={`${textPrimary} font-medium mb-1`}>显卡选择</div>
                        <div className={`${textSecondary} text-sm`}>优先使用哪块显卡进行加速渲染（切换后重启生效）</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleGpuPreferenceChange('auto')}
                          className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'auto' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                          style={gpuPreference === 'auto' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        >
                          自动
                        </button>
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'discrete').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('discrete')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '独立显卡'}</span>
                            <span className="ml-1.5 text-xs opacity-70">独显</span>
                          </button>
                        ))}
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'integrated').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('integrated')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '核显'}</span>
                            <span className="ml-1.5 text-xs opacity-70">核显</span>
                          </button>
                        ))}
                        {(!gpuStatus || (gpuStatus.gpus ?? []).filter(g => g.kind !== 'unknown').length === 0) && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('discrete')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              独立显卡
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('integrated')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              核显 / 集成显卡
                            </button>
                          </>
                        )}
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        默认使用独立显卡以获得最佳动画流畅度；笔记本想省电或独显驱动异常时可切换为核显或自动。切换后需重启软件生效。
                      </div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>音频频谱分析</div>
                          <div className={`${textSecondary} text-sm`}>用于封面脉动等可视化效果</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={audioAnalyzerEnabled}
                            onChange={(e) => handleAudioAnalyzerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: audioAnalyzerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        关闭后会降低 CPU 占用，适合低性能设备或省电场景。
                      </div>
                    </div>
                  </div>

                  {/* 开发者选项 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>开发者选项</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className={`${textPrimary} font-medium`}>开发者模式</div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={developerMode}
                            onChange={(e) => handleDeveloperModeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: developerMode ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 警告文案 */}
                      {developerMode && (
                        <div className={`mt-3 p-3 rounded-lg ${playerTheme === 'dark' ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-100 border border-yellow-300'}`}>
                          <p className={`text-xs ${playerTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-800'}`}>
                            ⚠️ 当前模式仅限调试作用，无问题情况下请勿打开
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 缓存清理 */}
                  <div className="mt-8">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>缓存管理</h3>
                    
                    {/* 缓存清理按钮 */}
                    <button
                      onClick={() => setShowCacheClear(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20` }}
                          >
                            <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>缓存清理</div>
                            <div className={`${textSecondary} text-sm`}>
                              管理封面、歌单列表和错误日志缓存
                            </div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* 关于标签页 */}
              {activeTab === 'about' && (
                <div className="space-y-4 pb-4">
                  <section className={`${bgCard} rounded-2xl border ${borderColor} overflow-hidden`}>
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4 mb-5">
                        <div>
                          <div className={`text-xs font-semibold tracking-[0.2em] uppercase ${textTertiary} mb-2`}>About</div>
                          <h2 className={`text-2xl font-bold ${textPrimary}`}>关于 WaveForge</h2>
                        </div>
                        <span className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${playerTheme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-black/5 text-black/60'}`}>
                          v{packageInfo.version} Beta
                        </span>
                      </div>

                      <div className={`rounded-xl border ${borderColor} p-4 flex items-center gap-4`}>
                        <img src={appLogoUrl} alt="WaveForge" className="w-14 h-14 rounded-xl object-cover shadow-lg shrink-0" />
                        <div className="min-w-0">
                          <p className={`text-xs ${textTertiary} mb-1`}>开发者</p>
                          <p className={`text-lg font-semibold leading-6 ${textPrimary}`}>Yoshino / Castorice</p>
                          <p className={`text-sm leading-6 ${textSecondary} mt-1`}>WaveForge 澜音工坊的开发与维护</p>
                        </div>
                      </div>
                      <button
                        onClick={() => window.open('https://www.afdian.com/a/Kirito666233', '_blank')}
                        className="mt-3 w-full rounded-xl px-4 py-3 text-white font-semibold flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5 hover:shadow-lg"
                        style={{ background: `linear-gradient(135deg, ${accentColor}, #ff5b9d)`, boxShadow: `0 10px 28px ${accentColor}24` }}
                      >
                        <Heart className="w-4 h-4" fill="currentColor" />
                        <span>赞助 WaveForge</span>
                        <ExternalLink className="w-3.5 h-3.5 opacity-80" />
                      </button>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        <div>
                          <p className={`font-medium ${textPrimary}`}>查看软件源代码</p>
                          <p className={`text-sm ${textSecondary} mt-1`}>选择国内 Gitee 或 GitHub 仓库</p>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 w-full">
                          <button onClick={() => window.open('https://gitee.com/kirito666233/wave-forge', '_blank')} className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 flex items-center justify-center gap-2 transition-colors`}>
                            <Code2 className="w-4 h-4" /><span className="text-sm font-medium">Gitee</span><ExternalLink className="w-3.5 h-3.5 opacity-60" />
                          </button>
                          <button onClick={() => window.open('https://github.com/YoshinoRinn/WaveForge', '_blank')} className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 flex items-center justify-center gap-2 transition-colors`}>
                            <Github className="w-4 h-4" /><span className="text-sm font-medium">GitHub</span><ExternalLink className="w-3.5 h-3.5 opacity-60" />
                          </button>
                        </div>
                      </div>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        <button onClick={() => void checkForUpdates()} disabled={updateCheck.status === 'checking'} className={`w-full py-3 px-4 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} font-medium transition-colors disabled:opacity-60`}>
                          {updateCheck.status === 'checking' ? '正在检查新版本…' : '检查新版本'}
                        </button>
                        {updateCheck.message && (
                          <p className={`${updateCheck.status === 'error' ? 'text-red-400' : textSecondary} mt-3 text-center text-sm`}>
                            {updateCheck.message}
                            {updateCheck.status === 'available' && updateCheck.url && <button onClick={() => window.open(updateCheck.url, '_blank')} className="ml-2 underline">查看发布页</button>}
                          </p>
                        )}
                      </div>
                    </div>
                  </section>

                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}><Users className="w-5 h-5" /></div>
                      <div>
                        <h3 className={`text-lg font-semibold ${textPrimary}`}>特别鸣谢 / 粉丝开发者</h3>
                        <p className={`mt-3 font-medium ${textPrimary}`}>WaveForge 澜音工坊群的各位</p>
                        <p className={`mt-1.5 text-sm leading-6 ${textSecondary}`}>感谢各位朋友们对软件的喜爱与鼓励。</p>
                      </div>
                    </div>
                  </section>

                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5 sm:p-6`}>
                    <div className="flex items-start justify-between gap-4 mb-5">
                      <div>
                        <div className="flex items-center gap-2"><Gift className="w-5 h-5" style={{ color: accentColor }} /><h3 className={`text-lg font-semibold ${textPrimary}`}>赞助名单</h3></div>
                        <p className={`text-sm ${textSecondary} mt-1.5`}>感谢每一位支持 WaveForge 的朋友</p>
                      </div>
                      <button
                        onClick={() => window.open('https://www.afdian.com/a/Kirito666233', '_blank')}
                        className={`shrink-0 rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-3 py-2 inline-flex items-center gap-2 transition-colors`}
                        title="前往爱发电"
                      >
                        <img src={afdianLogoUrl} alt="爱发电" className="w-6 h-6 object-contain" />
                        <span className="text-sm font-medium">爱发电</span>
                        <ExternalLink className="w-3.5 h-3.5 opacity-60" />
                      </button>
                    </div>
                    {sponsorSupporters.length > 0 ? (
                      <div className="grid grid-cols-1 gap-3">
                        {sponsorSupporters.map((supporter, index) => (
                          <div key={supporter.id} className={`rounded-xl border ${borderColor} p-3 flex items-center gap-3`}>
                            <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: accentColor }}>
                              {supporter.avatar ? <img src={supporter.avatar} alt="" className="w-full h-full object-cover" /> : supporter.name.slice(0, 1)}
                            </div>
                            <div className="min-w-0 flex-1"><p className={`font-medium truncate ${textPrimary}`}>{index + 1}. {supporter.name}</p><p className={`text-xs ${textTertiary} truncate`}>{supporter.tierName || `¥${supporter.tier} 档位`}</p></div>
                            <BadgeCheck className="w-4 h-4 shrink-0" style={{ color: accentColor }} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={`rounded-xl border border-dashed ${borderColor} p-6 text-center`}>
                        <Heart className={`w-6 h-6 mx-auto mb-2 ${textTertiary}`} />
                        <p className={`text-sm ${textSecondary}`}>当前暂时没有可展示的赞助者</p>
                        <p className={`text-xs ${textTertiary} mt-1`}>赞助名单会随 WaveForge 正式版本更新。</p>
                      </div>
                    )}
                  </section>

                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                    <div className="flex items-start gap-4 mb-5">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
                        <KeyRound className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className={`text-lg font-semibold ${textPrimary}`}>设备授权</h3>
                        <p className={`text-sm ${textSecondary} mt-1.5 leading-6`}>仅用作设备标识，这不会收集关于您设备的任何信息</p>
                      </div>
                    </div>
                    <button
                      onClick={() => void copyDeviceId()}
                      disabled={deviceState.status === 'loading'}
                      className="w-full rounded-xl px-5 py-3.5 text-white font-semibold flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                      style={{ backgroundColor: accentColor, boxShadow: `0 10px 28px ${accentColor}24` }}
                    >
                      <Copy className="w-4 h-4" />
                      获取识别码
                    </button>
                    <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                      <button
                        onClick={() => {
                          setRedeemMessage(null)
                          setShowRedeemModal(true)
                        }}
                        className={`w-full rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-5 py-3.5 font-semibold flex items-center justify-center gap-2 transition-colors`}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        兑换码验证
                      </button>
                      {deviceState.grants.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {deviceState.grants.map(grant => (
                            <span key={grant.feature} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium" style={{ backgroundColor: `${accentColor}18`, color: accentColor }}>
                              <BadgeCheck className="w-3.5 h-3.5" />
                              {grant.label}{grant.expiresAt ? ` · 至 ${new Date(grant.expiresAt * 1000).toLocaleDateString('zh-CN')}` : ' · 永久'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>

                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-1">
                    <p className={`${textTertiary} text-xs`}>© 2026 WaveForge. All rights reserved.</p>
                    <button onClick={() => setShowLegalModal(true)} className={`px-5 py-2.5 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} text-sm font-medium transition-colors`}>法律声明</button>
                  </div>
                </div>
              )}
                        </div>
</div> {/* 关闭内容层 div from line 144 */}
          </motion.div>
        </React.Fragment>
      )}
      
      {/* 首页自定义弹窗 */}
      <HomeCustomizeModal 
        key="home-customize-modal"
        show={showHomeCustomize}
        onClose={() => setShowHomeCustomize(false)}
        playerTheme={playerTheme}
        onBlurAdjustOpen={() => {
          // 当打开模糊度调整时，关闭设置面板
          onClose()
        }}
        onReopenRequest={() => {
          // 重新打开首页自定义面板
          setShowHomeCustomize(true)
        }}
      />
      
      {/* 缓存清理弹窗 */}
      {/* 播放音质弹窗 */}
      <AudioQualitySettingsModal
        key="audio-quality-settings-modal"
        show={showAudioQuality}
        onClose={() => setShowAudioQuality(false)}
        playerTheme={playerTheme}
        neteaseVip={neteaseVip}
        qqVip={qqVip}
        neteaseLoggedIn={neteaseLoggedIn}
        qqLoggedIn={qqLoggedIn}
      />

      {/* 远程遥控器设置弹窗 */}
      <RemoteControlSettingsModal
        show={showRemoteSettings}
        onClose={() => setShowRemoteSettings(false)}
        playerTheme={playerTheme}
      />

      <CacheClearModal 
        key="cache-clear-modal"
        show={showCacheClear}
        onClose={() => setShowCacheClear(false)}
        playerTheme={playerTheme}
      />
      
      {/* 兑换码验证弹窗 */}
      {showRedeemModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => {
            setShowRedeemModal(false)
            setRedeemCode('')
            setRedeemMessage(null)
          }}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border ${
              playerTheme === 'dark'
                ? 'bg-zinc-900 border-zinc-800'
                : 'bg-white border-gray-200'
            } shadow-2xl overflow-hidden`}
          >
            <div className={`px-5 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>兑换码验证</h2>
            </div>
            <div className="px-5 py-5">
              <p className={`text-sm leading-6 ${textSecondary}`}>请将获取到的兑换码粘贴在下方</p>
              <div className="mt-4 flex items-stretch gap-3">
                <input
                  autoFocus
                  value={redeemCode}
                  onChange={(event) => {
                    setRedeemCode(event.target.value)
                    if (redeemMessage?.type === 'error') setRedeemMessage(null)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    void pasteRedeemCode()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && redeemMessage?.type !== 'info') void redeemDeviceCode()
                  }}
                  placeholder="WF1.……"
                  autoComplete="off"
                  spellCheck={false}
                  title="右键可直接粘贴"
                  className={`min-w-0 flex-1 rounded-xl border ${borderColor} ${
                    playerTheme === 'dark' ? 'bg-black/20' : 'bg-black/5'
                  } ${textPrimary} px-4 py-3 font-mono text-sm outline-none focus:ring-2`}
                  style={{ '--tw-ring-color': accentColor } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={() => void pasteRedeemCode()}
                  disabled={redeemMessage?.type === 'info'}
                  className={`shrink-0 rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60`}
                >
                  <ClipboardPaste className="w-4 h-4" />
                  粘贴
                </button>
              </div>
              {redeemMessage && (
                <p className={`mt-3 text-sm ${redeemMessage.type === 'error' ? 'text-red-400' : textSecondary}`}>
                  {redeemMessage.text}
                </p>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    setShowRedeemModal(false)
                    setRedeemCode('')
                    setRedeemMessage(null)
                  }}
                  disabled={redeemMessage?.type === 'info'}
                  className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 font-semibold transition-colors disabled:opacity-60`}
                >
                  取消
                </button>
                <button
                  onClick={() => void redeemDeviceCode()}
                  disabled={redeemMessage?.type === 'info'}
                  className="rounded-xl px-4 py-3 text-white font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: accentColor }}
                >
                  确定
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 设备识别码弹窗 */}
      {showDeviceIdModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowDeviceIdModal(false)}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border ${
              playerTheme === 'dark'
                ? 'bg-zinc-900 border-zinc-800'
                : 'bg-white border-gray-200'
            } shadow-2xl overflow-hidden`}
          >
            <div className={`flex items-center justify-between px-5 py-4 border-b ${
              playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'
            }`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>设备识别码</h2>
              <button
                onClick={() => setShowDeviceIdModal(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
                aria-label="关闭"
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            <div className="px-5 py-5">
              <p className={`text-sm leading-6 ${textSecondary}`}>您的设备识别码为：</p>
              <div className={`mt-3 rounded-xl border ${borderColor} ${
                playerTheme === 'dark' ? 'bg-black/20' : 'bg-black/5'
              } px-4 py-4`}>
                <p className={`font-mono text-sm leading-6 break-all select-all ${textPrimary}`}>
                  {deviceIdForModal}
                </p>
              </div>
              <p className={`mt-4 text-sm leading-6 ${textSecondary}`}>
                请您前往对应平台进行兑换或标记。
              </p>
              <button
                onClick={() => setShowDeviceIdModal(false)}
                className="mt-5 w-full rounded-xl px-4 py-3 text-white font-semibold transition-opacity hover:opacity-90"
                style={{ backgroundColor: accentColor }}
              >
                确定
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 法律声明弹窗 */}
      {showLegalModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowLegalModal(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col`}
          >
            {/* 标题栏 */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-xl font-bold ${textPrimary}`}>法律声明</h2>
              <button
                onClick={() => setShowLegalModal(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>
            
            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className={`space-y-4 ${textSecondary} text-sm leading-relaxed`}>
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>1. 软件使用声明</h3>
                  <p>
                    WaveForge 是一款免费开源的音乐播放器软件。本软件按"现状"提供，不提供任何形式的明示或暗示保证，
                    包括但不限于适销性、特定用途的适用性和非侵权性的保证。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>2. 免责声明</h3>
                  <p>
                    在任何情况下，软件作者或版权持有人均不对任何索赔、损害或其他责任负责，无论这些追责来自合同、
                    侵权或其他行为中，还是产生于、源于或有关于本软件以及本软件的使用或其他处置。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>3. 第三方服务</h3>
                  <p>
                    本软件集成了第三方音乐平台的 API 服务（包括但不限于网易云音乐、QQ音乐等）。
                    用户使用这些服务时需遵守相应平台的服务条款和使用协议。本软件不对第三方服务的可用性、
                    准确性或合法性承担任何责任。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>4. 版权声明</h3>
                  <p>
                    本软件播放的所有音乐内容的版权归原作者及其版权所有者所有。用户应当尊重知识产权，
                    仅将本软件用于个人学习和研究目的。任何商业使用或侵犯版权的行为均与本软件及其开发者无关。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>5. 用户责任</h3>
                  <p>
                    用户应当合法使用本软件，不得利用本软件从事任何违反法律法规的活动。用户因使用本软件
                    而产生的一切后果由用户自行承担，与本软件开发者无关。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>6. 隐私保护</h3>
                  <p>
                    本软件尊重用户隐私。软件不会主动收集、存储或传输用户的个人信息。用户登录第三方平台时，
                    相关凭证仅存储在本地设备，不会上传到任何服务器。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>7. 开源许可</h3>
                  <p>
                    本软件基于开源许可发布，具体许可条款请参阅项目源代码仓库。使用、修改或分发本软件时，
                    请遵守相应的开源许可协议。
                  </p>
                </section>
                
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>8. 更新与变更</h3>
                  <p>
                    本法律声明可能会不定期更新。继续使用本软件即表示您接受更新后的声明内容。
                    重大变更将在软件更新说明中告知用户。
                  </p>
                </section>
                
                <div className={`mt-6 p-4 rounded-lg ${playerTheme === 'dark' ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
                  <p className={`text-xs ${textTertiary}`}>
                    最后更新时间：2026年7月<br />
                    如有任何疑问，请通过 GitHub 或 Gitee 仓库联系开发者。
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

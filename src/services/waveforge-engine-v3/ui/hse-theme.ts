/**
 * HyperSoundEngine 风格主题 —— 深色琥珀金
 *
 * 基于参考图配色：深黑底 (#0d0d0f) + 琥珀金高亮 (#c9a84c, #e8c766)
 * 玻璃拟态卡片 + 内发光边框
 */

import { useEffect, useState } from 'react'

export interface HSETheme {
  dark: true
  accentColor: string
  accentGlow: string
  accentDim: string
  /** 面板背景 */
  panelBg: string
  panelBorder: string
  panelHighlight: string
  /** 卡片背景 */
  cardBg: string
  cardBorder: string
  cardGlow: string
  /** 导航 */
  navBg: string
  navActiveBg: string
  navActiveBorder: string
  navHoverBg: string
  /** 文本 */
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textMuted: string
  /** 输入/滑块 */
  inputBg: string
  trackBg: string
  trackFill: string
  /** 状态 */
  statusOk: string
  statusWarn: string
  /** 毛玻璃 */
  glassBlur: string
  glassCardBlur: string
  /** 滑条辅助 */
  sliderTrack: (value: number, min: number, max: number) => string
}

function useAccentColor(): string {
  const [accentColor, setAccentColor] = useState(() => {
    try {
      const saved = localStorage.getItem('accentColor')
      return saved || '#c9a84c'
    } catch {
      return '#c9a84c'
    }
  })
  useEffect(() => {
    const handleAccentChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail) setAccentColor(customEvent.detail)
    }
    window.addEventListener('accentColorChanged', handleAccentChange)
    return () => window.removeEventListener('accentColorChanged', handleAccentChange)
  }, [])
  return accentColor
}

export function useHSETheme(): HSETheme {
  const accentColor = useAccentColor()
  const amber = '#c9a84c'
  const glow = `${accentColor}44`
  const dim = `${accentColor}22`

  return {
    dark: true,
    accentColor,
    accentGlow: glow,
    accentDim: dim,
    panelBg: 'rgba(18, 18, 22, 0.85)',
    panelBorder: 'rgba(255,255,255,0.08)',
    panelHighlight: 'linear-gradient(160deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 45%, rgba(255,255,255,0.04) 100%)',
    cardBg: 'linear-gradient(150deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 100%)',
    cardBorder: 'rgba(255,255,255,0.08)',
    cardGlow: `0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.12)`,
    navBg: 'rgba(12,12,16,0.7)',
    navActiveBg: `linear-gradient(135deg, ${dim} 0%, ${dim}00 60%)`,
    navActiveBorder: `${accentColor}66`,
    navHoverBg: 'rgba(255,255,255,0.04)',
    textPrimary: 'text-white',
    textSecondary: 'text-white/70',
    textTertiary: 'text-white/45',
    textMuted: 'text-white/25',
    inputBg: 'rgba(255,255,255,0.04)',
    trackBg: 'rgba(255,255,255,0.10)',
    trackFill: accentColor,
    statusOk: '#4ade80',
    statusWarn: '#fbbf24',
    glassBlur: 'blur(24px) saturate(160%)',
    glassCardBlur: 'blur(16px) saturate(140%)',
    sliderTrack: (value: number, min: number, max: number) => {
      const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)))
      const rest = 'rgba(255,255,255,0.12)'
      return `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${ratio * 100}%, ${rest} ${ratio * 100}%, ${rest} 100%)`
    },
  }
}

/**
 * 把 HSE 主题转换为旧 V3Theme 接口（供既有弹窗/面板组件复用）
 * 用于 modals 系列 / eqPanel 等仍依赖 V3Theme 玻璃拟态接口的组件。
 */
export function toLegacyTheme(t: HSETheme): {
  dark: true
  accentColor: string
  glassPanel: string
  glassPanelHighlight: string
  glassCard: string
  glassBorder: string
  glassBlur: string
  glassCardBlur: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  inputBg: string
  sliderTrack: (value: number, min: number, max: number) => string
} {
  return {
    dark: true,
    accentColor: t.accentColor,
    glassPanel: 'rgba(18,18,22,0.92)',
    glassPanelHighlight: t.panelHighlight,
    glassCard: t.cardBg,
    glassBorder: t.cardBorder,
    glassBlur: t.glassBlur,
    glassCardBlur: t.glassCardBlur,
    textPrimary: t.textPrimary,
    textSecondary: t.textSecondary,
    textTertiary: t.textTertiary,
    inputBg: t.inputBg,
    sliderTrack: t.sliderTrack,
  }
}

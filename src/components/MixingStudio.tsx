import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AudioLines, SlidersHorizontal, Music2, Save, Copy, ClipboardPaste, Trash2, Info, FileAudio } from 'lucide-react'
import {
  AudioEffectsEngine,
  type AudioEffectsSettings,
  type DeepPartial,
  type EqMode,
  SIMPLE_EQ_BANDS,
  PRO_EQ_FREQUENCIES,
} from '../services/audioEffects/AudioEffectsEngine'

interface MixingStudioProps {
  engine: AudioEffectsEngine
  onClose: () => void
  playerTheme: 'dark' | 'light'
  sourceUrl?: string
  sourceDuration?: number
  /** 打开按钮的锚点位置（弹窗从按钮侧弹出/关闭时收缩回按钮） */
  anchorRect?: { x: number; y: number; width: number; height: number } | null
}

type Tab = 'effects' | 'eq' | 'tuner'

const PRESETS_KEY = 'waveforge:eq-presets'

interface EqPreset {
  id: string
  name: string
  mode: EqMode
  simpleBands: number[]
  proBands: { frequency: number; gain: number; q: number }[]
}

function loadPresets(): EqPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    return raw ? (JSON.parse(raw) as EqPreset[]) : []
  } catch {
    return []
  }
}

function savePresets(presets: EqPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
  } catch {
    // 忽略
  }
}

export default function MixingStudio({ engine, onClose, playerTheme, sourceUrl, sourceDuration, anchorRect }: MixingStudioProps) {
  const [activeTab, setActiveTab] = useState<Tab>('effects')
  const [settings, setSettings] = useState<AudioEffectsSettings>(engine.getSettings())
  const [presets, setPresets] = useState<EqPreset[]>(loadPresets())
  const [presetName, setPresetName] = useState('')
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')
  const [exporting, setExporting] = useState(false)

  const dark = playerTheme === 'dark'

  // 跟随全局主题色（accentColorChanged 事件实时联动，同其他面板一致）
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#8b5cf6'
  })
  useEffect(() => {
    const handleAccentChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail) setAccentColor(customEvent.detail)
    }
    window.addEventListener('accentColorChanged', handleAccentChange)
    return () => window.removeEventListener('accentColorChanged', handleAccentChange)
  }, [])

  // ── liquid glass 视觉变量（暗色 / 亮色双主题）──
  // 面板背景低不透明度 + 更强毛玻璃：更透更"液态"，背景内容透过玻璃清晰可见
  const glassPanel = dark
    ? 'rgba(10, 12, 20, 0.38)'
    : 'rgba(255, 255, 255, 0.45)'
  const glassPanelHighlight = dark
    ? 'linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.06) 100%)'
    : 'linear-gradient(160deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.35) 45%, rgba(255,255,255,0.55) 100%)'
  const glassCard = dark
    ? 'linear-gradient(150deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 100%)'
    : 'linear-gradient(150deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.30) 100%)'
  const glassBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)'
  // 毛玻璃强度提升约 20%：主面板 24px→30px，卡片 14px→18px，饱和度同步上调
  const glassBlur = 'blur(30px) saturate(185%)'
  const glassCardBlur = 'blur(18px) saturate(160%)'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/65' : 'text-black/65'
  const textTertiary = dark ? 'text-white/40' : 'text-black/45'
  const inputBg = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.5)'

  const update = useCallback((patch: DeepPartial<AudioEffectsSettings>) => {
    engine.updateSettings(patch)
    setSettings(engine.getSettings())
  }, [engine])

  const patchEffects = useCallback((patch: DeepPartial<AudioEffectsSettings['effects']>) => {
    update({ effects: patch })
  }, [update])

  const patchEq = useCallback((patch: DeepPartial<AudioEffectsSettings['eq']>) => {
    update({ eq: patch })
  }, [update])

  const patchPitch = useCallback((patch: DeepPartial<AudioEffectsSettings['pitch']>) => {
    update({ pitch: patch })
  }, [update])

  // ---- EQ 预设 ----
  const currentPresetJson = useMemo(() => {
    const { mode, simpleBands, proBands } = settings.eq
    return JSON.stringify({ mode, simpleBands, proBands })
  }, [settings.eq])

  const handleSavePreset = () => {
    const name = presetName.trim() || `均衡器 ${presets.length + 1}`
    if (presets.length >= 8) return
    const next: EqPreset[] = [...presets, {
      id: `${Date.now()}`,
      name,
      mode: settings.eq.mode,
      simpleBands: [...settings.eq.simpleBands],
      proBands: settings.eq.proBands.map(b => ({ ...b })),
    }]
    setPresets(next)
    savePresets(next)
    setPresetName('')
  }

  const handleApplyPreset = (preset: EqPreset) => {
    patchEq({ mode: preset.mode, simpleBands: [...preset.simpleBands], proBands: preset.proBands.map(b => ({ ...b })) })
  }

  const handleDeletePreset = (id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next)
    savePresets(next)
  }

  const handleExport = () => {
    setExportText(currentPresetJson)
  }

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(currentPresetJson)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器设置已复制到剪贴板', type: 'info' } }))
    } catch {
      setExportText(currentPresetJson)
    }
  }

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText) as { mode?: EqMode; simpleBands?: number[]; proBands?: { frequency: number; gain: number; q: number }[] }
      if (parsed.mode && Array.isArray(parsed.simpleBands) && parsed.simpleBands.length === 5 && Array.isArray(parsed.proBands)) {
        patchEq({
          mode: parsed.mode,
          simpleBands: parsed.simpleBands,
          proBands: parsed.proBands,
        })
        setImportText('')
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器设置已导入', type: 'info' } }))
      } else {
        throw new Error('格式无效')
      }
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导入失败：JSON 格式无效', type: 'error' } }))
    }
  }

  const handleExportWav = async () => {
    if (!sourceUrl) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前没有正在播放的歌曲', type: 'error' } }))
      return
    }
    setExporting(true)
    try {
      await engine.exportToWav(sourceUrl, sourceDuration || 0)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已导出处理后的音频（WAV）', type: 'info' } }))
    } catch (error) {
      console.error('[MixingStudio] 导出失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导出失败：' + (error instanceof Error ? error.message : '未知错误'), type: 'error' } }))
    } finally {
      setExporting(false)
    }
  }

  const sliderTrack = (value: number, min: number, max: number) =>
    `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((value - min) / (max - min)) * 100}%, ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'} ${((value - min) / (max - min)) * 100}%, ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'} 100%)`

  const renderToggle = (checked: boolean, onChange: (v: boolean) => void) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? '' : dark ? 'bg-white/20' : 'bg-black/15'}`}
      style={checked ? { backgroundColor: accentColor, boxShadow: `0 0 12px ${accentColor}55` } : undefined}
    >
      <span
        className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )

  const renderEffectCard = (
    title: string,
    desc: string,
    enabled: boolean,
    onToggle: (v: boolean) => void,
    children: React.ReactNode,
  ) => (
    <div
      className="relative rounded-2xl p-4 overflow-hidden"
      style={{
        background: glassCard,
        backdropFilter: glassCardBlur,
        WebkitBackdropFilter: glassCardBlur,
        border: `1px solid ${glassBorder}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      {/* 顶部高光 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)' }} />
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className={`${textPrimary} font-medium`}>{title}</div>
          <div className={`${textSecondary} text-xs mt-0.5`}>{desc}</div>
        </div>
        {renderToggle(enabled, onToggle)}
      </div>
      {children}
    </div>
  )

  const renderRange = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    display?: string,
  ) => (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className={`${textSecondary} text-xs`}>{label}</span>
        <span className={`${textPrimary} text-xs font-medium`}>{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
        style={{ background: sliderTrack(value, min, max) }}
      />
    </div>
  )

  // glass 卡片包装（面板内通用）
  const glassCardShell = (children: React.ReactNode) => (
    <div
      className="relative rounded-2xl p-4 overflow-hidden"
      style={{
        background: glassCard,
        backdropFilter: glassCardBlur,
        WebkitBackdropFilter: glassCardBlur,
        border: `1px solid ${glassBorder}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)' }} />
      {children}
    </div>
  )

  return (
    <>
      {/* 玻璃滑块 thumb 全局样式（双主题） */}
      <style>
        {`
          .wf-glass-range::-webkit-slider-thumb {
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.92);
            border: 2px solid rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          .wf-glass-range::-webkit-slider-thumb:hover {
            transform: scale(1.2);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
          .wf-glass-range::-webkit-slider-thumb:active {
            transform: scale(1.05);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), 0 0 0 4px ${accentColor}66, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
          .wf-glass-range::-moz-range-thumb {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.92);
            border: 2px solid rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          .wf-glass-range::-moz-range-thumb:hover {
            transform: scale(1.2);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
        `}
      </style>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-8"
        style={{
          backgroundColor: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
          backdropFilter: 'blur(6px) saturate(140%)',
          WebkitBackdropFilter: 'blur(6px) saturate(140%)',
        }}
        onClick={onClose}
      >
        <motion.div
          // 弹窗从打开按钮的锚点侧弹出（缩放 + 透明度 + 位移），关闭时收缩回按钮位置后消失。
          // 无锚点（如初次渲染兜底）时退化为居中缩放弹出。
          initial={{ scale: 0.5, opacity: 0, x: anchorRect ? anchorRect.x - (window.innerWidth / 2) : 0, y: anchorRect ? anchorRect.y - (window.innerHeight / 2) : 0 }}
          animate={{ scale: 1, opacity: 1, x: 0, y: 0 }}
          exit={{ scale: 0.5, opacity: 0, x: anchorRect ? anchorRect.x - (window.innerWidth / 2) : 0, y: anchorRect ? anchorRect.y - (window.innerHeight / 2) : 0 }}
          transition={{ type: 'spring', damping: 26, stiffness: 300, mass: 0.9 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl"
          style={{
            background: glassPanel,
            backdropFilter: glassBlur,
            WebkitBackdropFilter: glassBlur,
            border: `1px solid ${glassBorder}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          {/* 面板顶部渐变高光 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24" style={{ background: glassPanelHighlight, borderRadius: '1.5rem 1.5rem 0 0' }} />

          {/* 头部 */}
          <div className="relative flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: `${accentColor}2e`, border: `1px solid ${accentColor}55`, boxShadow: `0 4px 14px ${accentColor}33` }}
              >
                <AudioLines className="w-4.5 h-4.5" style={{ color: accentColor }} />
              </div>
              <div>
                <h2 className={`text-lg font-semibold ${textPrimary}`}>调音室</h2>
                <div className={`${textTertiary} text-[11px] -mt-0.5`}>云澜音效 · 均衡器 · 变调变速 · WAV 导出</div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}
            >
              <X className={`w-5 h-5 ${textSecondary}`} />
            </button>
          </div>

          {/* Tab 栏 */}
          <div className="relative flex px-3 pt-2 gap-1" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            {([
              { key: 'effects', label: '云澜音效', icon: Music2 },
              { key: 'eq', label: '均衡器', icon: SlidersHorizontal },
              { key: 'tuner', label: '调音器', icon: AudioLines },
            ] as const).map((tab) => {
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2.5 flex items-center justify-center gap-1.5 text-sm rounded-t-xl transition-all ${
                    active
                      ? `${textPrimary} font-medium`
                      : `${textSecondary} hover:${textPrimary}`
                  }`}
                  style={active ? {
                    background: dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.5)',
                    border: `1px solid ${glassBorder}`,
                    borderBottom: 'none',
                    color: accentColor,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
                  } : undefined}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                  {active && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accentColor }} />}
                </button>
              )
            })}
          </div>

          {/* 内容 */}
          <div className="relative p-4 sm:p-5 overflow-y-auto" style={{ height: 'calc(88vh - 140px)' }}>
            <AnimatePresence mode="wait">
              {activeTab === 'effects' && (
                <motion.div key="effects" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                  {renderEffectCard('全景声厅', '让声场更宽广 + 大厅混响', settings.effects.hall.enabled, (v) => patchEffects({ hall: { ...settings.effects.hall, enabled: v } }),
                    renderRange('全景幅度', settings.effects.hall.level, 1, 6, 1, (v) => patchEffects({ hall: { ...settings.effects.hall, level: v } }), `${settings.effects.hall.level} 级`))}
                  {renderEffectCard('3D 环绕', '耳机内环绕旋转的立体声场', settings.effects.surround3d.enabled, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, enabled: v } }), (
                    <>
                      {renderRange('环绕近远', settings.effects.surround3d.distance, 1, 6, 1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, distance: v } }))}
                      {renderRange('环绕速度', settings.effects.surround3d.speed, 0.2, 3, 0.1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, speed: v } }), `${settings.effects.surround3d.speed.toFixed(1)}x`)}
                    </>
                  ))}
                  {renderEffectCard('低音增强', '增强低频的厚度与力度', settings.effects.bassBoost.enabled, (v) => patchEffects({ bassBoost: { ...settings.effects.bassBoost, enabled: v } }), (
                    <>
                      {renderRange('深度', settings.effects.bassBoost.depth, 60, 200, 5, (v) => patchEffects({ bassBoost: { ...settings.effects.bassBoost, depth: v } }), `${settings.effects.bassBoost.depth}Hz`)}
                      {renderRange('强度', settings.effects.bassBoost.intensity, 0, 12, 0.5, (v) => patchEffects({ bassBoost: { ...settings.effects.bassBoost, intensity: v } }), `+${settings.effects.bassBoost.intensity.toFixed(1)}dB`)}
                    </>
                  ))}
                  {renderEffectCard('人声加强', '提升人声存在感与清晰度', settings.effects.vocalBoost.enabled, (v) => patchEffects({ vocalBoost: { ...settings.effects.vocalBoost, enabled: v } }),
                    renderRange('强度', settings.effects.vocalBoost.intensity, 0, 9, 0.5, (v) => patchEffects({ vocalBoost: { ...settings.effects.vocalBoost, intensity: v } }), `+${settings.effects.vocalBoost.intensity.toFixed(1)}dB`))}
                  {renderEffectCard('伴奏加强', '削弱人声频段、突出伴奏', settings.effects.accompanimentBoost.enabled, (v) => patchEffects({ accompanimentBoost: { ...settings.effects.accompanimentBoost, enabled: v } }),
                    renderRange('强度', settings.effects.accompanimentBoost.intensity, 0, 9, 0.5, (v) => patchEffects({ accompanimentBoost: { ...settings.effects.accompanimentBoost, intensity: v } }), `-${settings.effects.accompanimentBoost.intensity.toFixed(1)}dB`))}
                </motion.div>
              )}

              {activeTab === 'eq' && (
                <motion.div key="eq" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-4">
                  {/* 开关 + 模式 */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium`}>均衡器</div>
                          <div className={`${textSecondary} text-xs`}>调整各频段的增益</div>
                        </div>
                        {renderToggle(settings.eq.enabled, (v) => patchEq({ enabled: v }))}
                      </div>
                      {settings.eq.enabled && (
                        <div className="flex gap-2 mt-3">
                          <button
                            type="button"
                            onClick={() => patchEq({ mode: 'simple' })}
                            className={`flex-1 py-2 rounded-lg text-sm transition-all ${settings.eq.mode === 'simple' ? 'text-white font-medium' : `${textSecondary} ${dark ? 'bg-white/5' : 'bg-black/5'}`}`}
                            style={settings.eq.mode === 'simple' ? { backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` } : undefined}
                          >
                            简约
                          </button>
                          <button
                            type="button"
                            onClick={() => patchEq({ mode: 'pro' })}
                            className={`flex-1 py-2 rounded-lg text-sm transition-all ${settings.eq.mode === 'pro' ? 'text-white font-medium' : `${textSecondary} ${dark ? 'bg-white/5' : 'bg-black/5'}`}`}
                            style={settings.eq.mode === 'pro' ? { backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` } : undefined}
                          >
                            专业
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* 频段滑杆 */}
                  {settings.eq.enabled && (
                    glassCardShell(
                      <div className="space-y-3">
                        {settings.eq.mode === 'simple' ? (
                          <>
                            <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                              <Info className="w-3.5 h-3.5" /> 使用说明：往上加重该频段、往下减弱；建议从 0 开始微调。
                            </div>
                            {SIMPLE_EQ_BANDS.map((band, i) => (
                              <div key={band.frequency}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className={`${textSecondary} text-xs`}>{band.label}（{band.frequency}Hz）</span>
                                  <span className={`${textPrimary} text-xs font-medium`}>{settings.eq.simpleBands[i] > 0 ? '+' : ''}{settings.eq.simpleBands[i].toFixed(1)}dB</span>
                                </div>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={0.5}
                                  value={settings.eq.simpleBands[i]}
                                  onChange={(e) => {
                                    const next = [...settings.eq.simpleBands]
                                    next[i] = parseFloat(e.target.value)
                                    patchEq({ simpleBands: next })
                                  }}
                                  className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
                                  style={{ background: sliderTrack(settings.eq.simpleBands[i], -12, 12) }}
                                />
                                <div className={`${textTertiary} text-xs mt-0.5`}>{band.hint}</div>
                              </div>
                            ))}
                          </>
                        ) : (
                          <>
                            <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                              <Info className="w-3.5 h-3.5" /> 专业版：10 段倍频程均衡，每段独立调节增益，双击滑杆归零。
                            </div>
                            {settings.eq.proBands.map((band, i) => (
                              <div key={band.frequency}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className={`${textSecondary} text-xs`}>{band.frequency >= 1000 ? `${band.frequency / 1000}k` : band.frequency}Hz</span>
                                  <span className={`${textPrimary} text-xs font-medium`}>{band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}dB</span>
                                </div>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={0.5}
                                  value={band.gain}
                                  onChange={(e) => {
                                    const next = settings.eq.proBands.map(b => ({ ...b }))
                                    next[i].gain = parseFloat(e.target.value)
                                    patchEq({ proBands: next })
                                  }}
                                  className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
                                  style={{ background: sliderTrack(band.gain, -12, 12) }}
                                />
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    )
                  )}

                  {/* 预设 */}
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-2`}>预设（{presets.length}/8）</div>
                      <div className="flex gap-2 mb-3">
                        <input
                          value={presetName}
                          onChange={(e) => setPresetName(e.target.value)}
                          placeholder="预设名称"
                          className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none transition-shadow ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}
                        />
                        <button
                          type="button"
                          onClick={handleSavePreset}
                          disabled={presets.length >= 8}
                          className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-95`}
                          style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}
                        >
                          <Save className="w-4 h-4" /> 保存
                        </button>
                      </div>
                      {presets.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {presets.map(preset => (
                            <div key={preset.id} className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(preset)}
                                className={`px-3 py-1.5 rounded-lg text-xs transition-opacity hover:opacity-80 ${textPrimary}`}
                                style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}
                              >
                                {preset.name}
                              </button>
                              <button type="button" onClick={() => handleDeletePreset(preset.id)} className={`p-1 ${textTertiary} hover:${textPrimary}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* 导入导出 */}
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-2`}>导入 / 导出</div>
                      <div className="flex gap-2 mb-2">
                        <button type="button" onClick={handleCopyExport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white transition-all hover:brightness-110 active:scale-95`} style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}>
                          <Copy className="w-4 h-4" /> 复制我的设置
                        </button>
                        <button type="button" onClick={handleExport} className={`px-3 py-2 rounded-lg text-sm transition-opacity hover:opacity-80 ${textPrimary}`} style={{ background: inputBg, border: `1px solid ${glassBorder}` }}>
                          显示导出文本
                        </button>
                      </div>
                      {exportText && (
                        <textarea
                          readOnly
                          value={exportText}
                          className={`w-full h-20 px-3 py-2 rounded-lg text-xs outline-none ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                        />
                      )}
                      <div className="flex gap-2 mt-2">
                        <textarea
                          value={importText}
                          onChange={(e) => setImportText(e.target.value)}
                          placeholder="粘贴别人分享的均衡器 JSON 到这里"
                          className={`flex-1 h-16 px-3 py-2 rounded-lg text-xs outline-none ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                        />
                        <button type="button" onClick={handleImport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white transition-all hover:brightness-110 active:scale-95`} style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}>
                          <ClipboardPaste className="w-4 h-4" /> 导入
                        </button>
                      </div>
                    </>
                  )}
                </motion.div>
              )}

              {activeTab === 'tuner' && (
                <motion.div key="tuner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-3`}>人声 / 伴奏比例</div>
                      {renderRange('人声 ↔ 伴奏', settings.pitch.voiceBalance, -1, 1, 0.05, (v) => patchPitch({ voiceBalance: v }), settings.pitch.voiceBalance === 0 ? '原声' : settings.pitch.voiceBalance > 0 ? `人声 +${Math.round(settings.pitch.voiceBalance * 100)}%` : `伴奏 +${Math.round(-settings.pitch.voiceBalance * 100)}%`)}
                      <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                        <Info className="w-3.5 h-3.5" /> 基于中/侧声道分离，会同时影响居中的低频，效果为卡拉OK级。
                      </div>
                    </>
                  )}

                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-3`}>变调 / 变速</div>
                      {renderRange('变调', settings.pitch.semitones, -10, 10, 0.5, (v) => patchPitch({ semitones: v }), `${settings.pitch.semitones > 0 ? '+' : ''}${settings.pitch.semitones} 半音`)}
                      {renderRange('倍速', settings.pitch.rate, 0.25, 3, 0.05, (v) => patchPitch({ rate: v }), `${settings.pitch.rate.toFixed(2)}x`)}
                      <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                        <Info className="w-3.5 h-3.5" /> 基于 SoundTouch 实时处理，变调与变速互相独立。
                      </div>
                    </>
                  )}

                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-1`}>导出处理后的音乐</div>
                      <div className={`${textSecondary} text-xs mb-3`}>把当前音效与均衡器离线渲染成 WAV 文件下载（个人处理用途，涉及版权曲目请勿分发）</div>
                      <button
                        type="button"
                        onClick={() => void handleExportWav()}
                        disabled={exporting || !sourceUrl}
                        className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
                        style={{ backgroundColor: accentColor, boxShadow: `0 6px 18px ${accentColor}44` }}
                      >
                        <FileAudio className="w-4 h-4" />
                        {exporting ? '导出中…' : '导出 WAV'}
                      </button>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </>
  )
}

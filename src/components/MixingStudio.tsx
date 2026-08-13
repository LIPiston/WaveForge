import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AudioLines, SlidersHorizontal, Music2, Save, Copy, ClipboardPaste, Trash2, Info } from 'lucide-react'
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

export default function MixingStudio({ engine, onClose, playerTheme }: MixingStudioProps) {
  const [activeTab, setActiveTab] = useState<Tab>('effects')
  const [settings, setSettings] = useState<AudioEffectsSettings>(engine.getSettings())
  const [presets, setPresets] = useState<EqPreset[]>(loadPresets())
  const [presetName, setPresetName] = useState('')
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')

  const dark = playerTheme === 'dark'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'
  const textTertiary = dark ? 'text-white/40' : 'text-black/40'
  const bgCard = dark ? 'bg-white/5' : 'bg-black/5'
  const borderColor = dark ? 'border-white/10' : 'border-black/10'
  const accentColor = '#8b5cf6'

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

  const sliderTrack = (value: number, min: number, max: number) =>
    `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((value - min) / (max - min)) * 100}%, rgba(255,255,255,0.2) ${((value - min) / (max - min)) * 100}%, rgba(255,255,255,0.2) 100%)`

  const renderToggle = (checked: boolean, onChange: (v: boolean) => void) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? '' : dark ? 'bg-white/20' : 'bg-black/20'}`}
      style={checked ? { backgroundColor: accentColor } : undefined}
    >
      <span
        className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform"
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
    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
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
        className="w-full h-2 rounded-lg appearance-none cursor-pointer"
        style={{ background: sliderTrack(value, min, max) }}
      />
    </div>
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-8"
      style={{ backgroundColor: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl border ${borderColor}`}
        style={{
          background: dark ? 'linear-gradient(135deg, rgba(10,12,18,0.96), rgba(20,22,32,0.96))' : 'linear-gradient(135deg, rgba(255,255,255,0.97), rgba(245,245,250,0.97))',
        }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
              <AudioLines className="w-4 h-4" style={{ color: accentColor }} />
            </div>
            <h2 className={`text-lg font-semibold ${textPrimary}`}>调音室</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
          >
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        {/* Tab 栏 */}
        <div className="flex border-b border-white/10">
          {([
            { key: 'effects', label: '云澜音效', icon: Music2 },
            { key: 'eq', label: '均衡器', icon: SlidersHorizontal },
            { key: 'tuner', label: '调音器', icon: AudioLines },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 py-3 px-2 flex items-center justify-center gap-1.5 text-sm transition-colors ${
                activeTab === tab.key
                  ? `${textPrimary} border-b-2`
                  : `${textSecondary} hover:${textPrimary} border-b-2 border-transparent`
              }`}
              style={activeTab === tab.key ? { borderColor: accentColor } : undefined}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div className="p-5 overflow-y-auto" style={{ height: 'calc(88vh - 130px)' }}>
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
                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
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
                        className={`flex-1 py-2 rounded-lg text-sm transition-colors ${settings.eq.mode === 'simple' ? 'text-white' : `${textSecondary} ${bgCard}`}`}
                        style={settings.eq.mode === 'simple' ? { backgroundColor: accentColor } : undefined}
                      >
                        简约
                      </button>
                      <button
                        type="button"
                        onClick={() => patchEq({ mode: 'pro' })}
                        className={`flex-1 py-2 rounded-lg text-sm transition-colors ${settings.eq.mode === 'pro' ? 'text-white' : `${textSecondary} ${bgCard}`}`}
                        style={settings.eq.mode === 'pro' ? { backgroundColor: accentColor } : undefined}
                      >
                        专业
                      </button>
                    </div>
                  )}
                </div>

                {/* 频段滑杆 */}
                {settings.eq.enabled && (
                  <div className={`${bgCard} rounded-xl p-4 border ${borderColor} space-y-3`}>
                    {settings.eq.mode === 'simple' ? (
                      <>
                        <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                          <Info className="w-3.5 h-3.5" /> 使用说明：往上加重该频段、往下减弱；双击滑杆可归零。建议从 0 开始微调。
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
                              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
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
                              className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                              style={{ background: sliderTrack(band.gain, -12, 12) }}
                            />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}

                {/* 预设 */}
                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                  <div className={`${textPrimary} font-medium mb-2`}>预设（{presets.length}/8）</div>
                  <div className="flex gap-2 mb-3">
                    <input
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      placeholder="预设名称"
                      className={`flex-1 px-3 py-2 rounded-lg text-sm border ${borderColor} ${textPrimary} ${dark ? 'bg-white/5' : 'bg-black/5'} outline-none`}
                    />
                    <button
                      type="button"
                      onClick={handleSavePreset}
                      disabled={presets.length >= 8}
                      className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white disabled:opacity-40`}
                      style={{ backgroundColor: accentColor }}
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
                            className={`px-3 py-1.5 rounded-lg text-xs border ${borderColor} ${textPrimary} ${bgCard} hover:opacity-80 transition-opacity`}
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
                </div>

                {/* 导入导出 */}
                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                  <div className={`${textPrimary} font-medium mb-2`}>导入 / 导出</div>
                  <div className="flex gap-2 mb-2">
                    <button type="button" onClick={handleCopyExport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white`} style={{ backgroundColor: accentColor }}>
                      <Copy className="w-4 h-4" /> 复制我的设置
                    </button>
                    <button type="button" onClick={handleExport} className={`px-3 py-2 rounded-lg text-sm border ${borderColor} ${textPrimary}`}>
                      显示导出文本
                    </button>
                  </div>
                  {exportText && (
                    <textarea
                      readOnly
                      value={exportText}
                      className={`w-full h-20 px-3 py-2 rounded-lg text-xs border ${borderColor} ${textPrimary} ${dark ? 'bg-black/20' : 'bg-black/5'} outline-none`}
                    />
                  )}
                  <div className="flex gap-2 mt-2">
                    <textarea
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      placeholder="粘贴别人分享的均衡器 JSON 到这里"
                      className={`flex-1 h-16 px-3 py-2 rounded-lg text-xs border ${borderColor} ${textPrimary} ${dark ? 'bg-white/5' : 'bg-black/5'} outline-none`}
                    />
                    <button type="button" onClick={handleImport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white`} style={{ backgroundColor: accentColor }}>
                      <ClipboardPaste className="w-4 h-4" /> 导入
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'tuner' && (
              <motion.div key="tuner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                  <div className={`${textPrimary} font-medium mb-3`}>人声 / 伴奏比例</div>
                  {renderRange('人声 ↔ 伴奏', settings.pitch.voiceBalance, -1, 1, 0.05, (v) => patchPitch({ voiceBalance: v }), settings.pitch.voiceBalance === 0 ? '原声' : settings.pitch.voiceBalance > 0 ? `人声 +${Math.round(settings.pitch.voiceBalance * 100)}%` : `伴奏 +${Math.round(-settings.pitch.voiceBalance * 100)}%`)}
                  <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                    <Info className="w-3.5 h-3.5" /> 基于中/侧声道分离，会同时影响居中的低频，效果为卡拉OK级。
                  </div>
                </div>

                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                  <div className={`${textPrimary} font-medium mb-3`}>变调 / 变速</div>
                  {renderRange('变调', settings.pitch.semitones, -10, 10, 0.5, (v) => patchPitch({ semitones: v }), `${settings.pitch.semitones > 0 ? '+' : ''}${settings.pitch.semitones} 半音`)}
                  {renderRange('倍速', settings.pitch.rate, 0.25, 3, 0.05, (v) => patchPitch({ rate: v }), `${settings.pitch.rate.toFixed(2)}x`)}
                  <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                    <Info className="w-3.5 h-3.5" /> 基于 SoundTouch 实时处理，变调与变速互相独立。
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  )
}

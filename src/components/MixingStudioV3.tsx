import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music2, SlidersHorizontal, Cpu, Ear, Save, Trash2, FileAudio, Volume2, Smartphone, Headphones, Bluetooth, Speaker, RotateCcw } from 'lucide-react'
import {
  AudioEffectsEngineV3,
  type V3Settings,
  type DeepPartial,
  type V3EqMode,
} from '../services/audio-effects-v3/AudioEffectsEngineV3'
import { EQ_BANDS_20, EQ_PRESET_NAMES, EQ_PRESET_CURVES, DEVICE_PROFILES } from '../services/audio-effects-v3/constants'
import { evaluateCurveAt, setBand, addBandAt, removeBandAt, sortCurve } from '../services/audio-effects-v3/curve'
import type { DeviceModelOption } from '../services/audio-effects-v3/deviceDb'
import type { BuiltinReverbType } from '../services/audio-effects-v3/convolution'
import { IEQ_STYLE_NAMES, loadCustomIeq } from '../services/audio-effects-v3/ieq'
import { defaultLoudnessCurve, sampleCurveAtPercent } from '../services/audio-effects-v3/frequencyResponse'
import ResponseCurveGraph from './ResponseCurveGraph'
import DraggableCurveEditor from './DraggableCurveEditor'
import { detectAudioCapabilities, summarizeCapabilities, type AudioCapabilitiesReport } from '../services/audio-effects-v3/audioCapabilities'

/**
 * 调音室 v3 UI（独立实现，仅调用 v3 引擎 API）
 *
 * 分区：
 *   models   —— 机型基础预设（品牌分组网格）+ 输出设备自动适配（Windows 端点）
 *   eq       —— 20 段均衡器 + 5 预设 + 曲线编辑 + 设备档案
 *   advanced —— PEQ(64阶IIR) / 低频增强 / 虚拟低频 / 齿音抑制 / 卷积(含内置混响) / 压缩 / 夜间 / 智能响度 / 场景
 *   hearing  —— 听力分析（听感分析引导调校）
 */

interface MixingStudioV3Props {
  engine: AudioEffectsEngineV3
  onClose: () => void
  playerTheme: 'dark' | 'light'
  sourceUrl?: string
  sourceDuration?: number
  anchorRect?: { x: number; y: number; width: number; height: number } | null
  engineVersion?: 'v1' | 'v2' | 'v3'
  onSwitchEngine?: (version: 'v1' | 'v2' | 'v3') => void
}

type Tab = 'models' | 'eq' | 'advanced' | 'hearing'

const TAB_META: Array<{ id: Tab; label: string; icon: typeof Music2 }> = [
  { id: 'models', label: '机型预设', icon: Smartphone },
  { id: 'eq', label: '均衡器', icon: SlidersHorizontal },
  { id: 'advanced', label: '高级音效', icon: Cpu },
  { id: 'hearing', label: '听力分析', icon: Ear },
]

// 20 段频点显示名（Hz）
const BAND_LABELS = EQ_BANDS_20.map(f => (f >= 1000 ? (f / 1000).toFixed(f % 1000 === 0 ? 0 : 1) + 'k' : String(f)))

const OUTPUT_KINDS: Array<{ kind: 'speaker' | 'headphones' | 'bluetooth' | 'unknown'; label: string; icon: typeof Speaker }> = [
  { kind: 'speaker', label: '外放', icon: Speaker },
  { kind: 'headphones', label: '耳机', icon: Headphones },
  { kind: 'bluetooth', label: '蓝牙', icon: Bluetooth },
]

const FEEDBACK_BUTTONS: Array<{ value: 'more' | 'less' | 'ok' | 'muddy' | 'harsh'; label: string; hint: string }> = [
  { value: 'more', label: '再沉一点', hint: '增强当前频段' },
  { value: 'less', label: '轻一点', hint: '减弱当前频段' },
  { value: 'ok', label: '合适', hint: '进入下一项' },
  { value: 'muddy', label: '有点糊', hint: '削中低频' },
  { value: 'harsh', label: '有点刺', hint: '削高频' },
]

export default function MixingStudioV3({
  engine, onClose, playerTheme, sourceUrl, sourceDuration, engineVersion = 'v3', onSwitchEngine,
}: MixingStudioV3Props) {
  const [activeTab, setActiveTab] = useState<Tab>('models')
  const [settings, setSettings] = useState<V3Settings>(() => engine.getSettings())
  const [modelGroups, setModelGroups] = useState(() => engine.getDeviceModelGroups())
  const [builtinReverbs] = useState(() => engine.getBuiltinReverbs())
  const [sceneName, setSceneName] = useState('')
  const [profileName, setProfileName] = useState('')
  const [importingIr, setImportingIr] = useState(false)
  const [shareText, setShareText] = useState('')
  const [shareNotice, setShareNotice] = useState('')
  const [eqUiLock, setEqUiLock] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [capReport, setCapReport] = useState<AudioCapabilitiesReport | null>(null)
  const [capChecking, setCapChecking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [customizedHint, setCustomizedHint] = useState(false)

  const dark = playerTheme === 'dark'
  const glassPanel = dark ? 'rgba(10, 12, 20, 0.38)' : 'rgba(255, 255, 255, 0.45)'
  const glassCard = dark
    ? 'linear-gradient(150deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 100%)'
    : 'linear-gradient(150deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.30) 100%)'
  const glassBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/65' : 'text-black/65'
  const textTertiary = dark ? 'text-white/40' : 'text-black/45'
  const inputBg = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.5)'

  // 主题色联动（与项目其他面板一致）
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#8b5cf6')
  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  const refresh = useCallback(() => {
    setSettings(engine.getSettings())
    setModelGroups(engine.getDeviceModelGroups())
  }, [engine])

  const update = useCallback((patch: DeepPartial<V3Settings>) => {
    engine.updateSettings(patch)
    refresh()
  }, [engine, refresh])

  // 当前 20 段增益（供滑条显示）
  const bandGains = useMemo(() => {
    const curve = engine.currentEqCurve()
    return EQ_BANDS_20.map(f => evaluateCurveAt(curve, f))
  }, [engine, settings])

  // ── 均衡器操作 ──

  const applyEqMode = (mode: V3EqMode, presetIndex = settings.eq.presetIndex) => {
    update({ eq: { mode, presetIndex, enabled: mode !== 'flat' ? settings.eq.enabled || true : settings.eq.enabled } })
  }

  const setPreset = (index: number) => {
    // 预设曲线 → 10 段增益 → 曲线点（Q=1）
    const gains = EQ_PRESET_CURVES[index]!
    const curve = [47, 234, 469, 844, 1313, 2250, 3750, 5813, 9000, 13875].map((freq, i) => ({
      freq, gain: gains[i]!, q: 1,
    }))
    update({ eq: { mode: 'preset', presetIndex: index, curve: sortCurve(curve), enabled: true } })
  }

  const setBandSlider = (index: number, gain: number) => {
    const freq = EQ_BANDS_20[index]!
    const curve = settings.eq.curve
    const existing = curve.findIndex(p => Math.abs(p.freq - freq) < 1)
    let next: typeof curve
    if (existing >= 0) next = setBand(curve, existing, { gain })
    else next = sortCurve([...curve, { freq, gain, q: 1 }])
    update({ eq: { mode: 'curve', curve: next, enabled: true } })
  }

  const resetEq = () => {
    update({ eq: { mode: 'flat', presetIndex: 1, curve: [47, 141, 234, 328, 469, 656, 844, 1031, 1313, 1688, 2250, 3000, 3750, 4688, 5813, 7125, 9000, 11250, 13875, 19688].map(f => ({ freq: f, gain: 0, q: 1 })), enabled: false } })
  }

  // ── PEQ 操作 ──

  const setPeqBand = (index: number, patch: { freq?: number; gain?: number; q?: number }) => {
    const bands = settings.peq.bands.map((b, i) => (i === index ? { ...b, ...patch } : b))
    update({ peq: { bands } })
  }

  // ── 卷积 IR 文件 ──

  const onIrFile = async (file: File | undefined) => {
    if (!file) return
    setImportingIr(true)
    try {
      const buf = await file.arrayBuffer()
      await engine.setImpulseResponse(buf)
      refresh()
    } catch (err) {
      console.warn('[MixingStudioV3] IR 加载失败:', err)
    } finally {
      setImportingIr(false)
    }
  }

  // ── 场景 / 档案 ──

  const saveScene = () => {
    if (engine.saveAsMyScene(sceneName)) {
      setSceneName('')
      refresh()
    }
  }

  const saveProfile = () => {
    if (engine.saveCurrentAsAppProfile(profileName || undefined)) {
      setProfileName('')
      refresh()
    }
  }

  // ── 导出 ──

  const doExport = async () => {
    if (!sourceUrl || exporting) return
    setExporting(true)
    try {
      await engine.exportToWav(sourceUrl, sourceDuration ?? 30)
    } catch (err) {
      console.warn('[MixingStudioV3] 导出失败:', err)
    } finally {
      setExporting(false)
    }
  }

  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, suffix = '') => (
    <div className="flex items-center gap-3 py-1.5">
      <span className={'w-24 shrink-0 text-xs ' + textSecondary}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1"
        style={{ accentColor }}
      />
      <span className={'w-14 shrink-0 text-right text-xs tabular-nums ' + textTertiary}>
        {value}{suffix}
      </span>
    </div>
  )

  const toggleRow = (label: string, desc: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div className="flex items-center justify-between py-1.5">
      <div className="min-w-0">
        <div className={'text-sm ' + textPrimary}>{label}</div>
        <div className={'text-xs ' + textTertiary}>{desc}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className="ml-3 shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors"
        style={{
          background: checked ? accentColor : inputBg,
          color: checked ? '#fff' : textTertiary,
          border: '1px solid ' + (checked ? 'transparent' : glassBorder),
        }}
      >
        {checked ? '已启用' : '使用'}
      </button>
    </div>
  )

  const sectionCard = (title: string, icon: typeof Music2, children: React.ReactNode) => {
    const Icon = icon
    return (
      <div className="rounded-2xl p-4 mb-3" style={{ background: glassCard, border: '1px solid ' + glassBorder }}>
        <div className={'flex items-center gap-2 mb-2 text-sm font-medium ' + textPrimary}>
          <Icon size={16} style={{ color: accentColor }} />
          {title}
        </div>
        {children}
      </div>
    )
  }

  const eq = settings.eq
  const adv = settings.advanced
  const conv = adv.convolution

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="fixed z-[100] rounded-3xl p-5 shadow-2xl"
      style={{
        background: glassPanel,
        backdropFilter: 'blur(30px) saturate(185%)',
        border: '1px solid ' + glassBorder,
        width: 720,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: '82vh',
      }}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Music2 size={20} style={{ color: accentColor }} />
          <span className={'text-base font-semibold ' + textPrimary}>调音室 v3</span>
          {settings.device.modelName && (
            <span className="rounded-full px-2.5 py-0.5 text-xs" style={{ background: inputBg, color: accentColor }}>
              机型：{settings.device.modelName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSwitchEngine && (
            <div className="flex rounded-full p-0.5" style={{ background: inputBg, border: '1px solid ' + glassBorder }}>
              {(['v1', 'v2', 'v3'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => onSwitchEngine(v)}
                  className="rounded-full px-2.5 py-0.5 text-xs transition-colors"
                  style={{
                    background: engineVersion === v ? accentColor : 'transparent',
                    color: engineVersion === v ? '#fff' : textSecondary,
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <button onClick={onClose} className="p-1.5 rounded-full hover:opacity-70" style={{ color: textSecondary }}>
            <X size={18} />
          </button>
        </div>
      </div>

      {/* 音效方案切换（standard=标准/兼容回退，spatial=空间增强） */}
      <div className="flex items-center gap-1 mb-3">
        <span className={'text-xs mr-1 ' + textTertiary}>方案</span>
        {(['standard', 'spatial'] as const).map(scheme => (
          <button
            key={scheme}
            onClick={() => { engine.setScheme(scheme); refresh() }}
            className="rounded-full px-3 py-1 text-xs transition-colors"
            style={{
              background: settings.scheme === scheme ? accentColor : inputBg,
              color: settings.scheme === scheme ? '#fff' : textSecondary,
              border: '1px solid ' + glassBorder,
            }}
          >
            {scheme === 'standard' ? '标准' : '空间增强'}
          </button>
        ))}
        <span className={'text-[10px] ml-1 ' + textTertiary}>
          {settings.scheme === 'spatial' ? '低频增强/虚拟低频/IEQ 可用' : '兼容回退模式'}
        </span>
      </div>

      {/* Tab 导航 */}
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {TAB_META.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm transition-colors"
              style={{
                background: activeTab === tab.id ? accentColor : inputBg,
                color: activeTab === tab.id ? '#fff' : textSecondary,
              }}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          )
        })}
      </div>

      <div className="overflow-y-auto pr-1" style={{ maxHeight: 'calc(82vh - 140px)' }}>
        {/* ═══════════ 机型预设 ═══════════ */}
        {activeTab === 'models' && (
          <div>
            {sectionCard('机型基础预设', Smartphone, (
              <div>
                <p className={'text-xs mb-3 ' + textTertiary}>
                  把基础预设切换成任意机型的实测频响曲线（44 台设备：小米 / Redmi / JBL）。
                  选中后均衡器曲线自动切换为该机型实测响应。
                </p>
                {modelGroups.map(group => (
                  <div key={group.brand} className="mb-3">
                    <div className={'text-xs font-medium mb-1.5 ' + textSecondary}>{group.brand}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.items.map(m => (
                        <button
                          key={m.code || m.model}
                          onClick={() => { engine.applyDeviceModel(m.code || m.model); refresh() }}
                          className="rounded-lg px-2.5 py-1 text-xs transition-colors"
                          style={{
                            background: settings.device.modelCode === m.code ? accentColor : inputBg,
                            color: settings.device.modelCode === m.code ? '#fff' : textSecondary,
                            border: '1px solid ' + glassBorder,
                          }}
                        >
                          {m.model}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => { engine.applyDeviceModel(null); refresh() }}
                    className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs"
                    style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                  >
                    <RotateCcw size={12} /> 清除机型预设
                  </button>
                </div>
              </div>
            ))}

            {sectionCard('输出设备自动适配（Windows）', Speaker, (
              <div>
                <p className={'text-xs mb-2 ' + textTertiary}>
                  检测 Windows 音频输出端点，自动切换设备档案：外放→设备外放、耳机→头戴、蓝牙→入耳。
                </p>
                {toggleRow('自动适配', '按输出设备类型自动切换档案', settings.device.autoDetect, v => {
                  engine.setAutoDetect(v)
                  refresh()
                })}
                <div className="flex gap-2 mt-2">
                  {OUTPUT_KINDS.map(k => {
                    const Icon = k.icon
                    return (
                      <button
                        key={k.kind}
                        onClick={() => { engine.setOutputDeviceKind(k.kind); refresh() }}
                        className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs"
                        style={{
                          background: settings.device.outputKind === k.kind ? accentColor : inputBg,
                          color: settings.device.outputKind === k.kind ? '#fff' : textSecondary,
                          border: '1px solid ' + glassBorder,
                        }}
                      >
                        <Icon size={12} /> {k.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ═══════════ 均衡器 ═══════════ */}
        {activeTab === 'eq' && (
          <div>
            {sectionCard('模式与预设', SlidersHorizontal, (
              <div>
                <div className="flex gap-1.5 mb-3 flex-wrap">
                  {(['flat', 'preset', 'curve', 'device'] as V3EqMode[]).map(mode => (
                    <button
                      key={mode}
                      onClick={() => applyEqMode(mode)}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{
                        background: eq.mode === mode ? accentColor : inputBg,
                        color: eq.mode === mode ? '#fff' : textSecondary,
                      }}
                    >
                      {mode === 'flat' ? '平直' : mode === 'preset' ? '预设' : mode === 'curve' ? '自定义曲线' : '设备档案'}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {EQ_PRESET_NAMES.map((name, i) => (
                    <button
                      key={name}
                      onClick={() => setPreset(i)}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{
                        background: eq.presetIndex === i && eq.mode === 'preset' ? accentColor : inputBg,
                        color: eq.presetIndex === i && eq.mode === 'preset' ? '#fff' : textSecondary,
                        border: '1px solid ' + glassBorder,
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <div className="mt-3">
                  {toggleRow('启用均衡器', '20 段峰值均衡（47Hz-19.7kHz）', eq.enabled, v => update({ eq: { enabled: v } }))}
                </div>
              </div>
            ))}

            {sectionCard('20 段均衡器', SlidersHorizontal, (
              <div>
                {settings.eqLocked && (
                  <div className="rounded-xl p-2.5 mb-2 text-xs" style={{ background: 'rgba(255,150,80,0.12)', border: '1px solid rgba(255,150,80,0.35)', color: textSecondary }}>
                    该机型完整频响预设已启用，为防止 EQ 叠加出现破音等现象，暂不支持叠加使用；
                    如需使用 EQ 请清除机型预设。
                  </div>
                )}
                <ResponseCurveGraph
                  curve={engine.currentEqCurve()}
                  overlay={settings.device.modelCode ? settings.frequencyResponse.targetCurve : null}
                  overlayLabel={settings.device.modelName || undefined}
                  accentColor={accentColor}
                />
                <div className="flex gap-2 my-2">
                  <button
                    onClick={() => setEqUiLock(l => !l)}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: eqUiLock ? accentColor : inputBg, color: eqUiLock ? '#fff' : textSecondary, border: '1px solid ' + glassBorder }}
                    title="锁定均衡器调节"
                  >
                    {eqUiLock ? '已锁定' : '锁定'}
                  </button>
                  <button
                    onClick={() => { const str = engine.exportShareString(); void navigator.clipboard?.writeText(str).catch(() => undefined); setShareNotice('已复制分享串') }}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                  >
                    导出 EQ（复制分享串）
                  </button>
                  <input
                    value={shareText}
                    onChange={e => setShareText(e.target.value)}
                    placeholder="粘贴分享串导入…"
                    className="flex-1 rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: inputBg, color: textPrimary, border: '1px solid ' + glassBorder }}
                  />
                  <button
                    onClick={() => {
                      if (engine.importShareString(shareText)) { setShareNotice('导入成功'); refresh() }
                      else setShareNotice('导入失败：格式无效')
                    }}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: accentColor, color: '#fff' }}
                  >
                    导入
                  </button>
                </div>
                {shareNotice && <div className={'text-xs mb-1 ' + textTertiary}>{shareNotice}</div>}
                {settings.eq.mode === 'curve' && (
                  <div className="my-2">
                    <div className={'text-xs mb-1 ' + textTertiary}>曲线编辑：点击空白加频点 / 拖拽调整 / 双击删除（最多 50 点）</div>
                    <DraggableCurveEditor
                      points={settings.eq.curve}
                      onChange={next => update({ eq: { mode: 'curve', curve: next, enabled: true } })}
                      accentColor={accentColor}
                      disabled={settings.eqLocked || eqUiLock}
                    />
                  </div>
                )}
                {EQ_BANDS_20.map((freq, i) => (
                  <div key={freq} className="flex items-center gap-2 py-[3px]">
                    <span className={'w-10 shrink-0 text-right text-[10px] tabular-nums ' + textTertiary}>{BAND_LABELS[i]}</span>
                    <input
                      type="range" min={-12} max={12} step={0.5}
                      value={Math.max(-12, Math.min(12, bandGains[i] ?? 0))}
                      onChange={e => setBandSlider(i, parseFloat(e.target.value))}
                      disabled={eqUiLock || settings.eqLocked}
                      className="flex-1 disabled:opacity-40"
                      style={{ accentColor }}
                    />
                    <span className={'w-9 shrink-0 text-[10px] tabular-nums ' + textTertiary}>
                      {(bandGains[i] ?? 0) >= 0 ? '+' : ''}{(bandGains[i] ?? 0).toFixed(1)}
                    </span>
                  </div>
                ))}
                <button
                  onClick={resetEq}
                  className="mt-3 flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs"
                  style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                >
                  <RotateCcw size={12} /> 清空均衡器
                </button>
              </div>
            ))}

            {sectionCard('设备档案', Headphones, (
              <div className="flex flex-wrap gap-1.5">
                {DEVICE_PROFILES.map(p => (
                  <button
                    key={p.id}
                    onClick={() => update({ eq: { mode: 'device', deviceProfileId: p.id, enabled: true } })}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{
                      background: eq.deviceProfileId === p.id ? accentColor : inputBg,
                      color: eq.deviceProfileId === p.id ? '#fff' : textSecondary,
                      border: '1px solid ' + glassBorder,
                    }}
                    title={p.description}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ═══════════ 高级音效 ═══════════ */}
        {activeTab === 'advanced' && (
          <div>
            {sectionCard('64 阶 IIR 参数均衡', Cpu, (
              <div>
                {toggleRow('启用 IIR PEQ', '32 段 × 2 阶 = 64 阶级联', settings.peq.enabled, v => update({ peq: { enabled: v } }))}
                {settings.peq.bands.map((band, i) => (
                  <div key={i} className="rounded-xl p-2 my-1.5" style={{ background: inputBg }}>
                    <div className="flex items-center justify-between">
                      <span className={'text-xs ' + textSecondary}>频段 {i + 1}</span>
                      <button
                        onClick={() => {
                          const bands = settings.peq.bands.filter((_, j) => j !== i)
                          update({ peq: { bands: bands.length ? bands : [{ freq: 1000, gain: 0, q: 1 }] } })
                        }}
                        className="text-xs"
                        style={{ color: textTertiary }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {slider('频率', band.freq, 20, 20000, 1, v => setPeqBand(i, { freq: v }), 'Hz')}
                    {slider('增益', band.gain, -15, 15, 0.5, v => setPeqBand(i, { gain: v }), 'dB')}
                    {slider('Q', band.q, 0.2, 12, 0.05, v => setPeqBand(i, { q: v }))}
                  </div>
                ))}
                <button
                  onClick={() => {
                    const bands = [...settings.peq.bands, { freq: 1000, gain: 0, q: 1 }]
                    update({ peq: { bands } })
                  }}
                  className="mt-1 rounded-lg px-3 py-1.5 text-xs"
                  style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                >
                  + 添加频段（上限 32 段）
                </button>
              </div>
            ))}

            {sectionCard('低频与高频', Music2, (
              <div>
                {toggleRow('低频增强', 'lowshelf 提升低频量感与厚度', adv.bassEnhance.enabled, v => update({ advanced: { bassEnhance: { enabled: v } } }))}
                {adv.bassEnhance.enabled && (
                  <div>
                    {slider('增强量', adv.bassEnhance.intensity, 0, 10, 0.5, v => update({ advanced: { bassEnhance: { intensity: v } } }))}
                    {slider('截止频率', adv.bassEnhance.cutoff, 40, 250, 5, v => update({ advanced: { bassEnhance: { cutoff: v } } }), 'Hz')}
                    {slider('作用宽度', adv.bassEnhance.width, 0.4, 2.5, 0.05, v => update({ advanced: { bassEnhance: { width: v } } }))}
                  </div>
                )}
                {toggleRow('虚拟低频', '谐波合成补全放不出的次低频', adv.virtualBass.enabled, v => update({ advanced: { virtualBass: { enabled: v } } }))}
                {adv.virtualBass.enabled && (
                  <div>
                    {slider('强度', adv.virtualBass.amount, 0, 10, 0.5, v => update({ advanced: { virtualBass: { amount: v } } }))}
                    {slider('基频', adv.virtualBass.baseFreq, 30, 120, 1, v => update({ advanced: { virtualBass: { baseFreq: v } } }), 'Hz')}
                    {slider('谐波', adv.virtualBass.harmonics, 2, 4, 1, v => update({ advanced: { virtualBass: { harmonics: v } } }), '次')}
                    {slider('融合', adv.virtualBass.blend, 0, 1, 0.05, v => update({ advanced: { virtualBass: { blend: v } } }))}
                  </div>
                )}
                {toggleRow('对白清晰度', '提升对白存在感（2.2kHz）', adv.dialogueClarity.enabled, v => update({ advanced: { dialogueClarity: { enabled: v } } }))}
                {adv.dialogueClarity.enabled && slider('强度', adv.dialogueClarity.amount, 0, 10, 0.5, v => update({ advanced: { dialogueClarity: { amount: v } } }))}
                {toggleRow('齿音抑制', '动态衰减 6.5kHz 齿音', adv.deesser.enabled, v => update({ advanced: { deesser: { enabled: v } } }))}
                {adv.deesser.enabled && (
                  <div className="flex gap-1.5 mb-1">
                    {(['static', 'dynamic'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => update({ advanced: { deesser: { mode: m } } })}
                        className="rounded-lg px-2.5 py-1 text-xs"
                        style={{
                          background: adv.deesser.mode === m ? accentColor : inputBg,
                          color: adv.deesser.mode === m ? '#fff' : textSecondary,
                          border: '1px solid ' + glassBorder,
                        }}
                      >
                        {m === 'static' ? '简化动态' : '精确侧链（AudioWorklet）'}
                      </button>
                    ))}
                  </div>
                )}
                {adv.deesser.enabled && slider('强度', adv.deesser.amount, 0, 10, 0.5, v => update({ advanced: { deesser: { amount: v } } }))}
              </div>
            ))}

            {sectionCard('卷积脉冲响应', FileAudio, (
              <div>
                <p className={'text-xs mb-2 ' + textTertiary}>
                  启用卷积会临时关闭：虚拟低频 / IIR / 频响曲线 / 齿音抑制 / 低频增强（关闭后自动恢复）。
                </p>
                {toggleRow('启用卷积', 'IR 干湿混合（默认 0.35）', conv.enabled, v => update({ advanced: { convolution: { enabled: v } } }))}
                {conv.enabled && slider('干湿比', conv.mix, 0, 1, 0.05, v => update({ advanced: { convolution: { mix: v } } }), '')}
                <div className="mt-2">
                  <div className={'text-xs mb-1 ' + textSecondary}>内置混响（无需外部文件）</div>
                  <div className="flex flex-wrap gap-1.5">
                    {builtinReverbs.map(r => (
                      <button
                        key={r.type}
                        onClick={() => { engine.setBuiltinReverb(r.type as BuiltinReverbType); refresh() }}
                        className="rounded-lg px-2.5 py-1 text-xs"
                        style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="mt-2 flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs cursor-pointer"
                  style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}>
                  <FileAudio size={12} /> {importingIr ? '加载中…' : '导入外部 IR 文件'}
                  <input type="file" accept="audio/*,.wav,.mp3" className="hidden"
                    onChange={e => { void onIrFile(e.target.files?.[0]); e.target.value = '' }} />
                </label>
              </div>
            ))}

            {sectionCard('智能均衡 IEQ（频响设置）', SlidersHorizontal, (
              <div>
                <p className={'text-xs mb-2 ' + textTertiary}>
                  根据目标风格调整整体频响（仅空间增强方案生效）。
                </p>
                {toggleRow('启用 IEQ', '目标风格 × 低中高三段强度', settings.ieq.enabled, v => update({ ieq: { enabled: v } }))}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {IEQ_STYLE_NAMES.map((name, i) => (
                    <button
                      key={name}
                      onClick={() => update({ ieq: { style: i } })}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{
                        background: settings.ieq.style === i ? accentColor : inputBg,
                        color: settings.ieq.style === i ? '#fff' : textSecondary,
                        border: '1px solid ' + glassBorder,
                      }}
                    >
                      {name}
                    </button>
                  ))}
                  <button
                    onClick={() => update({ ieq: { style: 3 } })}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{
                      background: settings.ieq.style === 3 ? accentColor : inputBg,
                      color: settings.ieq.style === 3 ? '#fff' : textSecondary,
                      border: '1px solid ' + glassBorder,
                    }}
                  >
                    自定义
                  </button>
                </div>
                {settings.ieq.enabled && (
                  <div>
                    {slider('低频强度', settings.ieq.bassAmount, 0, 10, 1, v => update({ ieq: { bassAmount: v } }))}
                    {slider('中频强度', settings.ieq.presenceAmount, 0, 10, 1, v => update({ ieq: { presenceAmount: v } }))}
                    {slider('高频强度', settings.ieq.trebleAmount, 0, 10, 1, v => update({ ieq: { trebleAmount: v } }))}
                    <button
                      onClick={() => update({ ieq: loadCustomIeq(engine.currentBandGains20()) })}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                    >
                      载入当前风格（写入自定义目标）
                    </button>
                  </div>
                )}
              </div>
            ))}

            {sectionCard('智能 Post（自动计算 Post 均衡）', RotateCcw, (
              <div>
                <p className={'text-xs mb-2 ' + textTertiary}>
                  自动计算 Post 均衡，使其调音更加简易：自动生成少量补偿频段，
                  叠加在动态处理之后，整体听感更接近目标。
                </p>
                {toggleRow('启用智能 Post', '自动补偿当前曲线的显著偏差', settings.postEq.auto.enabled, v => update({ postEq: { auto: { enabled: v } } }))}
                {settings.postEq.auto.enabled && slider('强度', settings.postEq.auto.strength, 0.1, 1, 0.05, v => update({ postEq: { auto: { strength: v } } }))}
                {toggleRow('手工 Post 曲线', '动态处理后的独立均衡曲线', settings.postEq.manual.enabled, v => update({ postEq: { manual: { enabled: v } } }))}
              </div>
            ))}

            {sectionCard('动态与夜间', Music2, (
              <div>
                {toggleRow('动态压缩', '压平音量起伏', adv.compressor.enabled, v => update({ advanced: { compressor: { enabled: v } } }))}
                {adv.compressor.enabled && (
                  <div>
                    {slider('阈值', adv.compressor.threshold, -40, 0, 1, v => update({ advanced: { compressor: { threshold: v } } }), 'dB')}
                    {slider('比率', adv.compressor.ratio, 1, 10, 0.5, v => update({ advanced: { compressor: { ratio: v } } }))}
                    {slider('输出增益', adv.compressor.outputGain, 0, 12, 0.5, v => update({ advanced: { compressor: { outputGain: v } } }), 'dB')}
                  </div>
                )}
                {toggleRow('夜间模式', '温和压缩 + 高频衰减（深夜听感）', adv.nightMode.enabled, v => update({ advanced: { nightMode: { enabled: v } } }))}
                {adv.nightMode.enabled && slider('强度', adv.nightMode.amount, 0, 10, 0.5, v => update({ advanced: { nightMode: { amount: v } } }))}
              </div>
            ))}

            {sectionCard('等响曲线（音量-增益映射）', Volume2, (
              <div>
                <p className={'text-xs mb-2 ' + textTertiary}>
                  按当前听音音量从 20 档映射表采样补偿增益（x/ht.o 百分比索引语义），
                  低音量时补偿低频/高频，让不同音量段的听感更稳定。
                </p>
                {toggleRow('启用等响曲线', '音量越低补偿越多（默认曲线）', settings.master.loudnessCurve.enabled, v => update({ master: { loudnessCurve: { enabled: v } } }))}
                {settings.master.loudnessCurve.enabled && (
                  <div>
                    {slider('当前听音音量', settings.master.listeningVolume, 0, 100, 1, v => { engine.setListeningVolume(v); refresh() }, '%')}
                    <div className="flex gap-2 mt-1">
                      <button
                        onClick={() => update({ master: { loudnessCurve: { curve: defaultLoudnessCurve() } } })}
                        className="rounded-lg px-2.5 py-1 text-xs"
                        style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                      >
                        载入默认等响曲线
                      </button>
                      <span className={'text-[10px self-center ' + textTertiary}>
                        当前档位增益：{sampleCurveAtPercent(settings.master.loudnessCurve.curve, settings.master.listeningVolume).toFixed(2)} dB
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {sectionCard('设备音效能力（查看设备音效能力）', Cpu, (
              <div>
                {capReport ? (
                  <div>
                    <div className={'text-xs mb-1 ' + (capReport.degraded ? 'text-amber-400' : textSecondary)}>
                      {summarizeCapabilities(capReport)}
                    </div>
                    <div className={'text-xs ' + textTertiary}>
                      采样率 {capReport.sampleRate || '未知'}Hz · 声道 {capReport.maxChannels} ·
                      输出设备 {capReport.outputDevices.length} 个
                    </div>
                    {capReport.missing.length > 0 && (
                      <div className={'text-xs mt-1 ' + textTertiary}>缺失：{capReport.missing.join(' / ')}</div>
                    )}
                  </div>
                ) : (
                  <p className={'text-xs mb-2 ' + textTertiary}>检测当前环境支持的 Web Audio 能力（卷积/离线渲染/动态齿音等）。</p>
                )}
                <button
                  onClick={() => {
                    setCapChecking(true)
                    void detectAudioCapabilities().then(r => { setCapReport(r); setCapChecking(false) })
                  }}
                  className="mt-2 rounded-lg px-3 py-1.5 text-xs"
                  style={{ background: accentColor, color: '#fff' }}
                >
                  {capChecking ? '检测中…' : capReport ? '重新检测' : '查看设备音效能力'}
                </button>
              </div>
            ))}

            {sectionCard('智能响度', Volume2, (
              <div>
                {toggleRow('智能响度', '按曲目 LUFS 对齐目标响度（-14 LUFS）', settings.master.smartLoudness.enabled, v => update({ master: { smartLoudness: { enabled: v } } }))}
                {settings.master.smartLoudness.enabled && slider('目标', settings.master.smartLoudness.targetLufs, -23, -9, 0.5, v => update({ master: { smartLoudness: { targetLufs: v } } }), 'LUFS')}
                {toggleRow('响度归一化', '播放器按曲目测量结果设置增益', settings.normalizationEnabled, v => {
                  update({ normalizationEnabled: v })
                  window.dispatchEvent(new CustomEvent('normalizationEnabledChanged', { detail: v }))
                })}
              </div>
            ))}

            {sectionCard('场景与档案', Save, (
              <div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {engine.getBuiltinScenes().map(scene => (
                    <button
                      key={scene.id}
                      onClick={() => { engine.applyScene(scene); refresh() }}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{
                        background: settings.activeScene === scene.id ? accentColor : inputBg,
                        color: settings.activeScene === scene.id ? '#fff' : textSecondary,
                        border: '1px solid ' + glassBorder,
                      }}
                    >
                      {scene.name}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 items-center">
                  <input
                    value={sceneName}
                    onChange={e => setSceneName(e.target.value)}
                    placeholder="保存为我的场景…"
                    className="flex-1 rounded-lg px-3 py-1.5 text-xs"
                    style={{ background: inputBg, color: textPrimary, border: '1px solid ' + glassBorder }}
                  />
                  <button onClick={saveScene} className="rounded-lg px-3 py-1.5 text-xs" style={{ background: accentColor, color: '#fff' }}>
                    保存
                  </button>
                </div>
                {engine.getMyScenes().length > 0 && (
                  <div className="mt-2">
                    <div className={'text-xs mb-1 ' + textTertiary}>我的场景：</div>
                    {engine.getMyScenes().map(scene => (
                      <div key={scene.id} className="flex items-center justify-between py-0.5">
                        <button
                          onClick={() => { engine.applyScene(scene); refresh() }}
                          className={'text-xs ' + textSecondary}
                        >
                          {scene.name}
                        </button>
                        <button
                          onClick={() => { engine.deleteMyScene(scene.id); refresh() }}
                          className="text-xs"
                          style={{ color: textTertiary }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-center mt-2">
                  <input
                    value={profileName}
                    onChange={e => setProfileName(e.target.value)}
                    placeholder="保存当前曲目为独立音效档案…"
                    className="flex-1 rounded-lg px-3 py-1.5 text-xs"
                    style={{ background: inputBg, color: textPrimary, border: '1px solid ' + glassBorder }}
                  />
                  <button onClick={saveProfile} className="rounded-lg px-3 py-1.5 text-xs" style={{ background: accentColor, color: '#fff' }}>
                    保存档案
                  </button>
                </div>
              </div>
            ))}

            {sectionCard('App 独立音效档案', Save, (
              <div>
                {engine.getAppProfiles().length === 0 && (
                  <div className={'text-xs mb-2 ' + textTertiary}>暂无档案：切到某曲目后点上方「保存档案」即可建立独立音效。</div>
                )}
                {engine.getAppProfiles().map(p => (
                  <div key={p.sourceKey} className="flex items-center justify-between py-1">
                    <div className={'text-xs truncate ' + textSecondary}>{p.name}</div>
                    <button
                      onClick={() => { engine.deleteAppProfileFor(p.sourceKey); refresh() }}
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ color: textTertiary }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={() => { const str = engine.exportSettingsJson(); void navigator.clipboard?.writeText(str).catch(() => undefined); setShareNotice('全量设置 JSON 已复制') }}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                  >
                    导出全量设置 JSON
                  </button>
                  <button
                    onClick={() => {
                      const ok = engine.importSettingsJson(jsonText)
                      setShareNotice(ok ? '全量设置已导入' : '导入失败：JSON 格式/版本无效')
                      if (ok) refresh()
                    }}
                    className="rounded-lg px-2.5 py-1 text-xs"
                    style={{ background: accentColor, color: '#fff' }}
                  >
                    导入 JSON
                  </button>
                </div>
                <input
                  value={jsonText}
                  onChange={e => setJsonText(e.target.value)}
                  placeholder="粘贴全量设置 JSON…"
                  className="mt-2 w-full rounded-lg px-2.5 py-1 text-xs"
                  style={{ background: inputBg, color: textPrimary, border: '1px solid ' + glassBorder }}
                />
              </div>
            ))}

            {sourceUrl && (
              <button
                onClick={() => { void doExport() }}
                disabled={exporting}
                className="w-full rounded-xl py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: accentColor, color: '#fff' }}
              >
                {exporting ? '导出中…' : '导出当前音效为 WAV'}
              </button>
            )}
          </div>
        )}

        {/* ═══════════ 听力分析 ═══════════ */}
        {activeTab === 'hearing' && (
          <div>
            {sectionCard('听感分析引导调校', Ear, (
              <div>
                <p className={'text-xs mb-3 ' + textTertiary}>
                  选择本次要调校的播放设备，随后循环播放示例音乐，根据你的反馈实时调整基础曲线。
                </p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {DEVICE_PROFILES.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { engine.startHearingAnalysis(p.id); refresh() }}
                      className="rounded-lg px-2.5 py-1 text-xs"
                      style={{
                        background: engine.analysis.deviceProfileId === p.id ? accentColor : inputBg,
                        color: engine.analysis.deviceProfileId === p.id ? '#fff' : textSecondary,
                        border: '1px solid ' + glassBorder,
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => { engine.startAnalysisDemoTone(); refresh() }}
                    className="rounded-lg px-3 py-1.5 text-xs"
                    style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                  >
                    播放演示音（220-880Hz 循环扫频）
                  </button>
                  <button
                    onClick={() => { engine.stopAnalysisDemoTone(); refresh() }}
                    className="rounded-lg px-3 py-1.5 text-xs"
                    style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                  >
                    停止演示音
                  </button>
                </div>
                {(engine.analysis.phase === 'playing' || engine.analysis.phase === 'adjusting') && (
                  <div>
                    <div className={'rounded-xl p-3 mb-3 text-sm ' + textPrimary} style={{ background: inputBg, border: '1px solid ' + glassBorder }}>
                      {engine.getAnalysisGuidance()}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {FEEDBACK_BUTTONS.map(fb => (
                        <button
                          key={fb.value}
                          onClick={() => { engine.applyHearingFeedback(fb.value); refresh() }}
                          className="rounded-lg px-3 py-1.5 text-xs"
                          style={{ background: accentColor, color: '#fff' }}
                          title={fb.hint}
                        >
                          {fb.label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => { engine.finishHearingAnalysis(); refresh() }}
                      className="mt-3 rounded-lg px-3 py-1.5 text-xs"
                      style={{ background: inputBg, color: textSecondary, border: '1px solid ' + glassBorder }}
                    >
                      完成分析并应用到均衡器
                    </button>
                  </div>
                )}
                {engine.analysis.phase === 'done' && (
                  <div className={'text-sm ' + textSecondary}>听感分析完成，曲线已应用到均衡器。</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部提示 */}
      {customizedHint && (
        <div className={'mt-3 text-xs ' + textTertiary}>
          已手动调整参数（脱离场景快照）。可随时重新应用场景覆盖。
        </div>
      )}
    </motion.div>
  )
}

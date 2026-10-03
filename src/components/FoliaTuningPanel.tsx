/**
 * Folia 模式参数面板宿主。
 *
 * 上游把各模式的参数面板挂在 registry entry 的 `renderSettingsPanel` 上，由它自己的
 * 设置界面（VisPlayground / 设置弹窗）渲染；WaveForge 没有那套外壳，所以这些面板
 * 一直躺在 vendor 里没人调用。这里按注册表驱动：谁声明了面板就渲染谁，
 * 新增模式不用改这个文件。
 *
 * 滑块沿用上游的「草稿 / 松手提交」语义：拖动过程中只更新本地草稿（每帧写 localStorage
 * 会卡），松手才落盘。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getVisualizerRegistryEntry } from '../vendor/folia/components/visualizer/registry'
import type { VisualizerSettingsPanelProps } from '../vendor/folia/components/visualizer/definition'
import { buildFoliaPanelStyles, buildFoliaTheme } from './foliaTunings'

export interface FoliaTuningPanelProps {
  /** 当前 folia 模式 id */
  mode: string
  /** 该模式当前生效的调参（已含上下文推导，例如绘光的 darkField / renderQuality） */
  tuning: Record<string, unknown> | undefined
  /** 落盘：把整份调参写回（仅在选择/开关/松手时调用） */
  onCommit: (next: Record<string, unknown>) => void
  onReset: () => void
  hasOverride: boolean
  playerTheme: 'dark' | 'light'
  accentColor: string
}

/** mode → 上游面板读取的 props 名（`lumiere` → `lumiereTuning` / `onLumiereTuningChange`）。 */
const tuningPropName = (mode: string) => `${mode}Tuning`
const tuningSetterName = (mode: string) => `on${mode.charAt(0).toUpperCase()}${mode.slice(1)}TuningChange`

export function FoliaTuningPanel({
  mode,
  tuning,
  onCommit,
  onReset,
  hasOverride,
  playerTheme,
  accentColor,
}: FoliaTuningPanelProps) {
  const { t } = useTranslation()
  const entry = getVisualizerRegistryEntry(mode as never)
  const renderSettingsPanel = entry?.renderSettingsPanel
  const isDaylight = playerTheme === 'light'
  const theme = useMemo(() => buildFoliaTheme({ playerTheme, accentColor }), [playerTheme, accentColor])
  const styles = useMemo(() => buildFoliaPanelStyles(theme, isDaylight), [theme, isDaylight])

  // 草稿：拖动中只改这里，松手才提交
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const draggingRef = useRef(false)
  // 换模式时丢弃草稿，否则会把上一个模式的键带进新模式的 tuning
  useEffect(() => { setDraft(null); draggingRef.current = false }, [mode])

  const effective = (draft ?? tuning ?? {}) as Record<string, unknown>

  const handleChange = (patch: Record<string, unknown>) => {
    const next = { ...effective, ...patch }
    setDraft(next)
    if (!draggingRef.current) onCommit(next)
  }
  const handleSliderPointerDown = () => { draggingRef.current = true }
  const handleSliderCommit = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (draft) onCommit(draft)
  }

  if (!renderSettingsPanel) return null

  const panelProps = {
    t,
    isDaylight,
    theme,
    controlCardBg: styles.controlCardBg,
    rangeInputClass: styles.rangeInputClass,
    [tuningPropName(mode)]: effective,
    [tuningSetterName(mode)]: handleChange,
    onSliderPointerDown: handleSliderPointerDown,
    onSliderCommit: handleSliderCommit,
  } as unknown as VisualizerSettingsPanelProps

  return (
    <div className="space-y-2">
      {mode === 'lumiere' && (
        // 上游明确写了绘光的歌词字号由各光位的文字区自动计算，通用字号设置只影响底部字幕。
        // 不提示的话用户会以为「字体大小」这个设置坏了。
        <p className={`rounded-lg px-2.5 py-2 text-[10px] leading-relaxed ${playerTheme === 'dark' ? 'bg-white/[0.06] text-white/55' : 'bg-black/[0.05] text-black/55'}`}>
          {t('options.lumiereFontSizeAutoNotice')}
        </p>
      )}
      {hasOverride && (
        <button
          type="button"
          onClick={onReset}
          className={`w-full rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${playerTheme === 'dark' ? 'text-white/60 hover:bg-white/[0.08] hover:text-white' : 'text-black/55 hover:bg-black/[0.06] hover:text-black'}`}
        >
          {t('ui.resetVisualizerTuning')}
        </button>
      )}
      {renderSettingsPanel(panelProps)}
    </div>
  )
}

export default FoliaTuningPanel

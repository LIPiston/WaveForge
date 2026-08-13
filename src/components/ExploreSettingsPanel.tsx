import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { ExplorePlatform } from '../services/exploreApi'

export type ExploreSectionId = 'discover' | 'journey' | 'playlists' | 'charts' | 'newSongs' | 'albums' | 'channels'
export type ExploreDensity = 'comfortable' | 'compact'
export type ExploreContentAmount = 'curated' | 'expanded'
export type ExploreBackgroundIntensity = 'calm' | 'vivid'

export interface ExplorePlatformPreferences {
  order: ExploreSectionId[]
  hidden: ExploreSectionId[]
  density: ExploreDensity
  contentAmount: ExploreContentAmount
  showDescriptions: boolean
  backgroundIntensity: ExploreBackgroundIntensity
}

export interface ExplorePreferences {
  netease: ExplorePlatformPreferences
  qq: ExplorePlatformPreferences
}

export const EXPLORE_SECTION_LABELS: Record<ExploreSectionId, string> = {
  discover: '为你发现',
  journey: '音乐旅程',
  playlists: '推荐歌单',
  charts: '排行榜速览',
  newSongs: '最新音乐',
  albums: '新碟上架',
  channels: '声音与频道',
}

const BASE_ORDER: ExploreSectionId[] = ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels']
const PLATFORM_ORDER: Record<ExplorePlatform, ExploreSectionId[]> = {
  netease: BASE_ORDER,
  qq: BASE_ORDER,
}

export const createDefaultExplorePreferences = (): ExplorePreferences => ({
  netease: {
    order: [...PLATFORM_ORDER.netease],
    hidden: [],
    density: 'comfortable',
    contentAmount: 'curated',
    showDescriptions: true,
    backgroundIntensity: 'vivid',
  },
  qq: {
    order: [...PLATFORM_ORDER.qq],
    hidden: [],
    density: 'comfortable',
    contentAmount: 'curated',
    showDescriptions: true,
    backgroundIntensity: 'vivid',
  },
})

export function normalizeExplorePreferences(input: unknown): ExplorePreferences {
  const defaults = createDefaultExplorePreferences()
  const raw = input && typeof input === 'object' ? input as Partial<Record<ExplorePlatform, Partial<ExplorePlatformPreferences>>> : {}

  for (const platform of ['netease', 'qq'] as ExplorePlatform[]) {
    const source = raw[platform] || {}
    const defaultOrder = PLATFORM_ORDER[platform]
    const validOrder = Array.isArray(source.order)
      ? source.order.filter((item): item is ExploreSectionId => defaultOrder.includes(item as ExploreSectionId))
      : []
    const missing = defaultOrder.filter(item => !validOrder.includes(item))
    const hidden = Array.isArray(source.hidden)
      ? source.hidden.filter((item): item is ExploreSectionId => defaultOrder.includes(item as ExploreSectionId))
      : []
    let normalizedOrder = [...validOrder, ...missing]
    // 旧版本网易云没有旅程板块，QQ 旧偏好也可能缺失；升级后统一放在“为你发现”之后。
    if (!validOrder.includes('journey')) {
      normalizedOrder = normalizedOrder.filter(item => item !== 'journey')
      normalizedOrder.splice(Math.max(0, normalizedOrder.indexOf('discover') + 1), 0, 'journey')
    }
    defaults[platform] = {
      order: normalizedOrder,
      hidden,
      density: source.density === 'compact' ? 'compact' : 'comfortable',
      contentAmount: source.contentAmount === 'expanded' ? 'expanded' : 'curated',
      showDescriptions: source.showDescriptions !== false,
      backgroundIntensity: source.backgroundIntensity === 'calm' ? 'calm' : 'vivid',
    }
  }

  return defaults
}

interface ExploreSettingsPanelProps {
  show: boolean
  platform: ExplorePlatform
  preferences: ExplorePreferences
  accent: string
  onClose: () => void
  onPlatformChange: (platform: ExplorePlatform) => void
  onChange: (preferences: ExplorePreferences) => void
}

export default function ExploreSettingsPanel({
  show,
  platform,
  preferences,
  accent,
  onClose,
  onPlatformChange,
  onChange,
}: ExploreSettingsPanelProps) {
  const current = preferences[platform]
  const sectionLabel = (section: ExploreSectionId) => section === 'journey'
    ? (platform === 'netease' ? '网易云音乐旅程' : 'QQ 音乐旅程')
    : EXPLORE_SECTION_LABELS[section]

  const updateCurrent = (patch: Partial<ExplorePlatformPreferences>) => {
    onChange({ ...preferences, [platform]: { ...current, ...patch } })
  }

  const moveSection = (section: ExploreSectionId, direction: -1 | 1) => {
    const index = current.order.indexOf(section)
    const target = index + direction
    if (index < 0 || target < 0 || target >= current.order.length) return
    const next = [...current.order]
    ;[next[index], next[target]] = [next[target], next[index]]
    updateCurrent({ order: next })
  }

  const toggleSection = (section: ExploreSectionId) => {
    updateCurrent({
      hidden: current.hidden.includes(section)
        ? current.hidden.filter(item => item !== section)
        : [...current.hidden, section],
    })
  }

  const resetCurrent = () => {
    const defaults = createDefaultExplorePreferences()
    onChange({ ...preferences, [platform]: defaults[platform] })
  }

  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none fixed inset-0 z-[180]">
          <motion.button
            type="button"
            aria-label="关闭探索设置"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="pointer-events-auto absolute inset-0 bg-transparent"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 280 }}
            className="pointer-events-auto absolute bottom-4 right-4 top-8 flex w-[calc(100%_-_32px)] max-w-[480px] flex-col overflow-hidden rounded-[28px] border border-white/[0.12] bg-[#0b0e15]/92 shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold">
                  <SlidersHorizontal className="h-5 w-5" style={{ color: accent }} />
                  探索页设置
                </div>
                <p className="mt-1 text-xs text-white/40">调整会立即同步到面板背后的真实探索页</p>
              </div>
              <button type="button" onClick={onClose} className="rounded-xl bg-white/[0.06] p-2 text-white/55 transition hover:bg-white/[0.1] hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="explore-scrollbar flex-1 overflow-y-auto px-6 py-5">
              <div className="mb-6 grid grid-cols-2 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-1">
                {(['netease', 'qq'] as ExplorePlatform[]).map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => onPlatformChange(item)}
                    className={`rounded-xl px-4 py-2.5 text-sm transition ${item === platform ? 'text-[#071018]' : 'text-white/48 hover:text-white/78'}`}
                    style={{ background: item === platform ? accent : 'transparent' }}
                  >
                    {item === 'netease' ? '网易云布局' : 'QQ 音乐布局'}
                  </button>
                ))}
              </div>

              <section className="mb-7">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">板块排序与显隐</h3>
                    <p className="mt-1 text-xs text-white/36">使用箭头调整首页顺序，眼睛按钮控制显示。</p>
                  </div>
                  <button type="button" onClick={resetCurrent} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/42 transition hover:bg-white/[0.06] hover:text-white/72">
                    <RotateCcw className="h-3.5 w-3.5" /> 重置
                  </button>
                </div>
                <div className="space-y-2">
                  {current.order.map((section, index) => {
                    const visible = !current.hidden.includes(section)
                    return (
                      <div key={section} className={`flex items-center gap-3 rounded-2xl border p-3 transition ${visible ? 'border-white/[0.08] bg-white/[0.045]' : 'border-white/[0.04] bg-white/[0.02] opacity-55'}`}>
                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/[0.06] text-xs text-white/40">{index + 1}</span>
                        <span className="min-w-0 flex-1 text-sm font-medium">{sectionLabel(section)}</span>
                        <button type="button" onClick={() => moveSection(section, -1)} disabled={index === 0} className="rounded-lg p-1.5 text-white/45 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-20" aria-label={`上移${sectionLabel(section)}`}>
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => moveSection(section, 1)} disabled={index === current.order.length - 1} className="rounded-lg p-1.5 text-white/45 transition hover:bg-white/[0.08] hover:text-white disabled:opacity-20" aria-label={`下移${sectionLabel(section)}`}>
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => toggleSection(section)} className="rounded-lg p-1.5 text-white/55 transition hover:bg-white/[0.08] hover:text-white" aria-label={`${visible ? '隐藏' : '显示'}${sectionLabel(section)}`}>
                          {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>

              <section className="mb-7 space-y-4">
                <h3 className="text-sm font-semibold">内容与视觉</h3>
                <SettingChoice
                  label="首页内容量"
                  description="扩展模式会直接在首页展示更多卡片。"
                  value={current.contentAmount}
                  options={[['curated', '精选'], ['expanded', '扩展']]}
                  accent={accent}
                  onChange={value => updateCurrent({ contentAmount: value as ExploreContentAmount })}
                />
                <SettingChoice
                  label="卡片密度"
                  description="紧凑模式适合较小窗口或一次浏览更多内容。"
                  value={current.density}
                  options={[['comfortable', '舒适'], ['compact', '紧凑']]}
                  accent={accent}
                  onChange={value => updateCurrent({ density: value as ExploreDensity })}
                />
                <SettingChoice
                  label="背景氛围"
                  description="控制平台主题色在背景中的强度。"
                  value={current.backgroundIntensity}
                  options={[['calm', '柔和'], ['vivid', '鲜明']]}
                  accent={accent}
                  onChange={value => updateCurrent({ backgroundIntensity: value as ExploreBackgroundIntensity })}
                />
                <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
                  <span>
                    <span className="block text-sm font-medium">显示板块说明</span>
                    <span className="mt-1 block text-xs text-white/36">保留标题下方的推荐逻辑和内容说明。</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={current.showDescriptions}
                    onChange={event => updateCurrent({ showDescriptions: event.target.checked })}
                    className="h-4 w-4 accent-current"
                    style={{ color: accent }}
                  />
                </label>
              </section>

              <p className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-xs leading-relaxed text-white/40">
                当前就是实时预览。移动、隐藏板块或切换密度后，左侧真实页面会立即更新；关闭设置即可继续浏览。
              </p>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}

function SettingChoice({
  label,
  description,
  value,
  options,
  accent,
  onChange,
}: {
  label: string
  description: string
  value: string
  options: Array<[string, string]>
  accent: string
  onChange: (value: string) => void
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
      <div className="mb-3">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs text-white/36">{description}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-xl border px-3 py-2 text-xs transition ${value === option ? 'text-[#071018]' : 'border-white/[0.08] bg-white/[0.035] text-white/48 hover:text-white/75'}`}
            style={value === option ? { background: accent, borderColor: accent } : undefined}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

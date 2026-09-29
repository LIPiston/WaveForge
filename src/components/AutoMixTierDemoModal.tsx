import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, X, Check, Music2 } from 'lucide-react'
import {
  AUTOMIX_DEMO_PAIR,
  AUTOMIX_TIERS,
  type AutoMixTierKey,
} from '../audio/autoMixTiers'

interface AutoMixTierDemoModalProps {
  open: boolean
  onClose: () => void
  /** 当前已启用的档位 */
  selectedTier: AutoMixTierKey
  /** 在弹窗内直接启用某档 */
  onSelectTier: (tier: AutoMixTierKey) => void
  playerTheme?: 'light' | 'dark'
  accentColor?: string
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * AutoMix Enhanced 三档试听对比弹窗。
 *
 * 三份演示片段来自 automix-lab 在真实曲目对（Thank you for dears. → Put It All on Me）
 * 上的产物，每个片段结构一致：源曲尾部 → 过渡段 → 目标曲开头，
 * 时间轴按段着色并标注"哪段是 Thank you for dears. / 哪段是过渡 / 哪段是 Put It All on Me"。
 */
export default function AutoMixTierDemoModal({
  open,
  onClose,
  selectedTier,
  onSelectTier,
  playerTheme = 'dark',
  accentColor = '#3B82F6',
}: AutoMixTierDemoModalProps) {
  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black/90'
  const textSecondary = isDark ? 'text-white/55' : 'text-black/55'

  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const rafRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState<AutoMixTierKey | null>(null)
  const [times, setTimes] = useState<Record<string, number>>({})
  // 片段加载失败（资源缺失/解码失败）时给出提示，而不是静默点了没反应
  const [loadErrors, setLoadErrors] = useState<Record<string, boolean>>({})

  // 关闭时全部暂停并复位播放头（避免后台继续出声）
  const stopAll = useCallback(() => {
    for (const tier of AUTOMIX_TIERS) {
      const el = audioRefs.current[tier.key]
      if (el) {
        el.pause()
        el.currentTime = 0
      }
    }
    setPlaying(null)
    setTimes({})
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) stopAll()
    return () => {
      if (!open) return
      stopAll()
    }
  }, [open, stopAll])

  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (!playing) return
    const tick = () => {
      const el = audioRefs.current[playing]
      if (el) setTimes(prev => ({ ...prev, [playing]: el.currentTime }))
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [playing])

  const toggle = useCallback((tier: AutoMixTierKey) => {
    const el = audioRefs.current[tier]
    if (!el) return
    if (playing === tier) {
      el.pause()
      setPlaying(null)
      return
    }
    for (const other of AUTOMIX_TIERS) {
      if (other.key === tier) continue
      audioRefs.current[other.key]?.pause()
    }
    setPlaying(tier)
    void el.play().catch(() => setPlaying(null))
  }, [playing])

  const pairLine = useMemo(
    () => `${AUTOMIX_DEMO_PAIR.sourceName} → ${AUTOMIX_DEMO_PAIR.targetName}`,
    [],
  )

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)' }}
            onClick={onClose}
          />
          <motion.div
            className={`relative w-full max-w-3xl max-h-[86vh] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${
              isDark ? 'border-white/12 bg-[#141519]' : 'border-black/10 bg-white'
            }`}
            initial={{ scale: 0.96, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 12 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
          >
            {/* 头部 */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={`${textPrimary} text-base font-semibold flex items-center gap-2`}>
                  <Music2 className="w-4 h-4" style={{ color: accentColor }} />
                  三个档位，同一段换歌
                </div>
                <div className={`${textSecondary} text-xs mt-1 leading-relaxed`}>
                  试听素材为同一对歌曲、同一处换歌点，只有档位不同 —— 听完再挑一个启用。
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className={`flex-shrink-0 rounded-lg p-1.5 transition-colors ${
                  isDark ? 'hover:bg-white/10 text-white/70' : 'hover:bg-black/5 text-black/60'
                }`}
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 曲目对说明：明确哪首是前曲 / 哪首是后曲 */}
            <div
              className={`mt-4 rounded-xl border p-3 text-xs ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-black/10 bg-black/[0.02]'}`}
            >
              <div className={`${textSecondary} mb-1.5`}>演示曲目对（{pairLine}）</div>
              <div className="flex flex-col gap-1">
                <div className={`${textPrimary} flex items-center gap-2`}>
                  <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: '#8B5CF622', color: '#A78BFA' }}>前曲</span>
                  <span className="font-medium">{AUTOMIX_DEMO_PAIR.sourceName}</span>
                  <span className={textSecondary}>· {AUTOMIX_DEMO_PAIR.sourceArtist} · {AUTOMIX_DEMO_PAIR.sourceBpm} BPM</span>
                </div>
                <div className={`${textPrimary} flex items-center gap-2`}>
                  <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: '#10B98122', color: '#34D399' }}>后曲</span>
                  <span className="font-medium">{AUTOMIX_DEMO_PAIR.targetName}</span>
                  <span className={textSecondary}>· {AUTOMIX_DEMO_PAIR.targetArtist} · {AUTOMIX_DEMO_PAIR.targetBpm} BPM</span>
                </div>
              </div>
            </div>

            {/* 三档卡片 */}
            <div className="mt-4 flex flex-col gap-3">
              {AUTOMIX_TIERS.map(tier => {
                const t = times[tier.key] ?? 0
                const active = selectedTier === tier.key
                const isPlaying = playing === tier.key
                const sourcePct = (tier.demo.sourceEnd / tier.demo.duration) * 100
                const transitionPct = (tier.demo.transitionEnd / tier.demo.duration) * 100
                const headPct = Math.min(100, (t / tier.demo.duration) * 100)
                const inTransition = t >= tier.demo.sourceEnd && t < tier.demo.transitionEnd
                return (
                  <div
                    key={tier.key}
                    className={`rounded-xl border p-3 transition-colors ${
                      active
                        ? 'border-current'
                        : isDark ? 'border-white/10' : 'border-black/10'
                    }`}
                    style={{
                      borderColor: active ? accentColor : undefined,
                      background: active
                        ? `${accentColor}14`
                        : isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`${textPrimary} text-sm font-medium flex items-center gap-2`}>
                          <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: `${accentColor}22`, color: accentColor }}>
                            {tier.label}
                          </span>
                          <span className="truncate">{tier.title}</span>
                          {active && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold" style={{ color: accentColor }}>
                              <Check className="w-3 h-3" />已启用
                            </span>
                          )}
                        </div>
                        <div className={`${textSecondary} text-xs mt-1 leading-relaxed`}>
                          {tier.tagline} · 过渡 {tier.transitionSeconds.toFixed(2)}s
                          {tier.requiresCloudLogin ? ' · 需要平台登录' : ' · 无需登录'}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggle(tier.key)}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-transform hover:scale-[1.03]"
                          style={{ background: accentColor }}
                        >
                          {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                          {isPlaying ? '暂停' : '试听'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectTier(tier.key)}
                          disabled={active}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-45 ${
                            isDark ? 'bg-white/10 text-white hover:bg-white/15' : 'bg-black/8 text-black/80 hover:bg-black/12'
                          }`}
                        >
                          {active ? '当前档位' : '启用此档'}
                        </button>
                      </div>
                    </div>

                    {/* 时间轴：源曲 / 过渡 / 目标曲 三段标注 */}
                    <div className="mt-3">
                      <div
                        className={`relative h-6 w-full overflow-hidden rounded-md ${isDark ? 'bg-white/8' : 'bg-black/8'}`}
                        onClick={(event) => {
                          const el = audioRefs.current[tier.key]
                          if (!el) return
                          const rect = event.currentTarget.getBoundingClientRect()
                          const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
                          el.currentTime = ratio * tier.demo.duration
                          setTimes(prev => ({ ...prev, [tier.key]: el.currentTime }))
                        }}
                        role="slider"
                        aria-label={`${tier.label} 试听进度`}
                        aria-valuemin={0}
                        aria-valuemax={tier.demo.duration}
                        aria-valuenow={t}
                        tabIndex={0}
                      >
                        <div className="absolute inset-y-0 left-0" style={{ width: `${sourcePct}%`, background: '#8B5CF62E' }} />
                        <div className="absolute inset-y-0" style={{ left: `${sourcePct}%`, width: `${transitionPct - sourcePct}%`, background: `${accentColor}59` }} />
                        <div className="absolute inset-y-0 right-0" style={{ left: `${transitionPct}%`, background: '#10B9812E' }} />
                        <div className="absolute inset-y-0 w-[2px] bg-white/90" style={{ left: `calc(${headPct}% - 1px)` }} />
                      </div>
                      <div className={`mt-1 flex items-center justify-between text-[10px] ${textSecondary}`}>
                        <span className="inline-flex items-center gap-1">
                          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: '#8B5CF6' }} />
                          {AUTOMIX_DEMO_PAIR.sourceName}
                        </span>
                        <span className={inTransition ? 'font-semibold' : ''} style={inTransition ? { color: accentColor } : undefined}>
                          过渡段（{tier.transitionSeconds.toFixed(2)}s）
                        </span>
                        <span className="inline-flex items-center gap-1">
                          {AUTOMIX_DEMO_PAIR.targetName}
                          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: '#10B981' }} />
                        </span>
                      </div>
                      <div className={`mt-1 flex justify-between text-[10px] tabular-nums ${textSecondary}`}>
                        <span>{formatClock(t)} / {formatClock(tier.demo.duration)}</span>
                        <span>
                          {t < tier.demo.sourceEnd
                            ? '正在播放：前曲尾部'
                            : t < tier.demo.transitionEnd
                              ? '正在播放：过渡段'
                              : '正在播放：后曲开头'}
                        </span>
                      </div>
                    </div>

                    <audio
                      ref={(el) => { audioRefs.current[tier.key] = el }}
                      src={tier.demo.file}
                      preload="metadata"
                      onError={() => setLoadErrors(prev => ({ ...prev, [tier.key]: true }))}
                      onEnded={() => {
                        setPlaying(prev => (prev === tier.key ? null : prev))
                        setTimes(prev => ({ ...prev, [tier.key]: 0 }))
                      }}
                    />
                    {loadErrors[tier.key] && (
                      <div className="mt-2 text-[11px] text-red-400">
                        试听片段加载失败（缺少 {tier.demo.file}），请确认安装包完整。
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className={`${textSecondary} mt-4 text-[11px] leading-relaxed`}>
              试听片段取自三档在同一对歌曲上的真实产物：前段为《{AUTOMIX_DEMO_PAIR.sourceName}》尾部，
              中间为过渡段，后段为《{AUTOMIX_DEMO_PAIR.targetName}》开头。
              Advanced / Extreme 的切点与过渡时长由云端下发，因此三档的换歌时机并不相同。
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

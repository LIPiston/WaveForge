import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AudioLines, Drum, MicVocal, Music2, RotateCcw, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TrackStemGains, TrackStemName } from '../audio/trackStemMixer'
import { useTvBack } from '../tv/tvCore'

export type StemControlStatus = 'unavailable' | 'idle' | 'separating' | 'partial' | 'ready' | 'failed'

export interface TrackStemControlModel {
  status: StemControlStatus
  gains: TrackStemGains
  availableStems: TrackStemName[]
  progress?: number
  active: boolean
  locked?: boolean
  reason?: string
  onEnable: () => void | Promise<boolean | void>
  onVocalChange: (gain: number) => void
  onStemChange: (stem: TrackStemName, gain: number) => void
  onReturnOriginal: () => void
}

interface StemMixerPopoverProps {
  control: TrackStemControlModel
  accentColor: string
  theme: 'light' | 'dark'
  variant?: 'compact' | 'immersive'
  placement?: 'above' | 'left' | 'right'
  size?: 'default' | 'compact'
}

const STEM_META: Record<TrackStemName, { label: string; Icon: typeof MicVocal }> = {
  vocals: { label: '人声', Icon: MicVocal },
  drums: { label: '鼓组', Icon: Drum },
  bass: { label: '贝斯', Icon: Waves },
  other: { label: '其他乐器', Icon: Music2 },
}

const clamp = (value: number, min = 0, max = 1.2) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 1))

export function StemMixerPopover({
  control,
  accentColor,
  theme,
  variant = 'compact',
  placement = 'above',
  size = 'default',
}: StemMixerPopoverProps) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  /** 启用失败时的可见提示：onEnable 返回 false 的多数路径只写 status/reason，
   *  静默返回 false 的路径（换 generation / 预载重跑）界面上原本毫无反馈，用户只看到滑块弹回。 */
  const [enableHint, setEnableHint] = useState('')
  const enableInFlightRef = useRef<Promise<boolean> | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const dark = theme === 'dark'
  const immersive = variant === 'immersive'
  const disabled = Boolean(control.locked)
  const vocalPercent = Math.round(clamp(control.gains.vocals, 0, 1) * 100)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  // TV BACK：先关分轨调音 popover，不要穿透到外层（退出播放页）
  useTvBack(() => {
    if (open) {
      setOpen(false)
      return true
    }
    return false
  }, [open])

  const openOrEnable = () => {
    if (control.locked) return
    setOpen(value => !value)
  }
  /**
   * 首次启用要等模型加载 + 首个窗口分离（约 10–20s）。原实现每次 onChange 都直接调 onEnable()：
   * 拖动会连发多次，每次都会换 generation 并 kill 上一次的 worker，等于自己把刚启动的分离任务踩死
   * （用户实测"拖了没反应、重试更不可能成功"）。这里改成：准备期间只记录**最新一次**目标增益，
   * 复用同一个 in-flight enable，完成后统一应用。
   */
  const enableThen = (action: () => void) => {
    if (control.active) {
      action()
      return
    }
    pendingActionRef.current = action
    if (enableInFlightRef.current) return
    setEnableHint('')
    const attempt = Promise.resolve(control.onEnable())
      .then((result): boolean => {
        if (result === false) {
          setEnableHint(control.reason || '分轨准备失败，请重试')
          return false
        }
        const pending = pendingActionRef.current
        pendingActionRef.current = null
        pending?.()
        return true
      })
      .catch(() => {
        setEnableHint('分轨准备失败，请重试')
        return false
      })
      .finally(() => {
        enableInFlightRef.current = null
      })
    enableInFlightRef.current = attempt
  }

  const surface = dark ? 'rgba(17,19,27,.88)' : 'rgba(255,255,255,.9)'
  const text = dark ? '#f5f6fa' : '#202126'
  const muted = dark ? 'rgba(255,255,255,.55)' : 'rgba(20,21,26,.55)'
  const track = dark ? 'rgba(255,255,255,.13)' : 'rgba(10,12,18,.11)'

  return (
    <div ref={rootRef} className="relative flex items-center" data-stem-mixer-variant={variant}>
      {/* 沉浸模式下本按钮是玻璃板里的一行（行宽 = 板宽），放大 1.08 会让高亮冒出板外 →
          与 ImmersiveControls 同规矩：板内只换底色，按压只向内微缩。 */}
      <motion.button
        type="button"
        whileHover={disabled || immersive ? undefined : { scale: 1.08 }}
        whileTap={disabled ? undefined : { scale: immersive ? 0.94 : 0.95 }}
        onClick={openOrEnable}
        disabled={disabled}
        className={`relative transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${immersive
          ? `rounded-[18px] ${size === 'compact' ? 'p-2.5' : 'p-3'} ${dark ? 'hover:bg-white/[0.13]' : 'hover:bg-black/[0.10]'}`
          : `rounded-full p-2 ${dark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}`}
        title={control.locked ? 'AutoMix 过渡期间暂不可调整分轨' : control.reason || '人声与乐器调节'}
        aria-label="人声与乐器调节"
      >
        {/* 沉浸模式：本按钮在工具条底板上是一行**透明行**（底色/描边都在底板上），
            所以启用态自己画底色 —— 沿用原启用态的封面主色平涂配方，并在板左缘外挂一条主色指示条，
            与 ImmersiveControls 里那几行保持一致（主色透明度用 color-mix，hex / rgb() 都能上透明度）。 */}
        {immersive && control.active && (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[18px]"
              style={{
                backgroundColor: accentColor,
                boxShadow: `0 0 20px color-mix(in srgb, ${accentColor} 25%, transparent), inset 0 1px 1px rgba(255,255,255,0.3)`,
              }}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-[-7px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full"
              style={{ backgroundColor: accentColor }}
            />
          </>
        )}
        {/* 图标加 relative：上面那层主色行是 absolute（定位元素会盖在未定位内容之上），
            图标必须自己定位才能画回它上面。 */}
        <AudioLines className={immersive ? `${size === 'compact' ? 'h-5 w-5' : 'h-6 w-6'} relative` : 'h-4 w-4'} style={{ color: immersive && control.active ? '#fff' : control.active ? accentColor : muted }} />
        {control.status === 'separating' && <span className="absolute right-0 top-0 h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: accentColor }} />}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="stem-mixer-popover"
            data-tv-scope={open ? '' : undefined}
            initial={reducedMotion ? { opacity: 0 } : placement === 'above' ? { opacity: 0, y: 8, scale: 0.96 } : { opacity: 0, x: placement === 'left' ? 8 : -8, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : placement === 'above' ? { opacity: 0, y: 8, scale: 0.96 } : { opacity: 0, x: placement === 'left' ? 8 : -8, scale: 0.96 }}
            transition={{ duration: reducedMotion ? 0.1 : 0.18 }}
            className={`absolute z-[190] w-[300px] rounded-2xl border p-3 shadow-2xl ${placement === 'left' ? 'right-full top-1/2 mr-3 -translate-y-1/2' : placement === 'right' ? 'left-full top-1/2 ml-3 -translate-y-1/2' : 'bottom-full right-0 mb-3'}`}
            style={{ background: surface, color: text, borderColor: dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)', backdropFilter: 'blur(36px) saturate(170%)' }}
          >
            <style>{`
              .stem-mixer-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; border-radius:50%; background:${dark ? '#f7f7fa' : '#ffffff'}; border:1px solid ${dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.12)'}; box-shadow:0 3px 10px rgba(0,0,0,.28); }
              .stem-mixer-range::-moz-range-thumb { width:20px; height:20px; border-radius:50%; background:${dark ? '#f7f7fa' : '#ffffff'}; border:1px solid ${dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.12)'}; box-shadow:0 3px 10px rgba(0,0,0,.28); }
            `}</style>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">人声分离</div>
                <div className="text-[10px]" style={{ color: muted }}>
                  {enableHint
                    ? enableHint
                    : control.status === 'separating'
                      ? `正在准备分轨 ${Math.round((control.progress || 0) * 100)}%（首次需加载模型，约 10–20 秒）`
                      : control.status === 'unavailable' ? (control.reason || '当前音源暂不支持分轨') : control.status === 'failed' ? '分轨失败，当前保持原声' : control.locked ? '过渡进行中，已冻结当前增益' : '拖动时保持乐器不变，仅调节人声'}
                </div>
              </div>
              <button type="button" onClick={() => setCustom(value => !value)} className="rounded-lg px-2 py-1 text-xs font-medium" style={{ color: accentColor, background: `${accentColor}18` }}>
                {custom ? '简洁' : '自定义'}
              </button>
            </div>

            {(control.status === 'unavailable' || control.status === 'failed') && (
              <button
                type="button"
                onClick={() => {
                  setEnableHint('')
                  void Promise.resolve(control.onEnable()).then(result => {
                    if (result === false) setEnableHint(control.reason || '仍然不可用，请在设置里确认分轨模型已安装')
                  })
                }}
                className="mb-3 w-full rounded-lg py-1.5 text-xs font-medium"
                style={{ color: accentColor, background: `${accentColor}18` }}
              >
                重新检测并准备分轨
              </button>
            )}

            {!custom ? (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: muted }}><span>伴奏</span><span>原声</span></div>
                <input
                  aria-label="人声音量"
                  type="range" min="0" max="100" step="1" value={vocalPercent}
                  disabled={control.locked || control.status === 'separating' || control.status === 'unavailable' || control.status === 'failed'}
                  onChange={event => enableThen(() => control.onVocalChange(Number(event.target.value) / 100))}
                  className="stem-mixer-range h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${vocalPercent}%, ${track} ${vocalPercent}%, ${track} 100%)` }}
                />
                <div className="mt-2 text-center text-xs font-semibold tabular-nums">人声 {vocalPercent}%</div>
              </div>
            ) : (
              <div className="space-y-3">
                {control.availableStems.length === 0 && (
                  <div className="rounded-lg py-3 text-center text-xs" style={{ color: muted, background: track }}>
                    当前窗口尚未检测到可调音轨
                  </div>
                )}
                {control.availableStems.map(stem => {
                  const meta = STEM_META[stem]
                  const value = Math.round(clamp(control.gains[stem]) * 100)
                  return (
                    <label key={stem} className="grid grid-cols-[82px_1fr_42px] items-center gap-2">
                      <span className="flex items-center gap-1.5 text-xs"><meta.Icon className="h-3.5 w-3.5" style={{ color: accentColor }} />{meta.label}</span>
                      <input
                        aria-label={`${meta.label}增益`}
                        type="range" min="0" max="120" step="1" value={value}
                        disabled={control.locked || control.status === 'separating' || control.status === 'unavailable' || control.status === 'failed'}
                        onChange={event => enableThen(() => control.onStemChange(stem, Number(event.target.value) / 100))}
                        className="stem-mixer-range h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${value / 1.2}%, ${track} ${value / 1.2}%, ${track} 100%)` }}
                      />
                      <span className="text-right text-[11px] font-semibold tabular-nums" style={{ color: value > 100 ? accentColor : text }}>{value}%</span>
                    </label>
                  )
                })}
              </div>
            )}

            <button type="button" onClick={control.onReturnOriginal} className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium" style={{ color: muted, background: track }}>
              <RotateCcw className="h-3 w-3" />恢复原声
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default StemMixerPopover

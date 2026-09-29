import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RotateCcw, Trash2, X } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import {
  fetchQQDislikeList,
  fetchQQUserProfile,
  removeQQDislikeEntry,
  saveQQUserProfile,
  type QQDislikeEntry,
  type QQDislikeKind,
  type QQUserProfile,
} from './api'

/**
 * 我的音乐偏好（PC 横版）。
 * 数据与交互 1:1 对齐 QQ 音乐 App「刷歌播放页 → 右上角设置 → 我的音乐偏好」H5
 * （i.y.qq.com/n2/m/client/preferences_set_v2）：
 *  · 歌曲熟悉度 / 音乐情绪 = 三档固定选项（25 / 50 / 75）
 *  · 歌曲风格 = 1..99 滑杆，50 默认比例、<50 减少推荐、>50 增加推荐
 *  · 保存后调节状态 30 天内有效；重置把所有分数回到 50 并立即保存
 *  · 黑名单入口（歌曲 / 歌手 / 风格，可移除）
 */

const FAMILIARITY_KEY = '10008'
const MOOD_KEY = '10009'

type OptionItem = { name: string; score: number; img: string }

const FAMILIARITY_OPTIONS: OptionItem[] = [
  { name: '更探索', score: 25, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919855.png?max_age=2592000' },
  { name: '保持现状', score: 50, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919857.png?max_age=2592000' },
  { name: '更熟悉', score: 75, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919860.png?max_age=2592000' },
]

const MOOD_OPTIONS: OptionItem[] = [
  { name: '更伤感', score: 25, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919858.png?max_age=2592000' },
  { name: '保持现状', score: 50, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919857.png?max_age=2592000' },
  { name: '更欢快', score: 75, img: 'https://y.qq.com/music/common/upload/t_cm3_photo_publish/4919859.png?max_age=2592000' },
]

// 滑杆视觉：自绘 thumb / 轨道，避免原生控件在深色玻璃面板里突兀
const RANGE_CSS = `
.qqpref-range { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 999px; outline: none; cursor: pointer; }
.qqpref-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 999px; background: #ffffff; border: 3px solid var(--qqpref-accent, #22c55e); box-shadow: 0 2px 10px rgba(0,0,0,.5); transition: transform .12s ease; }
.qqpref-range:hover::-webkit-slider-thumb { transform: scale(1.14); }
.qqpref-range:disabled { opacity: .5; cursor: default; }
`

const formatUpdateDate = (seconds: number): string => {
  if (!seconds) return '—'
  const date = new Date(seconds * 1000)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

const scoreHint = (score: number): { text: string; cls: string } => {
  if (score === 50) return { text: '默认比例', cls: 'text-white/40' }
  return score > 50 ? { text: '增加推荐', cls: 'text-emerald-300/90' } : { text: '减少推荐', cls: 'text-amber-200/85' }
}

type DraftProfile = QQUserProfile

interface QQMusicPreferenceDialogProps {
  open: boolean
  onClose: () => void
  accent?: string
}

export default function QQMusicPreferenceDialog({ open, onClose, accent = '#22c55e' }: QQMusicPreferenceDialogProps) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [expired, setExpired] = useState(false)
  const [updateTime, setUpdateTime] = useState(0)
  const [showsTitle, setShowsTitle] = useState('')
  const [drafts, setDrafts] = useState<DraftProfile[]>([])
  const adjustKeyRef = useRef('')

  const [blackOpen, setBlackOpen] = useState(false)
  const [blackLoading, setBlackLoading] = useState(false)
  const [blackError, setBlackError] = useState('')
  const [blackGroups, setBlackGroups] = useState<{ songs: QQDislikeEntry[]; singers: QQDislikeEntry[]; styles: QQDislikeEntry[] }>({ songs: [], singers: [], styles: [] })

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(current => (current === message ? '' : current)), 2400)
  }, [])

  const loadProfile = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchQQUserProfile()
      setExpired(Boolean(data.expired))
      setUpdateTime(Number(data.updateTime) || 0)
      setShowsTitle(String(data.showsTitle || ''))
      setDrafts(data.profiles.map(item => ({ ...item })))
      adjustKeyRef.current = ''
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '音乐偏好加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadProfile()
    setToast('')
  }, [open, loadProfile])

  useEffect(() => {
    if (!open) {
      setBlackOpen(false)
      setBlackGroups({ songs: [], singers: [], styles: [] })
    }
  }, [open])

  const loadBlacklist = useCallback(async () => {
    setBlackLoading(true)
    setBlackError('')
    try {
      const data = await fetchQQDislikeList()
      setBlackGroups({ songs: data.songs || [], singers: data.singers || [], styles: data.styles || [] })
    } catch (loadError) {
      setBlackError(loadError instanceof Error ? loadError.message : '黑名单加载失败')
    } finally {
      setBlackLoading(false)
    }
  }, [])

  const toggleBlackPanel = useCallback(() => {
    setBlackOpen(current => {
      const next = !current
      if (next) void loadBlacklist()
      return next
    })
  }, [loadBlacklist])

  const handleRemoveBlack = useCallback(async (kind: QQDislikeKind, entry: QQDislikeEntry) => {
    try {
      await removeQQDislikeEntry(kind, entry)
      setBlackGroups(current => ({
        songs: kind === 'song' ? current.songs.filter(item => item.id !== entry.id) : current.songs,
        singers: kind === 'singer' ? current.singers.filter(item => item.id !== entry.id) : current.singers,
        styles: kind === 'style' ? current.styles.filter(item => !(item.id === entry.id && item.idType === entry.idType)) : current.styles,
      }))
      showToast(`已从黑名单移除「${entry.name || entry.id}」`)
    } catch (removeError) {
      showToast(removeError instanceof Error ? removeError.message : '移除失败，请稍后重试')
    }
  }, [showToast])

  const setScore = useCallback((key: string, score: number) => {
    adjustKeyRef.current = key
    setDrafts(current => current.map(item => (item.key === key ? { ...item, score } : item)))
  }, [])

  const persist = useCallback(async (next: DraftProfile[], message: string, resetAdjust: boolean) => {
    setSaving(true)
    setError('')
    try {
      await saveQQUserProfile(next.map(item => ({
        key: item.key,
        score: item.score,
        isAdjust: !resetAdjust && item.key === adjustKeyRef.current,
        isBlack: item.isBlack,
      })))
      adjustKeyRef.current = ''
      setExpired(false)
      setUpdateTime(Math.floor(Date.now() / 1000))
      showToast(message)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '音乐偏好保存失败')
    } finally {
      setSaving(false)
    }
  }, [showToast])

  const handleSave = useCallback(() => {
    if (saving || drafts.length === 0) return
    void persist(drafts, '已保存，调节状态持续生效 30 天', false)
  }, [drafts, persist, saving])

  const handleReset = useCallback(() => {
    if (saving || drafts.length === 0) return
    const next = drafts.map(item => ({ ...item, score: 50 }))
    setDrafts(next)
    void persist(next, '已重置，调节状态持续生效 30 天', true)
  }, [drafts, persist, saving])

  const familiarity = useMemo(() => drafts.find(item => item.key === FAMILIARITY_KEY), [drafts])
  const mood = useMemo(() => drafts.find(item => item.key === MOOD_KEY), [drafts])
  const styleProfiles = useMemo(() => drafts.filter(item => item.key !== FAMILIARITY_KEY && item.key !== MOOD_KEY), [drafts])

  if (!open) return null

  const disabled = loading || saving

  const renderOptionColumn = (title: string, hint: string, profile: DraftProfile | undefined, options: OptionItem[]) => (
    <section className="flex min-h-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <header className="mb-3 flex items-baseline justify-between">
        <h4 className="text-[15px] font-semibold tracking-tight text-white/90">{title}</h4>
        <span className="text-[11px] text-white/35">{hint}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5">
        {options.map(option => {
          const selected = Number(profile?.score) === option.score
          return (
            <button
              key={option.name}
              type="button"
              disabled={disabled || !profile}
              onClick={() => profile && setScore(profile.key, option.score)}
              className={`group flex min-h-[64px] flex-1 items-center gap-3.5 rounded-xl border px-4 text-left transition ${selected ? 'border-transparent text-[#04160d] shadow-[0_16px_36px_-18px_var(--qqpref-accent)]' : 'border-white/[0.07] bg-white/[0.02] text-white/75 hover:border-white/[0.14] hover:bg-white/[0.05] disabled:opacity-45'}`}
              style={selected ? { background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)` } : undefined}
            >
              <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-black/10' : 'bg-white/[0.05]'}`}>
                <CachedImage src={option.img} alt="" className="h-7 w-7 object-contain" role="compact" priority="visible" platform="qq" />
              </span>
              <span className="flex-1 text-[14.5px] font-medium">{option.name}</span>
              {selected && <span className="h-1.5 w-1.5 rounded-full bg-[#04160d]/70" />}
            </button>
          )
        })}
      </div>
    </section>
  )

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-6 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="我的音乐偏好" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
      <style>{RANGE_CSS}</style>
      <div
        className="relative flex max-h-[90vh] w-full max-w-[1240px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0b0f14] shadow-[0_40px_140px_-30px_rgba(0,0,0,0.95)]"
        style={{ ['--qqpref-accent' as string]: accent }}
      >
        {/* 顶部氛围光：给深色面板一点层次，而不是一块死黑 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-44" style={{ background: `radial-gradient(58% 130% at 18% 0%, ${accent}24 0%, transparent 72%)` }} />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}66, transparent)` }} />

        <header className="relative flex items-center justify-between gap-6 px-8 pt-6 pb-4">
          <div className="flex items-baseline gap-3">
            <h3 className="text-[22px] font-semibold tracking-tight text-white">我的音乐偏好</h3>
            {showsTitle ? <span className="rounded-full border border-white/[0.09] bg-white/[0.03] px-2.5 py-[3px] text-[11px] text-white/55">{showsTitle}</span> : null}
            <span className="text-xs text-white/35">保存后 30 天内有效</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={toggleBlackPanel} className={`h-9 rounded-full border px-4 text-[13px] transition ${blackOpen ? 'border-white/[0.18] bg-white/[0.1] text-white' : 'border-white/[0.09] text-white/60 hover:bg-white/[0.06] hover:text-white'}`}>黑名单</button>
            <button type="button" disabled={saving} onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white" aria-label="关闭音乐偏好">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="relative flex items-center justify-between px-8 pb-4 text-[13px]">
          <span className="text-white/45">
            上次调节 <span className="font-medium tabular-nums text-white/85">{formatUpdateDate(updateTime)}</span>
            <span className="ml-1 text-white/25">（30 天有效）</span>
          </span>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-[3px] text-[12px] ${expired ? 'border-amber-300/25 bg-amber-300/[0.08] text-amber-200/90' : 'border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-200/90'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${expired ? 'bg-amber-300/80' : 'bg-emerald-300/90'}`} />
            {expired ? '已过期' : '生效中'}
          </span>
        </div>

        <div className="relative min-h-0 flex-1 px-8">
          {blackOpen ? (
            <div className="grid h-full min-h-[320px] grid-cols-3 gap-5 overflow-hidden">
              {blackLoading ? (
                <div className="col-span-3 flex min-h-56 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-white/55" /></div>
              ) : blackError ? (
                <p className="col-span-3 rounded-xl border border-rose-300/15 bg-rose-300/[0.06] p-4 text-sm text-rose-100/85">{blackError}</p>
              ) : (
                ([['歌曲', 'song', blackGroups.songs], ['歌手', 'singer', blackGroups.singers], ['风格', 'style', blackGroups.styles]] as Array<[string, QQDislikeKind, QQDislikeEntry[]]>).map(([label, kind, entries]) => (
                  <section key={kind} className="flex min-h-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <header className="mb-3 flex items-baseline justify-between">
                      <h4 className="text-[15px] font-semibold tracking-tight text-white/90">{label}黑名单</h4>
                      <span className="text-[11px] tabular-nums text-white/35">{entries.length} 项</span>
                    </header>
                    {entries.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-white/[0.08] px-3 py-6 text-center text-xs leading-5 text-white/35">
                        暂无{label}黑名单
                        <br />加入黑名单的{label}将不会被推荐
                      </p>
                    ) : (
                      <div className="-mr-1 flex-1 space-y-1 overflow-y-auto pr-1">
                        {entries.map(entry => (
                          <div key={`${kind}-${entry.id}-${entry.idType}`} className="group flex items-center gap-2.5 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2 transition hover:border-white/[0.12] hover:bg-white/[0.05]">
                            {entry.img ? <CachedImage src={entry.img} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" role="compact" priority="visible" platform="qq" /> : null}
                            <span className="min-w-0 flex-1 truncate text-[13px] text-white/80" title={entry.name}>{entry.name || entry.id}</span>
                            <button type="button" onClick={() => void handleRemoveBlack(kind, entry)} className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-white/35 opacity-0 transition group-hover:opacity-100 hover:bg-white/[0.08] hover:text-rose-200">
                              <Trash2 className="h-3.5 w-3.5" />移除
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                ))
              )}
            </div>
          ) : loading ? (
            <div className="flex min-h-[320px] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-white/55" /></div>
          ) : error ? (
            <p className="rounded-xl border border-rose-300/15 bg-rose-300/[0.06] p-4 text-sm text-rose-100/85">{error}</p>
          ) : drafts.length === 0 ? (
            <p className="py-16 text-center text-sm text-white/45">QQ 音乐未返回可调节的偏好项，请稍后重试。</p>
          ) : (
            <div className="grid h-full min-h-[400px] grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)_minmax(360px,1.5fr)] gap-5">
              {renderOptionColumn('歌曲熟悉度', '决定推荐的新鲜度', familiarity, FAMILIARITY_OPTIONS)}
              {renderOptionColumn('音乐情绪', '决定推荐的情绪走向', mood, MOOD_OPTIONS)}
              <section className="flex min-h-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <header className="mb-3 flex items-baseline justify-between">
                  <h4 className="text-[15px] font-semibold tracking-tight text-white/90">歌曲风格</h4>
                  <span className="text-[11px] text-white/35">向左减少 · 向右增加</span>
                </header>
                <div className="-mr-1 flex-1 space-y-1.5 overflow-y-auto pr-1">
                  {styleProfiles.map(profile => {
                    const hint = scoreHint(profile.score)
                    const value = Math.max(1, Math.min(99, profile.score || 1))
                    const pct = ((value - 1) / 98) * 100
                    return (
                      <div key={profile.key} className="grid grid-cols-[76px_1fr_62px] items-center gap-3.5 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5 transition hover:border-white/[0.11] hover:bg-white/[0.04]">
                        <span className="truncate text-[13.5px] text-white/80" title={profile.name}>{profile.name}</span>
                        <span className="relative flex items-center">
                          <input
                            type="range"
                            min={1}
                            max={99}
                            value={value}
                            disabled={saving}
                            onChange={event => setScore(profile.key, Number(event.target.value))}
                            className="qqpref-range"
                            style={{ background: `linear-gradient(to right, ${accent} 0%, ${accent} ${pct}%, rgba(255,255,255,0.10) ${pct}%, rgba(255,255,255,0.10) 100%)` }}
                            aria-label={`${profile.name} 推荐比例`}
                          />
                          {/* 50 = 默认比例的中心刻度 */}
                          <span className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-white/25" />
                        </span>
                        <span className={`text-right text-[11.5px] ${hint.cls}`}>{hint.text}</span>
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>
          )}
        </div>

        <footer className="relative mt-4 flex items-center justify-between gap-4 border-t border-white/[0.07] px-8 py-4">
          <span className={`truncate text-xs ${toast ? 'text-emerald-200/90' : 'text-transparent'}`}>{toast || '\u00A0'}</span>
          <div className="flex items-center gap-3">
            <button type="button" disabled={disabled || drafts.length === 0} onClick={handleReset} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-[13px] text-white/70 transition hover:bg-white/[0.06] disabled:opacity-45">
              <RotateCcw className="h-4 w-4" />重置
            </button>
            <button type="button" disabled={disabled || drafts.length === 0} onClick={handleSave} className="flex h-10 items-center gap-2 rounded-full px-7 text-[13px] font-semibold text-[#04160d] shadow-[0_14px_34px_-16px_var(--qqpref-accent)] transition hover:brightness-105 disabled:opacity-45" style={{ background: `linear-gradient(135deg, ${accent} 0%, ${accent}cc 100%)` }}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

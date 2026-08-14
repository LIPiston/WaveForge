import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Disc3, Clock, BadgeCheck, Crown, Calendar, Video, CircleDollarSign } from 'lucide-react'
import type { Song } from '../services/musicApi'

interface SongDetailModalProps {
  song: Song
  onClose: () => void
  playerTheme: 'dark' | 'light'
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(ms: number): string {
  const d = new Date(Number(ms) || 0)
  if (Number.isNaN(d.getTime()) || !ms) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 网易云 fee 字段：0 免费 / 1 VIP / 4 付费专辑 / 8 低音质免费
const NETBASE_FEE_LABELS: Record<number, string> = {
  0: '免费',
  1: 'VIP 专享',
  4: '付费专辑',
  8: '免费（低音质）',
}

export default function SongDetailModal({ song, onClose, playerTheme }: SongDetailModalProps) {
  const dark = playerTheme === 'dark'
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [extra, setExtra] = useState<{ publishTime?: number; mvId?: number; fee?: number; quality?: string } | null>(null)

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  // 拉取两平台支持的歌曲详情补充字段（发行时间 / MV / 付费类型 / 音质）
  useEffect(() => {
    let cancelled = false
    const fetchDetail = async () => {
      try {
        if (song.platform === 'qq') {
          const mid = String(song.mid || song.id)
          const res = await fetch(`http://localhost:3001/api/qq/song/detail?mid=${encodeURIComponent(mid)}`)
          const data = await res.json()
          if (!cancelled && data?.song) {
            setExtra({
              publishTime: data.song.publishTime || data.song.album?.publishTime,
              mvId: data.song.mvId || data.song.mv,
              fee: data.song.fee,
              quality: data.song.vip ? '无损 / 高品质' : '标准',
            })
          }
        } else {
          const res = await fetch(`http://localhost:3001/api/netease/song/detail?ids=${encodeURIComponent(String(song.id))}`)
          const data = await res.json()
          const detail = data?.songs?.[0]
          if (!cancelled && detail) {
            const quality = detail.hr ? 'Hi-Res 无损'
              : detail.sq ? '无损 FLAC'
                : detail.h ? '高品质 320k'
                  : detail.m ? '标准 192k'
                    : detail.l ? '普通 128k'
                      : ''
            setExtra({
              publishTime: detail.publishTime || detail.al?.publishTime,
              mvId: detail.mv,
              fee: detail.fee,
              quality,
            })
          }
        }
      } catch {
        // 拉取失败时仅展示已有字段
      }
    }
    void fetchDetail()
    return () => { cancelled = true }
  }, [song.id, song.mid, song.platform])

  const artists = Array.isArray(song.artists) ? song.artists.map(a => a.name).filter(Boolean).join(' / ') : '未知歌手'
  const albumName = song.album?.name || '未知专辑'
  const coverUrl = song.album?.picUrl || ''
  const platformLabel = song.platform === 'qq' ? 'QQ音乐' : song.platform === 'netease' ? '网易云音乐' : ''
  const publishDate = formatDate(extra?.publishTime || 0)
  const feeLabel = extra?.fee != null && platformLabel === '网易云音乐'
    ? NETBASE_FEE_LABELS[extra.fee]
    : ''

  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'
  const border = dark ? 'border-white/12' : 'border-black/12'

  const infoRow = (icon: ReactNode, label: string, value: string, mono = false) => (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
      <span className="shrink-0" style={{ color: accentColor }}>{icon}</span>
      <span className={`${textSecondary} text-sm shrink-0`}>{label}</span>
      <span className={`flex-1 min-w-0 text-sm ${textPrimary} truncate text-right ${mono ? 'tabular-nums' : ''}`}>{value}</span>
    </div>
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-4"
      style={{ backgroundColor: dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 26, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl"
        style={{ background: dark ? 'rgba(14,17,24,0.86)' : 'rgba(255,255,255,0.9)', border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`, backdropFilter: 'blur(30px)' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
              <Music className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className={`text-base font-semibold ${textPrimary}`}>歌曲详情</h2>
              {platformLabel && <div className={`${textSecondary} text-[11px] -mt-0.5`}>{platformLabel}</div>}
            </div>
          </div>
          <button type="button" onClick={onClose} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        <div className="p-6">
          {/* 封面 + 标题 */}
          <div className="flex gap-4 items-center">
            <div className="w-24 h-24 rounded-2xl overflow-hidden shrink-0" style={{ background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', border: `1px solid ${border}` }}>
              {coverUrl ? (
                <img src={coverUrl} alt={song.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Music className="w-8 h-8" style={{ color: accentColor }} />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={`text-lg font-bold ${textPrimary} leading-snug break-words`}>{song.name || '未知歌曲'}</h3>
              <p className={`${textSecondary} text-sm mt-1 truncate`}>{artists}</p>
              {song.vip && (
                <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-md text-[11px] text-white" style={{ backgroundColor: `${accentColor}` }}>
                  <Crown className="w-3 h-3" /> VIP
                </span>
              )}
            </div>
          </div>

          {/* 信息列表 */}
          <div className="mt-5 space-y-2.5">
            {infoRow(<Disc3 className="w-4 h-4" />, '专辑', albumName)}
            {infoRow(<Clock className="w-4 h-4" />, '时长', formatDuration(song.duration), true)}
            {publishDate && infoRow(<Calendar className="w-4 h-4" />, '发行时间', publishDate, true)}
            {extra?.mvId != null && infoRow(<Video className="w-4 h-4" />, 'MV', '有 MV 版本')}
            {feeLabel && infoRow(<CircleDollarSign className="w-4 h-4" />, '音质', feeLabel)}
            {platformLabel && infoRow(<BadgeCheck className="w-4 h-4" />, '来源', platformLabel)}
            {typeof song.commentCount === 'number' && infoRow(<Music className="w-4 h-4" />, '评论', song.commentCount.toLocaleString(), true)}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

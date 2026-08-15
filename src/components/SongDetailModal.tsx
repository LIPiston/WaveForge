import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Disc3, Clock, BadgeCheck, Crown, Calendar, Video, CircleDollarSign, ListMusic, Mic2, ScrollText, BookOpen } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getLyrics, getNeteaseSongWiki, getQQSongPlaylist } from '../services/musicApi'

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
  // QQ 歌曲详情的板块数据
  const [qqInfo, setQqInfo] = useState<any>(null)
  const [credits, setCredits] = useState<string[]>([])
  const [lyrics, setLyrics] = useState<{ time: number; text: string }[]>([])
  const [lyricsLoading, setLyricsLoading] = useState(false)
  // 网易云歌曲百科 / QQ 所在歌单
  const [wiki, setWiki] = useState<string>('')
  const [songPlaylists, setSongPlaylists] = useState<{ id: string; name: string; coverUrl: string }[]>([])

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
          // 基础信息板块（语种/流派/唱片公司/发行时间/简介）
          if (!cancelled && data?.detail?.info) setQqInfo(data.detail.info)
          // 歌词 + 幕后团队（歌词前几行的“词/曲/编曲/制作人”等）
          setLyricsLoading(true)
          const lyricLines = await getLyrics(mid, 'qq', song.name, Array.isArray(song.artists) ? song.artists.map(a => a.name).join(', ') : '', song.duration)
          if (!cancelled && Array.isArray(lyricLines)) {
            setLyrics(lyricLines)
            const creditLines = lyricLines.slice(0, 20)
              .map(l => (l.text || '').trim())
              .filter(t => /^(词|曲|编曲|制作人|合声|和声|吉他|贝斯|鼓|录音|混音|母带|弦乐|小提琴|钢琴|键盘|监制)/.test(t))
            setCredits(creditLines)
          }
          if (!cancelled) setLyricsLoading(false)
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

  // 网易云歌曲百科 / QQ 歌曲所在歌单
  useEffect(() => {
    let cancelled = false
    if (song.platform === 'netease') {
      void getNeteaseSongWiki(song.id).then((summary) => {
        if (!cancelled && summary) setWiki(String(summary).slice(0, 300))
      })
    } else if (song.platform === 'qq' && song.mid) {
      void getQQSongPlaylist(String(song.mid)).then((data) => {
        if (cancelled || !data) return
        const list = data?.list || data?.songList || []
        setSongPlaylists(Array.isArray(list) ? list.slice(0, 5).map((p: any) => ({
          id: String(p.dissid || p.tid || ''),
          name: p.dissname || p.name || '未知歌单',
          coverUrl: p.imgurl || p.picUrl || '',
        })) : [])
      })
    }
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
        className="w-full max-w-lg overflow-hidden rounded-3xl shadow-2xl max-h-[88vh] flex flex-col"
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

        <div className="flex-1 overflow-y-auto p-6">
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

          {/* QQ 基础信息板块（语种/流派/唱片公司/发行时间/简介） */}
          {song.platform === 'qq' && qqInfo && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2.5">
                <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                <h4 className={`text-sm font-semibold ${textPrimary}`}>基础信息</h4>
              </div>
              <div className="space-y-2">
                {qqInfo.lan?.content?.[0]?.value && infoRow(<Mic2 className="w-4 h-4" />, '语种', qqInfo.lan.content[0].value)}
                {qqInfo.genre?.content?.[0]?.value && infoRow(<Music className="w-4 h-4" />, '流派', qqInfo.genre.content[0].value)}
                {qqInfo.company?.content?.[0]?.value && infoRow(<Disc3 className="w-4 h-4" />, '唱片公司', qqInfo.company.content[0].value)}
                {qqInfo.pub_time?.content?.[0]?.value && infoRow(<Calendar className="w-4 h-4" />, '发行时间', qqInfo.pub_time.content[0].value)}
              </div>
              {qqInfo.intro?.content?.[0]?.value && (
                <div className="mt-3 rounded-xl px-3 py-2.5" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                  <p className={`${textSecondary} text-xs mb-1`}>歌曲简介</p>
                  <p className={`${textPrimary} text-sm leading-relaxed`}>{qqInfo.intro.content[0].value}</p>
                </div>
              )}
            </div>
          )}

          {/* 幕后团队（QQ 歌词头部信息） */}
          {song.platform === 'qq' && credits.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2.5">
                <Mic2 className="w-4 h-4" style={{ color: accentColor }} />
                <h4 className={`text-sm font-semibold ${textPrimary}`}>幕后团队</h4>
              </div>
              <div className="rounded-xl px-3 py-2.5" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                {credits.map((line, i) => (
                  <p key={i} className={`${textPrimary} text-sm leading-6`}>{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* 歌词 */}
          {song.platform === 'qq' && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2.5">
                <ScrollText className="w-4 h-4" style={{ color: accentColor }} />
                <h4 className={`text-sm font-semibold ${textPrimary}`}>歌词</h4>
              </div>
              {lyricsLoading ? (
                <p className={`${textSecondary} text-sm py-3`}>加载歌词中...</p>
              ) : lyrics.length === 0 ? (
                <p className={`${textSecondary} text-sm py-3`}>暂无歌词</p>
              ) : (
                <div className="rounded-xl px-3 py-2.5 max-h-64 overflow-y-auto" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                  {lyrics.map((l, i) => (
                    <p key={i} className={`${textPrimary} text-sm leading-6`}>{l.text || '\u00A0'}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 网易云歌曲百科 */}
          {song.platform === 'netease' && wiki && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2.5">
                <BookOpen className="w-4 h-4" style={{ color: accentColor }} />
                <h4 className={`text-sm font-semibold ${textPrimary}`}>歌曲百科</h4>
              </div>
              <div className="rounded-xl px-3 py-2.5" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                <p className={`${textPrimary} text-sm leading-relaxed`}>{wiki}</p>
              </div>
            </div>
          )}

          {/* QQ 歌曲所在歌单 */}
          {song.platform === 'qq' && songPlaylists.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2.5">
                <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                <h4 className={`text-sm font-semibold ${textPrimary}`}>收录于歌单</h4>
              </div>
              <div className="space-y-2">
                {songPlaylists.map((p, i) => (
                  <div key={`${p.id}-${i}`} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}>
                    <div className="w-9 h-9 rounded-md overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                      {p.coverUrl ? <img src={p.coverUrl} alt={p.name} className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto mt-2 text-white/30" />}
                    </div>
                    <p className={`${textPrimary} text-sm truncate`}>{p.name}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

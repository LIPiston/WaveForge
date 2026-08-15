import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Play, ListPlus } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getSimilarSongs, getProxiedImageUrl } from '../services/musicApi'
import SongContextMenu from './SongContextMenu'

interface SimilarSongsPanelProps {
  song: Song
  onClose: () => void
  onPlayNow?: (song: Song) => void
  onPlayNext?: (song: Song) => void
  playerTheme: 'dark' | 'light'
}

export default function SimilarSongsPanel({ song, onClose, onPlayNow, onPlayNext, playerTheme }: SimilarSongsPanelProps) {
  const dark = playerTheme === 'dark'
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'

  useEffect(() => {
    let cancelled = false
    const fetchSimilar = async () => {
      try {
        const id = song.platform === 'qq' ? String(song.id || song.mid) : String(song.id)
        const data = await getSimilarSongs(id, song.platform as 'netease' | 'qq')
        if (!cancelled && data) {
          const raw = data.songs || data.data?.list || data.data?.songs || (Array.isArray(data.data) ? data.data : []) || []
          const normalized = raw.map((s: any) => {
            const track = s.songInfo || s.song || s
            const albumPic = track.album?.picUrl || track.album?.picurl || track.album?.cover || track.album?.coverUrl
              || s.album?.picUrl || s.album?.picurl
              || track.picUrl || track.picurl || track.albumpic
              || ''
            const albumMid = track.album?.mid || track.albummid || s.album?.mid || ''
            const coverUrl = albumPic || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid.replace(/_\d+$/, '')}.jpg` : '')
            return {
              id: track.id || s.id || 0,
              mid: track.mid || s.mid,
              name: track.name || track.title || track.songname || s.name || '',
              artists: Array.isArray(track.singer || track.artists || s.artists)
                ? (track.singer || track.artists || s.artists).map((a: any) => ({ name: a.name || a.title || '' }))
                : [],
              album: { picUrl: coverUrl },
              duration: (track.interval || track.dt || 0) * 1000 || track.duration || s.dt || 0,
              platform: song.platform
            } as Song
          })
          if (!cancelled) setSongs(normalized)
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false)
    }
    fetchSimilar()
    return () => { cancelled = true }
  }, [song])

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
        className="w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl max-h-[80vh] flex flex-col"
        style={{ background: dark ? 'rgba(14,17,24,0.86)' : 'rgba(255,255,255,0.9)', border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`, backdropFilter: 'blur(30px)' }}
      >
        <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
          <div className="flex items-center gap-2">
            <Music className="w-5 h-5" style={{ color: '#3B82F6' }} />
            <h2 className={`text-base font-semibold ${textPrimary}`}>相似歌曲</h2>
          </div>
          <button onClick={onClose} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className={`text-center py-8 ${textSecondary}`}>加载中...</div>
          ) : songs.length === 0 ? (
            <div className={`text-center py-8 ${textSecondary}`}>暂无相似歌曲</div>
          ) : (
            songs.map((s, i) => (
              <div key={s.mid || s.id || i} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${dark ? 'hover:bg-white/5' : 'hover:bg-black/5'} transition-colors group`}>
                <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
                  {s.album?.picUrl ? <img src={getProxiedImageUrl(s.album.picUrl, 100)} alt="" className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto text-white/40" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm truncate ${textPrimary}`}>{s.name}</p>
                  <p className={`text-xs truncate ${textSecondary}`}>{Array.isArray(s.artists) ? s.artists.map(a => a.name).join(' / ') : ''}</p>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {onPlayNext && <button onClick={() => { onPlayNext(s); onClose() }} className={`p-2 rounded-full ${dark ? 'hover:bg-white/10' : 'hover:bg-black/10'} transition-colors`} title="下一首播放"><ListPlus className={`w-4 h-4 ${textSecondary}`} /></button>}
                  {onPlayNow && <button onClick={() => { onPlayNow(s); onClose() }} className={`p-2 rounded-full ${dark ? 'hover:bg-white/10' : 'hover:bg-black/10'} transition-colors`} title="立即播放"><Play className={`w-4 h-4 ${textSecondary}`} fill="currentColor" /></button>}
                </div>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
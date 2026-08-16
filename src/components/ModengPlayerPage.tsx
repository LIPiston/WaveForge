import { memo, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'

interface ModengPlayerPageProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  playerTheme: 'light' | 'dark'
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  trackId?: string | number
  translationEnabled?: boolean
  romanEnabled?: boolean
  isTransitioning?: boolean
  onSeek?: (time: number) => void
  onPlayPause?: () => void
  onPrevious?: () => void
  onNext?: () => void
}

// 「模灯」歌词播放页：居中滚动歌词 + 左侧封面 + 底部播放控制。
// 当前播放时间经 playbackTimeStore（useSyncExternalStore）订阅，
// 仅时间变化时重渲染本组件，不牵动父级。
function ModengPlayerPage({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  accentColor,
  playerTheme,
  songTitle,
  songArtist,
  songAlbum,
  coverUrl,
  translationEnabled,
  romanEnabled,
  isTransitioning,
  onSeek,
  onPlayPause,
  onPrevious,
  onNext,
}: ModengPlayerPageProps) {
  const time = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot
  )
  const currentTime = time.currentTime + timeOffset

  // 计算每行歌词相对当前播放位置的状态：0=当前行，-1=已唱，1=未唱
  const lines = useMemo(() => {
    const activeTime = currentTime * 1000
    return lyrics
      .map((line, index) => {
        if (!line.text?.trim()) return null
        return {
          line,
          index,
          state: line.time <= activeTime ? (index === currentIndex ? 0 : -1) : 1,
          distance: Math.abs(index - currentIndex),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }, [lyrics, currentTime, currentIndex])

  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/55' : 'text-black/55'
  const textTertiary = isDark ? 'text-white/30' : 'text-black/30'

  const handleLineClick = useCallback((lineTime: number) => {
    onSeek?.(Math.max(0, lineTime / 1000 - timeOffset))
  }, [onSeek, timeOffset])

  const renderedLyrics = useMemo(() => lines.slice(0, 12), [lines])

  return (
    <div className="w-full h-full flex flex-col items-center justify-center px-8 py-6 overflow-hidden">
      <div className="w-full max-w-6xl h-full flex gap-10 items-center justify-center">
        {/* 左侧：封面 + 歌曲信息 */}
        <div className="flex-1 flex flex-col items-center justify-center gap-5 min-w-0">
          <motion.div
            animate={{ scale: isTransitioning ? 0.94 : 1, opacity: isTransitioning ? 0.7 : 1 }}
            transition={{ duration: 0.45, ease: [0.42, 0, 0.58, 1] }}
            className="relative w-64 h-64 rounded-2xl overflow-hidden shadow-2xl flex-shrink-0"
            style={{ boxShadow: `0 24px 64px -16px ${accentColor}44` }}
          >
            {coverUrl ? (
              <img src={coverUrl} alt={songTitle} className="w-full h-full object-cover" />
            ) : (
              <div className={`w-full h-full ${isDark ? 'bg-white/10' : 'bg-black/10'}`} />
            )}
            {isPlaying && (
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div
                  className={`w-20 h-20 rounded-full ${isDark ? 'bg-black/40' : 'bg-white/40'} backdrop-blur-sm flex items-center justify-center`}
                  animate={{ scale: [1, 1.06, 1] }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <Pause className="w-8 h-8 text-white" fill="currentColor" />
                </motion.div>
              </div>
            )}
          </motion.div>
          <div className="text-center space-y-1.5 min-w-0 px-2">
            <h2 className={`${textPrimary} text-lg font-semibold truncate`}>{songTitle}</h2>
            <p className={`${textSecondary} text-sm truncate`}>{songArtist}</p>
            {songAlbum && <p className={`${textTertiary} text-xs truncate`}>{songAlbum}</p>}
          </div>
        </div>

        {/* 右侧：滚动歌词 */}
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5 overflow-hidden py-8">
          {renderedLyrics.map(({ line, index, state, distance }) => {
            const isActive = state === 0
            const dim = Math.min(1, distance * 0.14)
            const lineOpacity = isActive ? 1 : 0.34 - dim * 0.1
            return (
              <button
                key={`${index}-${line.time}`}
                type="button"
                onClick={() => handleLineClick(line.time)}
                className={`text-left w-full px-4 py-1.5 rounded-xl transition-all duration-300 cursor-pointer ${isActive ? '' : 'hover:opacity-80'}`}
                style={{
                  opacity: lineOpacity,
                  color: isActive ? accentColor : textPrimary,
                  transform: `translateX(${isActive ? 0 : distance * -4}px)`,
                }}
              >
                <div className="text-lg leading-snug truncate">{line.text}</div>
                {translationEnabled && line.translation && (
                  <div className={`text-sm mt-0.5 truncate ${textTertiary}`}>{line.translation}</div>
                )}
                {romanEnabled && line.roman && (
                  <div className={`text-xs mt-0.5 truncate ${textTertiary}`}>{line.roman}</div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 底部播放控制 */}
      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={onPrevious}
          aria-label="上一首"
          className={`w-10 h-10 rounded-full ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'} flex items-center justify-center transition-colors`}
        >
          <SkipBack className={`w-5 h-5 ${textPrimary}`} />
        </button>
        <button
          type="button"
          onClick={onPlayPause}
          aria-label={isPlaying ? '暂停' : '播放'}
          className="w-14 h-14 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105"
          style={{ backgroundColor: accentColor }}
        >
          {isPlaying ? (
            <Pause className="w-6 h-6" fill="currentColor" />
          ) : (
            <Play className="w-6 h-6 ml-0.5" fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="下一首"
          className={`w-10 h-10 rounded-full ${isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-black/5 hover:bg-black/10'} flex items-center justify-center transition-colors`}
        >
          <SkipForward className={`w-5 h-5 ${textPrimary}`} />
        </button>
      </div>
    </div>
  )
}

export default memo(ModengPlayerPage)

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Music, Crown, Loader2, Sparkles } from 'lucide-react'
import { Song } from '../services/musicApi'
import CachedImage from './CachedImage'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'

interface PlaylistPanelProps {
  show: boolean
  onClose: () => void
  playlist: Song[]
  currentIndex: number
  onSongSelect: (index: number) => void
  neteaseVip?: boolean
  qqVip?: boolean
  currentPlatform?: 'netease' | 'qq'
  onSmartReorder?: () => void
  isSmartReordering?: boolean
  smartReorderProgress?: { completed: number; total: number }
}

const PLAYLIST_CARD_HEIGHT = 96
const PLAYLIST_ROW_GAP = 8
const PLAYLIST_ROW_HEIGHT = PLAYLIST_CARD_HEIGHT + PLAYLIST_ROW_GAP
const PLAYLIST_OVERSCAN = 5

export default function PlaylistPanel({
  show,
  onClose,
  playlist,
  currentIndex,
  onSongSelect,
  neteaseVip = false,
  qqVip = false,
  currentPlatform = 'netease',
  onSmartReorder,
  isSmartReordering = false,
  smartReorderProgress,
}: PlaylistPanelProps) {
  const isVip = currentPlatform === 'netease' ? neteaseVip : qqVip
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const pendingViewportRef = useRef({ scrollTop: 0, height: 0 })
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })

  const commitViewport = useCallback((scrollTop: number, height: number) => {
    pendingViewportRef.current = { scrollTop, height }
    if (scrollFrameRef.current !== null) return

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      setViewport(pendingViewportRef.current)
    })
  }, [])

  useEffect(() => {
    if (!show) {
      setViewport({ scrollTop: 0, height: 0 })
      return
    }

    const container = scrollContainerRef.current
    if (!container) return

    commitViewport(container.scrollTop, container.clientHeight)
    const resizeObserver = new ResizeObserver(() => {
      commitViewport(container.scrollTop, container.clientHeight)
    })
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [commitViewport, show])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }
  }, [])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget
    commitViewport(container.scrollTop, container.clientHeight)
  }

  const fallbackViewportHeight = typeof window === 'undefined' ? 720 : Math.max(320, window.innerHeight - 100)
  const viewportHeight = viewport.height || fallbackViewportHeight
  const startIndex = Math.max(0, Math.floor(viewport.scrollTop / PLAYLIST_ROW_HEIGHT) - PLAYLIST_OVERSCAN)
  const endIndex = Math.min(
    playlist.length,
    Math.ceil((viewport.scrollTop + viewportHeight) / PLAYLIST_ROW_HEIGHT) + PLAYLIST_OVERSCAN
  )
  const visibleRows = useMemo(
    () => playlist.slice(startIndex, endIndex).map((song, offset) => ({
      song,
      index: startIndex + offset,
    })),
    [endIndex, playlist, startIndex]
  )
  const virtualHeight = Math.max(0, playlist.length * PLAYLIST_ROW_HEIGHT - PLAYLIST_ROW_GAP)

  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/45"
          />

          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 h-full w-full max-w-md shadow-2xl"
            style={{
              background: 'linear-gradient(180deg, rgba(10, 10, 16, 0.82) 0%, rgba(4, 5, 10, 0.74) 100%)',
              backdropFilter: 'blur(26px) saturate(135%)',
              WebkitBackdropFilter: 'blur(26px) saturate(135%)',
              borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '-18px 0 48px rgba(0, 0, 0, 0.34)',
              willChange: 'transform',
            }}
          >
            <div className="flex items-center justify-between border-b border-white/10 p-6">
              <div className="flex items-center gap-3">
                <Music className="h-6 w-6 text-white" />
                <div>
                  <h2 className="text-2xl font-bold text-white">播放列表</h2>
                  <p className="text-sm text-white/60">{playlist.length} 首歌曲</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {onSmartReorder && (
                  <motion.button
                    type="button"
                    whileHover={!isSmartReordering ? { scale: 1.03 } : undefined}
                    whileTap={!isSmartReordering ? { scale: 0.97 } : undefined}
                    onClick={onSmartReorder}
                    disabled={isSmartReordering || playlist.length - Math.max(currentIndex + 1, 0) < 2}
                    title="按音色、和声与速度使用 HAM-2 重排后续歌曲"
                    className="flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-2 text-xs font-medium text-white/80 transition-colors hover:bg-white/14 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSmartReordering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    <span>
                      {isSmartReordering && smartReorderProgress
                        ? `${smartReorderProgress.completed}/${smartReorderProgress.total}`
                        : '智能重排'}
                    </span>
                  </motion.button>
                )}
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.08, rotate: 90 }}
                  whileTap={{ scale: 0.94 }}
                  onClick={onClose}
                  aria-label="关闭播放列表"
                  className="rounded-full p-2 transition-colors hover:bg-white/10"
                >
                  <X className="h-6 w-6 text-white/60" />
                </motion.button>
              </div>
            </div>

            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="h-[calc(100vh-100px)] overflow-y-auto p-4"
            >
              {playlist.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-white/40">
                  <Music className="mb-4 h-16 w-16" />
                  <p>播放列表为空</p>
                </div>
              ) : (
                <div className="relative w-full" style={{ height: `${virtualHeight}px` }}>
                  {visibleRows.map(({ song, index }) => {
                    const isCurrent = index === currentIndex
                    const rowKey = `${song.platform || currentPlatform}-${song.mid || song.id}-${index}`

                    return (
                      <motion.button
                        type="button"
                        key={rowKey}
                        whileHover={{ scale: 1.012, x: -2 }}
                        whileTap={{ scale: 0.99 }}
                        onClick={() => onSongSelect(index)}
                        className="absolute inset-x-0 flex w-full cursor-pointer items-center gap-4 overflow-hidden rounded-2xl px-4 text-left"
                        style={{
                          top: `${index * PLAYLIST_ROW_HEIGHT}px`,
                          height: `${PLAYLIST_CARD_HEIGHT}px`,
                          background: isCurrent
                            ? 'linear-gradient(135deg, rgba(255,255,255,0.19), rgba(255,255,255,0.11))'
                            : 'linear-gradient(135deg, rgba(255,255,255,0.065), rgba(255,255,255,0.035))',
                          border: isCurrent ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.045)',
                          boxShadow: isCurrent ? '0 10px 24px rgba(0,0,0,0.18)' : 'none',
                        }}
                      >
                        <div className="flex w-10 shrink-0 items-center justify-center">
                          {isCurrent ? (
                            <motion.div
                              animate={{ scale: [1, 1.14, 1] }}
                              transition={{ repeat: Infinity, duration: 1.6 }}
                            >
                              <Play className="h-5 w-5 fill-white text-white drop-shadow-lg" />
                            </motion.div>
                          ) : (
                            <span className="text-base font-semibold text-white/50">{index + 1}</span>
                          )}
                        </div>

                        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white/10 shadow-md ring-1 ring-white/15">
                          {song.album?.picUrl ? (
                            <CachedImage
                              src={song.album.picUrl}
                              alt={song.name}
                              className="h-full w-full object-cover"
                              fallback={
                                <div className="flex h-full w-full items-center justify-center bg-white/5">
                                  <Music className="h-6 w-6 text-white/30" />
                                </div>
                              }
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-white/5">
                              <Music className="h-6 w-6 text-white/30" />
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className={`truncate text-base font-semibold ${isCurrent ? 'text-white' : 'text-white/90'}`}>
                            {song.name}
                          </div>
                          <div className={`mt-1 truncate text-sm ${isCurrent ? 'text-white/70' : 'text-white/50'}`}>
                            {Array.isArray(song.artists) ? song.artists.map(artist => artist.name).join(', ') : '未知艺人'}
                          </div>
                        </div>

                        {(song.fee === 1 || song.fee === 4 || song.vip) && !isVip && (
                          <Crown className="h-5 w-5 shrink-0 text-yellow-400 drop-shadow-lg" />
                        )}
                      </motion.button>
                    )
                  })}
                </div>
              )}
            </div>

            <ScrollToCurrentSong
              containerRef={scrollContainerRef}
              currentSongIndex={currentIndex}
              threshold={160}
              playerTheme="dark"
              position="absolute"
              offsetLeft={-64}
              offsetBottom={88}
              cardHeight={PLAYLIST_CARD_HEIGHT}
              cardGapY={PLAYLIST_ROW_GAP}
              contentPaddingTop={16}
            />
            <ScrollToTop
              containerRef={scrollContainerRef}
              threshold={160}
              playerTheme="dark"
              position="absolute"
              offsetLeft={-64}
              offsetBottom={24}
            />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

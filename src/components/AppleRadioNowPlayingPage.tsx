import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Hls from 'hls.js'
import { ArrowLeft, AudioLines, Pause, Play, Radio, RotateCw, Volume2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import CachedImage from './CachedImage'
import QuickSettings from './QuickSettings'

type Props = {
  song: Song
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playerTheme: 'light' | 'dark'
  status?: 'connecting' | 'playing' | 'reconnecting' | 'error'
  error?: string
  /** 连续时间源：App 层 currentTime 是按展示键节流的（歌词页专用），电台页需要逐秒走动 */
  playbackTimeStore?: PlaybackTimeStore
  onBack: () => void
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onRetry: () => void
  /** 调音室（音效）：与普通歌词页共用同一入口，但按钮位置由电台页自行排布 */
  onOpenSoundEffects?: (anchorRect?: DOMRect) => void
}

const fallbackSnapshotValue = { currentTime: 0, duration: 0, isPlaying: false }
// useSyncExternalStore 要求 getSnapshot 返回稳定引用，否则无限重渲染
const fallbackSnapshot = () => fallbackSnapshotValue
const fallbackSubscribe = () => () => undefined

export default function AppleRadioNowPlayingPage({
  song,
  isPlaying,
  currentTime,
  duration,
  volume,
  playerTheme,
  status = 'playing',
  error,
  playbackTimeStore,
  onBack,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onRetry,
  onOpenSoundEffects,
}: Props) {
  const radio = song.appleRadio
  const motionRef = useRef<HTMLVideoElement | null>(null)
  const [motionFailed, setMotionFailed] = useState(false)
  const [motionEnabled] = useState(() => !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false))
  const motionUrl = radio?.motionArtworkUrl
  const poster = radio?.motionPosterUrl || radio?.heroArtworkUrl || radio?.artworkUrl || song.album.picUrl
  const timeline = radio?.timeline || 'unknown'
  const isLive = timeline !== 'vod'
  const isDark = playerTheme === 'dark'

  // 连续时间：直接订阅 playbackTimeStore（含回退到 App 层节流值）
  const timeSnapshot = useSyncExternalStore(
    playbackTimeStore?.subscribe ?? fallbackSubscribe,
    playbackTimeStore?.getSnapshot ?? fallbackSnapshot,
  )
  const liveTime = timeSnapshot.currentTime > 0 ? timeSnapshot.currentTime : currentTime
  const liveDuration = timeSnapshot.duration > 0 && Number.isFinite(timeSnapshot.duration)
    ? timeSnapshot.duration
    : (Number.isFinite(duration) && duration > 0 ? duration : (song.duration > 0 ? song.duration / 1000 : 0))

  // 音量弹出层：点击展开（向右弹出），指针离开控件 3 秒后收起，停留期间保持展开
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeCloseTimer = useRef<number | null>(null)
  const volumeWrapRef = useRef<HTMLDivElement | null>(null)

  const clearVolumeCloseTimer = () => {
    if (volumeCloseTimer.current) window.clearTimeout(volumeCloseTimer.current)
    volumeCloseTimer.current = null
  }
  const scheduleVolumeClose = (delay = 3000) => {
    clearVolumeCloseTimer()
    volumeCloseTimer.current = window.setTimeout(() => setVolumeOpen(false), delay)
  }
  const handleVolumeInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    onVolumeChange(Number(event.target.value))
    clearVolumeCloseTimer()
  }

  useEffect(() => () => clearVolumeCloseTimer(), [])

  useEffect(() => {
    if (!volumeOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (volumeWrapRef.current && !volumeWrapRef.current.contains(event.target as Node)) setVolumeOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [volumeOpen])

  // 进度条拖拽：拖拽期间以指针比例显示（不受播放时钟回推影响）
  const [scrubRatio, setScrubRatio] = useState<number | null>(null)
  const progressRef = useRef<HTMLDivElement | null>(null)
  const displayTime = scrubRatio !== null
    ? scrubRatio * liveDuration
    : Math.min(Math.max(liveTime, 0), liveDuration || liveTime)

  const seekFromClientX = (clientX: number) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || liveDuration <= 0) return
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    setScrubRatio(ratio)
    onSeek(ratio * liveDuration)
  }

  useEffect(() => {
    const video = motionRef.current
    if (!video || !motionUrl || !motionEnabled || motionFailed || !Hls.isSupported()) return
    const hls = new Hls({ autoStartLoad: true, capLevelToPlayerSize: true, maxBufferLength: 8, backBufferLength: 0 })
    hls.loadSource(motionUrl)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!document.hidden) void video.play().catch(() => undefined) })
    hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setMotionFailed(true) })
    const onVisibilityChange = () => {
      if (document.hidden) video.pause()
      else void video.play().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      hls.destroy()
    }
  }, [motionEnabled, motionFailed, motionUrl])

  const statusLabel = status === 'connecting'
    ? '正在连接'
    : status === 'reconnecting'
      ? '正在重新连接'
      : status === 'error'
        ? '播放中断'
        : isLive ? '直播' : '节目回放'

  return (
    <div className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden ${isDark ? 'bg-[#08090d] text-white' : 'bg-[#f5f5f7] text-black'}`} data-apple-radio-player>
      {poster && (
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-3xl"
          onError={event => { (event.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div className={`absolute inset-0 ${isDark ? 'bg-black/45' : 'bg-white/70'}`} />

      <header className="relative z-10 flex h-20 shrink-0 items-center justify-between px-5 md:px-10">
        <button type="button" onClick={onBack} className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'bg-white/10 hover:bg-white/16' : 'bg-black/8 hover:bg-black/12'}`} aria-label="返回 Apple Music 广播">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[#fa2d48]"><Radio className="h-4 w-4" />Apple Music 广播</div>
        <div className="h-10 w-10" />
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 items-center gap-8 overflow-y-auto px-6 pb-24 pt-3 md:grid-cols-[minmax(280px,520px)_minmax(280px,560px)] md:justify-center md:px-12">
        <div className="mx-auto w-full max-w-[520px]">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-white/5 shadow-2xl">
            {motionUrl && motionEnabled && !motionFailed ? (
              <video ref={motionRef} muted loop playsInline poster={poster || undefined} className="h-full w-full object-cover" />
            ) : poster ? (
              <CachedImage src={poster} alt={song.name} className="h-full w-full" role="hero" priority="critical" lazy={false} />
            ) : (
              <div className="flex h-full w-full items-center justify-center"><Radio className="h-24 w-24 opacity-25" /></div>
            )}
          </div>
        </div>

        <section className="min-w-0 text-center md:text-left">
          <div className="mb-4 flex justify-center md:justify-start">
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${status === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-[#fa2d48]/15 text-[#ff6b7f]'}`}>
              <span className={`h-2 w-2 rounded-full ${status === 'error' ? 'bg-red-400' : 'bg-[#fa2d48]'}`} />{statusLabel}
            </span>
          </div>
          <h1 className="text-3xl font-bold leading-tight md:text-5xl">{song.name}</h1>
          <p className={`mt-3 text-base md:text-lg ${isDark ? 'text-white/62' : 'text-black/58'}`}>{radio?.showName || song.artists.map(artist => artist.name).join(', ')}</p>
          {radio?.description && <p className={`mx-auto mt-5 max-w-xl text-sm leading-7 md:mx-0 ${isDark ? 'text-white/48' : 'text-black/48'}`}>{radio.description}</p>}
          {radio?.airTime?.start && <p className={`mt-3 text-xs ${isDark ? 'text-white/35' : 'text-black/35'}`}>{new Date(radio.airTime.start).toLocaleString('zh-CN')}</p>}

          {status === 'error' && (
            <div className="mt-6">
              <p className="text-sm text-red-300/85">{error || 'Apple Music 电台播放失败'}</p>
              <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black"><RotateCw className="h-4 w-4" />重新连接</button>
            </div>
          )}

          {/* 进度条：细条自绘（无滑块圆点），点击/拖拽跳转；直播窗口内由浏览器钳制 */}
          {liveDuration > 0 && (
            <div className="mt-8">
              <div
                ref={progressRef}
                role="slider"
                aria-label={isLive ? '直播进度' : '节目进度'}
                aria-valuemin={0}
                aria-valuemax={Math.round(liveDuration)}
                aria-valuenow={Math.round(displayTime)}
                tabIndex={0}
                onKeyDown={event => {
                  if (event.key === 'ArrowLeft') { event.preventDefault(); onSeek(Math.max(0, displayTime - 10)) }
                  if (event.key === 'ArrowRight') { event.preventDefault(); onSeek(Math.min(liveDuration, displayTime + 10)) }
                }}
                onPointerDown={event => {
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  seekFromClientX(event.clientX)
                }}
                onPointerMove={event => { if (event.buttons & 1) seekFromClientX(event.clientX) }}
                onPointerUp={() => setScrubRatio(null)}
                onPointerCancel={() => setScrubRatio(null)}
                className="group/bar flex h-4 cursor-pointer items-center"
              >
                <div className={`relative h-1 w-full overflow-hidden rounded-full transition-[height] group-hover/bar:h-1.5 ${isDark ? 'bg-white/20' : 'bg-black/15'}`}>
                  <div className="h-full rounded-full bg-[#fa2d48]" style={{ width: `${liveDuration > 0 ? Math.min(100, (displayTime / liveDuration) * 100) : 0}%` }} />
                </div>
              </div>
              <div className={`mt-1 flex justify-between text-xs ${isDark ? 'text-white/35' : 'text-black/35'}`}>
                <span>{formatTime(displayTime)}</span>
                <span>{formatTime(liveDuration)}</span>
              </div>
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-3 md:justify-start">
            <button type="button" onClick={onPlayPause} disabled={status === 'connecting' || status === 'reconnecting'} className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-xl disabled:opacity-45" aria-label={isPlaying ? '暂停电台' : '播放电台'}>
              {isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-0.5 h-6 w-6 fill-current" />}
            </button>
            {/* 音效（调音室）：与普通歌词页同一入口，但排在音量左侧、由电台页自己排布 */}
            {onOpenSoundEffects && (
              <button
                type="button"
                aria-label="音效"
                title="音效"
                onClick={event => onOpenSoundEffects(event.currentTarget.getBoundingClientRect())}
                className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              >
                <AudioLines className="h-5 w-5 opacity-55" />
              </button>
            )}
            {/* 设置：电台页专属入口（弹窗面板本身按 isPureMusic 收敛掉歌词相关项） */}
            <QuickSettings
              playerTheme={playerTheme}
              isPureMusic
              triggerClassName={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              triggerWidth={40}
              triggerHeight={40}
              triggerIconSize={20}
              triggerIconColor={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'}
            />
            {/* 音量：低频操作，点击向右弹出滑杆；指针离开控件 3 秒自动收起，停留期间保持展开 */}
            <div
              ref={volumeWrapRef}
              className="relative flex items-center"
              onMouseEnter={clearVolumeCloseTimer}
              onMouseLeave={() => scheduleVolumeClose(3000)}
            >
              <button
                type="button"
                onClick={() => {
                  clearVolumeCloseTimer()
                  setVolumeOpen(open => !open)
                }}
                aria-label="电台音量"
                aria-expanded={volumeOpen}
                className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              >
                <Volume2 className="h-5 w-5 opacity-55" />
              </button>
              {volumeOpen && (
                <div className={`absolute left-full top-1/2 z-10 ml-3 flex -translate-y-1/2 items-center gap-3 rounded-full px-4 py-2.5 shadow-xl ${isDark ? 'bg-[#1b1d24]/95' : 'bg-white/95'}`}>
                  <input
                    aria-label="电台音量"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={handleVolumeInput}
                    className="w-36 accent-[#fa2d48]"
                  />
                  <span className={`w-9 text-right text-xs tabular-nums ${isDark ? 'text-white/55' : 'text-black/55'}`}>{Math.round(volume * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

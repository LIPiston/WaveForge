import { memo } from 'react'
import { useTransitionOverlayProgress } from '../hooks/useTransitionVisual'
import type { TransitionVisualStore } from '../audio/transitionVisualStore'

interface TrackTitles {
  trackKey: string
  title: string
  artist: string
}

interface TransitionTrackTitlesProps {
  isTransitioning: boolean
  /** 过渡叠加进度（0..1，最后一段归一化；视觉轨道切换点恰好到 1）。 */
  progress: number
  /** 视觉轨道 store：传入时逐帧进度直达本组件（只重渲染这块文字），不再经 App 整树节流。 */
  progressStore?: TransitionVisualStore | null
  fromTrack: TrackTitles | null
  toTrack: TrackTitles | null
  /** 非过渡时显示的信息（canonical，且视觉轨道生效时它已是目标曲）。 */
  fallbackTitle: string
  fallbackArtist: string
  playerTheme: 'light' | 'dark'
  /** 版式档位：lg = 无歌词大标题页，md = 有歌词左右布局。 */
  size?: 'lg' | 'md'
}

/**
 * 歌名/歌手过渡层：双层叠加以 120ms linear 过渡跟随视觉轨道进度。
 * 与封面/MV/歌词共用同一条进度（overlayProgress，终点 = 视觉轨道切换点）——
 * 切换那一帧到 100%、叠加层随即退休，由 canonical（已是同一首目标曲）无缝接替，
 * 所以"过渡完毕"时画面上不会有任何字跳。
 */
function TransitionTrackTitles({
  isTransitioning,
  progress,
  progressStore = null,
  fromTrack,
  toTrack,
  fallbackTitle,
  fallbackArtist,
  playerTheme,
  size = 'lg',
}: TransitionTrackTitlesProps) {
  const storeProgress = useTransitionOverlayProgress(progressStore, progress)
  const effective = progressStore ? storeProgress : progress
  const dark = playerTheme === 'dark'
  const titleClass = size === 'lg' ? 'text-4xl font-bold' : 'text-3xl font-bold'
  const artistClass = size === 'lg' ? 'text-xl' : 'text-lg'
  const titleTone = dark ? 'text-white drop-shadow-lg' : 'text-black/90'
  const artistTone = dark ? 'text-white/80 drop-shadow-md' : 'text-black/60'
  const smooth = { transition: 'opacity 120ms linear', willChange: 'opacity' as const }

  if (!isTransitioning || effective <= 0 || !fromTrack || !toTrack) {
    return (
      <div className="relative">
        <h1 className={`${titleClass} ${titleTone}`}>{fallbackTitle}</h1>
        <p className={`${artistClass} ${artistTone}`}>{fallbackArtist}</p>
      </div>
    )
  }
  return (
    <>
      {/* 底层：旧歌曲信息 */}
      <div className="absolute inset-0" style={{ ...smooth, opacity: 1 - effective }}>
        <h1 className={`${titleClass} ${titleTone}`}>{fromTrack.title}</h1>
        <p className={`${artistClass} ${artistTone}`}>{fromTrack.artist}</p>
      </div>
      {/* 顶层：新歌曲信息 */}
      <div className="relative" style={{ ...smooth, opacity: effective }}>
        <h1 className={`${titleClass} ${titleTone}`}>{toTrack.title}</h1>
        <p className={`${artistClass} ${artistTone}`}>{toTrack.artist}</p>
      </div>
    </>
  )
}

export default memo(TransitionTrackTitles)

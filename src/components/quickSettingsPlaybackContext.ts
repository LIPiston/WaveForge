import type { PlaybackTimeStore } from '../audio/playbackTimeStore'

/**
 * 「播放设置」弹窗的播放上下文类型。
 *
 * 原先定义在弹窗顶部的实时预览组件里；预览整块移除后（用户要求：既不是真实时、又挤占设置空间），
 * 这组类型仍被 App 组装、经 `QuickSettingsHost` 透传给弹窗，**保留原有语义**，只搬家到这里，
 * 避免弹窗与宿主的类型依赖挂在一个已删除的组件上。
 */

export interface QuickSettingsPreviewTrack {
  title?: string
  artist?: string
  coverUrl?: string
}

/** 只需要「时间 + 文本 + 可选行末时间」，不依赖完整 LyricLine。 */
export interface QuickSettingsPreviewLyric {
  time: number
  text: string
  endTime?: number
}

/** App 层组装、逐层透传的播放上下文。 */
export interface QuickSettingsPlaybackContext {
  track?: QuickSettingsPreviewTrack | null
  lyrics?: readonly QuickSettingsPreviewLyric[] | null
  lyricOffset?: number
  playbackTimeStore?: PlaybackTimeStore | null
}

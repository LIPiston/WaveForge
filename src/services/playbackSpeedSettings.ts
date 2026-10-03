/**
 * 歌曲倍速设置（跨表面共享）：
 * - 普通播放页（音频引擎直接播放的 audio 元素）
 * - 看歌模式（BilibiliMvPlayer 的视频+音频双元素）
 * - MV 背景（BilibiliMvBackground 的视频元素）
 * 过渡保护：automix/overlap 期间引擎会拿 playbackRate 做 BPM 变速，用户倍速必须在
 * 过渡开始时归 1、过渡结束后恢复（consumeTransitionReset 标志位机制，应用方读后清除）。
 */
export interface PlaybackSpeedSettings {
  /** 0.5~2.0；1 = 原速 */
  speed: number
}

export const PLAYBACK_SPEED_SETTINGS_KEY = 'playbackSpeedSettings'
export const PLAYBACK_SPEED_SETTINGS_EVENT = 'playbackSpeedSettingsChanged'
/** 过渡开始时由 App 广播：所有消费方立刻把元素 playbackRate 归 1（引擎 BPM 变速接管） */
export const PLAYBACK_SPEED_TRANSITION_EVENT = 'playbackSpeedTransitionReset'

export const PLAYBACK_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

export function loadPlaybackSpeedSettings(): PlaybackSpeedSettings {
  if (typeof window === 'undefined') return { speed: 1 }
  try {
    const parsed = Number(JSON.parse(localStorage.getItem(PLAYBACK_SPEED_SETTINGS_KEY) || '{}').speed)
    return { speed: PLAYBACK_SPEED_OPTIONS.includes(parsed as never) ? parsed : 1 }
  } catch {
    return { speed: 1 }
  }
}

export function savePlaybackSpeedSettings(speed: number): PlaybackSpeedSettings {
  const next = { speed: PLAYBACK_SPEED_OPTIONS.includes(speed as never) ? speed : 1 }
  try { localStorage.setItem(PLAYBACK_SPEED_SETTINGS_KEY, JSON.stringify(next)) } catch { /* 忽略 */ }
  window.dispatchEvent(new CustomEvent(PLAYBACK_SPEED_SETTINGS_EVENT, { detail: next.speed }))
  return next
}

/** 过渡开始时调用：广播归一信号（各元素应用方监听并临时把 playbackRate 置 1） */
export function notifyPlaybackSpeedTransitionReset(): void {
  window.dispatchEvent(new CustomEvent(PLAYBACK_SPEED_TRANSITION_EVENT))
}

// ===== 当前生效倍速（跨表面注册表）=====
// 过渡期间各应用方把元素归 1，但用户设置（localStorage）保持不变——
// UI（如分轨弹窗的倍速区）需要显示「实际生效值」时读这里，而不是设置值。
let effectiveSpeed = loadPlaybackSpeedSettings().speed

/** 应用方更新实际生效倍速（过渡归 1 时传 1，恢复时传用户设置值） */
export function setEffectivePlaybackSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0) return
  effectiveSpeed = speed
  window.dispatchEvent(new CustomEvent('playbackSpeedEffectiveChanged', { detail: { speed } }))
}

/** 读当前实际生效倍速（过渡期间为 1，正常播放为用户设置值） */
export function getEffectivePlaybackSpeed(): number {
  return effectiveSpeed
}

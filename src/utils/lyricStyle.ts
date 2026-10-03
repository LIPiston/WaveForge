/**
 * 歌词风格样式：把原先分离的「逐字效果」与「歌词切换动画」两个设置合并为一种风格。
 *
 * - 柔和（soft）  ：柔光扩散逐字 + 弹簧滚动
 * - 摩登（modern）：Apple 逐词点亮逐字 + 弹簧滚动
 *
 * 两种风格统一走弹簧滚动：柔和的原生滚动在重定位竞态下表现为"滚动没有任何动画"
 * （用户实测反馈，见 LyricsDisplay 经典重定位路径的注释），修复为与摩登同源的
 * 弹簧 transform 滚动；两风格差异只保留在逐字填充与行视觉上（见 getWordEffectConfig）。
 *
 * 旧设置（wordByWordEffectMode / lyricScrollTransitionStyle）不再暴露给用户，
 * 读取时做一次等价迁移：Apple 逐字或崭新滚动 → 摩登，其余 → 柔和。
 */
export type LyricStyleMode = 'soft' | 'modern'

/** 逐字填充模式：clear 仅供桌面播放器等内部覆盖使用（不再出现在设置项中）。
 *  原先的 'apple' 逐词点亮分支已不可达（摩登风格改走 AMLL 光带实现），故从类型中移除。 */
export type WordByWordEffectMode = 'clear' | 'soft'

/** 滚动动画：classic 原生居中滚动 / amodern 弹簧 transform 滚动。 */
export type ScrollTransitionStyle = 'classic' | 'amodern'

export const LYRIC_STYLE_MODE_KEY = 'lyricStyleMode'
export const LYRIC_STYLE_MODE_EVENT = 'lyricStyleModeChanged'

export const readLyricStyleMode = (): LyricStyleMode => {
  try {
    const saved = localStorage.getItem(LYRIC_STYLE_MODE_KEY)
    if (saved === 'soft' || saved === 'modern') return saved
    if (localStorage.getItem('wordByWordEffectMode') === 'apple') return 'modern'
    if (localStorage.getItem('lyricScrollTransitionStyle') === 'amodern') return 'modern'
  } catch { /* 存储不可用（隐私模式等）时用默认值 */ }
  return 'soft'
}

export const persistLyricStyleMode = (mode: LyricStyleMode): void => {
  try {
    localStorage.setItem(LYRIC_STYLE_MODE_KEY, mode)
  } catch { /* 忽略写入失败 */ }
  window.dispatchEvent(new CustomEvent(LYRIC_STYLE_MODE_EVENT, { detail: mode }))
}

/** 风格 → 歌词切换动画。
 *  两种风格统一映射弹簧滚动（amodern）；'classic' 原生滚动不再由风格推导，
 *  仍可经 LyricsDisplay 的 scrollTransitionStyle prop 显式启用（兼容路径保留）。 */
export const scrollStyleOfStyle = (_style: LyricStyleMode): ScrollTransitionStyle => 'amodern'

/**
 * 逐字填充说明：两种风格共用「整行连续光带」填充（已唱亮 / 未唱暗，边界羽化），
 * 不再按词独立擦亮。差异只体现在光带宽度与滚动/行视觉上——
 * 柔和 = 大面积柔光扩散 + 弹簧滚动（焦点线居中）；摩登 = AMLL 式窄光带 + 弹簧滚动（焦点线上移 36%，无行级 y 位移）。
 * 光带宽度在 LyricsDisplay 的 getWordEffectConfig 里按风格取值。
 */
export const LYRIC_FILL_EFFECT_MODE: WordByWordEffectMode = 'soft'

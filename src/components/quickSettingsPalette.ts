/**
 * 「播放设置」弹窗的调色板。
 *
 * folia 的控件配方大量依赖 `theme.primaryColor / secondaryColor / backgroundColor`
 * 三色体系（`colorWithAlpha(theme.secondaryColor, 0.16)` 这种写法遍布它的设置面板）。
 * WaveForge 没有这套主题对象，只有「封面主色 accentColor + playerTheme 明暗」，
 * 所以这里把 folia 的三个槽位映射到 zinc 色阶，让上游的数值可以直接照用。
 *
 * 强调色（选中描边、开关的"开"）继续用 **accentColor** —— 播放面取色纪律要求
 * 播放页的配色只认封面主色（test/modeIntegrationWiring.test.ts 守着这条）。
 */
export interface QuickSettingsPalette {
  isDaylight: boolean
  /** 封面主色，来自 useColorThief 下发的 accentColor。 */
  accent: string
  /** 正文色（folia 的 `var(--text-primary)`）。 */
  primary: string
  /** 次要文字 / 边框基色（folia 的 `var(--text-secondary)`）。 */
  secondary: string
  /** 面板底（folia 的 `theme.backgroundColor`）。 */
  background: string
}

/**
 * hex / #rgb → rgba()。
 * folia 直接往颜色后面拼 `18`、`0.16` 这类 alpha，只有严格 6 位 hex 才成立；
 * 这里补上 #rgb 与已是 rgb()/命名色的情况，避免设置里存了非 6 位 hex 时颜色整条丢失。
 */
export function toRgba(color: string, alpha: number): string {
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(color)
  if (hex6) {
    const value = parseInt(hex6[1], 16)
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(color)
  if (hex3) {
    const [r, g, b] = hex3[1].split('').map((char) => parseInt(char + char, 16))
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

export function buildQuickSettingsPalette(accentColor: string, playerTheme: 'light' | 'dark'): QuickSettingsPalette {
  const isDaylight = playerTheme === 'light'
  return {
    isDaylight,
    accent: accentColor,
    primary: isDaylight ? '#18181b' : '#f4f4f5',
    secondary: isDaylight ? '#71717a' : '#a1a1aa',
    background: isDaylight ? '#ffffff' : '#18181b',
  }
}

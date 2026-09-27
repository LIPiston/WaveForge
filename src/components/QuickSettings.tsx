import { motion } from 'framer-motion'
import { memo, type CSSProperties } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import {
  toggleQuickSettings,
  useQuickSettingsState,
  type QuickSettingsSection,
} from '../services/quickSettingsStore'

/**
 * 播放设置（快捷设置）的**触发按钮**。
 *
 * 原实现是「触发按钮 + 下拉面板」一体的自包含组件；面板改为居中弹窗后，
 * 弹窗宿主收敛成全局唯一的一份（`QuickSettingsHost`，portal 到 body），
 * 本组件只保留触发按钮 —— 各播放页的按钮外观差异很大（玻璃圆钮 / 摩登 chip /
 * 电台页圆钮），这部分仍留在各自调用点。
 *
 * 因此下面三个「浮层专属」prop 已删除，改造后它们的语义不再成立：
 * - `forceClose`：原来由 ImmersiveControls 传 `!buttonsVisible`，控件条 3 秒自动隐退会顺手关掉面板。
 *   弹窗化后弹窗在 body、与控件条的自动隐藏无关，这个耦合必须断开（否则看设置看到一半会被关掉）。
 * - `expandUp` / `maxPanelHeightVh`：原来用于让面板在屏幕中部向上展开、并防止被歌词容器
 *   （overflow-hidden）裁切。弹窗居中且自带独立滚动容器，两者都不再需要。
 */
interface QuickSettingsProps {
  playerTheme?: 'light' | 'dark'
  /** 纯音乐 / 播客播放：功能段收敛掉歌词相关项 */
  isPureMusic?: boolean
  /** 自定义触发按钮 className（如摩登模式的 modeng-btn-chip 玻璃按钮）；不传用默认圆钮 */
  triggerClassName?: string
  /** 自定义触发按钮内联样式（如沉浸模式统一玻璃阴影） */
  triggerStyle?: CSSProperties
  /** 触发按钮宽/高（px，自定义样式时配合 chip 尺寸用） */
  triggerWidth?: number
  triggerHeight?: number
  /** 触发图标尺寸（px，默认 24） */
  triggerIconSize?: number
  /** 触发图标颜色（自定义样式时传入匹配 chip 的文字色） */
  triggerIconColor?: string
  /** 触发按钮无障碍标签（可选，默认缺省） */
  triggerAriaLabel?: string
  /** 打开弹窗后落到的分段，默认「外观」 */
  section?: QuickSettingsSection
}

export default memo(function QuickSettingsTrigger({
  playerTheme = 'dark',
  isPureMusic = false,
  triggerClassName,
  triggerStyle,
  triggerWidth,
  triggerHeight,
  triggerIconSize = 24,
  triggerIconColor,
  triggerAriaLabel,
  section,
}: QuickSettingsProps) {
  const { isOpen } = useQuickSettingsState()

  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.06, x: -1 }}
      whileTap={{ scale: 0.9 }}
      onClick={() => toggleQuickSettings({ playerTheme, isPureMusic, section })}
      aria-label={triggerAriaLabel}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      style={{ width: triggerWidth, height: triggerHeight, ...triggerStyle }}
      className={
        triggerClassName ??
        `p-3 rounded-full backdrop-blur-md border transition-colors ${
          playerTheme === 'dark'
            ? 'bg-black/40 hover:bg-black/60 border-white/20'
            : 'bg-white/40 hover:bg-white/60 border-black/20'
        }`
      }
    >
      <SlidersHorizontal
        style={{ width: triggerIconSize, height: triggerIconSize, ...(triggerIconColor ? { color: triggerIconColor } : {}) }}
        className={playerTheme === 'dark' ? 'text-white' : 'text-black'}
      />
    </motion.button>
  )
})

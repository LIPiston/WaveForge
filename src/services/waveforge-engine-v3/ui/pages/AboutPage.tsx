/**
 * 关于页 —— HyperSoundEngine 品牌信息（居中三行：品牌名 / 特供版 / 版权）
 */

import type { HSETheme } from '../hse-theme'

interface AboutPageProps {
  theme: HSETheme
}

export default function AboutPage({ theme }: AboutPageProps) {
  return (
    <div className="flex min-h-[56vh] flex-col items-center justify-center text-center">
      <div className="flex flex-col items-center">
        <span
          className="text-3xl font-bold tracking-wide"
          style={{
            background: `linear-gradient(135deg, ${theme.accentColor} 0%, #fff 130%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: `0 0 48px ${theme.accentGlow}`,
          }}
        >
          HyperSoundEngine
        </span>
        <span className={`${theme.textSecondary} mt-3 text-sm`}>WaveForge特供版</span>
        <span className={`${theme.textTertiary} mt-6 text-[11px] tracking-wide`}>2026 © IceFire_Icer All Right Reserved</span>
      </div>
    </div>
  )
}

import { motion, AnimatePresence } from 'framer-motion'
import { Song, getProxiedImageUrl } from '../services/musicApi'
import CachedImage from './CachedImage'

interface UpNextNotificationProps {
  show: boolean
  nextSong: Song | undefined
  secondsRemaining: number
  mode?: 'play' | 'transition'
  onSkip?: () => void // 添加点击跳转回调
  playerTheme?: 'light' | 'dark'
  /** AutoMix Pro（v2）：显示「Pro 过渡」文案与 Pro 徽标（缺省时渲染与历史完全一致） */
  enhanced?: boolean
  /** 过渡标识文案（Pro / Enhanced）；缺省按 Pro 过渡显示 */
  enhancedLabel?: string;
  /** Pro 过渡风格标签（energetic=高能量 / atmospheric=氛围 / clean=干净） */
  transitionStyle?: 'energetic' | 'atmospheric' | 'clean' | undefined
}

const TRANSITION_STYLE_LABEL: Record<string, { text: string; color: string }> = {
  energetic: { text: '高能量', color: '#F59E0B' },
  atmospheric: { text: '氛围', color: '#8B5CF6' },
  clean: { text: '干净', color: '#10B981' },
}

export default function UpNextNotification({ show, nextSong, secondsRemaining, mode = 'play', onSkip, playerTheme = 'dark', enhanced = false, enhancedLabel, transitionStyle }: UpNextNotificationProps) {
  // 刻意不接管 TV BACK：通知常驻挂载且注册早，BACK 会在无其他处理器时被它抢走——
  // 用户想返回主页却变成跳歌（破坏性误触）。卡片本身 OK 可点（跳下一首），自动消失。
  if (!nextSong) return null

  const isDark = playerTheme === 'dark'
  const isEnhancedTransition = enhanced && mode === 'transition'
  const styleTag = isEnhancedTransition && transitionStyle ? TRANSITION_STYLE_LABEL[transitionStyle] : undefined

  // 根节点带 `data-wf-upnext-card` 标记：沉浸模式右上角的收起箭头据此测量本弹框底边做纵向避让
  // （见 ImmersiveControls 的 arrowAvoidY），保证二者不互相压住。纯标记属性，不参与样式与层级。
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -50, x: 50 }}
          animate={{ opacity: 1, y: 0, x: 0 }}
          exit={{ opacity: 0, y: -50, x: 50 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed top-6 right-6 z-50"
          data-wf-upnext-card=""
        >
          <div
            onClick={onSkip}
            className="rounded-2xl border p-4 shadow-2xl min-w-[320px] relative overflow-hidden cursor-pointer hover:scale-105 transition-transform duration-200"
            style={{
              background: isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.78)',
              backdropFilter: 'blur(60px) saturate(180%)',
              WebkitBackdropFilter: 'blur(60px) saturate(180%)',
              borderColor: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)',
              boxShadow: isDark
                ? '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
                : '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.8)',
            }}
          >
            {/* 背景封面模糊效果 */}
            {nextSong.album?.picUrl && (
              <div
                className={`absolute inset-0 ${isDark ? 'opacity-30' : 'opacity-15'}`}
                style={{
                  backgroundImage: `url(${getProxiedImageUrl(nextSong.album.picUrl)})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  filter: 'blur(30px)',
                  transform: 'scale(1.2)'
                }}
              />
            )}

            {/* 渐变遮罩 */}
            <div
              className="absolute inset-0"
              style={{
                background: isDark
                  ? 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.2) 100%)'
                  : 'linear-gradient(135deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.3) 100%)'
              }}
            />

            {/* 内容层 */}
            <div className="relative flex items-center gap-4 z-10">
              {/* 封面 */}
              <div className={`w-16 h-16 rounded-lg overflow-hidden flex-shrink-0 shadow-lg ring-2 ${isDark ? 'bg-white/10 ring-white/20' : 'bg-black/5 ring-black/10'}`}>
                {nextSong.album?.picUrl ? (
                  <CachedImage
                    src={getProxiedImageUrl(nextSong.album.picUrl)}
                    alt={nextSong.name}
                    className="w-full h-full object-cover"
                    fallback={
                      <div className={`w-full h-full flex items-center justify-center bg-gradient-to-br ${isDark ? 'from-white/10 to-white/5' : 'from-black/10 to-black/5'}`}>
                        <svg className={`w-8 h-8 ${isDark ? 'text-white/30' : 'text-black/30'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 3 .895 3-2 3 .895 3 2zM9 10l12-3"></path>
                        </svg>
                      </div>
                    }
                  />
                ) : (
                  <div className={`w-full h-full flex items-center justify-center bg-gradient-to-br ${isDark ? 'from-white/10 to-white/5' : 'from-black/10 to-black/5'}`}>
                    <svg className={`w-8 h-8 ${isDark ? 'text-white/30' : 'text-black/30'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2 3 .895 3 2zM9 10l12-3"></path>
                    </svg>
                  </div>
                )}
              </div>

              {/* 信息 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <div className={`text-xs font-medium ${isDark ? 'text-white/70' : 'text-black/55'}`}>
                    {isEnhancedTransition ? (enhancedLabel || 'Pro 过渡') : mode === 'transition' ? '即将进入过渡' : '即将播放'} · {Math.max(0, Math.ceil(secondsRemaining))}秒后
                  </div>
                  {isEnhancedTransition && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ backgroundColor: '#3B82F6' + '30', color: '#60A5FA' }}>
                      {/* 徽章跟随实际引擎档位（Enhanced 过渡配 EN），不再写死 Pro 与文案打架 */}
                      {(enhancedLabel || 'Pro 过渡').startsWith('Enhanced') ? 'EN' : 'Pro'}
                    </span>
                  )}
                  {styleTag && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: styleTag.color + '2A', color: styleTag.color }}>
                      {styleTag.text}
                    </span>
                  )}
                </div>
                <div className={`font-semibold truncate text-base ${isDark ? 'text-white drop-shadow-md' : 'text-black/90'}`}>
                  {nextSong.name}
                </div>
                <div className={`text-sm truncate ${isDark ? 'text-white/80' : 'text-black/65'}`}>
                  {nextSong.artists.map(a => a.name).join(', ')}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

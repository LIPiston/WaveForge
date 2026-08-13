import { motion } from 'framer-motion'
import { Captions, Home, Languages } from 'lucide-react'
import { useState, useEffect } from 'react'
import QuickSettings from './QuickSettings'

interface ImmersiveControlsProps {
  onHomeClick: () => void
  onTranslationToggle: () => void
  translationEnabled: boolean
  hasTranslation: boolean
  onRomanToggle: () => void
  romanEnabled: boolean
  hasRoman: boolean
  playerTheme?: 'light' | 'dark'
  isPureMusic?: boolean // 新增：是否为纯音乐
}

export default function ImmersiveControls({
  onHomeClick,
  onTranslationToggle,
  translationEnabled,
  hasTranslation,
  onRomanToggle,
  romanEnabled,
  hasRoman,
  playerTheme = 'dark',
  isPureMusic = false, // 默认非纯音乐
}: ImmersiveControlsProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isHovered, setIsHovered] = useState(false)

  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  // 监听主题色变化
  useEffect(() => {
    const handleAccentColorChange = (e: CustomEvent) => {
      setAccentColor(e.detail)
    }
    
    window.addEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    
    return () => {
      window.removeEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    }
  }, [])

  useEffect(() => {
    // 当鼠标离开后3秒自动隐藏
    if (!isHovered) {
      const hideTimer = setTimeout(() => {
        setIsVisible(false)
      }, 3000)

      return () => clearTimeout(hideTimer)
    }
  }, [isHovered])

  const handleMouseEnter = () => {
    setIsHovered(true)
    setIsVisible(true)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  const featureButtonCount = (hasTranslation ? 1 : 0) + (hasRoman ? 1 : 0)
  const romanButtonTop = hasTranslation ? '8rem' : '4rem'
  const quickSettingsTop = `${4 + featureButtonCount * 4}rem`
  const featureButtonTransition = {
    duration: 0.48,
    ease: [0.22, 1, 0.36, 1] as const,
  }

  return (
    <div
      className="fixed top-[34px] right-0 z-40"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ width: '120px', height: `${150 + featureButtonCount * 50}px` }}
    >
      {/* Home按钮 */}
      <motion.button
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: isVisible ? 0 : 60,
          opacity: isVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
        }}
        whileHover={{ scale: 1.1, x: -2 }}
        whileTap={{ scale: 0.9 }}
        onClick={onHomeClick}
        className={`absolute top-0 right-6 p-3 rounded-full backdrop-blur-md border transition-colors ${
          playerTheme === 'dark'
            ? 'bg-black/40 hover:bg-black/60 border-white/20'
            : 'bg-white/50 hover:bg-white/70 border-black/20'
        }`}
      >
        <Home className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
      </motion.button>

      {/* 翻译按钮 - 只在有翻译时显示 */}
      {hasTranslation && (
        <motion.button
          key="translation-button"
          initial={{ x: 44, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: isVisible ? 0 : 44,
            opacity: isVisible ? 1 : 0,
            scale: isVisible ? 1 : 0.96,
            filter: isVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={{ scale: 1.06, x: -3, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onTranslationToggle}
          className="absolute top-16 right-6 p-3 rounded-full backdrop-blur-md border transition-colors overflow-hidden"
          style={{
            backgroundColor: translationEnabled
              ? accentColor
              : playerTheme === 'dark' 
                ? 'rgba(0,0,0,0.4)' 
                : 'rgba(255,255,255,0.5)',
            borderColor: translationEnabled
              ? `${accentColor}66`
              : playerTheme === 'dark'
                ? 'rgba(255,255,255,0.2)'
                : 'rgba(0,0,0,0.2)',
            boxShadow: translationEnabled
              ? `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`
              : '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          {/* 液态玻璃光泽层 */}
          {translationEnabled && (
            <div 
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          <Languages 
            className="w-6 h-6 relative z-10" 
            style={{
              color: translationEnabled ? '#fff' : playerTheme === 'dark' ? '#fff' : '#000'
            }}
          />
        </motion.button>
      )}

      {/* 罗马音按钮 - 只在当前歌曲有罗马音时显示 */}
      {hasRoman && (
        <motion.button
          key="roman-button"
          initial={{ x: 44, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: isVisible ? 0 : 44,
            opacity: isVisible ? 1 : 0,
            scale: isVisible ? 1 : 0.96,
            filter: isVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={{ scale: 1.06, x: -3, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onRomanToggle}
          className="absolute right-6 p-3 rounded-full backdrop-blur-md border transition-colors overflow-hidden"
          style={{
            top: romanButtonTop,
            backgroundColor: romanEnabled
              ? accentColor
              : playerTheme === 'dark'
                ? 'rgba(0,0,0,0.4)'
                : 'rgba(255,255,255,0.5)',
            borderColor: romanEnabled
              ? `${accentColor}66`
              : playerTheme === 'dark'
                ? 'rgba(255,255,255,0.2)'
                : 'rgba(0,0,0,0.2)',
            boxShadow: romanEnabled
              ? `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`
              : '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          {romanEnabled && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          <Captions
            className="w-6 h-6 relative z-10"
            style={{
              color: romanEnabled ? '#fff' : playerTheme === 'dark' ? '#fff' : '#000'
            }}
          />
        </motion.button>
      )}

      {/* 快速设置按钮 */}
      <motion.div
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: isVisible ? 0 : 60,
          opacity: isVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
          delay: 0.1,
        }}
        className="absolute right-6"
        style={{ top: quickSettingsTop }}
      >
        <QuickSettings 
          forceClose={!isVisible}
          playerTheme={playerTheme}
          isPureMusic={isPureMusic} // 传递纯音乐标识
        />
      </motion.div>
    </div>
  )
}

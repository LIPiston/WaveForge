/**
 * 平台切换控件（个人中心 / 桌面模式共用一套品牌视觉）。
 *
 *  · `PlatformPillCarousel`：可拖拽药丸轮播，两种密度共用同一套指针逻辑：
 *      - 默认（labelled）：色点 + 平台名 + 居中液态玻璃高亮 —— 首页「个人信息」同款样式，
 *        个人中心用它（拖动/点击切换）；
 *      - `variant="logo"`（紧凑）：只显示平台 logo 磁贴，槽宽更小、高度对齐 48px 圆钮行
 *        —— 桌面模式底栏用（用户要求：紧凑、只用 logo、滑动切平台）。
 *  · `PlatformLogo`：内联 SVG 品牌标识（红云+音符=网易云、绿音符=QQ音乐、渐变方=Apple Music、
 *    绿弧=Spotify、橙色 K=酷狗、蓝泡+音符=汽水）。仓库没有可用的图标资源，全部手绘；
 *    六平台统一 24×24 视觉重量，深色玻璃面板上都可辨。
 */
import { memo, useEffect, useRef, type ReactElement } from 'react'
import { animate, motion, useMotionValue } from 'framer-motion'
import type { MusicPlatform } from '../services/platforms'

/** 平台品牌色点（与首页平台药丸同一套配色） */
export const PLATFORM_DOT_CLASS: Record<MusicPlatform, string> = {
  netease: 'bg-red-500',
  qq: 'bg-green-500',
  apple: 'bg-pink-500',
  spotify: 'bg-[#1DB954]',
  kugou: 'bg-orange-500',
  soda: 'bg-sky-500',
}

/** 平台短名（药丸里显示的称呼） */
export const PLATFORM_SHORT_NAME: Record<MusicPlatform, string> = {
  netease: '网易云',
  qq: 'QQ音乐',
  apple: 'Apple',
  spotify: 'Spotify',
  kugou: '酷狗',
  soda: '汽水',
}

/** 平台 logo 磁贴的底色（与文字徽标同一套品牌色） */
const PLATFORM_LOGO_BACKGROUND: Record<MusicPlatform, string> = {
  netease: '#d81e2b',
  qq: '#31c27c',
  apple: 'linear-gradient(135deg, #fa5c73, #e5254a)',
  spotify: '#1db954',
  kugou: '#ff7a00',
  soda: 'linear-gradient(135deg, #5fc7f7, #38bdf8)',
}

/** 单个音符（网易云 / Apple / 汽水 共用基础形） */
function NoteGlyph() {
  return (
    <g fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round">
      <ellipse cx="8.4" cy="17.4" rx="2.9" ry="2.4" fill="#fff" stroke="none" />
      <path d="M11.3 17.4V5.9" />
      <path d="M11.3 5.9c2.6.5 4.6 1.6 5.6 3.4" />
    </g>
  )
}

/** 双音符（QQ音乐） */
function DoubleNoteGlyph() {
  return (
    <g fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round">
      <ellipse cx="6.6" cy="17.6" rx="2.6" ry="2.1" fill="#fff" stroke="none" />
      <ellipse cx="15.4" cy="16.2" rx="2.6" ry="2.1" fill="#fff" stroke="none" />
      <path d="M9.2 17.6V7.4l8.8-2.2v11" />
      <path d="M9.2 10.2l8.8-2.2" />
    </g>
  )
}

/** 云 + 音符（网易云音乐） */
function CloudNoteGlyph() {
  return (
    <g>
      <g fill="#fff">
        <circle cx="8.6" cy="12.9" r="3.1" />
        <circle cx="12.4" cy="11.4" r="4" />
        <circle cx="16.2" cy="13.2" r="2.7" />
        <rect x="5.8" y="12.6" width="12.4" height="3.5" rx="1.75" />
      </g>
      <path d="M13 12.6V6.4c1.9.4 3.3 1.2 4 2.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </g>
  )
}

/** 三条弧线（Spotify） */
function SpotifyGlyph() {
  return (
    <g fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round">
      <path d="M6.2 9.4c3.6-1.1 7.8-.7 11 1.3" />
      <path d="M7 13.1c3-.9 6.4-.5 9 1.1" />
      <path d="M7.8 16.4c2.4-.6 5-.4 7.1.9" />
    </g>
  )
}

/** 酷狗：字母 K + 音符点缀 */
function KugouGlyph() {
  return (
    <g fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.2 6.4v11.2" />
      <path d="M15.4 6.4l-5.6 5.6 5.8 5.6" />
    </g>
  )
}

/** 汽水：气泡 + 音符 */
function SodaGlyph() {
  return (
    <g>
      <NoteGlyph />
      <circle cx="17.4" cy="7.2" r="1.5" fill="#fff" />
      <circle cx="19.2" cy="10.4" r="1" fill="#fff" />
    </g>
  )
}

const PLATFORM_GLYPHS: Record<MusicPlatform, () => ReactElement> = {
  netease: CloudNoteGlyph,
  qq: DoubleNoteGlyph,
  apple: NoteGlyph,
  spotify: SpotifyGlyph,
  kugou: KugouGlyph,
  soda: SodaGlyph,
}

/** 平台 logo 磁贴：品牌底 + 手绘 SVG 标识。Apple 用圆角方形（与官方图标同形），其余圆形。 */
export const PlatformLogo = memo(function PlatformLogo({ platform, size = 24 }: { platform: MusicPlatform; size?: number }) {
  const Glyph = PLATFORM_GLYPHS[platform]
  const radius = platform === 'apple' ? 'rounded-[26%]' : 'rounded-full'
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${radius}`}
      style={{ width: size, height: size, background: PLATFORM_LOGO_BACKGROUND[platform] }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width={size} height={size}>{Glyph ? <Glyph /> : null}</svg>
    </span>
  )
})

interface PlatformCarouselProps {
  platforms: MusicPlatform[]
  current: MusicPlatform
  onChange: (platform: MusicPlatform) => void
  playerTheme?: 'light' | 'dark'
  /** 高亮玻璃的模糊量（px） */
  blurAmount?: number
  /** 单槽宽度（px） */
  slot?: number
  /** 视口可见槽数（当前平台始终居中） */
  visibleSlots?: number
  /** labelled = 色点 + 名称（图3 样式）；logo = 只显示平台 logo 磁贴（紧凑，桌面模式用） */
  variant?: 'labelled' | 'logo'
}

/**
 * 可拖拽平台轮播：当前平台始终居中（液态玻璃高亮覆盖），拖动实时跟随、松手平滑归中，
 * 未拖动时按点击直接切换。platforms 由调用方按「已登录 + 未隐藏」过滤后传入。
 */
export const PlatformPillCarousel = memo(function PlatformPillCarousel({
  platforms,
  current,
  onChange,
  playerTheme = 'dark',
  blurAmount = 20,
  slot = 80,
  visibleSlots = 3,
  variant = 'labelled',
}: PlatformCarouselProps) {
  const isDark = playerTheme === 'dark'
  const width = slot * visibleSlots
  const centerSlot = Math.floor(visibleSlots / 2)
  const currentIdx = Math.max(0, platforms.indexOf(current))
  const stripX = useMotionValue((centerSlot - currentIdx) * slot)
  const idxRef = useRef(currentIdx)
  idxRef.current = currentIdx
  const dragRef = useRef<{ startX: number; startIdx: number; dragging: boolean; moved: boolean; pressedKey: MusicPlatform | null }>({
    startX: 0, startIdx: currentIdx, dragging: false, moved: false, pressedKey: null,
  })
  const draggingRef = useRef(false)

  // 外部切换（点击/设置里改平台）→ 平滑滚动到当前平台居中
  useEffect(() => {
    if (draggingRef.current) return
    animate(stripX, (centerSlot - currentIdx) * slot, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
  }, [current, platforms, stripX, currentIdx, centerSlot, slot])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const pressed = (e.target as HTMLElement).closest('button')?.getAttribute('data-platform') as MusicPlatform | null
    e.currentTarget.setPointerCapture(e.pointerId)
    stripX.stop()
    dragRef.current = { startX: e.clientX, startIdx: idxRef.current, dragging: true, moved: false, pressedKey: pressed }
    draggingRef.current = true
  }
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current
    if (!st.dragging) return
    const rawDelta = e.clientX - st.startX
    if (Math.abs(rawDelta) > 8) st.moved = true
    // 连续浮点索引：起点索引固定为按下时的索引，floatIndex 完全由 rawDelta 决定。
    // 切勿改写 st.startIdx——跨槽后 rawDelta 仍相对最初按下点，改写起点会「拖 1px 跳一槽」。
    const floatIndex = Math.max(0, Math.min(platforms.length - 1, st.startIdx - rawDelta / slot))
    const nextIdx = Math.round(floatIndex)
    if (nextIdx !== st.startIdx && platforms[nextIdx]) onChange(platforms[nextIdx])
    stripX.set((centerSlot - floatIndex) * slot)
  }
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current
    if (!st.dragging) return
    const wasDrag = st.moved
    const pressedKey = st.pressedKey
    st.dragging = false
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    stripX.stop()
    animate(stripX, (centerSlot - idxRef.current) * slot, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
    // 未拖动：解析按下的药丸直接切换（pointer capture 会拦截原生 click）
    if (!wasDrag && pressedKey && pressedKey !== current) onChange(pressedKey)
  }

  if (!platforms.includes(current)) return null
  const compact = variant === 'logo'
  const highlightInset = compact ? 3 : 4

  return (
    <div
      className="relative overflow-hidden rounded-full"
      style={{
        width,
        height: compact ? 48 : undefined,
        padding: compact ? '0' : '4px',
        background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
        boxShadow: compact ? '0 8px 32px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.2)' : undefined,
      }}
      aria-label={`平台切换，当前 ${PLATFORM_SHORT_NAME[current] ?? current}，左右拖动切换`}
    >
      {/* 液态玻璃高亮：固定视口中央（当前平台被它覆盖） */}
      <div
        aria-hidden="true"
        className="absolute rounded-full"
        style={{
          width: slot - highlightInset * 2,
          height: compact ? 48 - highlightInset * 2 : undefined,
          top: highlightInset,
          bottom: compact ? undefined : highlightInset,
          left: centerSlot * slot + highlightInset,
          background: isDark
            ? 'linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.12))'
            : 'linear-gradient(135deg, rgba(255,255,255,0.95), rgba(255,255,255,0.75))',
          backdropFilter: `blur(${blurAmount}px) saturate(160%)`,
          WebkitBackdropFilter: `blur(${blurAmount}px) saturate(160%)`,
          boxShadow: isDark
            ? '0 4px 18px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)'
            : '0 4px 20px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.8)'}`,
        }}
      />
      {/* 可拖拽内容条：当前位置 = (中心槽 - 浮点索引) × 槽宽 */}
      <motion.div
        className="relative flex h-full touch-none select-none items-center"
        style={{ x: stripX, cursor: compact ? 'grab' : 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {platforms.map((key) => {
          const active = key === current
          return (
            <button
              key={key}
              type="button"
              data-platform={key}
              title={PLATFORM_SHORT_NAME[key] ?? key}
              onClick={() => { /* 由 pointerup 统一处理（pointer capture 拦截 click） */ }}
              className={`flex-shrink-0 relative z-10 flex items-center justify-center transition-opacity ${
                compact
                  ? active ? 'opacity-100' : 'opacity-55'
                  : `py-2 text-sm font-semibold gap-1.5 transition-colors ${
                    active
                      ? isDark ? 'text-white' : 'text-black/90'
                      : isDark ? 'text-white/45' : 'text-black/35'
                  }`
              }`}
              style={{ width: slot, height: compact ? 48 : undefined }}
            >
              {compact ? (
                <PlatformLogo platform={key} size={30} />
              ) : (
                <>
                  <PlatformDot platform={key} />
                  {PLATFORM_SHORT_NAME[key] ?? key}
                </>
              )}
            </button>
          )
        })}
      </motion.div>
    </div>
  )
})

export function PlatformDot({ platform, className = 'h-1.5 w-1.5' }: { platform: MusicPlatform; className?: string }) {
  return <span className={`inline-block shrink-0 rounded-full ${className} ${PLATFORM_DOT_CLASS[platform]}`} aria-hidden="true" />
}

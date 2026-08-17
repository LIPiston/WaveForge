/**
 * TV 遥控器交互核心（仅在 html.tv-mode 下生效，桌面不受影响）。
 *
 * 设计思路：把"鼠标 hover/点击"交互整体替换为"焦点"交互——
 *  - 空间导航：D-pad 按 DOM 几何找最佳邻居，滚动到可视区并画焦点环；
 *  - Enter/OK 激活：对焦点元素执行 click()（原生 button/链接/带 onClick 的 div 都适用）；
 *  - 聚焦域（scope）：模态/面板用 data-tv-scope 标记，出现时焦点自动收拢进域内；
 *  - BACK 栈：组件可用 useTvBack() 注册返回处理（关闭面板/软键盘等）；
 *  - data-tv-arrows：容器标记后可让方向键穿透给组件自身逻辑（seek/volume/scroll）。
 *
 * 键码兼容两套：DOM 标准箭头键（37-40）与 Android TV 遥控器键码（19-22 上下左右、23/66 确定）。
 */
import { useEffect, useSyncExternalStore } from 'react'

// ---------------- tv-mode 状态（React 可订阅） ----------------
let tvMode =
  typeof document !== 'undefined' && document.documentElement.classList.contains('tv-mode')

const tvListeners = new Set<() => void>()

export function isTvMode(): boolean {
  return tvMode
}

function setTvMode(v: boolean): void {
  if (tvMode === v) return
  tvMode = v
  tvListeners.forEach((fn) => fn())
}

function subscribeTvMode(cb: () => void): () => void {
  tvListeners.add(cb)
  return () => tvListeners.delete(cb)
}

/** React Hook：当前是否 TV 遥控器模式。 */
export function useTvMode(): boolean {
  return useSyncExternalStore(subscribeTvMode, isTvMode)
}

// ---------------- 远程遥控光标模式（React 可订阅） ----------------
// 手机遥控器连上 TV 后切换为"光标交互"：hover 驱动 UI（与 PC 一致），焦点环隐藏。
let remoteCursorMode = false
const remoteCursorListeners = new Set<() => void>()

export function isRemoteCursorMode(): boolean {
  return remoteCursorMode
}

export function setRemoteCursorMode(v: boolean): void {
  if (remoteCursorMode === v) return
  remoteCursorMode = v
  if (v) {
    // 光标模式下隐藏焦点环（用户在用手势/触摸板，不是方向键）
    ensureRing().classList.add('tv-ring-idle')
  } else {
    ensureRing().classList.remove('tv-ring-idle')
    updateRing()
  }
  remoteCursorListeners.forEach((fn) => fn())
}

function subscribeRemoteCursorMode(cb: () => void): () => void {
  remoteCursorListeners.add(cb)
  return () => remoteCursorListeners.delete(cb)
}

/** React Hook：手机遥控器是否处于连接（光标模式）。 */
export function useRemoteCursorMode(): boolean {
  return useSyncExternalStore(subscribeRemoteCursorMode, isRemoteCursorMode)
}

// ---------------- 焦点候选 ---------------- 
// 除了原生可聚焦元素，还纳入本项目约定俗成的可点击项：
//  - [class*="cursor-pointer"]：歌曲行/歌单卡片等 div + onClick 的容器（Tailwind 统一类）
//  - [data-tv-focus]：组件手动标注的任意可聚焦元素
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]',
  '[data-tv-focus]',
  '[class*="cursor-pointer"]',
].join(', ')

/** 开关（checkbox/radio）在设置页用 sr-only 写法（1x1px），导航/焦点环改用其 label 区域。 */
function focusRectOf(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect()
  if (
    r.width < 2 &&
    r.height < 2 &&
    el.tagName === 'INPUT' &&
    ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')
  ) {
    const label = el.closest('label')
    if (label) {
      const lr = label.getBoundingClientRect()
      if (lr.width >= 2 && lr.height >= 2) return lr
    }
  }
  return r
}

/** 渲染存在性：display/visibility/透明度/尺寸（不含视口与滚动裁剪）。 */
function isRendered(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const style = getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (Number(style.opacity) === 0) return false
  const r = el.getBoundingClientRect()
  // 开关（checkbox/radio）是 sr-only 1px，用 label 区域判定，否则设置页开关永远不可聚焦
  if (r.width < 2 || r.height < 2) {
    const isSwitch =
      el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')
    if (!isSwitch) return false
  }
  const vr = focusRectOf(el)
  if (vr.width < 2 || vr.height < 2) return false
  return true
}

/** 基本可见性：渲染存在 + 在视口内（不含滚动容器裁剪）。 */
function isBasicallyVisible(el: HTMLElement): boolean {
  if (!isRendered(el)) return false
  const vr = focusRectOf(el)
  if (vr.bottom < 0 || vr.top > window.innerHeight) return false
  if (vr.right < 0 || vr.left > window.innerWidth) return false
  return true
}

function isVisible(el: HTMLElement): boolean {
  if (!isBasicallyVisible(el)) return false
  // 滚动容器裁剪判定：被可滚动/裁剪祖先挡住（滚出可视区）的元素不算候选——
  // 否则滚到页面底部按"上"会跳到容器外/不可见的元素（如设置页跳标签栏）。
  if (isClippedByScroll(el)) return false
  return true
}

/** 元素是否被某个滚动/裁剪祖先排除在可视区之外（rect 不相交）。 */
function isClippedByScroll(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    const o = style.overflow
    const oy = style.overflowY
    const scrolls =
      oy === 'auto' || oy === 'scroll' || o === 'auto' || o === 'scroll' || o === 'hidden' || oy === 'hidden'
    if (scrolls) {
      const pr = node.getBoundingClientRect()
      if (r.bottom < pr.top + 1 || r.top > pr.bottom - 1 || r.right < pr.left + 1 || r.left > pr.right - 1) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * 元素是否被「不可滚动」的裁剪容器（overflow:hidden/clip）排除在可视区外。
 * 这类容器无法 scrollIntoView 滚回来，同容器保留逻辑不应接纳它们。
 */
function isClippedByNonScrollable(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    const o = style.overflow
    const oy = style.overflowY
    const scrollable = oy === 'auto' || oy === 'scroll' || o === 'auto' || o === 'scroll'
    const clipping = o === 'hidden' || oy === 'hidden' || o === 'clip' || oy === 'clip'
    if (clipping && !scrollable) {
      const pr = node.getBoundingClientRect()
      if (r.bottom < pr.top + 1 || r.top > pr.bottom - 1 || r.right < pr.left + 1 || r.left > pr.right - 1) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/** 元素所在的最近滚动容器（overflow-y auto/scroll）。 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

/**
 * 命中测试：元素中心点是否还能被点击到。
 * 模态/面板打开时，其背后的元素会被遮挡（elementFromPoint 命中遮罩而非元素本身），
 * 从而被自动排除在导航候选之外——无需给每个模态框都标记 data-tv-scope 也能避免焦点"穿墙"。
 */
function isHitTestable(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!hit) return false
  if (hit === el || el.contains(hit)) return true
  // sr-only 开关：命中 label 区域即视为可点（视觉开关 div 在 label 内，中心点可能落在它上面）
  const label = el.closest('label')
  if (label && (hit === label || label.contains(hit))) return true
  return false
}

// ---------------- 聚焦域（scope） ----------------
// 按出现顺序入栈；取可见的最顶层。组件卸载后自动失效（isConnected 检查）。
const scopes: HTMLElement[] = []

function currentScope(): HTMLElement | Document {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i]
    if (s.isConnected && isVisible(s)) return s
  }
  return document
}

function candidates(from: HTMLElement | null = null, dir: Direction | null = null): HTMLElement[] {
  const scope = currentScope()
  const root = scope instanceof Document ? document : scope
  const list = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)) as HTMLElement[]
  return list.filter((el) => {
    if (el.closest('[data-tv-skip]')) return false
    if (!isRendered(el)) return false
    if (isClippedByScroll(el)) {
      // 被不可滚动容器（overflow:hidden/clip）裁掉的项滚不回来，排除
      if (isClippedByNonScrollable(el)) return false
      // 同滚动容器内被裁剪的项仍保留为候选：上下导航选中后 scrollIntoView 自动滚回，
      // 避免"按上跳过紧邻的上一项直接跳到标签栏"；跨容器裁剪项仍排除。
      // 注意：被裁剪项不做视口检查——高模态框把顶部（如关闭按钮）滚出浏览器视口时，
      // 选中后 scrollIntoView 会把容器滚回来使其进入视口。
      if (from && dir && (dir === 'up' || dir === 'down')) {
        const curScroll = scrollParentOf(from)
        const candScroll = scrollParentOf(el)
        if (curScroll && candScroll === curScroll) return true
      }
      return false
    }
    // 未裁剪项必须在视口内且可命中
    const vr = focusRectOf(el)
    if (vr.bottom < 0 || vr.top > window.innerHeight) return false
    if (vr.right < 0 || vr.left > window.innerWidth) return false
    if (!isHitTestable(el)) return false
    return true
  })
}

// ---------------- 焦点状态与焦点环 ----------------
let focusedEl: HTMLElement | null = null
const focusListeners = new Set<() => void>()

export function getFocusedElement(): HTMLElement | null {
  return focusedEl
}

function subscribeFocus(cb: () => void): () => void {
  focusListeners.add(cb)
  return () => focusListeners.delete(cb)
}

/** React Hook：当前焦点元素（用于"焦点落在组件内部时展开控件"等场景）。 */
export function useTvFocus(): HTMLElement | null {
  return useSyncExternalStore(subscribeFocus, getFocusedElement)
}

let ringEl: HTMLDivElement | null = null

function ensureRing(): HTMLDivElement {
  if (ringEl?.isConnected) return ringEl
  ringEl = document.createElement('div')
  ringEl.id = 'tv-focus-ring'
  ringEl.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483000;box-sizing:border-box;' +
    'border-radius:8px;border:3px solid #4fc3f7;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 20px rgba(79,195,247,.5);' +
    'transition:left .12s ease,top .12s ease,width .12s ease,height .12s ease,opacity .3s ease;display:none;'
  document.body.appendChild(ringEl)
  return ringEl
}

function updateRing(): void {
  const ring = ensureRing()
  if (!focusedEl || !focusedEl.isConnected || !isVisible(focusedEl)) {
    ring.style.display = 'none'
    return
  }
  const r = focusRectOf(focusedEl)
  ring.style.display = 'block'
  ring.style.left = `${r.left - 5}px`
  ring.style.top = `${r.top - 5}px`
  ring.style.width = `${r.width + 10}px`
  ring.style.height = `${r.height + 10}px`
}

// 焦点环空闲自动渐隐：任意按键/焦点移动视为活动，3 秒无操作后加 tv-ring-idle 类淡出
let ringIdleTimer: number | null = null

function markRingActive(): void {
  const ring = ensureRing()
  ring.classList.remove('tv-ring-idle')
  if (ringIdleTimer !== null) {
    window.clearTimeout(ringIdleTimer)
  }
  ringIdleTimer = window.setTimeout(() => {
    ensureRing().classList.add('tv-ring-idle')
  }, 3000)
}

// ---------------- 设置焦点 ----------------
// 软键盘激活时：焦点环照常移动，但不调用原生 focus()，避免输入框失焦导致键盘消失。
let keyboardActive = false

export function isKeyboardActive(): boolean {
  return keyboardActive
}

export function setKeyboardActive(v: boolean): void {
  keyboardActive = v
  if (!v && !focusedEl) focusFirst()
}

export function setTvFocus(el: HTMLElement | null): void {
  if (el === focusedEl) {
    updateRing()
    return
  }
  focusedEl?.classList.remove('tv-focused')
  focusedEl = el
  if (el) {
    el.classList.add('tv-focused')
    if (!keyboardActive) {
      try {
        el.focus({ preventScroll: true })
      } catch {
        // ignore
      }
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  focusListeners.forEach((fn) => fn())
  updateRing()
  markRingActive()
  updateVolumeKeyCapture()
}

/** 焦点在 range 滑块上时，让原生层把音量键转发给页面（用于 +1/-1 调节） */
function updateVolumeKeyCapture(): void {
  const capture =
    focusedEl !== null &&
    focusedEl.tagName === 'INPUT' &&
    (focusedEl as HTMLInputElement).type === 'range'
  const native = (window as any).WaveForgeNative
  if (native?.setVolumeKeyCapture) {
    try {
      native.setVolumeKeyCapture(capture)
    } catch {
      // ignore
    }
  }
}

// ---------------- 空间导航 ----------------
type Direction = 'up' | 'down' | 'left' | 'right'

function bestNeighbor(current: HTMLElement, dir: Direction): HTMLElement | null {
  const list = candidates(current, dir)
  const cur = focusRectOf(current)
  const cx = cur.left + cur.width / 2
  const cy = cur.top + cur.height / 2
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === current) continue
    const r = focusRectOf(el)
    const ecx = r.left + r.width / 2
    const ecy = r.top + r.height / 2
    const dx = ecx - cx
    const dy = ecy - cy
    let inDir = false
    if (dir === 'right') inDir = dx > 4
    else if (dir === 'left') inDir = dx < -4
    else if (dir === 'down') inDir = dy > 4
    else inDir = dy < -4
    if (!inDir) continue
    const parallel = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy)
    const perpendicular = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    // 垂直方向偏差权重大，避免对角线跳跃
    let score = parallel + perpendicular * 1.5
    // 同滚动容器优先：上下导航不应跳出当前面板的滚动区（如设置页内容区→左侧标签栏），
    // 跨容器候选加重惩罚，仅在无同容器候选时才会被选到。
    if (dir === 'up' || dir === 'down') {
      const curScroll = scrollParentOf(current)
      const candScroll = scrollParentOf(el)
      if (curScroll && candScroll !== curScroll) score += 400
      // 同容器内滚出可视区的项（可自动滚动回去）也小惩，优先选当前可见的紧邻项
      else if (curScroll && candScroll === curScroll && isClippedByScroll(el)) score += 60
    }
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

function focusFirst(): void {
  const list = candidates()
  if (list.length) setTvFocus(list[0])
}

/** 焦点元素是否处于允许方向键穿透的容器（seek/volume/scroll 等组件自处理）。 */
function arrowsPassThrough(dir: Direction): boolean {
  if (!focusedEl) return false
  const mode = focusedEl.closest('[data-tv-arrows]')?.getAttribute('data-tv-arrows')
  if (!mode) return false
  if ((mode.includes('seek') || mode.includes('volume')) && (dir === 'left' || dir === 'right')) return true
  if (mode.includes('scroll') && (dir === 'up' || dir === 'down')) return true
  if (mode.includes('horizontal') && (dir === 'left' || dir === 'right')) return true
  return false
}

function moveFocus(dir: Direction): void {
  if (arrowsPassThrough(dir)) return
  if (!focusedEl || !focusedEl.isConnected) {
    focusFirst()
    return
  }
  const next = bestNeighbor(focusedEl, dir)
  if (next) setTvFocus(next)
}

// ---------------- 激活（Enter/OK） ----------------
function activate(): void {
  if (!focusedEl) {
    focusFirst()
    return
  }
  // 先尝试 click()；点击不可用（如纯展示元素）则聚焦第一个候选
  try {
    const el = focusedEl as HTMLElement
    if (typeof el.click === 'function') {
      el.click()
      return
    }
  } catch {
    // ignore
  }
  focusFirst()
}

// ---------------- BACK 处理栈 ----------------
type BackHandler = () => boolean
const backHandlers: BackHandler[] = []

export function useTvBack(handler: BackHandler): void {
  useEffect(() => {
    backHandlers.push(handler)
    return () => {
      const i = backHandlers.indexOf(handler)
      if (i >= 0) backHandlers.splice(i, 1)
    }
  }, [handler])
}

/** 触发一次 BACK（由 DOM keydown/自定义事件/Kotlin 转发调用）。返回是否已被消费。 */
export function dispatchTvBack(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    if (backHandlers[i]()) return true
  }
  return false
}

// ---------------- 全局键监听 ----------------
// 只有文本类输入才算"可编辑"：checkbox/range/radio 等开关不算（否则焦点到开关会被当文本处理）
const TV_TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text'
    return TV_TEXT_INPUT_TYPES.has(type)
  }
  return false
}

function dirOf(code: number): Direction {
  switch (code) {
    case 37:
    case 21:
      return 'left'
    case 38:
    case 19:
      return 'up'
    case 39:
    case 22:
      return 'right'
    default:
      return 'down'
  }
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!tvMode) return
  const code = e.keyCode
  // 任何按键都视为活动：焦点环重新显示，3 秒无操作后渐隐
  markRingActive()

  // 音量键（KEYCODE_VOLUME_UP=24 / DOWN=25，原生层在滑块聚焦时转发）：
  // 焦点在 range 滑块上时 +1/-1 调节，而不是移走焦点
  if (code === 24 || code === 25) {
    const el = focusedEl
    if (el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') {
      e.preventDefault()
      const input = el as HTMLInputElement
      try {
        if (code === 24) input.stepUp()
        else input.stepDown()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        // ignore
      }
    }
    return
  }

  // 软键盘激活：方向键在键盘网格内做空间导航，Enter 激活键位，BACK 关闭键盘
  if (keyboardActive) {
    switch (code) {
      case 37:
      case 38:
      case 39:
      case 40:
      case 19:
      case 20:
      case 21:
      case 22:
        e.preventDefault()
        moveFocus(dirOf(code))
        return
      case 13:
      case 23:
      case 66:
        e.preventDefault()
        activate()
        return
      case 4:
        if (dispatchTvBack()) e.preventDefault()
        return
      default:
        return
    }
  }

  // 输入框聚焦时（非软键盘激活，例如接物理键盘），方向键留给文本编辑
  if (isEditable(document.activeElement)) {
    return
  }

  switch (code) {
    case 37: // ArrowLeft
    case 21:
      e.preventDefault()
      moveFocus('left')
      return
    case 38: // ArrowUp
    case 19:
      e.preventDefault()
      moveFocus('up')
      return
    case 39: // ArrowRight
    case 22:
      e.preventDefault()
      moveFocus('right')
      return
    case 40: // ArrowDown
    case 20:
      e.preventDefault()
      moveFocus('down')
      return
    case 13: // Enter
    case 23: // KEYCODE_DPAD_CENTER
    case 66: // KEYCODE_ENTER
      e.preventDefault()
      activate()
      return
    case 8: // Backspace（PC 模拟 TV 的 BACK）
    case 27: // Escape（PC 模拟 TV 的 BACK）
    case 4: // KEYCODE_BACK
      if (dispatchTvBack()) {
        e.preventDefault()
      }
      return
    case 85: // KEYCODE_MEDIA_PLAY_PAUSE
    case 126: // KEYCODE_MEDIA_PLAY
    case 127: // KEYCODE_MEDIA_PAUSE
    case 86: // KEYCODE_MEDIA_STOP
    case 87: // KEYCODE_MEDIA_NEXT
    case 88: // KEYCODE_MEDIA_PREVIOUS
      // 媒体键：不拦截，交给 App 的 mediaSession / 快捷键逻辑
      return
    default:
      return
  }
}

// ---------------- 聚焦域自动管理 ----------------
let scopeObserver: MutationObserver | null = null

function setupScopeObserver(): void {
  scopeObserver = new MutationObserver((mutations) => {
    let changed = false
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches('[data-tv-scope]')) {
          scopes.push(node)
          changed = true
        }
        node.querySelectorAll('[data-tv-scope]').forEach((el) => {
          scopes.push(el as HTMLElement)
          changed = true
        })
      }
    }
    if (changed) {
      // 新面板打开：若当前焦点不在新域内，收拢到新域
      const scope = currentScope()
      if (scope instanceof HTMLElement && (!focusedEl || !scope.contains(focusedEl))) {
        focusFirst()
      }
    }
  })
  scopeObserver.observe(document.body, { childList: true, subtree: true })
}

// 初始时收录已存在的域
function collectExistingScopes(): void {
  document.querySelectorAll('[data-tv-scope]').forEach((el) => scopes.push(el as HTMLElement))
}

// ---------------- 初始化 ----------------
let initialized = false

export function initTv(): void {
  if (initialized) return
  initialized = true
  tvMode = document.documentElement.classList.contains('tv-mode')
  if (!tvMode) return

  ensureRing()
  collectExistingScopes()
  setupScopeObserver()
  document.addEventListener('keydown', handleKeyDown, true)

  // 首次聚焦
  focusFirst()

  // 每次布局/渲染变化后校正焦点环位置（ResizeObserver 对整页更省事，用 rAF 节流）
  let raf = 0
  const onLayout = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(updateRing)
  }
  window.addEventListener('scroll', onLayout, true)
  window.addEventListener('resize', onLayout)
  const ro = new ResizeObserver(onLayout)
  ro.observe(document.body)
}

/** 在文档加载完成后调用一次（WebView 就绪、React 挂载后由 main.tsx 调用）。 */
export function startTv(): void {
  if (typeof document === 'undefined') return
  if (!document.documentElement.classList.contains('tv-mode')) return
  if (!initialized) {
    initTv()
  } else {
    // 已初始化过（如 React 挂载后再次调用）：重新收拢焦点到当前可见候选。
    focusFirst()
  }
}

/** 供 Kotlin 转发媒体键等时判定是否已激活。 */
export function isTvActive(): boolean {
  return tvMode
}

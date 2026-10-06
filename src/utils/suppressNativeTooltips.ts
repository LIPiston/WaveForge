/**
 * 全局禁用浏览器的原生 title 悬浮提示。
 *
 * 背景（用户反馈）：原生 tooltip 的样式/延迟与播放器的视觉语言不符（"太 low"），
 * 要求全局不要弹。CSS 无法关闭原生 tooltip，因此在捕获阶段拦截 mouseover，
 * 把命中元素的 `title` 摘到 `data-wf-title`（信息保留，便于将来自绘 tooltip 复用），
 * 浏览器随即不会再显示原生气泡；另在 DOM 就绪时对存量 [title] 做一次预清扫。
 * 成本：一个捕获监听 + 一次初始扫描；不用 MutationObserver，
 * 动态元素在首次被悬停时清理即可。React 重新渲染改回 title 时，下次悬停会再次清理。
 */
let installed = false

export function installNativeTooltipSuppressor(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  const strip = (element: Element | null) => {
    if (!element || !(element instanceof HTMLElement)) return
    const title = element.getAttribute('title')
    if (title === null) return
    element.setAttribute('data-wf-title', title)
    element.removeAttribute('title')
  }

  document.addEventListener('mouseover', event => {
    const target = event.target
    if (!(target instanceof Element)) return
    strip(target.closest('[title]'))
  }, true)

  const sweep = () => {
    document.querySelectorAll('[title]').forEach(strip)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sweep, { once: true })
  } else {
    sweep()
  }
}

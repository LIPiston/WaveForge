/**
 * 共享可见性观察器：同一 rootMargin 全页面只建一个 IntersectionObserver。
 *
 * 与 CachedImage 里的懒加载 observer 的区别：那边只关心「第一次进入视口」，
 * 回调命中即可注销（一次性）；动态封面需要**持续**跟踪进入/离开——离开视口要暂停播放，
 * 离得更远要回收媒体管线（HLS/MSE 缓冲、解码器、GPU 纹理）。
 *
 * 若每张卡片各建 observer：探索页上百张卡 × 2~3 档 margin 就是数百个观察器同帧参与
 * 交叉计算，这正是 CachedImage 注释里记录过的卡顿源。这里按 rootMargin 收敛成单例，
 * 元素级回调支持 enter/exit 双向通知。
 *
 * 延迟到首次真正需要时才创建实例：Electron 早期启动/测试环境可能在模块加载之后
 * 才注入 IntersectionObserver polyfill（与 CachedImage 同样的理由）。
 */

export interface VisibilityHandlers {
  /** 进入该 margin 定义的区域（首次也会触发一次） */
  onEnter?: () => void
  /** 离开该区域 */
  onExit?: () => void
}

interface RegistryEntry extends VisibilityHandlers {
  inside: boolean
}

interface Registry {
  observer: IntersectionObserver
  entries: WeakMap<Element, RegistryEntry>
}

const registries = new Map<string, Registry>()

function getRegistry(rootMargin: string): Registry | null {
  const existing = registries.get(rootMargin)
  if (existing) return existing
  if (typeof IntersectionObserver === 'undefined') return null
  const entries = new WeakMap<Element, RegistryEntry>()
  const observer = new IntersectionObserver(
    observed => {
      for (const entry of observed) {
        const record = entries.get(entry.target)
        if (!record) continue
        const next = entry.isIntersecting
        if (next === record.inside) continue
        record.inside = next
        if (next) record.onEnter?.()
        else record.onExit?.()
      }
    },
    { rootMargin, threshold: 0 },
  )
  const registry: Registry = { observer, entries }
  registries.set(rootMargin, registry)
  return registry
}

/**
 * 注册元素到共享观察器。返回注销函数（组件卸载时必须调用）。
 * 环境不支持 IntersectionObserver 时立刻按「不可见」处理并返回空注销函数：
 * 调用方据此停掉播放/释放媒体，安全方向正确（宁可少播，不要泄漏）。
 */
export function observeVisibility(element: Element, rootMargin: string, handlers: VisibilityHandlers): () => void {
  const registry = getRegistry(rootMargin)
  if (!registry) return () => undefined
  registry.entries.set(element, { ...handlers, inside: false })
  registry.observer.observe(element)
  return () => {
    registry.entries.delete(element)
    registry.observer.unobserve(element)
  }
}

/** 视口附近（可播）判定范围：卡片露出前后一小段就起播，避免边缘处反复启停。 */
export const MOTION_PLAY_MARGIN = '150px'
/** 媒体保留判定范围：离开这个范围才销毁 HLS 管线，避免正常滚动来回重建。
 *  视口上下各留约一屏：纵向滚动时上下两行的封面管线仍然热着，横向滑出货架一两屏就回收。 */
export const MOTION_RETAIN_MARGIN = '800px'
/** 动态封面数据加载判定范围：进入即拉取（拉取结果有会话缓存，一次性）。 */
export const MOTION_LOAD_MARGIN = '400px'

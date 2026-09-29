import { createContext, useContext, type CSSProperties } from 'react'

/**
 * 视图模式层（探索 / 桌面 / 共振 / 传统 / 简约）的层叠样式，五个模式层共用。
 *
 * 五个模式层是同一个层叠上下文里的同级整屏容器，靠 z-index 分层、靠 DOM 顺序兜底。
 * 切走的模式不卸载、只「挂起」（保留已加载内容、滚动位置与打开中的弹窗），因此挂起层
 * 必须显式让位：z-index 降到 1 且 visibility: hidden。
 *
 * 这里必须是两者的组合，缺一个就会出事故：挂起层若保持 z-index: 2 且可见，它与当前
 * 模式同层，DOM 顺序又排在后面（JSX 顺序：探索 → 桌面 → 共振 → 传统 → 简约），
 * 于是盖住当前模式——简约层自带不透明黑底（bg-black），表现为切模式后整屏黑屏，
 * 并且吞掉所有鼠标点击（命中测试全部落在挂起层内部）。
 *
 * @param suspended 该模式是否处于挂起态（已挂载但不是当前显示的模式）
 * @param overlayAbove 是否以覆盖层身份盖在其它模式之上（仅简约层作为播放页覆盖
 *   探索页时使用；与 suspended 互斥——覆盖层是「当前显示的内容」，不是挂起态）
 */
export function modeLayerStyle(options: { suspended: boolean; overlayAbove?: boolean }): CSSProperties {
  const { suspended, overlayAbove = false } = options
  return {
    willChange: 'transform, opacity',
    backfaceVisibility: 'hidden',
    zIndex: suspended ? 1 : overlayAbove ? 4 : 2,
    visibility: suspended ? 'hidden' : 'visible',
  }
}

/**
 * 挂起层的调试标记（data-wf-suspended）。与 CSS 无关，仅用于排查「哪个层被挂起了」。
 */
export function modeLayerSuspendedAttr(suspended: boolean): '' | undefined {
  return suspended ? '' : undefined
}

/**
 * 模式层的挂起状态，供层内的浮层读取（React context 走 React 树，portal 不打断它）。
 *
 * 为什么不能只靠 CSS：挂起层用 visibility: hidden 隐藏，但层内 `createPortal(…, document.body)`
 * 的浮层在 DOM 上是 body 的子节点，不是挂起层的后代，CSS 管不着它们——弹窗/下拉/候选条会留在
 * 屏幕上盖住当前模式。React context 则沿 React 树传递，portal 不影响这条传递路径，
 * 所以层内任意深度的浮层都能读到「我所属的模式层被挂起了」。
 *
 * 用法：
 *   · 模式层容器内提供本 context（值 = 该层的挂起态，见 App.tsx 各模式层）；
 *   · 浮层组件用 useModeParked()，挂起时不渲染 portal。**只隐藏、不卸载组件**，
 *     所以切回该模式时浮层原样恢复（与「切走只隐藏、保留状态」的挂起语义一致）。
 *   · 不在任何模式层内（App 级全局浮层）读到的默认值是 false，行为不变。
 */
export const ModeParkedContext = createContext(false)

/** 当前浮层所属的模式层是否处于挂起态（不在模式层内恒为 false）。 */
export function useModeParked(): boolean {
  return useContext(ModeParkedContext)
}

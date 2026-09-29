/**
 * 游戏模式运行态势（渲染端单一真源）
 *
 * 主进程的「游戏模式冻结」经 game-mode:freeze 广播到 App.tsx，App 再写入这里。
 * 存在的意义：渲染端大量后台循环散落在 service / hook / 组件里（Apple 桥 200ms 状态轮询、
 * 无缝衔接尾段监测、音频特效旋转、桌面挂件时钟……），它们拿不到 React 状态，
 * 也不该各自去订阅一遍 IPC。这里提供一份全局只读快照 + 订阅，
 * 让这些循环按「游戏模式冻结中」自行降频或暂停——冻结结束自动恢复原节奏。
 *
 * 注意与 document.hidden 的区别：主窗开了 backgroundThrottling:false，
 * 隐藏到托盘时 Page Visibility 未必切到 hidden，游戏模式必须走这条显式通道。
 */

let frozen = false
const listeners = new Set<(frozen: boolean) => void>()

export function setGameModeFrozen(value: boolean) {
  const next = value === true
  if (next === frozen) return
  frozen = next
  for (const listener of Array.from(listeners)) {
    try {
      listener(next)
    } catch {
      /* 单个订阅者异常不影响其它循环 */
    }
  }
}

export function isGameModeFrozen() {
  return frozen
}

/**
 * 「现在不该出帧」的统一判定：页面被浏览器判定为隐藏，或游戏模式已把主窗隐藏到托盘。
 *
 * 为什么要合并这两件事：主窗用 backgroundThrottling:false 换来隐藏时的持续合成
 * （避免重新显示时首帧空白），代价是 Page Visibility 不再翻到 hidden——
 * 于是所有写 `document.visibilityState === 'hidden'` 的停帧逻辑在托盘隐藏时全部失效，
 * rAF 照样按显示器刷新率全速跑。重负载渲染组件（全屏着色器/可视化器/歌词时钟）
 * 应当用本函数代替裸的 visibilityState 判断，并订阅 subscribeGameModeFrozen 触发停/启。
 */
export function isRenderSuspended() {
  if (frozen) return true
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function subscribeGameModeFrozen(listener: (frozen: boolean) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

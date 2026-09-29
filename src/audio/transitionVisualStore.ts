/**
 * 过渡视觉轨道（Transition Visual Track）——把"画面上显示的过渡进度"从 React 状态传播里拆出来。
 *
 * 背景：过渡期间逐帧进度原本经 `onStateChange` → App `setState`（还被 10fps 节流）→ 整棵 App
 * 重渲染，导致叠加动画呈 10 步/秒的台阶（用户反馈"过渡看起来很卡"）。同时"视觉切换"（歌名/
 * 封面/歌词/MV 换成目标曲）被推迟到真正的音频提交帧，于是提交瞬间整屏跳变（"没有丝滑转过去"）。
 *
 * 本 store 承担两件事：
 *   1. 逐帧进度/时间线：由播放引擎在过渡期间以 ~30fps 发布，**叶子组件直接订阅**（或命令式写
 *      opacity），App 层只保留"是否在过渡 / 视觉是否已切换"这类离散事实。
 *   2. 视觉切换标记（`switched`）：进度到 90% 时置位，表示"从这一帧起，画面属于目标曲"——
 *      歌词/MV/时间线据此提前切换，真正提交时无需再改任何可见内容。
 *
 * 时间线语义：
 *   - `sourceTime`：过渡缓冲驱动的合成时间（源曲时间轴，切换前使用）
 *   - `targetTime`：目标曲自身的绝对时间（切换后使用；缓冲结束时恰等于目标 deck 的续播点，
 *     因此提交帧时间线连续、无跳变）
 *   - 播放引擎在 `switched` 之后把 `targetTime` 发进 playbackTimeStore，进度条/歌词自动跟随。
 */
export interface TransitionVisualSnapshot {
  /** 是否处于过渡的"动画窗口"（armed 起、提交/取消止）。false 时其余字段无意义。 */
  active: boolean
  /** 0..1：整个过渡（缓冲剩余时长）的进度。 */
  progress: number
  /** 过渡总时长（秒）。 */
  duration: number
  /** 源曲时间轴上的合成播放时间（秒）。 */
  sourceTime: number
  /** 目标曲时间轴上的绝对播放时间（秒）。 */
  targetTime: number
  /** 视觉是否已切到目标曲（≈进度 90%）。 */
  switched: boolean
  /** 过渡两端的 trackKey，便于消费方校验与 key 派生。 */
  fromTrackKey: string
  toTrackKey: string
  /**
   * 动画窗口提前量（秒）：AI 长混音 20s，其余 10s。叠加层的展示进度需要它做窗口门控
   *（`progress < 1 - lead/duration` 时保持 0），与 App 侧 `transitionStartTime` 的口径一致。
   */
  animationLeadSeconds: number
}

export interface TransitionVisualStore {
  getSnapshot: () => TransitionVisualSnapshot
  subscribe: (listener: () => void) => () => void
  /** 发布一次进度（引擎在过渡 rAF 中调用，~30fps）。 */
  publish: (state: Partial<TransitionVisualSnapshot>) => void
  /** 标记视觉已切换到目标曲（进度 90%）。 */
  markSwitched: () => void
  /** 开始一次过渡（armed 阶段即可，progress 从 0 起）。 */
  begin: (init: { fromTrackKey: string; toTrackKey: string; duration: number; animationLeadSeconds?: number }) => void
  /**
   * 收起过渡。`holdFinalFrame = true` 时保留最后一帧（progress=1）直到调用方显式 reset——
   * 用于"提交帧与视觉切换同批"的场景：先保帧、等 canonical 状态落地后再清，避免叠加层闪回。
   */
  end: (holdFinalFrame?: boolean) => void
  reset: () => void
}

const EMPTY: TransitionVisualSnapshot = {
  active: false,
  progress: 0,
  duration: 0,
  sourceTime: 0,
  targetTime: 0,
  switched: false,
  fromTrackKey: '',
  toTrackKey: '',
  animationLeadSeconds: 10,
}

function sameSnapshot(a: TransitionVisualSnapshot, b: TransitionVisualSnapshot): boolean {
  return a.active === b.active
    && a.progress === b.progress
    && a.duration === b.duration
    && a.sourceTime === b.sourceTime
    && a.targetTime === b.targetTime
    && a.switched === b.switched
    && a.fromTrackKey === b.fromTrackKey
    && a.toTrackKey === b.toTrackKey
    && a.animationLeadSeconds === b.animationLeadSeconds
}

export function createTransitionVisualStore(): TransitionVisualStore {
  let snapshot: TransitionVisualSnapshot = EMPTY
  const listeners = new Set<() => void>()

  const commit = (next: TransitionVisualSnapshot) => {
    if (sameSnapshot(snapshot, next)) return
    snapshot = next
    listeners.forEach(listener => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (state) => {
      commit({ ...snapshot, ...state })
    },
    markSwitched: () => {
      if (snapshot.switched) return
      commit({ ...snapshot, switched: true })
    },
    begin: (init) => {
      commit({
        ...EMPTY,
        active: true,
        duration: Math.max(0, init.duration),
        animationLeadSeconds: init.animationLeadSeconds && init.animationLeadSeconds > 0 ? init.animationLeadSeconds : EMPTY.animationLeadSeconds,
        fromTrackKey: init.fromTrackKey,
        toTrackKey: init.toTrackKey,
      })
    },
    end: (holdFinalFrame = false) => {
      if (holdFinalFrame) {
        commit({ ...snapshot, active: false, progress: 1 })
        return
      }
      commit({ ...EMPTY })
    },
    reset: () => commit({ ...EMPTY }),
  }
}

/**
 * React 订阅：`useTransitionVisual()`（由 App 通过 props 下发给叶子组件，避免在这里 import React
 * 造成 hook 依赖方向混乱）。组件内用 `useSyncExternalStore(store.subscribe, store.getSnapshot)`
 * 即可获得 30fps 的进度快照——只重渲染订阅者自己，不再牵动 App 整树。
 */

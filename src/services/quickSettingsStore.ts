/**
 * 快捷设置弹窗（原 QuickSettings 下拉面板）的全局开关状态。
 *
 * 为什么需要它：面板改成弹窗后**宿主必须唯一**，且必须挂在 App 层再经 portal 挂到 body，
 * 否则会被 `minimal-playback-surface` 的 transform 层叠上下文与歌词容器的 overflow-hidden 困住/裁切。
 * 于是「开 / 关」不能再是面板组件内的 useState —— 5 个触发入口（播放面纵向按钮列、紧凑横条、
 * 摩登页脚 chip、电台页、播客页）各自保留自己的按钮外观，只调这里的 open / close。
 *
 * 参考开源项目 folia（folia-major）：设置弹窗状态放在 store 里
 * （其 useSettingsModalStore 的 openSettings / closeSettings），宿主在 App 层只挂一份，
 * 弹窗对外只暴露「打开 / 关闭」，不关心自己挂在哪个页面下。
 */
import { useSyncExternalStore } from 'react'

export type QuickSettingsSection = 'appearance' | 'features' | 'playback'

export interface QuickSettingsOpenOptions {
  /** 打开后落到的分段，默认「外观」 */
  section?: QuickSettingsSection
  /** 播放面主题：弹窗宿主在 App 层，拿不到调用页的上下文，只能随 open 一起带过来 */
  playerTheme?: 'light' | 'dark'
  /** 纯音乐 / 播客播放：功能段收敛掉歌词相关项 */
  isPureMusic?: boolean
}

export interface QuickSettingsState {
  isOpen: boolean
  section: QuickSettingsSection
  playerTheme: 'light' | 'dark'
  isPureMusic: boolean
  /** 每次「关 → 开」自增：作为弹窗 key，保证每次打开都按最新存储值重新挂载面板 */
  seq: number
}

const CLOSED_STATE: QuickSettingsState = {
  isOpen: false,
  section: 'appearance',
  playerTheme: 'dark',
  isPureMusic: false,
  seq: 0,
}

let state: QuickSettingsState = CLOSED_STATE
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

export const subscribeQuickSettings = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 会无限重渲染 */
export const getQuickSettingsState = () => state

export function openQuickSettings(options: QuickSettingsOpenOptions = {}) {
  // 已打开时是空操作：不 bump seq，避免第二次 open 把面板重挂载（会闪一下、丢当前分段）
  if (state.isOpen) return
  state = {
    isOpen: true,
    section: options.section ?? 'appearance',
    playerTheme: options.playerTheme ?? 'dark',
    isPureMusic: options.isPureMusic ?? false,
    seq: state.seq + 1,
  }
  emit()
}

export function closeQuickSettings() {
  if (!state.isOpen) return
  state = { ...state, isOpen: false }
  emit()
}

export function toggleQuickSettings(options: QuickSettingsOpenOptions = {}) {
  if (state.isOpen) closeQuickSettings()
  else openQuickSettings(options)
}

export function useQuickSettingsState(): QuickSettingsState {
  return useSyncExternalStore(subscribeQuickSettings, getQuickSettingsState, getQuickSettingsState)
}

/** 仅供测试：把 store 复位，避免用例之间互相污染（保留订阅者，避免被挂载中的组件丢事件） */
export function resetQuickSettingsForTest() {
  state = { ...CLOSED_STATE }
  emit()
}

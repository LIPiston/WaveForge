import { useEffect, useState } from 'react'
import { isGameModeFrozen, subscribeGameModeFrozen } from '../services/gameModeRuntime'

/**
 * 订阅「游戏模式冻结中」的渲染端全局态势。
 *
 * 与 App 内的 gameModeFrozen state 同源（App 把状态写进 gameModeRuntime），
 * 供深层组件（桌面挂件、看点页等）在不透传 props 的情况下自行降频/暂停后台循环。
 */
export function useGameModeFrozen() {
  const [frozen, setFrozen] = useState(isGameModeFrozen)
  useEffect(() => subscribeGameModeFrozen(setFrozen), [])
  return frozen
}

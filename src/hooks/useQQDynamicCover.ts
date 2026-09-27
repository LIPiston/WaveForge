/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * QQ 音乐动态封面 Hook：与 useAppleDynamicCover 同款时序（300ms 延迟、切歌防旧）。
 * 严格判定由服务端保证：dynamicCoverVid 为空 / 视频解析失败 → cover=null。
 * 优先级（App.tsx 内合成）：QQ 动态封面 > Apple Music 动态封面。
 */
import { useEffect, useState } from 'react'
import {
  getQQDynamicCover,
  type QQDynamicCoverData,
} from '../services/qqDynamicCover'
import { isAppleDynamicCoverEnabled } from '../services/appleDynamicCover'

export interface QQDynamicCoverState {
  cover: QQDynamicCoverData | null
  loading: boolean
}

export function useQQDynamicCover(query: {
  /** QQ 歌曲 mid（QQ 平台的当前歌曲直接带） */
  songMid?: string
  title: string
  artist?: string
  album?: string
  /** 曲目唯一键（切歌判旧用） */
  trackKey: string | number
}): QQDynamicCoverState {
  const { songMid, title, artist, album, trackKey } = query
  const [state, setState] = useState<QQDynamicCoverState>({ cover: null, loading: false })

  useEffect(() => {
    // 与 AM 动态封面共用总开关；关闭时零请求
    if (!isAppleDynamicCoverEnabled() || (!songMid && !title)) {
      setState({ cover: null, loading: false })
      return
    }
    const controller = new AbortController()
    setState((prev) => ({ cover: prev.cover, loading: true }))
    const timer = window.setTimeout(() => {
      void getQQDynamicCover({ songMid, title, artist, album, signal: controller.signal })
        .then((cover) => {
          if (!controller.signal.aborted) setState({ cover, loading: false })
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ cover: null, loading: false })
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [songMid, title, artist, album, trackKey])

  useEffect(() => {
    const onSettingChanged = () => {
      if (!isAppleDynamicCoverEnabled()) setState({ cover: null, loading: false })
    }
    window.addEventListener('appleDynamicCoverSettingChanged', onSettingChanged)
    return () => window.removeEventListener('appleDynamicCoverSettingChanged', onSettingChanged)
  }, [])

  return state
}

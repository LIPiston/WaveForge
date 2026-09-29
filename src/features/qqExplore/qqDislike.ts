import type { Song } from '../../services/musicApi'
import { addQQDislike, cancelQQDislike, fetchQQDislikeList } from './api'

/**
 * QQ 音乐「不喜欢」（歌曲黑名单，App 同款 music.feedback.FeedbackBlack）。
 * 2026-09-27 活体实证：AddDislike / CancelDislike 参数一致
 *   { Songs: [{ id: '<数字 songId>', idType: 0, name: '<歌名>' }] }
 * 列表 id 即数字 songId（Song.id），故本地缓存用字符串化 id 比对。
 */
let dislikeIds: Set<string> | null = null
let loading: Promise<Set<string>> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeQQDislike(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 已加载时返回是否在名单内；未加载返回 null（调用方自行触发加载）。 */
export function peekQQDislike(song: Song | null | undefined): boolean | null {
  if (!song || dislikeIds === null) return null
  return dislikeIds.has(String(song.id))
}

export function loadQQDislikeIds(force = false): Promise<Set<string>> {
  if (!force && dislikeIds) return Promise.resolve(dislikeIds)
  if (!force && loading) return loading
  loading = fetchQQDislikeList()
    .then(data => {
      dislikeIds = new Set((data.songs || []).map(item => String(item.id)))
      emit()
      return dislikeIds
    })
    .catch(error => {
      if (!dislikeIds) dislikeIds = new Set()
      throw error
    })
    .finally(() => { loading = null })
  return loading
}

/** 切换「不喜欢」状态，返回切换后的状态（true = 已不喜欢）。 */
export async function toggleQQDislike(song: Song): Promise<boolean> {
  if (dislikeIds === null) await loadQQDislikeIds().catch(() => {})
  const numericId = String(song.id)
  const next = !(dislikeIds?.has(numericId) ?? false)
  const payload = { songId: song.id, songMid: song.mid, name: song.name }
  // 后端在中转时会把 mid 解析为数字 songId；缓存以解析后的 id 为准（防 songId=0 的歌曲）
  const result = next ? await addQQDislike(payload) : await cancelQQDislike(payload)
  const cacheKey = String(result?.id || numericId)
  if (!dislikeIds) dislikeIds = new Set()
  if (next) dislikeIds.add(cacheKey)
  else dislikeIds.delete(cacheKey)
  emit()
  return next
}

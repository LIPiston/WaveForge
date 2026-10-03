/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 歌单持久缓存的失效竞态。
 *
 * 背景：持久层失效是异步的（且历史上是 fire-and-forget），紧随其后的
 * getUserPlaylists 会从 IndexedDB 读回尚未删除的旧列表并写回内存，表现为
 * 「删掉的歌单又回来 / 新建的不出现 / 改名回退」。这里用一个「删除有延迟」的
 * 假 IDB 复现该时序：若读取前不等待失效落地，就会拿到旧列表。
 *
 * 假 IDB 刻意不解析缓存键格式：本用例只关心时序，键结构由 playlistService 内部决定。
 */

let persistedValue: any[] | null = null
let clearDelayMs = 0

const clearPlaylistsForPlatform = vi.fn(async () => {
  if (clearDelayMs > 0) await new Promise(resolve => setTimeout(resolve, clearDelayMs))
  persistedValue = null
})
const getCachedPlaylist = vi.fn(async () => persistedValue)
const cachePlaylist = vi.fn(async (_id: string, _platform: string, data: any[]) => {
  persistedValue = data
})

vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    invalidatePlaylist: vi.fn().mockResolvedValue(undefined),
    clearPlaylistsForPlatform: () => clearPlaylistsForPlatform(),
    getCachedPlaylist: (_id: string) => getCachedPlaylist(),
    cachePlaylist: (id: string, platform: string, data: any[]) => cachePlaylist(id, platform, data),
    clearPlaylists: vi.fn().mockResolvedValue(undefined),
  },
}))

const { invalidateUserPlaylistsCache, getUserPlaylists } = await import('../src/services/playlistService')

const STALE = [{ id: '1', name: '已被删除的歌单', trackCount: 1, platform: 'netease' }]
const FRESH = [{ id: '2', name: '服务端最新列表', trackCount: 2, platform: 'netease' }]

/** 网易云分支读的是 data.playlist */
function freshNetworkResponse() {
  return { ok: true, json: async () => ({ playlist: FRESH }) }
}

describe('歌单持久缓存失效', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persistedValue = null
    clearDelayMs = 0
    localStorage.clear()
  })

  it('失效后立即读取不会读回旧列表', async () => {
    persistedValue = STALE
    const fetchMock = vi.fn().mockResolvedValue(freshNetworkResponse())
    vi.stubGlobal('fetch', fetchMock)

    // 删除有 10ms 延迟：若读取前不等待失效落地，就会读到 STALE
    clearDelayMs = 10
    invalidateUserPlaylistsCache('netease', 'u1')

    const result = await getUserPlaylists('netease', 'u1')
    expect(result.map((item: any) => item.id)).toEqual(['2'])
    expect(result).not.toEqual(STALE)
  })

  it('失效过程中读到的陈旧持久值会被丢弃并改为联网刷新', async () => {
    persistedValue = STALE
    const fetchMock = vi.fn().mockResolvedValue(freshNetworkResponse())
    vi.stubGlobal('fetch', fetchMock)

    const pending = getUserPlaylists('netease', 'u1')
    // 读取途中发生失效（用户恰好在这个窗口里删了歌单）
    invalidateUserPlaylistsCache('netease', 'u1')

    const result = await pending
    expect(result.map((item: any) => item.id)).toEqual(['2'])
  })

  it('无失效时正常复用持久缓存，不联网', async () => {
    persistedValue = FRESH
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await getUserPlaylists('netease', 'u1')
    expect(result.map((item: any) => item.id)).toEqual(['2'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('失效按平台前缀清理，不做整库清空', () => {
    invalidateUserPlaylistsCache('netease', 'u1')
    expect(clearPlaylistsForPlatform).toHaveBeenCalled()
  })
})

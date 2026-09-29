/** @vitest-environment jsdom */
// 诊断：传统模式接入的官方化页面在真实（无 stub）挂载时是否抛错 → 全黑屏
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined
}

// 网络全失败：组件应降级到错误态而不是抛异常
globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) })) as any

import NeteaseExplorePage from '../src/features/neteaseExplore/NeteaseExplorePage'
import QQExplorePage from '../src/features/qqExplore/QQExplorePage'

const noop = () => undefined

describe('诊断：传统模式嵌入页真实挂载', () => {
  it('NeteaseExplorePage 挂载不抛错', () => {
    expect(() => {
      render(
        <NeteaseExplorePage
          loggedIn
          username="测试"
          userId="123"
          entitlement="free"
          authRevision={0}
          accent="#ff5a70"
          showDescription
          currentSong={null}
          publicContent={null}
          accountPlaylists={[]}
          onRequestFallback={noop}
          onLogin={noop}
          onPlaySongs={noop}
          onOpenPlaylist={noop}
          onOpenChannel={noop}
          onOpenAlbum={noop}
          onOpenArtist={noop}
          onOpenMV={noop}
          onSongContextMenu={noop}
          onPlaylistContextMenu={noop}
          onAddToFavorites={noop}
          onRemoveFromFavorites={noop}
        />,
      )
    }).not.toThrow()
  })

  it('QQExplorePage 挂载不抛错', () => {
    expect(() => {
      render(
        <QQExplorePage
          loggedIn={false}
          username=""
          authRevision={0}
          entitlement="free"
          accent="#31e68b"
          showDescription
          officialEnhanced={false}
          publicContent={null}
          onLogin={noop}
          isPlaying={false}
          onPlayPause={noop}
          onPlaySongs={noop}
          onPlayDaily30={noop}
          onOpenPlaylist={noop}
          onOpenChart={noop}
          onOpenChannel={noop}
          onOpenSearch={noop}
          onConfiguredChange={noop}
          onOpenPlaylists={noop}
          onOpenCharts={noop}
          onOpenMVs={noop}
          onSongContextMenu={noop}
          onAddToFavorites={noop}
          onRemoveFromFavorites={noop}
          active
        />,
      )
    }).not.toThrow()
  })
})

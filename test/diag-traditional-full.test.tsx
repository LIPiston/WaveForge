/** @vitest-environment jsdom */
// 诊断 2：完整 TraditionalView + 真实 NeteaseExplorePage（无 stub）是否崩
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined
}

globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) })) as any

vi.mock('../src/services/desktopSpectrum', () => ({
  registerDesktopSpectrumConsumer: vi.fn(() => () => undefined),
}))

import TraditionalView from '../src/components/TraditionalView'

const analyzerSnapshot = {
  bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
  spectrum: new Float32Array(24),
  left: { bass: 0, mid: 0, high: 0, overall: 0 },
  right: { bass: 0, mid: 0, high: 0, overall: 0 },
}
const analyzerStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => analyzerSnapshot,
  retainBackground: () => () => undefined,
  hasBackgroundConsumers: () => false,
}

describe('诊断：完整 TraditionalView（真实嵌入页）', () => {
  it('netease 平台首页挂载不抛错', async () => {
    let threw: unknown = null
    try {
      render(<TraditionalView
        onSongSelect={vi.fn()}
        onOpenPlayer={vi.fn()}
        analyzerStore={analyzerStore as any}
        playbackTimeStore={{ subscribe: () => () => undefined, getSnapshot: () => ({ currentTime: 0 }) } as any}
        currentSong={null}
        queue={[]}
        currentIndex={-1}
        isPlaying={false}
        duration={0}
        lyrics={[]}
        volume={0.5}
        playerTheme="dark"
        neteaseLoggedIn
        neteaseUsername="测试"
        neteaseUserId="123"
        qqLoggedIn={false}
        qqUsername=""
        appleLoggedIn={false}
        appleUsername=""
        spotifyLoggedIn={false}
        spotifyUsername=""
        kugouLoggedIn={false}
        kugouUsername=""
        sodaLoggedIn={false}
        sodaUsername=""
        authRevision={0}
        onLoginClick={vi.fn()}
        onProfileClick={vi.fn()}
        onSearchClick={vi.fn()}
        onSettingsClick={vi.fn()}
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onSeek={vi.fn()}
        onVolumeChange={vi.fn()}
      />)
    } catch (error) {
      threw = error
    }
    // 等一轮异步（lazy chunk + fetch 失败降级）
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(threw).toBeNull()
  })
})

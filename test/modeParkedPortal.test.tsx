/** @vitest-environment jsdom */
// 模式挂起 × portal 浮层：层内 `createPortal(…, document.body)` 的浮层在 DOM 上是 body 的子节点，
// 挂起层的 visibility: hidden 管不到它们。必须靠 React context（沿 React 树传递、portal 不打断）
// 让浮层自己知道「我所属的模式层被挂起了」。这里用真实组件（模式选择面板）验证机制本身。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { ModeParkedContext, useModeParked } from '../src/utils/modeLayer'
import ModeSelectionPanel from '../src/components/ModeSelectionPanel'

// jsdom 缺 matchMedia / ResizeObserver：模式面板内部会用到
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
if (!(globalThis as Record<string, unknown>).ResizeObserver) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

/** 最小复现：一个 portal 到 body 的浮层，按所属模式层的挂起状态决定是否渲染 */
function PortalledBadge() {
  const parked = useModeParked()
  if (parked) return null
  return createPortal(<span data-testid="parked-badge">浮层内容</span>, document.body)
}

const withParked = (parked: boolean, children: ReactNode) => (
  <ModeParkedContext.Provider value={parked}>{children}</ModeParkedContext.Provider>
)

describe('模式挂起与 portal 浮层', () => {
  afterEach(cleanup)

  it('不在模式层内时读到默认 false，浮层照常渲染', () => {
    render(<PortalledBadge />)
    expect(screen.getByTestId('parked-badge')).toBeTruthy()
  })

  it('所属模式层挂起时不渲染，恢复后原样回来（只隐藏、不卸载）', () => {
    const { rerender } = render(withParked(true, <PortalledBadge />))
    expect(screen.queryByTestId('parked-badge')).toBeNull()
    rerender(withParked(false, <PortalledBadge />))
    expect(screen.getByTestId('parked-badge')).toBeTruthy()
  })

  it('模式选择面板在挂起的模式层里不会出现在 body 上', () => {
    const panel = <ModeSelectionPanel currentMode="desktop" onClose={() => undefined} onSelect={() => undefined} />
    const { rerender } = render(withParked(true, panel))
    expect(screen.queryByText('模式选择')).toBeNull()
    rerender(withParked(false, panel))
    expect(screen.getByText('模式选择')).toBeTruthy()
  })
})

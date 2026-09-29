/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImmersiveControls from '../src/components/ImmersiveControls'
import type { TrackStemControlModel } from '../src/components/StemMixerPopover'

let tvMode = false
let remoteCursorMode = false

vi.mock('../src/tv/tvCore', () => ({
  useTvMode: () => tvMode,
  useRemoteCursorMode: () => remoteCursorMode,
  // StemMixerPopover 的 BACK 处理（TV 长按菜单轮次引入）：测试环境空实现
  useTvBack: () => undefined,
}))

vi.mock('../src/components/QuickSettings', () => ({
  default: () => <button type="button" aria-label="快速设置" />,
}))

function stemControl(): TrackStemControlModel {
  return {
    status: 'ready',
    gains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    availableStems: ['vocals', 'drums', 'bass', 'other'],
    active: true,
    onEnable: vi.fn(),
    onVocalChange: vi.fn(),
    onStemChange: vi.fn(),
    onReturnOriginal: vi.fn(),
  }
}

const baseProps = {
  onHomeClick: vi.fn(),
  onTranslationToggle: vi.fn(),
  translationEnabled: false,
  hasTranslation: true,
  onRomanToggle: vi.fn(),
  romanEnabled: false,
  hasRoman: true,
  onMvBackgroundToggle: vi.fn(),
}

beforeEach(() => {
  tvMode = false
  remoteCursorMode = false
})

afterEach(cleanup)

describe('ImmersiveControls', () => {
  it('renders the optional stem control after feature rows and grows the desktop rail', () => {
    const { container } = render(<ImmersiveControls {...baseProps} stemControl={stemControl()} />)

    const stemButton = screen.getByRole('button', { name: '人声与乐器调节' })
    expect(stemButton.className).toContain('p-3')
    expect(stemButton.parentElement?.parentElement?.style.top).toBe('16rem')
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('20rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('414px')
  })

  it('omits the stem row when no control is provided', () => {
    render(<ImmersiveControls {...baseProps} />)

    expect(screen.queryByRole('button', { name: '人声与乐器调节' })).toBeNull()
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('16rem')
  })

  it('uses compact TV row spacing and trigger sizing', () => {
    tvMode = true
    const { container } = render(<ImmersiveControls {...baseProps} stemControl={stemControl()} />)

    const stemButton = screen.getByRole('button', { name: '人声与乐器调节' })
    expect(stemButton.className).toContain('p-2.5')
    expect(stemButton.parentElement?.parentElement?.style.top).toBe('12.8rem')
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('16rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('310px')
  })

  it('immersive (left) keeps arrow + buttons as one top-right stack, arrow owning the first row', () => {
    render(<ImmersiveControls {...baseProps} variant="left" coverColor="#3b82f6" />)

    const arrow = screen.getByRole('button', { name: '收起控制按钮' })
    // 箭头与按钮同属一列（列内 absolute、同款玻璃），不是脱离整组的独立浮标
    expect(arrow.className).toContain('absolute')
    expect(arrow.className).toContain('right-0')
    expect(arrow.className).not.toContain('fixed')
    expect(arrow.getAttribute('data-wf-immersive-arrow')).toBe('')

    // 整组容器贴右上角（fixed right-6，顶部 34px 与其它模式的右上角按钮列同高）
    const rail = arrow.parentElement as HTMLElement
    expect(rail.className).toContain('fixed')
    expect(rail.className).toContain('right-6')
    expect(rail.style.top).toBe('34px')

    // 箭头仍独占列内第一行 → Home 回到 4rem（与搬到左侧之前同一套行序）
    expect(screen.getByRole('button', { name: '回到主界面' }).style.top).toBe('4rem')
  })

  it('modern (slab) reuses the immersive glass slab but keeps the default rail geometry', () => {
    const { container } = render(<ImmersiveControls {...baseProps} variant="slab" coverColor="#3b82f6" />)

    // 形态：整列收进一块玻璃板（与沉浸模式同一块，`data-wf-immersive-slab` 复用同一标记）
    const slab = container.querySelector('[data-wf-immersive-slab]') as HTMLElement | null
    expect(slab).toBeTruthy()
    expect(slab?.className).toContain('rounded-[18px]')
    expect(slab?.className).toContain('backdrop-blur-md')
    expect(slab?.className).toContain('right-6')
    // 板高 = 最后一行底 + 下留白 12，板顶上提 12 → 64 + 3×64 + 48 + 24 = 328（无箭头行）
    expect(slab?.style.height).toBe('328px')
    expect(slab?.style.width).toBe('48px')
    expect(slab?.style.top).toBe('-12px')

    // 位置：仍走默认布局 —— 没有收起箭头，按钮也不含箭头那一行的纵向偏移
    expect(container.querySelector('[data-wf-immersive-arrow]')).toBeNull()
    expect(screen.queryByRole('button', { name: '收起控制按钮' })).toBeNull()
    expect(screen.getByRole('button', { name: '回到主界面' }).style.top).toBe('')

    // 行本身是透明方行（不再是圆钮），圆角与板同心且不带描边
    const home = screen.getByRole('button', { name: '回到主界面' })
    expect(home.className).toContain('rounded-[18px]')
    expect(home.className).not.toContain('rounded-full')
    expect(home.className).not.toContain('border')
  })

  it('leaves the default rail untouched for folia / pv / multidimensional', () => {
    const { container } = render(<ImmersiveControls {...baseProps} coverColor="#3b82f6" />)

    // default 分支被 folia / pv / 多维三个模式共用：不能出现玻璃板，也必须保持独立玻璃圆钮
    expect(container.querySelector('[data-wf-immersive-slab]')).toBeNull()
    expect(container.querySelector('[data-wf-immersive-arrow]')).toBeNull()
    const home = screen.getByRole('button', { name: '回到主界面' })
    expect(home.className).toContain('rounded-full')
    expect(home.className).toContain('border')
    expect(home.className).not.toContain('rounded-[18px]')
  })
})

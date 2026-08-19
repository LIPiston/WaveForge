/**
 * 空间音频：输出设备选择 UI 冒烟（jsdom）
 *
 * 覆盖：
 *  - SpatialSettingsModal「输出设备」区：API 不可枚举 → 「系统默认（不可枚举）」
 *    禁用态；枚举到设备 → 下拉渲染（系统默认 + 设备项，空 label 回退占位名）、
 *    选中项跟随 spatial.sinkId、切换触发 onPatch + setOutputDevice 持久化生效；
 *  - SpatialStudioLayout 状态栏「输出」只读展示：sinkId 缺省 → 系统默认、
 *    有 sinkId → 已选设备（完整切换在设置弹窗，状态栏不做联动）。
 * 环境：文件头 @vitest-environment jsdom（与 uiSmoke.test.tsx 同范式）。
 * 注：listOutputDevices/setOutputDevice 走真实 fusion 实现——jsdom 的 navigator
 * 无 mediaDevices 时天然返回 []（禁用态路径）；枚举用 vi.stubGlobal 注入桩。
 */

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react'
import SpatialSettingsModal from './SpatialSettingsModal'
import SpatialStudioLayout from './SpatialStudioLayout'
import { createDefaultSpatialParams } from '../../src/spatial/types'
import { getSpatialParams } from '../../src/spatial/fusion'
import type { HSETheme } from '../hse-theme'
import type { DeepPartial, SpatialParams } from '../../src/spatial/types'

/** 测试用 HSE 主题（与 useHSETheme 默认值同义的最小对象，不依赖 hook/window） */
const theme: HSETheme = {
  dark: true,
  accentColor: '#22d3ee',
  accentGlow: '#22d3ee44',
  accentDim: '#22d3ee22',
  accentFrom: '#22d3ee',
  accentTo: '#7c3aed',
  accentGradient: 'linear-gradient(135deg, #22d3ee 0%, #7c3aed 100%)',
  panelBg: 'rgba(18, 18, 22, 0.85)',
  panelBorder: 'rgba(255,255,255,0.08)',
  panelHighlight: 'linear-gradient(160deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 45%, rgba(255,255,255,0.04) 100%)',
  cardBg: 'linear-gradient(150deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 100%)',
  cardBorder: 'rgba(255,255,255,0.08)',
  cardGlow: '0 8px 24px rgba(0,0,0,0.25)',
  navBg: 'rgba(12,12,16,0.7)',
  navActiveBg: 'linear-gradient(135deg, #22d3ee22 0%, transparent 60%)',
  navActiveBorder: '#22d3ee66',
  navHoverBg: 'rgba(255,255,255,0.04)',
  textPrimary: 'text-white',
  textSecondary: 'text-white/70',
  textTertiary: 'text-white/45',
  textMuted: 'text-white/25',
  inputBg: 'rgba(255,255,255,0.04)',
  trackBg: 'rgba(255,255,255,0.10)',
  trackFill: '#22d3ee',
  statusOk: '#4ade80',
  statusWarn: '#fbbf24',
  glassBlur: 'blur(24px) saturate(160%)',
  glassCardBlur: 'blur(16px) saturate(140%)',
  sliderTrack: () => 'linear-gradient(to right, #22d3ee 0%, #7c3aed 100%)',
}

function renderModal(spatial: SpatialParams, onPatch: (p: DeepPartial<SpatialParams>) => void) {
  return render(
    <SpatialSettingsModal open onClose={() => undefined} theme={theme} spatial={spatial} onPatch={onPatch} />,
  )
}

describe('空间音频：输出设备选择 UI 冒烟', () => {
  beforeEach(() => cleanup())
  afterEach(() => vi.unstubAllGlobals())

  it('弹窗：设备不可枚举（jsdom 无 mediaDevices）→ 「系统默认（不可枚举）」禁用态', async () => {
    renderModal(createDefaultSpatialParams(), () => undefined)
    expect(await screen.findByText('系统默认（不可枚举）')).toBeTruthy()
  })

  it('弹窗：枚举到设备 → 下拉渲染系统默认 + 设备项，选中项跟随 spatial.sinkId', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audiooutput', deviceId: 'dev-a', label: '扬声器 A' },
          { kind: 'audiooutput', deviceId: 'dev-b', label: '' }, // 空 label → 占位名
        ]),
      },
    })
    renderModal({ ...createDefaultSpatialParams(), sinkId: 'dev-a' }, () => undefined)
    const select = (await screen.findByLabelText('输出设备')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3)) // 系统默认 + 2 设备
    expect(select.value).toBe('dev-a') // 已保存设备回显
    expect(screen.getByText('输出设备 2')).toBeTruthy() // 空 label 回退占位名
  })

  it('弹窗：切换设备 → onPatch 写 sinkId + setOutputDevice 持久化生效（选中联动）', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audiooutput', deviceId: 'dev-a', label: '扬声器 A' },
          { kind: 'audiooutput', deviceId: 'dev-b', label: '扬声器 B' },
        ]),
      },
    })
    const patches: DeepPartial<SpatialParams>[] = []
    const { rerender } = renderModal(createDefaultSpatialParams(), (p) => patches.push(p))
    const select = (await screen.findByLabelText('输出设备')) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))
    // 切到 dev-b：onPatch 立即写快照，setOutputDevice（真实实现，无 ctx → 仅持久化）
    fireEvent.change(select, { target: { value: 'dev-b' } })
    expect(patches).toEqual([{ sinkId: 'dev-b' }])
    await waitFor(() => expect(getSpatialParams().sinkId).toBe('dev-b')) // fusion 快照已写入
    // 父级 patch 落地后 rerender → 下拉回显新设备
    rerender(
      <SpatialSettingsModal
        open
        onClose={() => undefined}
        theme={theme}
        spatial={{ ...createDefaultSpatialParams(), sinkId: 'dev-b' }}
        onPatch={(p) => patches.push(p)}
      />,
    )
    expect(select.value).toBe('dev-b')
    // 切回系统默认 → sinkId 清除（恢复系统默认）
    fireEvent.change(select, { target: { value: 'default' } })
    expect(patches[1]).toEqual({ sinkId: undefined })
    await waitFor(() => expect(getSpatialParams().sinkId).toBeUndefined())
  })

  it('布局：状态栏「输出」只读展示（系统默认 / 已选设备）', () => {
    const common = {
      theme,
      onPatch: () => undefined,
      onHeadLockedLayout: () => undefined,
      selectedWorldId: null,
      onSelectWorld: () => undefined,
    }
    const { rerender } = render(
      <SpatialStudioLayout mode="instant" spatial={createDefaultSpatialParams()} {...common} />,
    )
    expect(screen.getByText('系统默认')).toBeTruthy()
    rerender(
      <SpatialStudioLayout mode="instant" spatial={{ ...createDefaultSpatialParams(), sinkId: 'dev-a' }} {...common} />,
    )
    expect(screen.getByText('已选设备')).toBeTruthy()
  })
})

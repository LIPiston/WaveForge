/**
 * WaveForge v3 调音室 UI —— 渲染冒烟测试（jsdom）
 *
 * 验证主面板可渲染、页签切换、效果弹窗开合、场景应用、分享串往返、
 * 听力测试流程状态机推进。不依赖真实 Web Audio（桥由 EngineV3 真实实例提供）。
 * 环境：文件头 @vitest-environment jsdom。
 */

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { EngineV3 } from '../src/engine/EngineV3'
import { createV3UiBridge } from './bridge'
import V3MixingStudio from './V3MixingStudio'
import { encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'

function makeUi() {
  const engine = new EngineV3(48000, 2)
  const bridge = createV3UiBridge(engine, 48000)
  const view = render(<V3MixingStudio bridge={bridge} playerTheme="dark" onClose={() => undefined} />)
  return { engine, bridge, view }
}

/** 点击页签 */
function clickTab(label: string) {
  fireEvent.click(screen.getAllByText(label)[0])
}

describe('V3 调音室 UI 冒烟', () => {
  beforeEach(() => cleanup())

  it('主面板渲染：标题 + 4 页签 + 默认音效场景页', () => {
    makeUi()
    expect(screen.getByText('调音室')).toBeTruthy()
    for (const label of ['音效场景', '均衡器', '调音器', '分析']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    // 默认页：场景方案 + 效果卡
    expect(screen.getByText('场景方案')).toBeTruthy()
    expect(screen.getByText('混响')).toBeTruthy()
    expect(screen.getByText('3D 环绕')).toBeTruthy()
    expect(screen.getByText('低音增强')).toBeTruthy()
    expect(screen.getByText('音量自适应补偿')).toBeTruthy()
  })

  it('效果卡点击打开配置弹窗，关闭按钮关闭', () => {
    makeUi()
    fireEvent.click(screen.getByText('混响'))
    expect(screen.getByText('启用 混响')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('关闭弹窗'))
    // 弹窗关闭后主面板仍在
    expect(screen.getByText('调音室')).toBeTruthy()
  })

  it('弹窗内修改参数经桥写入引擎（压缩器阈值）', () => {
    const { bridge } = makeUi()
    fireEvent.click(screen.getByText('动态压缩'))
    expect(screen.getByText('启用 动态压缩')).toBeTruthy()
    // 拖动阈值滑杆到 -30（fireEvent.change 模拟）
    const sliders = screen.getAllByRole('slider')
    expect(sliders.length).toBeGreaterThan(0)
    fireEvent.change(sliders[0], { target: { value: '-30' } })
    const p = bridge.getParams()
    expect(p.compressor.thresholdDb).toBe(-30)
  })

  it('场景应用：点「流行」→ sceneId=pop 且参数变化', () => {
    const { bridge } = makeUi()
    fireEvent.click(screen.getByText('流行'))
    expect(bridge.getParams().sceneId).toBe('pop')
    expect(bridge.getParams().eq.proBands[0].gain).not.toBe(0)
  })

  it('分享串：生成 → 解码往返一致（校验白名单）', () => {
    const { bridge } = makeUi()
    clickTab('调音器')
    fireEvent.click(screen.getByText('生成分享串'))
    const textarea = screen.getAllByRole('textbox').find((el) => (el as HTMLTextAreaElement).value.length > 20) as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    const decoded = decodeShareCode(textarea.value)
    expect(decoded.eq.enabled).toBe(bridge.getParams().eq.enabled)
    expect(decoded.limiter.thresholdDb).toBe(bridge.getParams().limiter.thresholdDb)
    // 篡改校验失败
    expect(() => decodeShareCode(textarea.value.slice(0, -2) + 'aa')).toThrow()
  })

  it('听力测试：开始 → 二分推进 5 轮后切频点 → 完成', () => {
    const { bridge } = makeUi()
    clickTab('分析')
    fireEvent.click(screen.getByText('开始测试'))
    // 7 频点 × 5 轮 = 35 次作答（全部"没听到"则阈值收敛到 -60.. 区间）
    for (let i = 0; i < 35; i++) {
      const heardBtn = screen.queryByText('听到了')
      if (!heardBtn) break
      fireEvent.click(screen.getByText('没听到'))
    }
    expect(screen.getByText(/测试完成/)).toBeTruthy()
    const audio = bridge.hearingStep()
    expect(audio.done).toBe(true)
    expect(audio.audiogram.length).toBe(7)
  })

  it('EQ 页签：10/20 段切换 + 曲线编辑器存在', () => {
    const { bridge } = makeUi()
    clickTab('均衡器')
    fireEvent.click(screen.getByText('20 段'))
    expect(bridge.getParams().eq.bandCount).toBe(20)
    expect(bridge.getParams().eq.proBands.length).toBe(20)
    // SVG 曲线编辑器
    expect(document.querySelector('svg')).toBeTruthy()
  })

  it('音量自适应补偿：auto 曲线读数随音量变化', () => {
    const { bridge } = makeUi()
    // 响度补偿/归一化两卡各有"配置"按钮，第一个是音量自适应补偿
    fireEvent.click(screen.getAllByText('配置')[0])
    expect(screen.getByText('启用 音量自适应补偿')).toBeTruthy()
    // 音量滑杆拖动到 20% → 低频提升 >0
    const sliders = screen.getAllByRole('slider')
    const volSlider = sliders.find((el) => (el as HTMLInputElement).min === '0' && (el as HTMLInputElement).max === '100')
    expect(volSlider).toBeTruthy()
    fireEvent.change(volSlider!, { target: { value: '20' } })
    const p = bridge.getParams()
    expect(p.loudnessCompensation.volumePercent).toBe(20)
    // 展示曲线读数：低频 +9.0dB（spl=56 → (80-56)*0.35=8.4 → 显示 +8.4）
    expect(screen.getByText(/\+8\.4dB/)).toBeTruthy()
  })

  it('编码一致性：encodeShareCode 与桥一致', () => {
    const { bridge } = makeUi()
    const p = bridge.getParams()
    expect(encodeShareCode(p)).toBe(bridge.encodeShare(p))
  })
});
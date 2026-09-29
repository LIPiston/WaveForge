import { describe, expect, it } from 'vitest'
import { modeLayerStyle, modeLayerSuspendedAttr } from '../src/utils/modeLayer'

describe('modeLayerStyle', () => {
  it('keeps the active mode layer visible on the normal layer', () => {
    const style = modeLayerStyle({ suspended: false })
    expect(style.visibility).toBe('visible')
    expect(style.zIndex).toBe(2)
  })

  it('hides a parked mode layer and drops it below the active layer', () => {
    const style = modeLayerStyle({ suspended: true })
    expect(style.visibility).toBe('hidden')
    expect(style.zIndex).toBe(1)
  })

  it('promotes an overlay layer above the other mode layers while staying visible', () => {
    const style = modeLayerStyle({ suspended: false, overlayAbove: true })
    expect(style.visibility).toBe('visible')
    expect(style.zIndex).toBe(4)
  })

  it('never leaves a parked layer painted, even when asked to overlay', () => {
    // 挂起优先于覆盖：suspended 与 overlayAbove 本应互斥，这里把「挂起必定隐藏」钉死，
    // 避免以后有人给新组合传值时不小心让挂起层继续遮挡当前模式。
    const style = modeLayerStyle({ suspended: true, overlayAbove: true })
    expect(style.visibility).toBe('hidden')
    expect(style.zIndex).toBe(1)
  })

  it('always pairs visibility with the layer height, never crossing the two', () => {
    const combos = [
      { suspended: false, overlayAbove: false },
      { suspended: true, overlayAbove: false },
      { suspended: false, overlayAbove: true },
      { suspended: true, overlayAbove: true },
    ]
    for (const combo of combos) {
      const style = modeLayerStyle(combo)
      const parked = style.zIndex === 1
      expect(style.visibility).toBe(parked ? 'hidden' : 'visible')
    }
  })

  it('marks parked layers for DOM inspection', () => {
    expect(modeLayerSuspendedAttr(true)).toBe('')
    expect(modeLayerSuspendedAttr(false)).toBeUndefined()
  })
})

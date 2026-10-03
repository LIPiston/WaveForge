/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// TV 判定决定「普通档」走 balanced 还是 full，测试里直接控制它
const isTvModeActive = vi.fn(() => false)
vi.mock('../src/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/platform')>()),
  isTvModeActive: () => isTvModeActive(),
}))

const {
  LUMIERE_FALLBACK_STYLE,
  buildWordSegments,
  resetLumiereSupportCache,
  resolveFoliaStyleFallback,
  resolveLumiereRenderQuality,
  resolveLumiereTuning,
  supportsLumiere,
} = await import('../src/components/foliaLumiereSupport')
const { DEFAULT_LUMIERE_TUNING } = await import('../src/vendor/folia/types')

beforeEach(() => {
  isTvModeActive.mockReturnValue(false)
  resetLumiereSupportCache()
})

describe('buildWordSegments', () => {
  it('逐字时间轴能精确重建整行时产出边界', () => {
    expect(buildWordSegments('Hello world', [{ word: 'Hello' }, { word: ' ' }, { word: 'world' }]))
      .toEqual(['Hello', ' ', 'world'])
  })

  it('词自带尾随空格时照样重建', () => {
    expect(buildWordSegments('Hello world', [{ word: 'Hello ' }, { word: 'world' }]))
      .toEqual(['Hello ', 'world'])
  })

  it('逐字时间轴不覆盖整行时返回 undefined（实测形态：text 有尾巴但 words 没有）', () => {
    // 上游对 wordSegments 有 join('')===fullText 的硬校验；这里刻意不补齐——
    // 补齐会得到「整行一个词」，反而让按词排版失效，不如交给 Intl.Segmenter
    expect(buildWordSegments('Main vocal', [{ word: 'Main' }])).toBeUndefined()
  })

  it('空输入与空词一律返回 undefined', () => {
    expect(buildWordSegments('', [{ word: 'a' }])).toBeUndefined()
    expect(buildWordSegments('abc', undefined)).toBeUndefined()
    expect(buildWordSegments('abc', [])).toBeUndefined()
    expect(buildWordSegments('abc', [{ word: '' }, { word: '' }])).toBeUndefined()
  })

  it('中文逐字同样成立', () => {
    expect(buildWordSegments('夜空中最亮的星', [{ word: '夜空中' }, { word: '最亮的星' }]))
      .toEqual(['夜空中', '最亮的星'])
  })
})

describe('resolveLumiereRenderQuality', () => {
  it('效率档给 low（低端设备跑 full 会掉帧到不可用）', () => {
    expect(resolveLumiereRenderQuality('efficiency')).toBe('low')
  })

  it('增强档给 full', () => {
    expect(resolveLumiereRenderQuality('enhanced')).toBe('full')
  })

  it('普通档在 PC 上是 full，在 TV 上降为 balanced', () => {
    expect(resolveLumiereRenderQuality('normal')).toBe('full')
    isTvModeActive.mockReturnValue(true)
    expect(resolveLumiereRenderQuality('normal')).toBe('balanced')
  })
})

describe('resolveLumiereTuning', () => {
  it('常规背景保留默认暗场', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: false,
      foliaBackgroundEnabled: true,
      renderQuality: 'full',
    })
    expect(tuning.darkField).toBe(DEFAULT_LUMIERE_TUNING.darkField)
  })

  it('MV 背景激活时让出背景：暗场归零，否则视频被近黑盖住', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: true,
      foliaBackgroundEnabled: true,
      renderQuality: 'full',
    })
    expect(tuning.darkField).toBe(0)
  })

  it('用户关闭 Folia 背景时同样让出背景', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: false,
      foliaBackgroundEnabled: false,
      renderQuality: 'full',
    })
    expect(tuning.darkField).toBe(0)
  })

  it('让出背景时用户设置不能把暗场调回不透明', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: true,
      foliaBackgroundEnabled: true,
      renderQuality: 'full',
      userTuning: { darkField: 0.9, lightIntensity: 1.8 },
    })
    expect(tuning.darkField).toBe(0)
    // 其余用户设置照常生效
    expect(tuning.lightIntensity).toBe(1.8)
  })

  it('不让出背景时尊重用户的暗场设置', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: false,
      foliaBackgroundEnabled: true,
      renderQuality: 'full',
      userTuning: { darkField: 0.4 },
    })
    expect(tuning.darkField).toBe(0.4)
  })

  it('自动推导的画质覆盖默认值', () => {
    const tuning = resolveLumiereTuning({
      mvBackgroundActive: false,
      foliaBackgroundEnabled: true,
      renderQuality: 'low',
    })
    expect(tuning.renderQuality).toBe('low')
  })
})

describe('resolveFoliaStyleFallback', () => {
  it('不支持 WebGL 时绘光回落到静止', () => {
    expect(resolveFoliaStyleFallback('lumiere', false)).toBe(LUMIERE_FALLBACK_STYLE)
    expect(LUMIERE_FALLBACK_STYLE).toBe('still')
  })

  it('支持 WebGL 时保持绘光', () => {
    expect(resolveFoliaStyleFallback('lumiere', true)).toBe('lumiere')
  })

  it('其余样式不受影响', () => {
    for (const style of ['classic', 'tempera', 'still', 'sonnet']) {
      expect(resolveFoliaStyleFallback(style, false)).toBe(style)
    }
  })
})

describe('supportsLumiere', () => {
  it('jsdom 无 WebGL2 时判定为不支持，且结果被缓存', () => {
    // jsdom 的 canvas.getContext('webgl2') 返回 null（未安装 node-canvas）
    expect(supportsLumiere()).toBe(false)
    expect(supportsLumiere()).toBe(false)
  })

  it('重置缓存后重新探测', () => {
    supportsLumiere()
    resetLumiereSupportCache()
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    supportsLumiere()
    expect(spy).toHaveBeenCalledWith('webgl2')
    spy.mockRestore()
  })
})

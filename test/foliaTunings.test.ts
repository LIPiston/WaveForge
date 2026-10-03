/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FOLIA_TUNINGS_KEY,
  buildFoliaTheme,
  hasFoliaTuningOverride,
  readFoliaTunings,
  resolvePanelTuning,
  writeFoliaTunings,
} from '../src/components/foliaTunings'

beforeEach(() => {
  localStorage.clear()
})

describe('readFoliaTunings 容错', () => {
  it('没存过返回空 bundle', () => {
    expect(readFoliaTunings()).toEqual({})
  })

  it('脏值一律返回空 bundle，不让一个坏值毁掉整个面板', () => {
    localStorage.setItem(FOLIA_TUNINGS_KEY, 'not json')
    expect(readFoliaTunings()).toEqual({})
    localStorage.setItem(FOLIA_TUNINGS_KEY, '[1,2,3]')
    expect(readFoliaTunings()).toEqual({})
    localStorage.setItem(FOLIA_TUNINGS_KEY, '"str"')
    expect(readFoliaTunings()).toEqual({})
  })

  it('丢弃 registry 不认识的模式键', () => {
    localStorage.setItem(FOLIA_TUNINGS_KEY, JSON.stringify({
      lumiere: { lightIntensity: 1.5 },
      'not-a-mode': { x: 1 },
    }))
    const bundle = readFoliaTunings()
    expect(bundle.lumiere).toEqual({ lightIntensity: 1.5 })
    expect((bundle as Record<string, unknown>)['not-a-mode']).toBeUndefined()
  })

  it('丢弃非对象的值，但保留同包内其它合法模式', () => {
    localStorage.setItem(FOLIA_TUNINGS_KEY, JSON.stringify({
      lumiere: 'oops',
      tempera: { textureResolution: 0.5 },
    }))
    const bundle = readFoliaTunings()
    expect(bundle.lumiere).toBeUndefined()
    expect(bundle.tempera).toEqual({ textureResolution: 0.5 })
  })

  it('写入后能读回', () => {
    writeFoliaTunings({ lumiere: { lightIntensity: 1.25 } } as never)
    expect(readFoliaTunings().lumiere).toEqual({ lightIntensity: 1.25 })
  })
})

describe('resolvePanelTuning', () => {
  it('无用户改动时给出该模式的默认基线', () => {
    const tuning = resolvePanelTuning({}, 'lumiere')
    expect(tuning.lightIntensity).toBe(1)
    expect(tuning.darkField).toBe(0.75)
    expect(tuning.renderQuality).toBe('full')
  })

  it('用户改动覆盖基线', () => {
    const tuning = resolvePanelTuning({ lumiere: { lightIntensity: 1.8 } } as never, 'lumiere')
    expect(tuning.lightIntensity).toBe(1.8)
    // 未改动的字段仍来自基线
    expect(tuning.darkField).toBe(0.75)
  })

  it('凝彩/商籁的 WaveForge 默认（纹理分辨率 1）在基线里', () => {
    expect(resolvePanelTuning({}, 'tempera').textureResolution).toBe(1)
    expect(resolvePanelTuning({}, 'sonnet').textureResolution).toBe(1)
  })

  it('面板值不含上下文推导：绘光在 MV 背景下的 darkField=0 不该出现在这里', () => {
    // 若这里返回 0，用户随手拖一下别的滑块就会把 0 写进用户设置，MV 关掉后暗场再也回不来
    expect(resolvePanelTuning({}, 'lumiere').darkField).toBe(0.75)
  })

  it('未知模式返回空对象而不是抛错', () => {
    expect(resolvePanelTuning({}, 'nope')).toEqual({})
  })
})

describe('hasFoliaTuningOverride', () => {
  it('有改动为 true，无改动为 false', () => {
    expect(hasFoliaTuningOverride({}, 'lumiere')).toBe(false)
    expect(hasFoliaTuningOverride({ lumiere: { lightIntensity: 2 } } as never, 'lumiere')).toBe(true)
  })
})

describe('buildFoliaTheme', () => {
  it('深色与浅色各自给出可读的主题色与背景', () => {
    const dark = buildFoliaTheme({ playerTheme: 'dark', accentColor: '#101010' })
    expect(dark.backgroundColor).toBe('#15171f')
    expect(dark.primaryColor).toBe('#f5f6fa')
    const light = buildFoliaTheme({ playerTheme: 'light', accentColor: '#fefefe' })
    expect(light.backgroundColor).toBe('#f4f4f7')
    expect(light.primaryColor).toBe('#1c1d22')
  })

  it('过暗的封面色在深色主题下被提亮（可读性校正）', () => {
    const theme = buildFoliaTheme({ playerTheme: 'dark', accentColor: '#0a0a0a' })
    expect(theme.accentColor).not.toBe('#0a0a0a')
  })

  it('词色三级都给出', () => {
    const theme = buildFoliaTheme({ playerTheme: 'dark', accentColor: '#3b82f6' })
    expect(theme.wordColors?.map(entry => entry.word)).toEqual(['accent', 'bright', 'warm'])
  })
})

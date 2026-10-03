import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * App.tsx 的歌词面板接线契约（源码级断言，沿用 test/modeIntegrationWiring.test.ts 的写法）。
 *
 * 为什么需要它：面板是两个页签共用同一块 JSX，靠三元切换数据源；菜单该列什么、
 * Folia 页签该不该出现 Folia 自身、参数面板是否注册表驱动，这些都只在 JSX 接线里，
 * 纯函数单测看不到。这里把它们钉住，避免以后重构时静默改回「两个页签都列 WaveForge 模式」。
 */
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

describe('歌词面板接线', () => {
  it('菜单数据源按页签切换：Folia 页签列 Folia 风格，否则列 WaveForge 模式', () => {
    expect(app).toContain('const lyricModeMenuEntries = lyricPanelPage === \'folia\'')
    // Folia 分支按 Folia 样式顺序展开，非 Folia 分支按模式顺序展开
    expect(app).toMatch(/lyricPanelPage === 'folia'\s*\?\s*orderedFoliaStyles\.map/)
    expect(app).toMatch(/:\s*orderedLyricModes\.map/)
  })

  it('Folia 页签下优先使用 Folia 自己的术语，不再叫「歌词模式」', () => {
    expect(app).toMatch(/'显示 \/ 隐藏歌词样式'/)
    expect(app).toMatch(/'显示 \/ 隐藏歌词模式'/)
  })

  it('预设条与菜单都按顺序表渲染，而不是硬编码数组顺序', () => {
    // WaveForge 页的横格来自 orderedLyricModeTiles（顺序表），不再是内联元组的直接 map
    expect(app).toContain('orderedLyricModeTiles.map(')
    expect(app).not.toMatch(/\{\(\[[\s\S]{0,40}\['modern', '现代'/)
    // 顺序由 mergeOrder 统一合并（新增项不会被过时顺序表弄丢）
    expect(app).toContain('mergeOrder(foliaStyleIds, foliaStyleOrder)')
    expect(app).toContain('mergeOrder(ALL_LYRIC_MODES, lyricModeOrder)')
  })

  it('Folia 预设条改用横向拖拽条，并保留第 9 个的露出', () => {
    expect(app).toContain('<HorizontalShelf')
    expect(app).toContain('ariaLabel="Folia 歌词样式"')
    // 8.3 分法 = 一屏 8 个 + 第 9 个露出一点
    expect(app).toMatch(/itemClassName="w-\[calc\(\(100%-3\.65rem\)\/8\.3\)\] shrink-0"/)
    // 副标题并入标题右侧，不再单独占一行
    expect(app).toMatch(/Folia 歌词<\/h2>[\s\S]{0,400}种歌词视觉 · 设计来源 Project Folia/)
  })

  it('绘光在非 WebGL 环境下被灰掉并回落，而不是点了抛错', () => {
    expect(app).toContain("style.id === 'lumiere' && !lumiereSupported")
    expect(app).toContain('需要 WebGL')
    expect(app).toContain('resolveFoliaStyleFallback(saved || \'classic\')')
    expect(app).toContain('const resolved = resolveFoliaStyleFallback(style)')
  })

  it('参数面板由注册表驱动，且与模式菜单互斥', () => {
    expect(app).toContain('getVisualizerRegistryEntry(foliaStyle as never)?.renderSettingsPanel')
    expect(app).toContain('<FoliaTuningPanel')
    // 打开一个要关掉另一个（两个弹层在同一位置，同时开必然重叠）
    expect(app).toMatch(/setShowLyricModeCustomize\(false\)\s*\n\s*setShowFoliaTuning\(\(value\) => !value\)/)
    expect(app).toContain('setShowFoliaTuning(false)')
  })

  it('调参持久化整包注入 FoliaLyricsPage', () => {
    expect(app).toContain('userTunings={userFoliaTunings}')
    expect(app).toContain('readFoliaTunings()')
    expect(app).toContain('writeFoliaTunings(bundle)')
  })

  it('排序入口同时提供拖拽把手与上/下移（拖拽够不到时仍有键盘路径）', () => {
    expect(app).toContain('onPointerDown={(event) => handleMenuGripPointerDown(event, entry.id)}')
    expect(app).toMatch(/aria-label=\{`\$\{entry\.label\} 上移`\}/)
    expect(app).toMatch(/aria-label=\{`\$\{entry\.label\} 下移`\}/)
  })
})

describe('FoliaLyricsPage 接线', () => {
  const page = readFileSync(new URL('../src/components/FoliaLyricsPage.tsx', import.meta.url), 'utf8')

  it('MV 背景 / 关背景都由 resolveLumiereTuning 折进绘光调参', () => {
    expect(page).toContain('resolveLumiereTuning({')
    expect(page).toContain('mvBackgroundActive: Boolean(mvBackgroundActive)')
    expect(page).toContain('renderQuality: resolveLumiereRenderQuality(perfMode)')
    // lumiere 必须排在 userTunings 之后，否则持久化值会把 MV 背景下的 darkField=0 覆盖掉
    const userSpread = page.indexOf('...userTunings,')
    const lumiereKey = page.indexOf('lumiere: resolveLumiereTuning({')
    expect(userSpread).toBeGreaterThan(-1)
    expect(lumiereKey).toBeGreaterThan(userSpread)
  })

  it('逐字时间轴喂给 wordSegments（仅当能精确重建整行）', () => {
    expect(page).toContain('wordSegments: buildWordSegments(line.text, line.words)')
  })

  it('面板与渲染共用同一份主题推导', () => {
    expect(page).toContain('buildFoliaTheme({ playerTheme, accentColor })')
  })
})

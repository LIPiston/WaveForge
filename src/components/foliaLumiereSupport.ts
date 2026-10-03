/**
 * WaveForge 侧对 Project Folia「绘光」(lumiere) 的适配与降级策略。
 *
 * 这里是纯函数集合，不做渲染：绘光的光场与辉光都是 GLSL，对上下文有两个我们独有的
 * 约束——①它自带一层近乎不透明的暗场，会盖掉我们的 MV 背景；②非 WebGL 环境下上游
 * 直接 throw。所以「用什么参数跑、能不能跑」这件事必须由我们这层决定，而不是照抄上游默认值。
 */
import { DEFAULT_LUMIERE_TUNING, type LumiereRenderQuality, type LumiereTuning } from '../vendor/folia/types'
import { isTvModeActive } from '../platform'
import type { PerfMode } from '../tv/perfMode'

/** 非 WebGL 环境下的回落目标：静止是纯 DOM 模式，零 GPU 依赖。 */
export const LUMIERE_FALLBACK_STYLE = 'still'

/**
 * 性能档 → 绘光画质。
 *
 * 上游默认 `full`（光场与辉光全分辨率、烟雾 6 个倍频）；它是给 PC 调的。我们是唯一有
 * TV 分档与软件渲染路径的一方，所以：
 * - 效率档：直接 `low`（图形层 0.5 缩放、烟雾 3 倍频、浮尘 ×0.6）——这一档本来就是
 *   为低端设备准备的，绘光在这类设备上跑 `full` 会掉帧到不可用。
 * - 普通档：TV 上给 `balanced`（4K 大屏面积是 PC 的数倍，全分辨率光场代价陡增）；
 *   PC 上保持 `full`，与上游一致。
 * - 增强档：`full`。
 */
export function resolveLumiereRenderQuality(mode: PerfMode): LumiereRenderQuality {
  if (mode === 'efficiency') return 'low'
  if (mode === 'enhanced') return 'full'
  return isTvModeActive() ? 'balanced' : 'full'
}

/** 探测 WebGL2 是否可用。结果缓存：探测要建一个临时 canvas，不该每次切样式都做。 */
let lumiereSupportCache: boolean | null = null

export function supportsLumiere(): boolean {
  if (lumiereSupportCache !== null) return lumiereSupportCache
  try {
    const canvas = document.createElement('canvas')
    // Pixi 8 在 WebGL 之外还会尝试 WebGPU；但上游 runtime 明确要求 RendererType.WEBGL，
    // 所以这里只认 webgl2，探测口径与 createLumierePixiRuntime 的检查保持一致。
    lumiereSupportCache = Boolean(canvas.getContext('webgl2'))
  } catch {
    lumiereSupportCache = false
  }
  return lumiereSupportCache
}

/** 测试/降级路径用：重置探测缓存（GPU 被禁用/恢复后允许重新判定）。 */
export function resetLumiereSupportCache(): void {
  lumiereSupportCache = null
}

/**
 * 持久化的样式在当前环境下是否还可用。不可用时回落到静止（纯 DOM，任何环境都能跑），
 * 避免开机直接抛 "Lumiere requires WebGL" 把整个歌词页打空。
 */
export function resolveFoliaStyleFallback(style: string, lumiereSupported: boolean = supportsLumiere()): string {
  if (style === 'lumiere' && !lumiereSupported) return LUMIERE_FALLBACK_STYLE
  return style
}

export interface FoliaLumiereContext {
  /** MV 背景激活：绘光必须让出背景，否则视频被暗场盖掉 */
  mvBackgroundActive: boolean
  /** 用户关闭「使用 Folia 背景」：同上，露出 WaveForge 封面背景 */
  foliaBackgroundEnabled: boolean
  renderQuality: LumiereRenderQuality
  /** 用户在参数面板里的显式设置，优先于上面的自动推导 */
  userTuning?: Partial<LumiereTuning>
}

/**
 * 把运行上下文折进绘光参数。
 *
 * 关键一条：`darkField`（默认 0.75，浅色主题还保底 0.94）是绘光压暗共享背景用的暗场。
 * 我们的 MV 背景走的是 `background: { transparent: true }`（见 FoliaLyricsPage 的背景推导），
 * 两者语义直接冲突——视频会被那层近黑盖住，"MV 背景 + 绘光"等于白开。
 * 上游对该字段的定义就是「0 = 共享背景原样透出」，所以让出背景时置 0，光束仍然叠加在
 * 视频上（这正是绘光该有的观感），不需要改上游代码。
 */
export function resolveLumiereTuning(context: FoliaLumiereContext): LumiereTuning {
  const { mvBackgroundActive, foliaBackgroundEnabled, renderQuality, userTuning } = context
  const yieldBackground = mvBackgroundActive || !foliaBackgroundEnabled
  const tuning: LumiereTuning = {
    ...DEFAULT_LUMIERE_TUNING,
    ...userTuning,
    renderQuality,
  }
  // 最后写：让出背景时必须压到 0，不能被 userTuning 里的 darkField 覆盖回不透明。
  if (yieldBackground) tuning.darkField = 0
  return tuning
}

/**
 * 提供方的逐字时间轴 → 绘光的 `Line.wordSegments`（按词排版用）。
 *
 * 上游在 `wordSegmentation.segmentLyricWords` 里对这份数据有硬校验：`join('') === fullText`，
 * 不满足就当它过期、退回 `Intl.Segmenter`。
 *
 * 我们的歌词数据里 `words` **不一定覆盖整行**（实测 `text: 'Main vocal'` 只带
 * `words: ['Main']`——逐字时间轴通常只覆盖真正唱出来的部分）。所以这里刻意**不做补齐**：
 * 把尾巴并进最后一个词会得到「整行只有一个词」的分段，反而让绘光的按词排版失效
 * （虚词缩小、最长实词强调都无从触发），比交给 Intl.Segmenter 更差。
 * 只在能精确重建整行时才产出，否则返回 undefined 让它走默认分词。
 */
export function buildWordSegments(
  fullText: string,
  words: { word: string }[] | undefined,
): string[] | undefined {
  if (!fullText || !words?.length) return undefined
  const boundaries = words
    .map(word => (typeof word?.word === 'string' ? word.word : ''))
    .filter(Boolean)
  if (!boundaries.length) return undefined
  return boundaries.join('') === fullText ? boundaries : undefined
}

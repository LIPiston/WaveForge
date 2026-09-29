/**
 * AutoMix 引擎与 AutoMix Enhanced 三档的共享元数据。
 *
 * 三档与 automix-lab 的同名方案一一对应（演示产物由该实验台生成）：
 *  - lite     = 自主优化版（本地进阶方案）：wsola_sync 多声道同步拉伸 + 低音交换/扫频，纯本地、零云端
 *  - advanced = 云端智能混音（基础渐变）：云端下发切点与衔接计划，本地渲染
 *  - extreme  = 云端智能混音（进阶交融）：更强效果链 + 专属切点，过渡更长
 *
 * 三档共同点：都走同一套"源曲尾部 → 过渡段 → 目标曲开头"的交接结构；
 * 差异在切点选择（云端/本地）、过渡时长与效果链强度。
 */

export type AutoMixEngineKey = 'standard' | 'pro' | 'enhanced'
export type AutoMixTierKey = 'lite' | 'advanced' | 'extreme'

export interface AutoMixTierDemo {
  /** public/automix-demo 下的演示片段 */
  file: string
  /** 片段总时长（秒） */
  duration: number
  /** 源曲段结束（= 过渡开始）在片段内的位置（秒） */
  sourceEnd: number
  /** 过渡段结束（= 目标曲开始）在片段内的位置（秒） */
  transitionEnd: number
}

export interface AutoMixTierMeta {
  key: AutoMixTierKey
  label: string
  /** 卡片标题 */
  title: string
  /** 一句话定位 */
  tagline: string
  /** 手法要点 */
  techniques: string
  /** 云端档是否需要平台登录 */
  requiresCloudLogin: boolean
  /** 该方案在原曲上的切点（秒）与过渡时长（秒） */
  cutSeconds: number
  transitionSeconds: number
  demo: AutoMixTierDemo
}

/** 三档对比演示使用的曲目对（automix-lab 真实产物） */
export const AUTOMIX_DEMO_PAIR = {
  sourceName: 'Thank you for dears.',
  sourceArtist: 'GET IN THE RING',
  targetName: 'Put It All on Me (feat. Ella Mai)',
  targetArtist: 'Ed Sheeran / Ella Mai',
  sourceBpm: 103.4,
  targetBpm: 101.0,
}

/** 演示片段目录：相对路径 —— 开发态（vite 根）与生产态（file:// dist/index.html）都能解析 */
const DEMO_DIR = './automix-demo'

export const AUTOMIX_TIERS: AutoMixTierMeta[] = [
  {
    key: 'lite',
    label: 'Lite',
    title: '自主优化版（本地进阶方案）',
    tagline: '纯本地渲染 · 无需登录',
    techniques: '多声道同步拉伸 + 低音交换 + 连续扫频，过渡悠长、自然',
    requiresCloudLogin: false,
    cutSeconds: 314.29,
    transitionSeconds: 12.0,
    demo: { file: `${DEMO_DIR}/lite.mp3`, duration: 28.0, sourceEnd: 8.0, transitionEnd: 20.0 },
  },
  {
    key: 'advanced',
    label: 'Advanced',
    title: '云端智能混音（基础渐变）',
    tagline: '云端智能切点 · 本地渲染',
    techniques: '云端挑选最佳切点，滤波与 EQ 平滑渐变衔接，短小、干净',
    requiresCloudLogin: true,
    cutSeconds: 292.0,
    transitionSeconds: 4.92,
    demo: { file: `${DEMO_DIR}/advanced.mp3`, duration: 20.92, sourceEnd: 8.0, transitionEnd: 12.92 },
  },
  {
    key: 'extreme',
    label: 'Extreme',
    title: '云端智能混音（进阶交融）',
    tagline: '更强效果链 · 过渡更充分',
    techniques: '增益渐变 + 双向滤波扫频 + 低频 EQ 阶梯全面交融，衔接最长、最尽兴',
    requiresCloudLogin: true,
    cutSeconds: 275.65,
    transitionSeconds: 14.64,
    demo: { file: `${DEMO_DIR}/extreme.mp3`, duration: 30.64, sourceEnd: 8.0, transitionEnd: 22.64 },
  },
]

export function getAutoMixTier(key: AutoMixTierKey): AutoMixTierMeta {
  return AUTOMIX_TIERS.find(tier => tier.key === key) ?? AUTOMIX_TIERS[0]
}

/** 档位的中文序号（用于弹窗里的三档并列展示） */
export const AUTOMIX_TIER_ORDER: AutoMixTierKey[] = ['lite', 'advanced', 'extreme']

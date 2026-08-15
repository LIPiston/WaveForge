/**
 * 原应用 逆向数据常量（源：MainActivity.java / x/fp.java / x/al.java）
 *
 * 本文件是音频引擎 v3 的"逆向数据底座"：20 段均衡频点、5 套预设曲线、
 * 5 套设备档案、默认 PEQ 曲线、对数频率轴与量化函数，全部来自对
 * 原应用.APK 的 jadx 反编译结果，字段名保留原始含义注释。
 */

// ============ 20 段均衡器（MainActivity.E8，Hz） ============
// 47, 141, 234, 328, 469, 656, 844, 1031, 1313, 1688,
// 2250, 3000, 3750, 4688, 5813, 7125, 9000, 11250, 13875, 19688
// 由两组 10 段交错构成：fp.b（奇数位）与 fp.c（偶数位）
export const EQ_BANDS_20 = [
  47, 141, 234, 328, 469, 656, 844, 1031, 1313, 1688,
  2250, 3000, 3750, 4688, 5813, 7125, 9000, 11250, 13875, 19688,
] as const

/** fp.b：10 段奇数位频点（预设曲线应用到的频点） */
export const EQ_BANDS_10_ODD = [47, 234, 469, 844, 1313, 2250, 3750, 5813, 9000, 13875] as const
/** fp.c：10 段偶数位频点 */
export const EQ_BANDS_10_EVEN = [141, 328, 656, 1031, 1688, 3000, 4688, 7125, 11250, 19688] as const

// ============ 预设曲线（MainActivity.F8 / G8） ============
// 5 套预设名称与 10 段增益（dB，作用于 EQ_BANDS_10_ODD 频点）
export const EQ_PRESET_NAMES = ['自定义曲线', '平直', '低频增强', '人声清晰', '通透氛围'] as const

/** G8：每套预设 10 个增益值（dB） */
export const EQ_PRESET_CURVES: number[][] = [
  [1.0, 1.0, 0.5, 0.0, -0.5, 0.0, 0.5, 1.0, 1.5, 1.5], // 自定义曲线（默认起步）
  [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // 平直
  [4.0, 3.5, 3.0, 2.0, 1.0, 0.0, -0.5, -1.0, -1.0, -0.5], // 低频增强
  [-1.0, -1.0, -0.5, 0.0, 1.0, 2.0, 2.5, 1.5, 0.5, -0.5], // 人声清晰
  [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.0], // 通透氛围
]

// ============ 默认 PEQ 曲线（MainActivity.a5，fp.j 解析） ============
// "90:0.00:0.80;1000:0.00:1.00;9500:0.00:0.80" —— 三段 0dB 起点曲线（90Hz / 1kHz / 9.5kHz）
export const DEFAULT_PEQ_CURVE_STRING = '90:0.00:0.80;1000:0.00:1.00;9500:0.00:0.80'

// ============ 设备档案（MainActivity.H8，x.al 模型） ============
// al 字段：a=名称 b=描述 c..l=10 个调音参数 m=4 个频点 n=调音引导文案
// 10 参数语义（依据听感分析流程推断，见 MERGE_GUIDE.md §5）：
//   c=低频增益基准(dB) d=中低频增益(e) e=低频增强上限(dB) f=高频衰减基准(dB)
//   g=低频 shelf 频点(Hz) h=中低频频点(Hz) i=中高频频点(Hz) j=高频频点(Hz)
//   k=低频动态系数 l=高频动态系数；m=4 个频响控制频点(Hz)
export interface DeviceProfile {
  id: string
  name: string
  description: string
  params: [number, number, number, number, number, number, number, number, number, number]
  curveFreqs: number[] // 4 个频点（Hz）
  guidance: string // 调校过程中的中文引导文案
}

export const DEVICE_PROFILES: DeviceProfile[] = [
  {
    id: 'device-speaker',
    name: '设备外放',
    description: '针对手机、Pad的内置扬声器外放。',
    params: [1.4, 1.0, 8.5, -6.0, 72.0, 230.0, 1450.0, 7200.0, 0.85, 1.05],
    curveFreqs: [58, 72, 90, 110],
    guidance: '现在鼓点底部够不够沉、够不够往下走？手机外放会先试更低的下盘，如果开始糊或破，就要收回来。',
  },
  {
    id: 'device-over-ear',
    name: '耳机（头戴）',
    description: '针对普通头戴式耳机。',
    params: [0.8, 0.8, 5.5, -5.5, 72.0, 210.0, 1800.0, 7600.0, 0.75, 1.0],
    curveFreqs: [72, 52, 96, 125],
    guidance: '现在鼓点和贝斯够不够扎实？头戴耳机通常不需要推太多，重点是厚而不闷。',
  },
  {
    id: 'device-in-ear',
    name: '耳机（入耳）',
    description: '针对各类入耳式耳机。',
    params: [0.65, 0.75, 4.5, -5.5, 78.0, 185.0, 2100.0, 6800.0, 0.82, 1.15],
    curveFreqs: [78, 58, 105, 140],
    guidance: '现在鼓点是否足够有弹性？入耳耳机变化会很明显，我们会小步调整，避免轰头。',
  },
  {
    id: 'device-desktop',
    name: '桌面音箱',
    description: '针对于放置在桌面上的音箱，或蓝牙音箱。',
    params: [0.95, 0.85, 6.0, -5.5, 58.0, 240.0, 1550.0, 8200.0, 0.7, 0.95],
    curveFreqs: [58, 45, 82, 110],
    guidance: '现在鼓点和贝斯的支撑够不够？桌面音箱可以更自然地展开，但不要让箱体嗡起来。',
  },
  {
    id: 'device-stage-amp',
    name: '舞台级功放',
    description: '针对于舞台级别的功放机与现场，如露天或报告厅。',
    params: [0.45, 0.7, 3.5, -6.5, 48.0, 190.0, 1350.0, 6500.0, 0.65, 0.9],
    curveFreqs: [48, 38, 70, 95],
    guidance: '现在鼓点是否已经有足够的力量？舞台级设备余量大，我们主要做细调，避免推过头。',
  },
]

// ============ 对数频率轴（fp.d / MainActivity.w3） ============
/** 31 点对数轴：20Hz-20kHz，i/30（fp.d 原样移植） */
export function logAxis31(): number[] {
  const out: number[] = []
  const lo = Math.log(20)
  const hi = Math.log(20000)
  for (let i = 0; i < 31; i++) out.push(Math.round(Math.exp(lo + (hi - lo) * (i / 30))))
  return out
}

/** 128 点对数轴：20Hz-20kHz，i/127（MainActivity.w3 原样移植，设备库曲线同轴） */
export function logAxis128(): number[] {
  const out: number[] = []
  const lo = Math.log10(20)
  const hi = Math.log10(20000)
  for (let i = 0; i < 128; i++) out.push(Math.pow(10, lo + (hi - lo) * (i / 127)))
  return out
}

// ============ 量化函数（fp.v / fp.u / fp.s） ============
/** 增益量化：0.5dB 步进，钳制 ±15dB（fp.v 原样移植） */
export function quantizeGain(gain: number): number {
  const clamped = Math.max(-15, Math.min(15, gain))
  return Math.round((clamped + 15) / 0.5) * 0.5 - 15
}

/** Q 量化：0.05 步进，钳制 0.2-12（fp.u 原样移植） */
export function quantizeQ(q: number): number {
  return Math.round((Math.max(0.2, Math.min(12, q)) - 0.2) / 0.05) * 0.05 + 0.2
}

/** 频点量化：取整到 1Hz，钳制 20-20000（fp.s 原样移植） */
export function quantizeFreq(freq: number): number {
  return Math.round(Math.max(20, Math.min(20000, freq)))
}

// ============ 音频格式白名单（MainActivity.C8） ============
export const SUPPORTED_AUDIO_FORMATS = ['.mp3', '.flac', '.wav', '.ogg', '.m4a'] as const

// ============ 听力分析目录（MainActivity.B8） ============
export const HEARING_ANALYSIS_DIRS = ['hearing_analysis', 'analysis', ''] as const

// ============ 设备路由（x/sv.h） ============
/** 播放路由：STANDARD / DAP（数字音频处理） */
export type AudioRoute = 'standard' | 'dap'
export const ROUTE_NAMES = ['speaker', 'bluetooth', 'wired'] as const

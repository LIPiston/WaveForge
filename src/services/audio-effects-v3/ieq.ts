/**
 * 智能均衡 IEQ（频响设置）（源：x/bb.java 移植）
 *
 * 原应用文案："根据目标风格调整整体频响，可与 Pre 一起试听。此功能仅在空间增强方案下生效。"
 * "点击应用后将写入自定义 IEQ 目标并立即用于当前空间增强。"、"载入当前风格"。
 *
 * 逆向语义（x/bb.java 字段）：
 *   - i   = 20 段均衡频点（与 EQ_BANDS_20 相同）
 *   - j   = 3 套内置风格目标曲线：20 段增益（原值 ×100 存储，÷100 得 dB）
 *   - g   = 风格下标 0-2（内置）/ 3（自定义曲线 h）；b() 按 g 返回目标
 *   - h   = 自定义目标曲线（20 段增益，初始复制风格 0）
 *   - a/c/e = 三个子功能开关；b/d/f = 对应强度 0-10（默认 6/2/6）
 *
 * v3 实现：风格目标曲线按低/中/高三段乘以强度系数（b=低频、d=中频、f=高频），
 * 输出 20 段目标增益；支持自定义曲线与"载入当前风格"（把任意 20 段增益写入 h）。
 */

import { EQ_BANDS_20, quantizeGain } from './constants'

/** 内置 IEQ 风格目标曲线（3 套 × 20 段增益 dB，原值 ÷100） */
export const IEQ_STYLE_CURVES: number[][] = [
  // j[0]：风格 0（默认）
  [1.57, 1.67, 2.18, 2.18, 2.03, 1.88, 1.92, 1.92, 2.05, 2.13,
   2.18, 2.09, 1.93, 1.59, 1.34, 0.97, 0.71, 0.22, -0.90, -2.83],
  // j[1]：风格 1
  [1.50, 1.42, 1.88, 2.16, 1.89, 1.95, 2.02, 1.99, 2.10, 2.25,
   2.30, 2.36, 2.35, 2.35, 2.14, 1.65, 1.12, 0.49, -0.24, -2.17],
  // j[2]：风格 2
  [1.14, 1.46, 1.83, 1.69, 1.70, 1.28, 1.03, 0.90, 0.98, 1.26,
   1.27, 1.40, 0.96, 0.85, 0.80, 0.66, 0.38, -0.32, -1.32, -2.75],
]

export const IEQ_STYLE_NAMES = ['风格 1（默认）', '风格 2', '风格 3'] as const

/** IEQ 状态（x/bb.java 字段语义移植） */
export interface IeqState {
  /** 总开关（对应 bb.a） */
  enabled: boolean
  /** 风格下标：0-2 内置 / 3 自定义（对应 bb.g） */
  style: number
  /** 低频强度 0-10（对应 bb.b，默认 6） */
  bassAmount: number
  /** 中频强度 0-10（对应 bb.d，默认 2） */
  presenceAmount: number
  /** 高频强度 0-10（对应 bb.f，默认 6） */
  trebleAmount: number
  /** 自定义目标曲线（20 段增益，null = 未设置，回退风格 0）（对应 bb.h） */
  customCurve: number[] | null
}

export function defaultIeqState(): IeqState {
  return {
    enabled: false,
    style: 0,
    bassAmount: 6,
    presenceAmount: 2,
    trebleAmount: 6,
    customCurve: null,
  }
}

/** 按 g 取目标曲线：0-2 内置 / 3 自定义（bb.b() 原样语义） */
export function ieqTargetCurve(state: IeqState): number[] {
  if (state.style === 3) return state.customCurve ? [...state.customCurve] : [...IEQ_STYLE_CURVES[0]!]
  const idx = Math.max(0, Math.min(2, state.style))
  return [...IEQ_STYLE_CURVES[idx]!]
}

/** 三段（低/中/高）强度系数：b 作用于前 7 段、d 作用于中 6 段、f 作用于后 7 段 */
export function ieqAmountScaling(state: IeqState): number[] {
  const low = state.bassAmount / 10
  const mid = state.presenceAmount / 10
  const high = state.trebleAmount / 10
  return EQ_BANDS_20.map((_, i) => (i < 7 ? low : i < 13 ? mid : high))
}

/** 应用 IEQ：目标曲线 × 三段强度，输出 20 段增益（逐段量化 0.5dB） */
export function applyIeq(state: IeqState): number[] {
  const target = ieqTargetCurve(state)
  const scaling = ieqAmountScaling(state)
  return target.map((g, i) => quantizeGain(g * scaling[i]!))
}

/** 载入当前风格：把现有 20 段增益写入自定义曲线并切到自定义（g=3） */
export function loadCustomIeq(curve: number[]): IeqState {
  return {
    enabled: true,
    style: 3,
    bassAmount: 6,
    presenceAmount: 2,
    trebleAmount: 6,
    customCurve: curve.map(g => quantizeGain(g)),
  }
}

/** 序列化（bb.c 的 int[] 数组语义：enabled,bass,presenceEnabled,presence,trebleEnabled,treble,style） */
export function serializeIeq(state: IeqState): number[] {
  return [
    state.enabled ? 1 : 0,
    state.bassAmount,
    state.enabled ? 1 : 0,
    state.presenceAmount,
    state.enabled ? 1 : 0,
    state.trebleAmount,
    state.style,
  ]
}

/** 反序列化 int[] → IeqState */
export function parseIeq(arr: number[] | null | undefined): IeqState {
  const base = defaultIeqState()
  if (!arr || arr.length === 0) return base
  return {
    ...base,
    enabled: arr[0] !== 0,
    bassAmount: Math.round(Math.max(0, Math.min(10, arr[1] ?? 6))),
    presenceAmount: Math.round(Math.max(0, Math.min(10, arr[3] ?? 2))),
    trebleAmount: Math.round(Math.max(0, Math.min(10, arr[5] ?? 6))),
    style: Math.max(0, Math.min(3, arr[6] ?? 0)),
  }
}

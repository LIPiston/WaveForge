/**
 * 听力分析（听感分析）引导调校流程（源：MainActivity.y3() + H8 设备档案）
 *
 * 原应用 流程（y3 方法原样语义）：
 *   1. "选择这次要调校的播放设备" —— 从 H8 五套设备档案中选择起点
 *   2. "随后会循环播放示例音乐，并根据你的反馈实时调整基础曲线"
 *      —— 循环播放示例音频，按引导文案（档案 guidance）提问用户反馈
 *   3. 用户回答"够/不够"等 → 按档案参数（10 floats）实时调整基础曲线
 *   4. 分析结束生成最终曲线，写入均衡器（对应"智能均衡"/"均衡器预设"入口）
 *
 * 本模块：流程状态机 + 调整规则（参数由档案 params 驱动，规则为
 * 逆向推断，见 MERGE_GUIDE.md §5 的说明）。
 */

import type { DeviceProfile } from './constants'
import { DEVICE_PROFILES } from './constants'
import { defaultCurve, setBand, sortCurve, type EqPoint } from './curve'

export type HearingFeedback = 'more' | 'less' | 'ok' | 'muddy' | 'harsh'

export interface HearingAnalysisState {
  phase: 'idle' | 'select-device' | 'playing' | 'adjusting' | 'done'
  deviceProfileId: string | null
  /** 当前提问序号（对应档案 guidance 引导的步骤） */
  step: number
  /** 分析中的基础曲线 */
  curve: EqPoint[]
  /** 已记录的反馈历史 */
  feedbackLog: Array<{ step: number; feedback: HearingFeedback; gainDelta: number }>
}

export function initialAnalysisState(): HearingAnalysisState {
  return {
    phase: 'idle',
    deviceProfileId: null,
    step: 0,
    curve: defaultCurve(),
    feedbackLog: [],
  }
}

export function getDeviceProfile(id: string | null): DeviceProfile | null {
  return DEVICE_PROFILES.find(p => p.id === id) ?? null
}

/**
 * 开始分析：选择设备档案 → 以档案参数初始化基础曲线。
 * 档案 params 前 4 项作为 4 个控制频点的初始增益（推断映射）：
 *   [低频增益基准, 中低频增益, 低频增强上限, 高频衰减基准] 对应曲线 4 控制点
 */
export function startAnalysis(state: HearingAnalysisState, deviceProfileId: string): HearingAnalysisState {
  const profile = getDeviceProfile(deviceProfileId)
  if (!profile) return { ...state, phase: 'idle', deviceProfileId: null }
  // 用档案 4 个频点 + 前 4 个参数构造起点曲线（Q 取 0.8/1.1/1.0/0.9 与 fp.i 一致）
  const curve: EqPoint[] = profile.curveFreqs.map((freq, i) => ({
    freq,
    gain: Math.max(-15, Math.min(15, profile.params[i]!)),
    q: [0.8, 1.1, 1.0, 0.9][i]!,
  }))
  return {
    ...state,
    phase: 'playing',
    deviceProfileId,
    step: 0,
    curve: sortCurve(curve),
    feedbackLog: [],
  }
}

/** 当前引导文案（按档案 guidance + 步骤后缀） */
export function currentGuidance(state: HearingAnalysisState): string {
  const profile = getDeviceProfile(state.deviceProfileId)
  if (!profile) return ''
  if (state.phase === 'select-device') return '选择这次要调校的播放设备。随后会循环播放示例音乐，并根据你的反馈实时调整基础曲线。'
  if (state.phase === 'done') return '听感分析完成，曲线已应用到均衡器。'
  return profile.guidance
}

/**
 * 应用反馈调整曲线（规则推断自档案参数，量化与 fp 一致）：
 *   - more：提升当前频段（步进 = params[k]/4，k=低频系数）
 *   - less：降低当前频段（步进 = params[l]/4，l=高频系数）
 *   - muddy（糊）：降低中低频
 *   - harsh（刺）：降低高频
 *   - ok：推进到下一频段
 */
export function applyFeedback(state: HearingAnalysisState, feedback: HearingFeedback): HearingAnalysisState {
  if (state.phase !== 'playing' && state.phase !== 'adjusting') return state
  const profile = getDeviceProfile(state.deviceProfileId)
  if (!profile) return state
  const curve = [...state.curve]
  const [lowCoef, midCoef, , , , , , , lowStep, highStep] = profile.params
  const stepSize = feedback === 'more' || feedback === 'less'
    ? Math.max(0.5, (feedback === 'more' ? lowCoef : highStep) * 0.5)
    : Math.max(0.5, (feedback === 'muddy' ? midCoef : highStep) * 0.5)
  const dir = feedback === 'more' ? 1 : feedback === 'less' ? -1 : feedback === 'muddy' ? -0.75 : feedback === 'harsh' ? -0.75 : 0

  const bandIndex = Math.min(state.step, curve.length - 1)
  const delta = dir === 0 ? 0 : stepSize * dir
  let next: EqPoint[] = curve
  if (delta !== 0) {
    const target = bandIndex === curve.length - 1
      ? (feedback === 'muddy' || feedback === 'harsh' ? bandIndex - 1 : bandIndex)
      : bandIndex
    if (target >= 0) {
      const current = curve[target]!
      next = setBand(curve, target, { gain: current.gain + delta })
    }
  }

  const done = state.step + 1 >= curve.length && feedback === 'ok'
  return {
    ...state,
    curve: sortCurve(next),
    step: done ? state.step : state.step + 1,
    phase: done ? 'done' : 'adjusting',
    feedbackLog: [...state.feedbackLog, { step: state.step, feedback, gainDelta: delta }],
  }
}

/** 完成分析：返回最终曲线并复位状态 */
export function finishAnalysis(state: HearingAnalysisState): { curve: EqPoint[]; state: HearingAnalysisState } {
  return {
    curve: sortCurve(state.curve),
    state: { ...state, phase: 'done' },
  }
}

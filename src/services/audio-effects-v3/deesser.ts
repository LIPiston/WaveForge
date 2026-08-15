/**
 * 齿音抑制（源：原应用"齿音抑制"，与 64 阶 IIR / 卷积并列的高级处理项）
 *
 * 原理：齿音（s/s/sh/t 的 5-8kHz 高频爆破音）能量集中且瞬态强。
 * 实现（Web Audio 动态 de-esser）：
 *   - bandpass 侧链（6.5kHz）检测齿音能量
 *   - 齿音强时动态压低 6.5kHz peaking 增益（dB），弱时恢复
 * 与静态 EQ 削高频不同，动态方式只压齿音、不牺牲整体亮度。
 */

/** 齿音检测频点（Hz） */
export const DEESSER_DETECT_FREQ = 6500

/** 齿音抑制增益曲线：amount(0-10) → 最大衰减 dB */
export function deesserMaxCut(amount: number): number {
  return Math.max(-12, Math.min(0, -(2 + amount * 1.0)))
}

/** 阈值推导：amount 越大阈值越低（越敏感） */
export function deesserThreshold(amount: number): number {
  return Math.max(-45, Math.min(-25, -45 + amount * 2))
}

/** 动态增益平滑（秒）：瞬态响应快、恢复慢（经典 de-esser 时序） */
export const DEESSER_ATTACK = 0.005
export const DEESSER_RELEASE = 0.15

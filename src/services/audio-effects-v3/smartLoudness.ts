/**
 * 智能响度（源：原应用 前台服务描述 "smart loudness" + 响度归一化思想）
 *
 * 原应用 的 AudioControlForegroundService 声明为 "Maintains user-enabled
 * 原应用audio effect processing and smart loudness"——智能响度 = 按内容
 * 动态调整增益：响度归一化（对齐目标 LUFS）+ 峰值限幅保护，避免不同曲目
 * 音量跳变。独立实现为引擎内自包含模块（不依赖任何外部服务），
 * 目标响度取行业标准值 -14 LUFS。
 */

/** 目标响度（LUFS，行业标准参考值，独立选取） */
export const SMART_LOUDNESS_TARGET = -14

/** 增益平滑时间常数（秒）——切歌/响度测量完成时避免跳变 */
export const SMART_LOUDNESS_TAU = 0.25

/** 增益钳制范围（dB）：过大的补偿会引入噪声与削波 */
export const SMART_LOUDNESS_MIN_DB = -9
export const SMART_LOUDNESS_MAX_DB = 9

/** 由测量响度计算目标增益（dB） */
export function loudnessGain(measuredLufs: number, targetLufs = SMART_LOUDNESS_TARGET): number {
  const g = targetLufs - measuredLufs
  return Math.max(SMART_LOUDNESS_MIN_DB, Math.min(SMART_LOUDNESS_MAX_DB, g))
}

/** 输出保护限幅器参数（引擎输出端，防削波） */
export const LIMITER_CONFIG = {
  threshold: -6,
  knee: 12,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
} as const

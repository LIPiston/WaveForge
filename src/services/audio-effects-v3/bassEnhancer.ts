/**
 * 低频增强 + 虚拟低频（源：原应用"低频增强" / "虚拟低频" 功能）
 *
 * 低频增强：lowshelf 提升低频量感与厚度（原应用 文案："增强低频量感与厚度。
 * 此功能仅在空间增强方案下生效"），深度可调。
 *
 * 虚拟低频：真实扬声器（尤其是小体积设备）无法重放 50Hz 以下的次低频，
 * 虚拟低频利用"基频缺失时大脑由高次谐波补全基频"的心理声学原理——
 * 通过非线性整形（WaveShaper）产生 2 次/3 次谐波，再与低通干声混合，
 * 让听感"听到"原本放不出来的低频。
 */

/**
 * 虚拟低频 WaveShaper 曲线：对低频信号做非对称饱和整形产生谐波。
 * 输入归一化到 [-1, 1]；k 为强度（1=轻微，10=强烈）。
 * harmonics：谐波次数（2=仅二次，3=二三次混合，4=加四次），基频缺失时
 * 高次谐波越多低频"存在感"越强；blend：谐波混合比例 0-1。
 */
export function buildVirtualBassShaperCurve(
  k: number,
  harmonics = 3,
  blend = 0.6,
): Float32Array<ArrayBuffer> {
  const n = 1024
  const curve = new Float32Array(n)
  const drive = 1 + k * 0.25
  const h2 = harmonics >= 2 ? 0.5 : 0 // 二次谐波权重
  const h3 = harmonics >= 3 ? 0.3 : 0 // 三次谐波权重
  const h4 = harmonics >= 4 ? 0.2 : 0 // 四次谐波权重
  const mix = Math.max(0, Math.min(1, blend))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    // 非对称 soft clip：产生偶次谐波（心理声学上偶次谐波更"温暖"）
    const shaped = Math.tanh(x * drive) * (1 + 0.18 * k / 10)
    // 谐波叠加（与基频 sin(pi x) 相位对齐，避免互调失真）
    const base = Math.sin(Math.PI * x)
    const harmonicSum = h2 * Math.sin(2 * Math.PI * x) + h3 * Math.sin(3 * Math.PI * x) + h4 * Math.sin(4 * Math.PI * x)
    curve[i] = shaped * (1 - mix * 0.4) + harmonicSum * mix * 0.55 + 0.04 * base
  }
  return curve
}

/** 虚拟低频混合建议：干/湿比例随强度变化 */
export function virtualBassMix(amount: number): { dry: number; wet: number } {
  const wet = Math.min(0.85, 0.15 + amount * 0.07)
  return { dry: 1 - wet * 0.5, wet }
}

/** 低频增强参数推导：强度 0-10 → lowshelf 增益 dB（原应用 增强量语义） */
export function bassEnhanceGain(intensity: number, maxDb = 12): number {
  return Math.max(0, Math.min(maxDb, intensity * 1.2))
}

/** 次低频 punch 频点（对应 AudioControlForegroundService 的 55Hz peaking 结构） */
export const VIRTUAL_BASS_CROSSOVER = 120
export const BASS_PUNCH_FREQ = 55

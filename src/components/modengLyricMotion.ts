/**
 * 摩登模式歌词动画底座 —— LyricsBlossom 逆向规格移植。
 *
 * ⚠ 作用域：**仅供 ModengPlayerPage（摩登歌词模式）使用**。请勿被其他歌词模式引用，
 *   其他模式的动画体系（AMLL 弹簧等）与摩登模式彼此隔离。
 *
 * 规格来源：`逆向成果/动画系统与时序曲线.md`、`renderLine-逆向报告.md`
 *   - `CSSCubicBezierTiming::evaluate`（RVA 0x2A7D10）：Newton-Raphson ≤8 次迭代求 x(t)，
 *     再按三次贝塞尔 Y 公式求值。**LyricsBlossom 没有 spring 物理**，所谓"弹簧感"来自
 *     back 型贝塞尔（x1=0.4 > x2=0.2）在中段的加速-减速观感。
 *   - 六处预设构造点（0x2B8620 / 0x2FA0C0 / 0x2FA7C0 / 0x2FDC60 / 0x2FDD80 / 0x2FDEA0）
 *     提取出的全部 double 常量，见下方 LB_EASING。
 *   - 逐词渲染 = 整行文本一次绘制 + 文字颜色随演唱进度 ARGB 线性插值（0x2F6110 主题色板）。
 *     逆向二进制里的 0x2F5C70 词底圆角矩形经实机核实为**用户拖选歌词的选区背景**，
 *     正常播放时不绘制，故摩登模式不实现词底胶囊（见 ModengPlayerPage 逐词段注释）。
 */

/* ------------------------------------------------------------------ *
 * 一、CSSCubicBezierTiming（0x2A7D10 逐行还原）
 * ------------------------------------------------------------------ */

/** 三次贝塞尔单轴求值：B(t) = 3(1-t)²t·a + 3(1-t)t²·b + t³（端点 0 / 1） */
const bezierAxis = (t: number, a: number, b: number): number => {
  const u = 1 - t
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
}

/** 单轴导数：B'(t) = 3(1-t)²(P1-P0) + 6(1-t)t(P2-P1) + 3t²(P3-P2) */
const bezierAxisDeriv = (t: number, a: number, b: number): number => {
  const u = 1 - t
  return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b)
}

/**
 * 按归一化时间求曲线值，语义等价于 CSS `cubic-bezier(x1,y1,x2,y2)` 的 y(x)。
 *
 * 逆向行为对齐（0x2A7D10）：
 *   - x <= 0 → 0；x >= 1 → 1（越界即完成，直接返回端点，不做外推）；
 *   - Newton-Raphson 最多 8 次迭代解 x(t) = x，导数过小或迭代越界即提前 break；
 *   - 最后按 Y 公式求值（y 分量不参与迭代）。
 *
 * @param progress 归一化进度（0..1，= elapsed / duration）
 */
export const cubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  progress: number,
): number => {
  if (!(progress > 0)) return 0
  if (progress >= 1) return 1
  let t = progress
  for (let i = 0; i < 8; i++) {
    const dx = bezierAxisDeriv(t, x1, x2)
    if (Math.abs(dx) < 1e-6) break
    const next = t - (bezierAxis(t, x1, x2) - progress) / dx
    // 迭代越界即放弃（对齐逆向的边界裁剪分支），保留上一次有效值
    if (next < 0 || next > 1) break
    t = next
  }
  return bezierAxis(t, y1, y2)
}

/** 一条完整的时序曲线 = 贝塞尔控制点 + 时长（对应 CSSCubicBezierTiming 的 0x30 字节布局） */
export interface LbCurve {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 动画时长（秒） */
  duration: number
}

/**
 * 六个预设构造点提取出的全部曲线（逆向文档 §2 常量表）。
 * 注释里的 RVA 是逆向时定位到的 CSSCubicBezierTiming 构造点。
 */
export const LB_EASING = {
  /** 0x2B8620：默认过渡 / 当前行"展开放大"钩子 —— ease-in-out 0.3s */
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1, duration: 0.3 },
  /** 0x2FA0C0：行切换位移（封面/overlay 位移同款）—— 0.32s */
  switch: { x1: 0.4, y1: 0, x2: 0.2, y2: 1, duration: 0.32 },
  /** 0x2FDC60 / 0x2FDD80 / 0x2FDEA0：放大行淡入（慢版）—— 0.45s */
  expandFade: { x1: 0.4, y1: 0, x2: 0.2, y2: 1, duration: 0.45 },
  /** 0x2FA7C0：ease-in 偏门 —— 0.28s */
  easeIn: { x1: 0, y1: 0, x2: 0.58, y2: 1, duration: 0.28 },
} as const satisfies Record<string, LbCurve>

/**
 * 按"已过去秒数"求曲线值。传入负数返回 0，超过 duration 返回 1（对齐 evaluate 的越界分支）。
 * 这是渲染层唯一需要的入口 —— 各动画槽只需保存一个起始墙钟，每帧传入 elapsed 即可。
 */
export const evalCurve = (curve: LbCurve, elapsedSec: number): number =>
  cubicBezier(curve.x1, curve.y1, curve.x2, curve.y2, elapsedSec / curve.duration)

/* ------------------------------------------------------------------ *
 * 二、逐词/逐行渲染常量（0x2F6110 + 0x2F5C70）
 * ------------------------------------------------------------------ */

/** 行渲染状态机阈值（逆向文档 §5 阈值表） */
export const LB_THRESHOLD = {
  /** 行进度达到该值视为"本行唱完"，行切换明暗 / 放大收束 */
  lineDone: 0.997,
  /** 已唱词淡出阈值（0x2F7C3E 处的 0.985 比较指令） */
  sungFade: 0.985,
  /** 行淡入到一半时复位行动画（逆向 dt/0.32 推进到 0.5 复位） */
  resetAt: 0.5,
  /** 词动画步长（0x2F76F7 循环步长系数 0.04） */
  wordStep: 0.04,
} as const

"""AutoMix Lab —— 逐轨效果链（按逆向证据实现）

效果类型**取自 QQ音乐 libSuperSound3.so 的符号表**，不是猜的：

    QMCPCOM::AUTOMIX 命名空间下 EffectParamBase 的模板参数列表：
        EffectParamBase<ThreebandEQ, Gain, LowpassFilter, HighpassFilter,
                        Reverb, MultiParamEffect, Echo>

    对应到 TrackParams 的 GetTrackState<> 实例化：
        HP_EFFECT_PARAM       → HighpassFilter
        LP_EFFECT_PARAM       → LowpassFilter
        ECHO_EFFECT_PARAM     → Echo
        GAIN_EFFECT_PARAM     → Gain
        REVERB_EFFECT_PARAM   → Reverb
        THREEBANDEQ_EFFECT_PARAM → ThreebandEQ

    另有 MTrackMixer::ss_multi_track_mixing 提供的逐轨参数容器
    （TrackParams: Echo/Reverb/ThreebandEQ set effect value 的越界告警
     证实这三个是逐轨可设的）。

本模块按上述清单实现同名效果，供各平台方案组合使用。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import signal


# ── 基础滤波（与 WaveForge render_worker 同一实现风格）────────────────────

def _sos(audio: np.ndarray, sr: int, cutoff: float, btype: str, order: int = 2,
         zero_phase: bool = True) -> np.ndarray:
    nyq = sr / 2
    safe = float(np.clip(cutoff, 20, nyq * 0.99))
    sos = signal.butter(order, safe, btype=btype, fs=sr, output='sos')
    if zero_phase:
        try:
            return signal.sosfiltfilt(sos, audio, axis=-1).astype(np.float32)
        except ValueError:
            pass
    return signal.sosfilt(sos, audio, axis=-1).astype(np.float32)


def biquad_q(audio: np.ndarray, sr: int, cutoff: float, btype: str,
             Q: float = 0.5) -> np.ndarray:
    """网易云 EQ 内核 biquad（RBJ 风格因果 2 阶, 纯正向/非零相位）。

    历史修正（2026-09-22, 过渡"拼接感"根因）: 初版按反汇编直译的 cos-biquad
    系数（a0 = cos(w0)² + cos(w0)/(2Q) + 1 等）翻译后滤波器**通带增益异常**：
    高通 20Hz 在 0.1k~5kHz 中频段仍衰减约 14dB（极点半径仅 ≈0.577, 过渡带宽
    达数个十倍频, 不是 20Hz 附近截止），导致源曲过渡全程被压到近静音、听感
    像两段直接拼接。反汇编证据 ne_h_runtime_evidence.md §3.3 亦注明: 系数
    公式与反汇编字节级一致, 但 **applyEQ→vtable+0xa0 的 DSP 最终应用跳转
    未闭合**（直流/增益归一化未知），故公式直译不可直接用于音频渲染。
    §3.3 同时给出官方认可的本地重构路线: **"RBJ 风格因果 2 阶（纯正向
    sosfilt, 匹配 native 80ms 步进实时重算语义）"** —— 即保持证据的扫频
    语义（20→20000Hz 对数, 80ms 步进, Q=0.5 恒值, FilterType 0=low_pass /
    1=high_pass）不变, 内核改用标准 RBJ 系数, 保证通带单位增益、截止频率
    正确（出曲低频渐切 / 入曲闷→揭开）。
    """
    w0 = 2.0 * np.pi * float(np.clip(cutoff, 1.0, sr * 0.49)) / sr
    alpha = np.sin(w0) / (2.0 * Q)
    cw = np.cos(w0)
    if btype == 'highpass':
        b = np.array([(1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0])
        a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    elif btype == 'bandpass':
        b = np.array([alpha, 0.0, -alpha])
        a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    else:  # lowpass
        b = np.array([(1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0])
        a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    b = b / a[0]
    a = a / a[0]
    sos = np.array([b[0], b[1], b[2], a[0], a[1], a[2]])[None, :]
    return signal.sosfilt(sos, audio, axis=-1).astype(np.float32)


def _env(n: int, points: list[tuple[float, float]]) -> np.ndarray:
    """折线包络：points = [(归一化位置 0..1, 值), ...]"""
    xs = np.array([p[0] for p in points], dtype=float)
    ys = np.array([p[1] for p in points], dtype=float)
    order = np.argsort(xs)
    return np.interp(np.linspace(0, 1, n), xs[order], ys[order]).astype(np.float32)


# ── 效果实现 ──────────────────────────────────────────────────────────────

def highpass(audio: np.ndarray, sr: int, cutoff: float) -> np.ndarray:
    """HighpassFilter —— 对应 HP_EFFECT_PARAM。"""
    return _sos(audio, sr, cutoff, 'highpass')


def lowpass(audio: np.ndarray, sr: int, cutoff: float) -> np.ndarray:
    """LowpassFilter —— 对应 LP_EFFECT_PARAM。"""
    return _sos(audio, sr, cutoff, 'lowpass')


def gain(audio: np.ndarray, db: float) -> np.ndarray:
    """Gain —— 对应 GAIN_EFFECT_PARAM。"""
    return (audio * (10.0 ** (db / 20.0))).astype(np.float32)


def three_band_eq(audio: np.ndarray, sr: int,
                  low_db: float = 0.0, mid_db: float = 0.0, high_db: float = 0.0,
                  lo_x: float = 240.0, hi_x: float = 3600.0) -> np.ndarray:
    """ThreebandEQ —— 对应 THREEBANDEQ_EFFECT_PARAM。

    互补三分频（保证求和精确重建），各段独立增益。
    """
    low = _sos(audio, sr, lo_x, 'lowpass')
    rest = audio - low
    mid = _sos(rest, sr, hi_x, 'lowpass')
    high = rest - mid
    return (low * (10 ** (low_db / 20)) + mid * (10 ** (mid_db / 20))
            + high * (10 ** (high_db / 20))).astype(np.float32)


def echo(audio: np.ndarray, sr: int, delay_s: float = 0.32,
         feedback: float = 0.28, taps: int = 4, mix: float = 0.25,
         envelope: np.ndarray | None = None) -> np.ndarray:
    """Echo —— 对应 ECHO_EFFECT_PARAM。

    多抽头反馈延迟。envelope 非空时按包络控制回声量（用于过渡尾部淡出）。
    """
    out = np.zeros_like(audio)
    offset = max(1, int(delay_s * sr))
    for t in range(1, taps + 1):
        d = offset * t
        if d >= audio.shape[-1]:
            break
        out[..., d:] += audio[..., :-d] * (feedback ** (t - 1))
    if envelope is not None:
        out *= envelope[None, :] if out.ndim > 1 else envelope
    return out.astype(np.float32)


def reverb(audio: np.ndarray, sr: int, decay: float = 0.16,
           mix: float = 0.18, seed: int = 0) -> np.ndarray:
    """Reverb —— 对应 REVERB_EFFECT_PARAM。

    指数衰减噪声脉冲响应卷积（轻量混响），再低通去掉金属感。
    """
    ir_len = max(64, int(0.45 * sr))
    rng = np.random.default_rng(seed)
    t = np.arange(ir_len) / sr
    ir = (rng.standard_normal(ir_len) * np.exp(-t / max(1e-3, decay))).astype(np.float32)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    wet = np.stack([signal.fftconvolve(audio[c], ir)[:audio.shape[1]]
                    for c in range(audio.shape[0])], axis=0).astype(np.float32)
    wet = _sos(wet, sr, 6000, 'lowpass')
    return (audio * (1 - mix) + wet * mix).astype(np.float32)


def bass_swap(source: np.ndarray, target: np.ndarray, sr: int,
              split_hz: float = 180.0, swap_at: float = 0.5,
              width: float = 0.12, order: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """低音所有权交换（DJ 手法）。

    与 WaveForge 现有实现的关键差异：**用 4 阶而非 2 阶分频**。
    2 阶（12dB/oct）在 180Hz 处太缓、泄漏到 700Hz，两曲贝斯会打架；
    4 阶（24dB/oct）分得干净。
    """
    n = source.shape[1]
    env = _env(n, [(0, 0), (max(0.0, swap_at - width), 0), (min(1.0, swap_at + width), 1), (1, 1)])
    s_low = _sos(source, sr, split_hz, 'lowpass', order=order)
    t_low = _sos(target, sr, split_hz, 'lowpass', order=order)
    # 源侧低音按 (1-env) 保留，目标侧低音按 env 进入
    s_out = source - s_low + s_low * (1 - env)
    t_out = target - t_low + t_low * env
    return s_out.astype(np.float32), t_out.astype(np.float32)


def filter_sweep(audio: np.ndarray, sr: int, start_hz: float = 120.0,
                 end_hz: float = 900.0, stages: int = 3,
                 wet: float = 0.8) -> np.ndarray:
    """滤波扫频（渐进高通）。

    用**连续插值**而非 WaveForge 现有的三段固定截止阶梯——阶梯会有听感台阶。
    为控制开销，分 stages 段各自滤波后按包络混合。
    """
    n = audio.shape[1]
    out = audio.copy()
    for i in range(stages):
        a, b = i / stages, (i + 1) / stages
        cut = start_hz * (end_hz / start_hz) ** ((i + 0.5) / stages)
        hp = _sos(audio, sr, cut, 'highpass')
        e = _env(n, [(0, 0), (a, 0), (b, wet * (i + 1) / stages), (1, wet * (i + 1) / stages)])
        out = out * (1 - e) + hp * e
    return out.astype(np.float32)


# ── 逐轨效果链容器 ────────────────────────────────────────────────────────

@dataclass
class TrackEffects:
    """单条轨（或整混音）的效果链状态。

    字段命名对齐逆向到的 *_EFFECT_PARAM 类型。
    """
    hp_hz: float | None = None          # HighpassFilter
    lp_hz: float | None = None          # LowpassFilter
    gain_db: float = 0.0                # Gain
    eq: tuple[float, float, float] | None = None   # ThreebandEQ (low,mid,high) dB
    echo_mix: float = 0.0               # Echo
    echo_delay_s: float = 0.32
    echo_feedback: float = 0.28
    reverb_mix: float = 0.0             # Reverb
    reverb_decay: float = 0.16

    def apply(self, audio: np.ndarray, sr: int,
              echo_env: np.ndarray | None = None, seed: int = 0) -> np.ndarray:
        y = audio
        if self.hp_hz:
            y = highpass(y, sr, self.hp_hz)
        if self.lp_hz:
            y = lowpass(y, sr, self.lp_hz)
        if self.eq:
            y = three_band_eq(y, sr, *self.eq)
        if self.gain_db:
            y = gain(y, self.gain_db)
        if self.reverb_mix > 0:
            y = reverb(y, sr, self.reverb_decay, self.reverb_mix, seed)
        if self.echo_mix > 0:
            y = y + echo(y, sr, self.echo_delay_s, self.echo_feedback,
                         mix=self.echo_mix, envelope=echo_env) * self.echo_mix
        return y.astype(np.float32)


# ── 中侧（MS）立体声处理 ──────────────────────────────────────────────────

def ms_process(audio: np.ndarray, sr: int,
               mid_gain_db: float = 0.0, side_gain_db: float = 0.0,
               side_hp_hz: float | None = None,
               side_lp_hz: float | None = None) -> np.ndarray:
    """中侧独立处理。

    逆向证据：QQ音乐 SSAutoMixInst 有 `SetMSProcessMode` / `SetMSProcessing`，
    说明它在中侧域做过处理。这里实现为：mid/side 各自增益 + side 可选带限。

    用途：过渡期可以把 side 抬一点保持声场开阔，或把 side 的高频切掉
    避免两侧镲片叠加刺耳。
    """
    if audio.ndim != 2 or audio.shape[0] < 2:
        return audio
    mid = (audio[0] + audio[1]) / 2
    side = (audio[0] - audio[1]) / 2
    if side_hp_hz:
        side = highpass(side[None, :], sr, side_hp_hz)[0]
    if side_lp_hz:
        side = lowpass(side[None, :], sr, side_lp_hz)[0]
    mid = mid * (10 ** (mid_gain_db / 20))
    side = side * (10 ** (side_gain_db / 20))
    return np.stack([mid + side, mid - side]).astype(np.float32)


# ── 两阶段断点 ────────────────────────────────────────────────────────────

def two_stage_breakpoint(n: int, sr: int, duration_s: float,
                         stage1: float = 0.5, blend_s: float = 0.6) -> np.ndarray:
    """两阶段断点曲线。

    逆向证据：QQ音乐 SSAutoMixInst 有 `SetTwoStageBreakpoint(float, float)`。
    语义为「过渡在某个断点处切换推进速率」。这里实现为一条单调 0→1 的分段曲线：
    断点前缓入（二次），断点后更快上升。
    """
    bp = float(np.clip(stage1, 0.01, 0.99))
    t = np.linspace(0, 1, n)

    # 必须用掩码分段赋值：np.where 会同时求值两个分支，
    # 而 (t-bp) 为负时开分数次幂 → NaN（且前段公式在 t>bp 时会溢出 >1）。
    curve = np.empty_like(t)
    m = t <= bp
    curve[m] = (t[m] / bp) ** 2
    curve[~m] = bp + ((t[~m] - bp) / (1 - bp)) ** 0.7 * (1 - bp)

    curve = np.clip(curve, 0.0, 1.0)
    if blend_s > 0 and n > 8:
        k = max(3, int(blend_s / max(1e-6, duration_s) * n) | 1)
        k = min(k, (n // 2) * 2 - 1) if n > 4 else k
        if k >= 3:
            curve = signal.savgol_filter(curve, k, 2, mode='nearest')
        # 平滑会轻微回摆，端点必须精确归位，否则交叉淡出不完整（源未静音/目标未满）
        curve = np.clip(curve, 0, 1)
        curve = (curve - curve[0]) / max(1e-9, curve[-1] - curve[0])
        curve = np.clip(curve, 0, 1)
    return curve.astype(np.float32)

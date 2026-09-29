"""AutoMix Lab —— QQ音乐 DJ 方案预设执行引擎

数据来源：`libSuperSound3.so`（QQ音乐 20.8.5.8）内嵌的 25 个 DJPlan JSON 预设，
经符号定位 + JSON 提取获得（见 `data/qqmusic_djplan_presets.json`）。

═══════════════════════════════════════════════════════════════════════════
预设 JSON 结构（逆向所得，非推测）
═══════════════════════════════════════════════════════════════════════════
{
  "name": "ThreeBandFade",
  "description": "Three band fade: low band steps over at the middle, ...",
  "Achain": { "description": "...", "list": [ {item}, ... ] },   ← 源轨效果链
  "Bchain": { "description": "...", "list": [ {item}, ... ] }    ← 目标轨效果链
}

单个 item：
{
  "effect": { "type": 0, "target_param": "low", "low": 0.0 },
  "automation": { "type": "custom", "control_points": [[0.0, 0.0], [0.5, 0.0], ...] }
}

effect.type 取值（由 25 个预设的用法推断，边界清晰）：
    0 = 分段 EQ（target_param = low / mid / high，值为 dB）
    1 = 整体 Gain（value = dB）
    2 = LowpassFilter（value = Hz）
    3 = HighpassFilter（value = Hz）
    4 = EQ 参数变体（3bandEQPreset 中出现）

automation.type 取值：
    "custom"     —— control_points = [[归一化位置, 值], ...] 线性插值
    "piecewise"  —— m / n / start_pos / end_pos / curve_type
    "step"       —— m / n / step_pos（阶跃）
    "simpleexchange" —— 参见 SimpleFilterPreset

CombinePresetPlan 的三个槽位（字符串池中紧邻出现）：
    volumePresetId      → 音量类（type=1）
    equalizerPresetId   → 分段EQ类（type=0/4）
    filterPresetId      → 滤波类（type=2/3）

即 QQ音乐不是"选一个预设"，而是**从三类各取一个组合**成最终 DJ 方案。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy import signal

PRESET_FILE = Path(__file__).resolve().parent / 'data' / 'qqmusic_djplan_presets.json'
# 官方 libSuperSound3.so 内嵌 8 套 DJPlan JSON（符号名→{name, Achain, Bchain}），
# 全量 dump 于第 2 阶段逆向（见 .analysis/automix_re_mapping.md）。
OFFICIAL_PRESET_FILE = Path(__file__).resolve().parent / 'data' / 'qqmusic_djplan_presets_official.json'

# 分段 EQ 的分频点（三段：low / mid / high）
# 2026-09-23 THREEBANDEQ_EFFECT_PARAM 常量表 0x584d10 反汇编实证：
#   [0,0,0,50] [0.3,1,50,0.9] [1,1100,0.3,1] [1100,0.9,1,12000] [0.3,1,12000,0.4]
#   → 50Hz（low-mid 边界）、1100Hz（mid-high 边界）、12000Hz（高频参考）
EQ_LOW_X = 50.0
EQ_HIGH_X = 1100.0

# 数值约定：分段EQ/Gain 的值是 dB；LPF/HPF 的值是 Hz
_TYPE_EQ, _TYPE_GAIN, _TYPE_LPF, _TYPE_HPF, _TYPE_EQ_PARAM = 0, 1, 2, 3, 4


def load_presets() -> dict:
    if not PRESET_FILE.exists():
        return {}
    return json.loads(PRESET_FILE.read_text(encoding='utf8'))


def load_official_presets() -> dict:
    """官方内置 DJPlan 预设（符号名→{name, Achain, Bchain}）；文件缺失返回 {}。"""
    if not OFFICIAL_PRESET_FILE.exists():
        return {}
    return json.loads(OFFICIAL_PRESET_FILE.read_text(encoding='utf8'))


def classify(name: str, preset: dict) -> str:
    """按 effect type 归类预设所属槽位。"""
    ts = set()
    for ch in ('Achain', 'Bchain'):
        for item in preset.get(ch, {}).get('list', []):
            ts.add(item.get('effect', {}).get('type'))
    if ts and ts <= {_TYPE_GAIN}:
        return 'volume'
    if ts & {_TYPE_LPF, _TYPE_HPF}:
        return 'filter'
    return 'equalizer'


# ── 自动化曲线求值 ────────────────────────────────────────────────────────

def eval_automation(aut: dict, n: int) -> np.ndarray:
    """把 automation 定义求值成长度 n 的曲线。

    支持逆向到的四种 type：
      custom     —— control_points 线性插值
      piecewise  —— m/n/start_pos/end_pos 线性（curve_type 0）
      step       —— step_pos 处阶跃
      simpleexchange —— 视为线性（见 SimpleFilterPreset 用法）
    """
    t = np.linspace(0.0, 1.0, n)
    typ = (aut or {}).get('type', 'custom')

    if typ == 'custom':
        cps = aut.get('control_points') or []
        if not cps:
            return np.zeros(n, dtype=np.float32)
        xs = np.array([float(p[0]) for p in cps])
        ys = np.array([float(p[1]) for p in cps])
        order = np.argsort(xs)
        return np.interp(t, xs[order], ys[order]).astype(np.float32)

    if typ == 'step':
        m = float(aut.get('m', 0.0))
        n_val = float(aut.get('n', 0.0))
        pos = float(aut.get('step_pos', 0.5))
        return np.where(t < pos, m, n_val).astype(np.float32)

    if typ == 'piecewise':
        m = float(aut.get('m', 0.0))
        nv = float(aut.get('n', 0.0))
        sp = float(aut.get('start_pos', 0.0))
        ep = float(aut.get('end_pos', 1.0))
        curve = np.full(n, m, dtype=np.float32)
        if ep > sp:
            w = np.clip((t - sp) / (ep - sp), 0, 1)
            ct = int(aut.get('curve_type', 0) or 0)
            # State2Param::Process_State2Track@0x41e23c 反汇编实证（curve_type 整数→曲线名字符串）：
            #   cmp w9,#1 ; csel x10,x11("log"),x10("exp"),eq
            #   cmp w9,#0 ; csel x1,"linear",x10,eq / csel 长度 6:3
            #   => curve_type==0 → "linear"；==1 → "log"；其余(2 等) → "exp"
            #   曲线式见 PiecewiseLinear::process@0x40a8c4：
            #     linear m+(n-m)t ；log m+(n-m)(2t-t²) ；exp m+(n-m)t²
            # 2026-09-24 修正：旧注释把 1/2 写反（原来 1=exp,2=log），已按上面实证改回。
            if ct == 0:
                curve = m + (nv - m) * w
            elif ct == 1:
                curve = m + (nv - m) * (2.0 * w - w * w)
            else:
                curve = m + (nv - m) * (w * w)

        return curve.astype(np.float32)

    # simpleexchange / 未知：线性
    m = float(aut.get('m', 0.0)); nv = float(aut.get('n', 0.0))
    return (m + (nv - m) * t).astype(np.float32)


# ── 效果施加 ──────────────────────────────────────────────────────────────

def _sos(audio, sr, cut, btype, order=2, zi=None):
    """官方 CommFilter::LPFilter_Q/HPFilter_Q 风格：N 阶 Butterworth 多二阶节级联，
    因果 IIR（DF2T 逐样本递推），状态跨块持续。

    2026-09-23 反汇编实证（automix_re_mapping.md §8.1）：
      - 官方 N 阶 Butterworth，级数=⌈order/2⌉，2 阶时 proto[0]=√2 与 scipy butter(2) 等价
      - 每节 RBJ cookbook biquad，double 精度 DF2T，状态跨块持续
      - 参数变化 → 重算全部系数、硬切换（无交叉淡化）
    ❌ 不能用 sosfiltfilt（零相位）——官方是因果 IIR。返回 (y, zi_new) 供跨块续算。
    """
    nyq = sr / 2
    safe = float(np.clip(cut, 20, nyq * 0.99))
    sos = signal.butter(order, safe, btype=btype, fs=sr, output='sos')
    zi = np.zeros((sos.shape[0], 2, audio.shape[0]), np.float64) if zi is None else zi
    y, zi = signal.sosfilt(sos, audio, axis=-1, zi=zi)
    return y.astype(np.float32), zi


def _split3(audio: np.ndarray, sr: int):
    """互补三分频：保证三段求和精确重建（分频点 50/1100Hz，官方实证）。"""
    low, _ = _sos(audio, sr, EQ_LOW_X, 'lowpass')
    rest = audio - low
    mid, _ = _sos(rest, sr, EQ_HIGH_X, 'lowpass')
    high = rest - mid
    return low, mid, high


# ── 官方 ThreeBandBiquadQEffect（AutoMix 三段 EQ 的真实 DSP，2026-09-23 全链反汇编实装）──
# SSAutoMixInst ctor@0x40de00 建立效果链 [ThreeBandBiquadQEffect → Amplifier → LPFilterQ →
# HPFilterQ → Mverb → FreezeEcho]（0x40eb88..0x40ee30），EQ 段即 ThreeBandBiquadQEffect。
# ThreeBandBiquadQEffect::Update@0x422010 的 6 段分支（Low/Mid/High × Boost/Cut）：
#   gain>0 → Boost：三带全用 CommFilter::PeakingFilter_Q（4 阶 Butterworth 双二次级联）
#   gain<0 → Cut ：Low/Mid 用 PeakingFilter_Q；High 用 HighShelfFilter_Q（2 阶）
# Update 按每块读取 band dBgain，符号决定 Boost/Cut → 重建滤波器（硬切换，无交叉淡化）。
# 系数数学（PeakingFilter_Q::update@0x252a44 / HighShelfFilter_Q::update@0x24f960）：
#   A = 10^(dB/40)；ω = 2π·freq/sr；Butterworth 原型 −2cos(π(ch+2i+1)/(2ch))；
#   tan(ω/2) 预畸变；块布局 b0..b4/a1..a4（4 阶）/ b0..b2/a1..a2（2 阶），DF1 递推，
#   状态跨块持续。频点与 Q 不随 plan 下发 → 用分频锚点（50/1100/12000Hz）与默认 Q=1。
#   （plan 的 type=0 只带 dB 曲线，如 low: 0→-15 step@0.75）

def _peaking_coeffs(freq, q, gain_db, sr, order=4):
    """CommFilter::PeakingFilter_Q 4 阶 peaking：A=10^(dB/40) + Butterworth 原型。
    官方 = TWOIIRBiquad（两个 2 阶 biquad 级联），返回 SOS (每行 [b0,b1,b2,1,a1,a2])。
    A 按节数均分（几何平均），级联后总峰值增益 = 10^(dB/40)。"""
    a_amp = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * float(freq) / float(sr)
    alpha = np.sin(w0) / (2.0 * q)
    nsec = order // 2
    sech = a_amp ** (1.0 / nsec)
    sos = []
    for _i in range(nsec):
        b0 = 1.0 + alpha * sech
        b1 = -2.0 * np.cos(w0)
        b2 = 1.0 - alpha * sech
        a0 = 1.0 + alpha / sech
        a1 = -2.0 * np.cos(w0)
        a2 = 1.0 - alpha / sech
        sos.append([b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0])
    return np.array(sos)


def _highshelf_coeffs(freq, q, gain_db, sr):
    """CommFilter::HighShelfFilter_Q 2 阶 highshelf（high-cut 分支专用）。
    shelf 斜率 S：q≥1 → 1+0.85·log2(q)；A=10^(dB/40)；ω=2πf/sr。"""
    a_amp = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * np.pi * float(freq) / float(sr)
    s = (1.0 + 0.85 * np.log(q) / np.log(2.0)) if q >= 1.0 else 1.0
    alpha = np.sin(w0) / 2.0 * np.sqrt((a_amp + 1.0 / a_amp) * (1.0 / s - 1.0) + 2.0)
    cosw = np.cos(w0)
    b0 = a_amp * ((a_amp + 1.0) - (a_amp - 1.0) * cosw + 2.0 * np.sqrt(a_amp) * alpha)
    b1 = 2.0 * a_amp * ((a_amp - 1.0) - (a_amp + 1.0) * cosw)
    b2 = a_amp * ((a_amp + 1.0) - (a_amp - 1.0) * cosw - 2.0 * np.sqrt(a_amp) * alpha)
    a0 = (a_amp + 1.0) + (a_amp - 1.0) * cosw + 2.0 * np.sqrt(a_amp) * alpha
    a1 = -2.0 * ((a_amp - 1.0) + (a_amp + 1.0) * cosw)
    a2 = (a_amp + 1.0) + (a_amp - 1.0) * cosw - 2.0 * np.sqrt(a_amp) * alpha
    return np.array([b0 / a0, b1 / a0, b2 / a0])


def _filter_blocks(x, b, a, zi):
    """DF1 因果递推（signal.lfilter），状态跨块持续；返回 (y, zi_new)。"""
    y, zi = signal.lfilter(b, a, x, axis=-1, zi=zi)
    return y, zi


def _apply_threeband_eq(audio: np.ndarray, sr: int, curve: np.ndarray,
                        tgt: str, block: int = 512) -> np.ndarray:
    """官方 ThreeBandBiquadQEffect 单带 EQ 施加。

    每块按块中点 dB 取 Boost/Cut 分支重建滤波器（符号随块变化硬切换），
    DF1 状态跨块持续。boost 用 4 阶 Peaking（2×biquad 级联）；cut 的 Low/Mid
    用 4 阶 Peaking、High 用 2 阶 HighShelf。频点：分频锚点 50/1100/12000Hz、Q=1 默认。
    """
    anchor = {'low': 50.0, 'mid': 1100.0, 'high': 12000.0}.get(tgt, 50.0)
    n = audio.shape[1]
    res = np.empty_like(audio)
    zi = None
    for a0 in range(0, n, block):
        a1 = min(n, a0 + block)
        gain_db = float(curve[min(n - 1, (a0 + a1) // 2)])
        if abs(gain_db) < 0.01:
            if zi is not None:
                zi = np.zeros_like(zi)
            res[:, a0:a1] = audio[:, a0:a1]
            continue
        boost = gain_db > 0.0
        if boost or tgt != 'high':
            sos = _peaking_coeffs(anchor, 1.0, gain_db, sr, order=4)
            nsec, nz = sos.shape[0], 2 * sos.shape[0]
        else:
            b = _highshelf_coeffs(anchor, 1.0, gain_db, sr)
            sos = np.array([list(b) + [1.0, 0.0, 0.0]])
            nsec, nz = 1, 2
        if zi is None or zi.shape[-1] != nz:
            zi = np.zeros((audio.shape[0], nz), np.float64)
        x = audio[:, a0:a1].astype(np.float64)
        for k in range(nsec):
            b = sos[k, :3]
            a = np.concatenate(([sos[k, 3]], sos[k, 4:]))
            x, zi[:, 2 * k:2 * k + 2] = _filter_blocks(x, b, a, zi[:, 2 * k:2 * k + 2])
        res[:, a0:a1] = x.astype(np.float32)
    return res.astype(np.float32)


def apply_chain(audio: np.ndarray, sr: int, chain: dict) -> np.ndarray:
    """按 Achain / Bchain 的 list 逐项施加效果。

    2026-09-23 官方 DSP 实证对齐：
      - Gain：逐样本乘 10^(dB/20)（电压约定，AudaciousArma::SetParam 实证）
      - 分段 EQ：三分频（50/1100Hz）+ 目标段增益，其余段不动
      - LPF/HPF：官方参数变化时重算系数、硬切换（无交叉淡化），
        因果 IIR 状态跨块持续（DF2T）→ 分块重算系数但 zi 续传
    """
    n = audio.shape[1]
    out = audio.copy()
    for item in (chain or {}).get('list', []):
        eff = item.get('effect', {}) or {}
        aut = item.get('automation', {}) or {}
        typ = eff.get('type')
        curve = eval_automation(aut, n)

        if typ == _TYPE_GAIN:
            out = out * (10 ** (curve / 20.0))[None, :]

        elif typ in (_TYPE_EQ, _TYPE_EQ_PARAM):
            tgt = eff.get('target_param', 'low')
            # 官方 ThreeBandBiquadQEffect（SSAutoMixInst 效果链 kg EQ 段）：单带按 dB 曲线
            # 驱动 peaking(4 阶)/highshelf(2 阶)，Boost/Cut 分支 + DF1 状态跨块持续。
            # （2026-09-23 全链反汇编实证，见 automix_re_mapping.md §8.4）
            out = _apply_threeband_eq(out, sr, curve, tgt)

        elif typ in (_TYPE_LPF, _TYPE_HPF):
            btype = 'lowpass' if typ == _TYPE_LPF else 'highpass'
            # 官方：参数变化 → 重算全部系数、硬切换（无交叉淡化）；
            # 因果 IIR 状态跨块持续。分块（0.05s）取块中点 cut 重算系数，zi 续传。
            block = max(256, int(0.05 * sr))
            res = np.empty_like(out)
            zi = None
            for a in range(0, n, block):
                b = min(n, a + block)
                cut = float(curve[min(n - 1, (a + b) // 2)])
                y, zi = _sos(out[:, a:b], sr, cut, btype, zi=zi)
                res[:, a:b] = y
            out = res
        # 其他 type 忽略（未在证据中出现明确语义）

    return out.astype(np.float32)


# ── 方案组合与执行 ────────────────────────────────────────────────────────

@dataclass
class DjPlan:
    """一个完整的 DJ 方案 = volume + equalizer + filter 三段预设的组合。"""
    volume: str | None = None
    equalizer: str | None = None
    filter: str | None = None
    name: str = ''

    def describe(self) -> str:
        parts = [p for p in (self.volume, self.equalizer, self.filter) if p]
        return ' + '.join(parts) if parts else '（空方案）'


def build_plan(volume=None, equalizer=None, filter=None, name='') -> DjPlan:
    return DjPlan(volume=volume, equalizer=equalizer, filter=filter, name=name)


def apply_dj_plan(src: np.ndarray, tgt: np.ndarray, sr: int,
                  plan: DjPlan, presets: dict | None = None) -> tuple[np.ndarray, np.ndarray]:
    """把 DJ 方案施加到源轨与目标轨，返回 (源处理后, 目标处理后)。"""
    presets = presets if presets is not None else load_presets()
    s, t = src.copy(), tgt.copy()
    for slot in (plan.volume, plan.equalizer, plan.filter):
        if not slot or slot not in presets:
            continue
        obj = presets[slot]
        s = apply_chain(s, sr, obj.get('Achain', {}))
        t = apply_chain(t, sr, obj.get('Bchain', {}))
    return s, t


# ── 两档（对应 QQ音乐 UI 的"基础渐变"与"进阶交融"）────────────────────────

def tier_presets() -> dict:
    """两档的方案组合。

    逆向依据：
      - UI 上两档的名字是「智能混音·基础渐变」与「智能混音·进阶交融」；
      - so 里的预设分三类槽位，且提供了 7 个 volume / 8 个 eq / 10 个 filter；
      - 「基础渐变」副标题是"更多保留原曲片段的丝滑衔接" → 温和的对称交叉；
      - 「进阶交融」副标题是"切歌点更智能 适配段落节奏特征" → 带低音交换与滤波的交融。
    组合选择基于上述语义与预设 description 的对应，非任意指定。
    """
    return {
        # 基础渐变：对称淡入淡出（SmoothFadeInFadeOut 描述即 "classic X shaped
        # symmetric crossfade"），配 NoPlan 的 EQ 槽（不做分段处理）
        'qq_basic': DjPlan(volume='smooth_fade_in_fade_out',
                           equalizer='NoPlan', filter=None,
                           name='基础渐变'),
        # 进阶交融：三段淡变（低音在中点交换、中高频交叉）
        # + 低音交换 + 高通切除（源侧逐渐失去低频）
        'qq_advanced': DjPlan(volume='smooth_fade_in_fade_out',
                              equalizer='ThreeBandFade',
                              filter='hpf_cut_out',
                              name='进阶交融'),
    }

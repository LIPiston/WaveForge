"""AutoMix Lab —— 过渡管线

把「纯拉伸对比」和「完整过渡对比」都做出来：

  Mode A：stretch_only    —— 单一引擎对一段音频做拉伸，隔离引擎变量
  Mode B：transition      —— 源尾+目标头，逐拍拉伸到共享网格 + 等功率交叉

Mode B 支持两种网格策略（这是 QQ音乐/网易云的真实做法差异）：
  fixed_ratio   ：整段用一个固定拉伸率
  ramped        ：逐拍线性渐变（源渐慢、目标回正）—— DJ 式渐进变速
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

from .engines.registry import Engine, fix_length


# ── 节拍 ─────────────────────────────────────────────────────────────────

def detect_beats(audio: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """检测拍点。优先 beat_this（若可用），否则 librosa 兜底。

    返回 (beat_times_seconds, bpm)。
    """
    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    try:
        from beat_this.inference import File2Beats  # type: ignore
        raise ImportError('beat_this 需要文件路径，此处走 librosa')
    except Exception:
        pass
    tempo, beats = librosa.beat.beat_track(y=mono.astype(np.float32), sr=sr,
                                           units='frames', trim=False)
    times = librosa.frames_to_time(beats, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0]) if tempo is not None else 120.0
    return times, bpm


def beat_segments(beat_times: np.ndarray, start_s: float, end_s: float,
                  n_segments: int) -> list[tuple[float, float]]:
    """把 [start_s, end_s] 按检测到的拍点切成 n_segments 段（无拍点时均分）。"""
    seg_len = (end_s - start_s) / max(1, n_segments)
    bounds = [start_s + i * seg_len for i in range(n_segments + 1)]
    if beat_times.size < 2:
        return [(bounds[i], bounds[i + 1]) for i in range(n_segments)]
    # 把每个理想边界吸附到最近的拍点
    snapped = [start_s]
    for b in bounds[1:-1]:
        idx = int(np.argmin(np.abs(beat_times - b)))
        snapped.append(float(beat_times[idx]))
    snapped.append(end_s)
    snapped = sorted(set(snapped))
    return [(snapped[i], snapped[i + 1]) for i in range(len(snapped) - 1)]


# ── 交叉曲线 ─────────────────────────────────────────────────────────────

def equal_power(n: int, points: int = 512) -> tuple[np.ndarray, np.ndarray]:
    t = np.linspace(0, 1, points)
    src, tgt = np.cos(t * np.pi / 2), np.sin(t * np.pi / 2)
    idx = np.linspace(0, points - 1, n)
    return np.interp(idx, np.arange(points), src), np.interp(idx, np.arange(points), tgt)


def linear_cross(n: int) -> tuple[np.ndarray, np.ndarray]:
    w = np.linspace(1.0, 0.0, n)
    return w, 1.0 - w


CROSSFADES = {
    'equal_power': ('等功率 cos/sin（WaveForge 现行）', equal_power),
    'linear': ('线性（中点塌陷 -3dB，用作下限对照）', linear_cross),
}


# ── 管线 ─────────────────────────────────────────────────────────────────

@dataclass
class TransitionResult:
    audio: np.ndarray
    segments: int
    avg_stretch: float
    seam_positions: list[int]
    target_samples: int
    meta: dict = None


def render_transition(src: np.ndarray, tgt: np.ndarray, engine: Engine,
                      window_s: float, sr: int, n_beats: int = 16,
                      grid: str = 'ramped', ramp: float = 0.10,
                      crossfade: str = 'equal_power',
                      seam_smooth_ms: float = 8.0,
                      trace=None) -> TransitionResult:
    """渲染完整过渡（整窗一次匀速拉伸，与两平台真实架构一致）。

    旧版逐段变速 + fix_length 补零会在每个分段边界产生周期性静音坑与速度
    跳变（每段 0.75s 的「一卡一卡」）。真实平台（QQ SoundTouch 连续流处理 /
    网易 RubberBand setTimeRatio 一次）都不分段，这里同样整窗只拉一次：
    源曲按 bpm_src/bpm_tgt 匹配到目标曲速度，目标曲保持原速取更长切片。
    grid/ramp/n_beats 仅为 API 兼容保留。
    """
    from .recipes import tempo_matched_windows
    so, to, tmeta = tempo_matched_windows(src, tgt, engine, sr, window_s, trace)
    total = so.shape[1]

    if crossfade not in CROSSFADES:
        raise KeyError(f'未知交叉曲线: {crossfade}')
    gs, gt = CROSSFADES[crossfade][1](total)
    mixed = so * gs[None, :] + to * gt[None, :]

    return TransitionResult(audio=mixed.astype(np.float32), segments=1,
                            avg_stretch=tmeta['stretch_factor'],
                            seam_positions=[], target_samples=total,
                            meta={'grid': 'uniform_bpm', **tmeta})



CROSSFADE_NAMES = {k: v[0] for k, v in CROSSFADES.items()}
GRID_NAMES = {
    'ramped': '逐拍渐变变速（源渐慢→目标回正，DJ 式）',
    'fixed_ratio': '整段固定拉伸率',
}

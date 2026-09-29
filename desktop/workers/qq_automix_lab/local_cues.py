# -*- coding: utf-8 -*-
"""本地 MIR 合成 —— 纯本地仿制 QQ 智能过渡的数据层（2026-09-27）。

官方链路：云端 MIR（bid=24 BEAT_INFO / bid=23 CUE_POINT_INFO）→ 决策（DesideCue）
→ EnableDate → 渲染。本地仿制没有云端，本模块用 librosa 节拍检测**合成官方形状**
的 cue 数据，让纯本地方案也能跑真正的官方决策算法（qq_desidecue）：

  synth_cue_cuts   ≈ MIR cue_cuts：出曲尾部小节对齐切点（升序秒，官方 6 点形）
  synth_cue_entrys ≈ MIR cue_entrys：入曲头部接入点（升序秒，官方 3 点形）
  synth_cue2_entrys≈ MIR cue2_entrys：进阶交融洽入口（降序 [大, 小, −1, −1]，
                     形状对齐 18 组真机实抓，见 .verify/emu_live_captures_2026-09-27.jsonl）

合成质量上限 = 本地节拍检测（librosa）不及官方 MIR 分析，但决策层/效果链/变速
曲线与官方逐字节同源。
"""
from __future__ import annotations

import numpy as np

from .pipeline import detect_beats

# 进阶交融洽入口候选的间距档位（小节）。依据：18 组真机实抓
# （.verify/emu_live_captures_2026-09-27.jsonl）间距 1.00~7.98 小节、中位 3.03。
_CUE2_GAP_BARS = 3.0


def local_bpm_and_beats(audio: np.ndarray, sr: int) -> tuple[float, np.ndarray]:
    """本地 BPM + 拍点（librosa）。失败时返回 (120.0, 空数组)。"""
    try:
        times, bpm = detect_beats(audio, sr)
        if not np.isfinite(bpm) or bpm <= 0:
            bpm = 120.0
        return float(bpm), np.asarray(times, dtype=np.float64)
    except Exception:
        return 120.0, np.empty(0, dtype=np.float64)


def _beat_grid_after(beat_times: np.ndarray, start_s: float, step_s: float,
                     n: int) -> list[float]:
    """从 start_s 起按 step_s（一小节）在拍点网格上取 n 个点（吸附最近拍）。"""
    out: list[float] = []
    for i in range(n):
        target = start_s + i * step_s
        if beat_times.size >= 2:
            idx = int(np.argmin(np.abs(beat_times - target)))
            cand = float(beat_times[idx])
        else:
            cand = target
        if cand <= 0:
            continue
        if not out or cand > out[-1] + 1e-3:
            out.append(round(cand, 3))
    return out


def synth_cue_cuts(beat_times: np.ndarray, bpm: float, duration_s: float,
                   tail_s: float = 32.0, n_points: int = 6) -> list[float]:
    """出曲尾部小节对齐切点（官方 cue_cuts 形状：升序秒，~6 点）。

    官方切点 = bar 网格（bar = 4×60/BPM），真机观测相邻切点 ≈ 1 小节
    （如 103.99/105.99/107.99…@120BPM）。取尾部 tail_s 内最后 n_points 个 bar 点。
    """
    if bpm <= 0 or duration_s <= 0:
        return []
    bar = 4 * 60.0 / bpm
    first = max(bar, duration_s - tail_s)
    # 对齐到 bar 网格
    k0 = int(np.ceil(first / bar))
    grid = _beat_grid_after(beat_times, k0 * bar, bar, n_points + 2)
    grid = [g for g in grid if g < duration_s - 0.5]
    return grid[-n_points:] if len(grid) >= 2 else []


def synth_cue_entrys(beat_times: np.ndarray, bpm: float) -> list[float]:
    """入曲头部接入点（官方基础档 cue_entrys 形状：升序秒，~3 点）。

    官方真机形状如 [0.002, 1.95, 4.67]：首点≈0（淡入即开始），
    后续点按 bar/2bar 网格给出回退档位。
    """
    if bpm <= 0:
        return []
    bar = 4 * 60.0 / bpm
    e0 = 0.002 if beat_times.size == 0 else float(max(0.002, min(0.05, beat_times[0])))
    pts = [e0]
    for mult in (0.5, 1.0):
        pts.append(round(_snap(beat_times, e0 + mult * bar), 3))
    # 升序去重（官方升序；半小节点可能与整小节重合）
    out = [pts[0]]
    for p in pts[1:]:
        if p > out[-1] + 1e-3:
            out.append(p)
    return out


def synth_cue2_entrys(beat_times: np.ndarray, bpm: float) -> list[float]:
    """进阶交融洽入口（官方 cue2_entrys 形状：降序 [大, 小, −1, −1]）。

    官方 18 组真机实抓（.verify/emu_live_captures_2026-09-27.jsonl）统计：
      e0 ∈ [3.73, 38.18]s、e1 ∈ [0.00, 23.90]s，间距 (e0−e1) ∈ [2.83, 15.97]s
      = 以入曲 bar(4×60/InBpm) 计 1.00~7.98 小节（中位 3.03，过半落在 2~3.4 小节）。
      间距即 V3 的 x4_dur 来源（x4_dur = (e0−e1)×InBpm_c/Out）→ 直接决定过渡段时长。

    2026-09-27 修订：旧实现取 e0=2 小节、e1=0.5 小节后各自吸附最近拍 —— 遇到节拍
    网格起步晚的曲子（前奏无拍）两值会吸到相邻拍，间距塌成 1 拍：Cold Blood →
    TIME CYCLE 实测 e0=3.773 / e1=2.775（目标曲首拍 2.775s）= 0.5 小节 → 过渡段仅
    1.04s，而官方同曲对 16.64s。现在 e1 取节拍网格起点（音乐实际开始处；官方 e1
    亦为小节级入口，18 组中有 0.00/0.02/0.04 这类近零点），e0 = e1 + 间距档位
    （默认 3 小节 = 实抓中位数），不再吸附，间距不会被网格起步位置吃掉。
    """
    if bpm <= 0:
        return []
    bar = 4 * 60.0 / bpm
    e1 = round(float(beat_times[0]), 3) if beat_times.size else 0.0
    e0 = round(e1 + _CUE2_GAP_BARS * bar, 3)
    if e0 <= e1:                       # 兜底：保证 e1 < e0（V3 校验要求）
        e0 = round(e1 + max(bar, 0.5), 3)
    return [e0, e1, -1.0, -1.0]


def _snap(beat_times: np.ndarray, t: float) -> float:
    if beat_times.size >= 2:
        idx = int(np.argmin(np.abs(beat_times - t)))
        return max(0.0, float(beat_times[idx]))
    return max(0.0, t)

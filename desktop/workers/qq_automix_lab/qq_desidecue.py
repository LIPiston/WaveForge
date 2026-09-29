# -*- coding: utf-8 -*-
"""QQ音乐「智能混音」本地变换 · 官方 transformInfo 终版复刻（2026-09-27 全量反汇编定稿）。

本模块 1:1 复刻官方 `SSAutoMix::transformInfo`（JNI `ss_effector_transform_info`）的
决策层。所有公式来自 libSuperSound3.so (md5 bf4033b3f4fecb7259fc59e346d4ffc2) 逐指令
反汇编 + oracle_pairs.jsonl 11888 行全量回归（输入/输出逐字段命中）+ 真机 3 组过渡
浮点级复现。交接材料五次累计的"已知未知"在本版全部归零。

── 派发（transformInfo 0x41c150-0x41c344，2026-09-27 静态定稿）──────────────
  MixMode == "EQfilter"(len8) / "3bandEQ"(len7) / "NoPlan"(len6)
      → correctBpmOut(0x41058c) 谐波带修正 InBpm → DesideCue v1（0x410900）
        · EQfilter 用候选表 {2,4} 小节（.rodata 0x581f28）
        · 3bandEQ/NoPlan/其它用 {1,2}（0x545f58）
  MixMode == "amfilter2"（reviseMixMode 归一后的缺省）：
      type ∈ [0,4)  → DesideCueV3（0x411d3c，变速档）
      type < 0      → DesideCueV2（0x411398，非变速 amfilter2 变体）
  ⚠ 五次交接更正记录：四次补充曾判 "v1 死代码、基础档=V2"——系 PLT 桩误读。
    2026-09-27 以函数签名比对（.dynsym mangled 名：v1 三个 float 按值 /
    V2 两个 float& 按引用）+ .rela.plt 桩序解析定案：基础档真身 = v1 的
    EQfilter 分支；V2 仅服务 amfilter2+type<0（oracle 160 行浮点级验证）。

── DesideCue v1 · EQfilter 分支（0x410900，基础渐变档执行体）────────────────
  InBpm_c     = correctBpmOut(Out, In)            （带修正，见下）
  posCuts/posEnts = 各自向量过滤 >0；posCuts 空 或 |posEnts|<2 → ret 0
  beat_out = 60/Out；beat_in = 60/In_c
  · |posCuts| == 1（单切点路径，无随机）：
      Δfac = (posEnts[1]−posEnts[0])×In_c/Out；OD = k×Δfac（k=1 起，逐拍累加），
      OutCue = posCuts[0]−Δfac，InCue = posEnts[0]；OD≥0.5 或 OutCue<0 即停；
      k>1 仍不达 → ApplyFallbackLogic("Single cue logic")
  · |posCuts| ≥ 2（主路径，官方随机源 = /dev/urandom 播种 MT19937，每次调用重播种）：
      cand = {2,4}[uniform_int{0,1}]          ← EQfilter 专属 {2,4}；其它表 {1,2}
      钳位：while cand≥2 且 cand+1≥n: cand−−；若仍 cand+1≥n → 终点=最后切点、
            bars=n−2、起点=posCuts[n>2?1:0]（日志 Adjusted bars to fit cue list）
      起点 = posCuts[1]（第 2 个正切点）
      k 循环（k=1..|posEnts|−1，取首个合法解）：
        InCue   = min(posEnts[0], posEnts[k])
        Δfac    = (posEnts[k]−InCue)×In_c/Out
        OD      = (posCuts[终点]−posCuts[起点]) + Δfac
        OutCue  = posCuts[起点] − Δfac
        合法 ⟺ OD≥0.5 且 OutCue≥0 且 InCue≥0（0.5 = transformInfo 传入 thresh）
      全体失败 → ApplyFallbackLogic(0x410784, "All cue2 options")：
        OutCue = 最后正切点 − ceil(0.5/beat_out)×beat_out；InCue = posEnts[1]；OD = 0.5
  后处理（transformInfo 0x41c348）：InDuration = OD×Out÷In_c − 0.0928798
  （0.0928798 = 4096/44100，一块 4096 样本 @44.1kHz，.rodata 0x584480）

── correctBpmOut（0x41058c；amfilter2 直通不修正）──────────────────────────
  r = Out/In：[0.8,1.25) 不变；[1.6,2.5] → In×2；[0.4,0.65] → In×0.5；
  >2.5 → In×2（一次）；<0.4 → In×0.5（一次）；其余（(0.65,0.8)、[1.25,1.6)）不变。
  （V3 的谐波修正 {1/3,1/2,1,2,3} 是另一套，在 V3 函数体内。）

── DesideCueV3（0x411d3c，amfilter2+type∈[0,4)，实测 1536/1536）────────────
  校验：e0>0、e1≥0（0 合法，oracle 实证）、e1<e0、有正切点
  InBpm_c = 谐波选档：候选 Out×{1/3,1/2,1,2,3}，按 ×3,×2,×1,×0.5,÷3 顺序
            最小化 |Out/f−In|÷(Out/f)，严格小于才更新（先到先得）
  x4_dur      = (e0−e1)×InBpm_c÷Out
  OutCue      = 首个正切点 − x4_dur；InCue = e1
  OutDuration = x4_dur×max(1, Out÷InBpm_c)   （amfilter2 OD 变换，0x41c3cc）
  InDuration  = x4_dur×Out÷InBpm_c − 0.0928798

── DesideCueV2（0x411398，amfilter2+type<0，实测 160/160）──────────────────
  校验：|entries|≥4（原始向量）、e0>0、e3>0 ⇒ e1,e2>0、e1≤0 ⇒ e2≤0
  特殊比值带（Out/In ∈ (1.493,1.8) ∪ (0.64,0.85)，double 精度比较）：
      InBpm 带修正（按 In/Out 的镜像带）后：
      OutCue = 首正切点 − 4×60/Out；InCue = e0 − 4×60/In_c（<0 → ret 0）；
      OD = 4×60/Out
  常规路径：InBpm 带修正 → 档位（In_c/Out）：(0.95,1.0526)→entry_1、
      [0.85,1.1765]→entry_2、其余→entry_3（选中 ≤0 → 自 e3 向下扫fallback）；
      Δ = e0−chosen（≤0 → ret 0）；OD = Δ×In_c÷Out；
      OutCue = 首正切点 − OD（<0 → ret 0）；InCue = chosen；
      OD>25 → 自 entry_{w−1} 逐级回退重算（w≥3）
"""
from __future__ import annotations

import json
import math
from pathlib import Path

# ── 常量（全部带出处）────────────────────────────────────────────────────
K_CUE = -0.09287981688976288          # .rodata 0x584480；= −4096/44100（2026-09-27 溯源）
HARMONIC_F = (1 / 3, 1 / 2, 1.0, 2.0, 3.0)   # DesideCueV3 跳转表 0x581f74：候选= InBpm×f
_LEGAL_MODES = ('NoPlan', '3bandEQ', 'EQfilter', 'amfilter2')   # reviseMixMode@0x41a4b8
_V3_GATE_MAX_TYPE = 1                 # SSAutoMixInst ctor 0x40e150: cmp w28,#1; b.hi 跳过改名
_CAND_TABLE_EQFILTER = (2, 4)         # .rodata 0x581f28（EQfilter 分支专属）
_CAND_TABLE_DEFAULT = (1, 2)          # .rodata 0x545f58（其余全部分支）
_THRESH = 0.5                         # transformInfo → DesideCue 第 3 个 float 实参
_SPECIAL_LO, _SPECIAL_HI = 0.64, 0.85         # V2 特殊带（0x581f38/0x541318, double）
_SPECIAL_LO2, _SPECIAL_HI2 = 1.493, 1.8       # V2 特殊带（0x581f30/0x542098, double）

_PRESETS_FILE = Path(__file__).resolve().parent / 'data' / 'qqmusic_djplan_presets_ALL.json'
_MIXMODE_FILE = Path(__file__).resolve().parent / 'data' / 'qqmusic_mixmode_table.json'


# ── 预设名解析（reviseMixMode + ctor 覆盖 + 8 名字表）────────────────────
def revise_mix_mode(name: str) -> str:
    """reviseMixMode@0x41a4b8：只认 4 个合法名（len 6..9 分支），其余一律归一 'amfilter2'。"""
    n = name or ''
    return n if n in _LEGAL_MODES else 'amfilter2'


def resolve_preset_name(mix_mode: str, type_: int | None = None) -> str:
    """setParam → SetPresetDJPlan 实际收到的预设名。

    1) reviseMixMode 归一；2) 'amfilter2' 且 type∈{0,1} → ctor 强制改 'NoPlan'。
    """
    nm = revise_mix_mode(mix_mode)
    if nm == 'amfilter2' and type_ is not None and 0 <= int(type_) <= _V3_GATE_MAX_TYPE:
        return 'NoPlan'
    return nm


_PRESET_CACHE: dict | None = None


def _presets() -> dict:
    global _PRESET_CACHE
    if _PRESET_CACHE is None:
        _PRESET_CACHE = json.loads(_PRESETS_FILE.read_text(encoding='utf8'))
    return _PRESET_CACHE


def preset_blob_for_mix_mode(mix_mode: str, type_: int | None = None) -> tuple[str, dict] | tuple[None, None]:
    """MixMode(+type) → （预设键, 预设 JSON）。查不到返回 (None, None)。"""
    name = resolve_preset_name(mix_mode, type_)
    table = json.loads(_MIXMODE_FILE.read_text(encoding='utf8'))
    key = table.get('legacy:' + name, {}).get('preset')
    # legacy 表里的 preset 是预设 name 字段，不是键名；按名字反查 ALL
    allp = _presets()
    for k, v in allp.items():
        if k.startswith('legacy:') is False and v.get('name') == key and k in (
                'kFilterPresetJson', 'k3bandPresetJson', 'simpleexchange', 'filterEQPresetJson',
                'NoPlanJson', 'EchoDeclineJson', 'AMfilterPlanJson', 'AMfilterPlanJson2'):
            return k, v
    return None, None


# ── correctBpmOut（0x41058c，v1/基础档路径的 InBpm 带修正）────────────────
def correct_bpm_out(out_bpm: float, in_bpm: float, mode: str = '') -> float:
    """SSAutoMixInst::correctBpmOut(0x41058c)。返回修正后 InBpm（官方写回 InBpm 槽）。

    r = Out/In：[0.8,1.25) 不变；[1.6,2.5] → ×2；[0.4,0.65] → ×0.5；
    >2.5 → ×2（一次）；<0.4 → ×0.5（一次）；(0.65,0.8)/[1.25,1.6) 不变（有日志）。
    amfilter2 直通（len==9 名串比较，实际派发不会带 amfilter2 进来）。"""
    if mode == 'amfilter2' or in_bpm <= 0:
        return in_bpm
    r = out_bpm / in_bpm
    if 0.8 <= r < 1.25:
        return in_bpm
    if 1.6 <= r <= 2.5:
        return in_bpm * 2.0
    if 0.4 <= r <= 0.65:
        return in_bpm * 0.5
    if r > 2.5:
        return in_bpm * 2.0
    if r < 0.4:
        return in_bpm * 0.5
    return in_bpm


# ── InBpm 谐波修正（DesideCueV3 内 "Best speed mode"）────────────────────
def correct_in_bpm(in_bpm: float, out_bpm: float) -> float:
    """谐波修正：候选= OutBpm×{1/3,1/2,1,2,3}，按跳转表顺序 ×3,×2,×1,×0.5,÷3
    最小化 |Out/f − In| ÷ (Out/f)，严格小于才更新（先到先得）。"""
    best_f, best_err = 1.0, None
    for f in (3.0, 2.0, 1.0, 0.5, 1 / 3):          # 分支顺序 = 跳转表顺序
        if f == 0:
            continue
        base = out_bpm / f
        if base <= 0:
            continue
        err = abs(base - in_bpm) / base
        if best_err is None or err < best_err:
            best_f, best_err = f, err
    return in_bpm * best_f


def _min_positive(values) -> float | None:
    pos = [v for v in (values or []) if v > 0]
    return min(pos) if pos else None


def _apply_fallback_logic(pos_cuts, pos_ents, out_bpm: float, in_c: float) -> dict | None:
    """ApplyFallbackLogic（0x410784）——DesideCue 全体候选失败后的官方兜底。

    OutCue = 最后正切点 − ceil(0.5/beat_out)×beat_out；InCue = posEnts[1]；
    OutDuration = 0.5（thresh 原值）；InDuration 由 transformInfo 后算。"""
    beat_out = 60.0 / out_bpm
    beats = int(math.ceil(_THRESH / beat_out))
    out_cue = pos_cuts[-1] - beats * beat_out
    if out_cue < 0:
        return None
    return {'InCue': float(pos_ents[1]), 'OutCue': out_cue,
            'OutDuration': _THRESH, 'InDuration': _THRESH * out_bpm / in_c + K_CUE,
            'InBpm': in_c, 'OutBpm': out_bpm, '_fallback': True}


# ── 基础渐变档真身：DesideCue v1 · EQfilter 分支（0x410900）──────────────
def transform_basic(cue_cuts, cue_entrys, in_bpm: float, out_bpm: float,
                    bars: int = 2, mode: str = 'EQfilter') -> dict | None:
    """官方 DesideCue(v1) 复刻 —— 基础渐变档（EQfilter）及 3bandEQ/NoPlan 档执行体。

    bars = 官方 MT19937 抽中的候选值（切点跨度，单位=切点步长）：EQfilter 表
    {2,4}（0x581f28）、其余 {1,2}（0x545f58），官方每次播放 50/50 抽签。
    本地渲染取确定性短窗：EQfilter bars=2、3bandEQ/NoPlan bars=1。

    校验失败返回 None（对应官方 ret=0）。"""
    table = _CAND_TABLE_EQFILTER if mode == 'EQfilter' else _CAND_TABLE_DEFAULT
    cuts = [float(c) for c in (cue_cuts or [])]
    ents = [float(e) for e in (cue_entrys or [])]
    pos_cuts = [c for c in cuts if c > 0]
    pos_ents = [e for e in ents if e > 0]
    if not pos_cuts or len(pos_ents) < 2:
        return None
    if in_bpm <= 0 or out_bpm <= 0:
        return None
    in_c = correct_bpm_out(out_bpm, in_bpm)
    beat_out = 60.0 / out_bpm
    beat_in = 60.0 / in_c

    if len(pos_cuts) == 1:
        # 单切点路径（0x410b3c-0x410ce4）：无随机，OD = k×Δfac 累加至 ≥0.5
        delta = (pos_ents[1] - pos_ents[0]) / beat_in * beat_out
        in_cue = float(pos_ents[0])
        od = 0.0
        out_cue = pos_cuts[0] - delta
        for k in (1, 2):
            od = delta * k
            out_cue = pos_cuts[0] - delta
            if out_cue < 0 or od >= _THRESH:
                break
        else:
            fb = _apply_fallback_logic(pos_cuts, pos_ents, out_bpm, in_c)
            return dict(fb, _local=True) if fb else None
        return {'InCue': in_cue, 'OutCue': out_cue,
                'InDuration': od * out_bpm / in_c + K_CUE, 'OutDuration': od,
                'InBpm': in_c, 'OutBpm': out_bpm, '_local': True}

    n = len(pos_cuts)
    cand = int(bars) if int(bars) in table else table[0]
    c = cand
    while c >= 2 and 1 + c >= n:          # 官方钳位环 0x410f9c
        c -= 1
    if c + 1 >= n:                        # 钳位路径 0x410fd0（Adjusted bars to fit cue list）
        end_idx = max(n - 1, 1)
        start_idx = 1 if n > 2 else 0
    else:
        end_idx = c + 1
        start_idx = 1                     # w28 = (|posCuts|≠1)，主路径恒 1
    span = pos_cuts[end_idx] - pos_cuts[start_idx]

    for k in range(1, len(pos_ents)):     # k 循环 0x411038-0x4111c0
        entry = pos_ents[k]
        in_cue = min(pos_ents[0], entry)  # B_start > cue_entry 警告分支
        dfac = (entry - in_cue) / beat_in * beat_out
        od = span + dfac
        out_cue = pos_cuts[start_idx] - dfac
        if od >= _THRESH and out_cue >= 0 and in_cue >= 0:
            return {'InCue': in_cue, 'OutCue': out_cue,
                    'InDuration': od * out_bpm / in_c + K_CUE, 'OutDuration': od,
                    'InBpm': in_c, 'OutBpm': out_bpm,
                    '_bars': c, '_k': k, '_local': True}
    fb = _apply_fallback_logic(pos_cuts, pos_ents, out_bpm, in_c)
    return dict(fb, _local=True) if fb else None


# ── V3 桶（amfilter2 + type∈[0,4)）───────────────────────────────────────
def transform_v3(in_bpm: float, out_bpm: float, in_cue_entrys, out_cue_cuts,
                 type_: int | None = None) -> dict | None:
    """DesideCueV3（0x411d3c）复刻。校验：e0>0、e1≥0（0 合法）、e1<e0、有正切点。"""
    ent = list(in_cue_entrys or [])
    cuts = list(out_cue_cuts or [])
    if len(ent) < 2:
        return None
    e0, e1 = float(ent[0]), float(ent[1])
    if e0 <= 0 or e1 < 0 or e1 >= e0:
        return None
    pos_cuts = [c for c in cuts if c > 0]
    if not pos_cuts:
        return None
    if in_bpm <= 0 or out_bpm <= 0:
        return None
    in_c = correct_in_bpm(in_bpm, out_bpm)
    x4_dur = (e0 - e1) * in_c / out_bpm
    out_cue = pos_cuts[0] - x4_dur
    # amfilter2 OD 变换（transformInfo 0x41c3cc）：Out>In_c 时 OD ×= Out/In_c
    od = x4_dur * (out_bpm / in_c if out_bpm > in_c else 1.0)
    return {'InCue': e1, 'OutCue': out_cue,
            'InDuration': x4_dur * out_bpm / in_c + K_CUE, 'OutDuration': od,
            'InBpm': in_c, 'OutBpm': out_bpm,
            'Type': int(type_) if type_ is not None else None, '_local': True}


# ── V2 桶（amfilter2 + type<0，0x411398）─────────────────────────────────
def transform_v2(cue_cuts, cue_entrys, in_bpm: float, out_bpm: float) -> dict | None:
    """DesideCueV2（0x411398）复刻 —— amfilter2 且 type<0 的官方变体。

    与 v1 的关键差异：无随机、无 {2,4} 候选表；entries 需 4 槽且
    Δ = e0 − chosen > 0（档位选中 entries[1/2/3]）；含特殊比值带快速路径。"""
    cuts = [float(c) for c in (cue_cuts or [])]
    ents = [float(e) for e in (cue_entrys or [])]
    if len(ents) < 4:
        return None
    if not any(c > 0 for c in cuts):
        return None
    if in_bpm <= 0 or out_bpm <= 0:
        return None
    e = ents
    if e[0] <= 0:
        return None
    if e[3] > 0 and (e[1] <= 0 or e[2] <= 0):
        return None
    if e[1] <= 0 and e[2] > 0:
        return None
    first_cut = next(c for c in cuts if c > 0)
    in_c = correct_bpm_out(out_bpm, in_bpm)

    d0 = out_bpm / in_bpm
    special = (_SPECIAL_LO2 < d0 < _SPECIAL_HI2) or (_SPECIAL_LO < d0 < _SPECIAL_HI)
    if special:
        # 特殊带内的镜像修正（0x41159c 块，作用于 InBpm 槽，带基准 = In/Out）
        s10 = in_bpm / out_bpm
        in_c2 = in_bpm
        if s10 >= 1.25 or s10 < 0.8:
            if 1.6 <= s10 <= 2.5:
                in_c2 = in_bpm * 2.0
            elif 0.4 <= s10 <= 0.65:
                in_c2 = in_bpm * 0.5
            elif s10 > 2.5:
                in_c2 = in_bpm * 2.0
            elif s10 < 0.4:
                in_c2 = in_bpm * 0.5
        bar_out = 4 * 60.0 / out_bpm          # 4×60/[x25]（Out 槽，不修正）
        bar_in = 4 * 60.0 / in_c2             # 4×60/[x24]（In 槽，修正后）
        out_cue = first_cut - bar_out
        in_cue = e[0] - bar_in
        if in_cue < 0:
            return None
        od = bar_out
        # amfilter2 OD 变换（transformInfo 0x41c3cc）：Out>In_c 时 OD ×= Out/In_c
        od_final = od * (out_bpm / in_c2 if out_bpm > in_c2 else 1.0)
        return {'InCue': in_cue, 'OutCue': out_cue,
                'InDuration': od * out_bpm / in_c2 + K_CUE, 'OutDuration': od_final,
                'InBpm': in_c2, 'OutBpm': out_bpm, '_special': True, '_local': True}

    r2 = out_bpm / in_c
    if 0.95 < r2 < 1.0526:
        w = 1
    elif 0.85 <= r2 <= 1.1765:
        w = 2
    else:
        w = 3
    chosen = e[w]
    if chosen <= 0:
        w = None
        for idx in (3, 2, 1):
            if e[idx] > 0:
                w = idx
                break
        if w is None:
            return None
        chosen = e[w]
    if w < 1 or chosen <= 0:
        return None
    beat_out = 60.0 / out_bpm                 # [sp+0x10] = 60/[x25]
    beat_in = 60.0 / in_c                     # [sp+0x14] = 60/[x24]
    d = e[0] - chosen
    if d <= 0:
        return None
    od = d / beat_in * 0.25 * 4 * beat_out    # bars×4×beat_out = Δ×In_c/Out
    out_cue = first_cut - od
    if out_cue < 0:
        return None
    # 25s 上限逐级回退（0x411a68-0x411b6c）
    while od > 25.0 and w >= 3:
        prev = e[w - 1]
        if prev <= 0:
            break
        d2 = e[0] - prev
        if d2 <= 0:
            break
        od2 = d2 / beat_in * 0.25 * 4 * beat_out
        if first_cut - od2 < 0:
            break
        w -= 1
        chosen = prev
        od = od2
        out_cue = first_cut - od2
    return {'InCue': chosen, 'OutCue': out_cue,
            'InDuration': od * out_bpm / in_c + K_CUE,
            'OutDuration': od * (out_bpm / in_c if out_bpm > in_c else 1.0),
            'InBpm': in_c, 'OutBpm': out_bpm, '_local': True}


# ── 旧 v1 桶名（3bandEQ / NoPlan / 兼容入口）────────────────────────────
def transform_v1(in_bpm: float, out_bpm: float, in_cue_entrys, out_cue_cuts,
                 bars: int = 1) -> dict | None:
    """DesideCue(v1) 非 EQfilter 分支（3bandEQ/NoPlan/echo/simpleexchange…）。

    与 EQfilter 分支唯一差异：候选表 = {1,2}（0x545f58），bars 默认取 1。"""
    return transform_basic(out_cue_cuts, in_cue_entrys, in_bpm, out_bpm, bars=bars)


# 兼容别名：四次补充曾把基础档执行体误记为 "DesideCueV2"；本名保留指向真身。
def transform_v2_basic(cue_cuts, cue_entrys, in_bpm: float, out_bpm: float) -> dict | None:
    """（兼容别名）= transform_basic。基础档真身 = DesideCue(v1) EQfilter 分支。"""
    return transform_basic(cue_cuts, cue_entrys, in_bpm, out_bpm, bars=2)


# ── 分桶派发（transformInfo 0x41c150-0x41c344 的等价实现）─────────────────
def transform_mix_plan(mix_plan: dict) -> dict | None:
    """输入 MixPlan/TransformInAutoMixInfo dict：
    {InBpm, OutBpm, InCueEntrys[], OutCueCuts[], MixMode[, type]}
    输出 TransformOutAutoMixInfo dict（InCue/OutCue/InDuration/OutDuration/InBpm/OutBpm）；
    校验失败返回 None（对应官方 ret=0）。"""
    if not mix_plan:
        return None
    in_bpm = float(mix_plan.get('InBpm') or 0)
    out_bpm = float(mix_plan.get('OutBpm') or 0)
    ent = [float(x) for x in (mix_plan.get('InCueEntrys') or [])]
    cuts = [float(x) for x in (mix_plan.get('OutCueCuts') or [])]
    mode = mix_plan.get('MixMode') or ''
    type_ = mix_plan.get('type')
    if in_bpm <= 0 or out_bpm <= 0:
        return None
    name = revise_mix_mode(mode)
    if name == 'amfilter2':
        if type_ is not None and int(type_) < 0:
            # isValueSpeedType@0x40f928 无符号比较：type<0 → V2
            t = transform_v2(cuts, ent, in_bpm, out_bpm)
            return dict(t, Type=-1) if t else None
        t = transform_v3(in_bpm, out_bpm, ent, cuts, type_=type_)
        return t
    # EQfilter / 3bandEQ / NoPlan → DesideCue(v1)：
    #   EQfilter 候选表 {2,4}（取 2 = 短窗确定性变体）；其余 {1,2}（取 1）
    bars = 2 if name == 'EQfilter' else 1
    t = transform_basic(cuts, ent, in_bpm, out_bpm, bars=bars)
    if t is not None:
        t.setdefault('Type', -1 if type_ is None else int(type_))
    return t


def to_am_enable_date(mix_plan: dict) -> dict | None:
    """等价官方 AutoMixEnableDate（n$c.b/n$i$a.b 的构造顺序）。"""
    t = transform_mix_plan(mix_plan)
    if t is None:
        return None
    return {
        'InSongKey': 0, 'OutSongKey': 0, 'Enable': True, 'IsFadeIn': True,
        'MixMode': resolve_preset_name(mix_plan.get('MixMode') or '',
                                       int(mix_plan['type']) if mix_plan.get('type') is not None else None),
        'InBpm': t['InBpm'], 'OutBpm': t['OutBpm'],
        'InCue': t['InCue'], 'OutCue': t['OutCue'],
        'InDuration': t['InDuration'], 'OutDuration': t['OutDuration'],
        'CurTime': 0.0, 'type': int(mix_plan.get('type') or -1),
    }

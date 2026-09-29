"""AutoMix Lab —— 三种平台方案

每个方案的每个环节都对应到**逆向证据**，不做无依据推测。

证据文件与关键符号：
  QQ音乐:  libSuperSound3.so → QMCPCOM::AUTOMIX 命名空间
  网易云:  libneaudioeffects.so → RubberBandStretcher::Impl
           libncmaudioplayer.so → CNCMAudioPlayer
"""

from __future__ import annotations

import numpy as np

from .effects import (TrackEffects, bass_swap, echo, filter_sweep, highpass,
                      lowpass, ms_process, three_band_eq, _env)
from .djplan import (DjPlan, apply_dj_plan, tier_presets, load_presets,
                     load_official_presets, apply_chain)
from .cloud_recipe import _am_preset, _tempo_mean_speed
from .engines.registry import Engine, get_engine, fix_length
from .pipeline import equal_power


def _filter_eq_preset() -> dict | None:
    """官方基础渐变渲染链 = filterEQPresetJson（MixMode=EQfilter）。

    2026-09-26/27 定稿：真机基础档默认 MixMode=EQfilter（3BAND arr[0]=−28 指纹），
    SetPresetDJPlan("EQfilter") → filterEQPresetJson@0x57adbd —— 旧 NoPlanJson
    为过时认知。取 so .rodata 权威 blob（与云端档同源）。"""
    official = load_official_presets()
    return official.get('_ZN7QMCPCOM7AUTOMIX18filterEQPresetJsonE')



def tempo_matched_windows(src, tgt, engine, sr, window_s, trace=None):
    """官方语义：源轨保持原速（2026-09-24 逆向修正，官方无变速）。

    此前按整窗一次匀速 BPM 匹配拉伸（factor=bpm_src/bpm_tgt）——错误。
    决定性证据：
      - libSuperSound3.so SoundTouch::setTempo/setRate 无任何调用者（仅链接符号）
      - SSAutoMixInst::processInSoundTouch@0x412240 反汇编 = M/S 立体声变换，非变速
      - 官方录音 QQ20260924-011149 log-mel 时基扫描：原速 corr 169.6 >> 2x 加速 132.0
    因此两轨均取等长窗口，tgt 稳健对齐。
    """
    win = int(window_s * sr)
    s_win = src[:, -win:]
    t_win = tgt[:, :win]
    total = min(s_win.shape[1], t_win.shape[1])
    so = s_win[:, :total].astype(np.float32)
    to = t_win[:, :total].astype(np.float32)
    meta = {'stretch_factor': 1.0, 'segments': 1,
            'note': '官方无变速（逆证实，setTempo 无调用者 + 录音时基原速胜出）'}
    return so, to, meta


def _seam_smooth(audio, seams, sr, ms):
    if ms <= 0:
        return audio
    k = max(1, int(ms / 1000 * sr))
    out = audio.copy()
    for p in seams[:-1]:
        a, b = max(0, p - k), min(out.shape[1], p + k)
        if b > a:
            w = np.linspace(0, np.pi, b - a)
            out[:, a:b] *= (0.90 + 0.10 * np.cos(w))[None, :]
    return out


def _env_linear(n):
    return np.linspace(0, 1, n).astype(np.float32)


def _equal_power_total(total):
    return equal_power(total)


# ── 方案一：QQ音乐版（两档可切）───────────────────────────────────────────
# 2026-09-27 终版加强（五次补充材料 §一~§九 全量落地到本地仿制）：
#   ① 数据层：librosa 本地节拍检测 → local_cues 合成官方 MIR 形状 cue
#      （cue_cuts 小节网格 / cue_entrys 升序 / cue2_entrys 降序 4 槽）——纯本地零云端；
#   ② 决策层：跑真正的官方 DesideCue 算法（qq_desidecue.transform_basic /
#      transform_v3，oracle 11888 行 0 未命中版本）——基础档 {2,4} 小节候选、
#      correctBpmOut 带修正、ApplyFallbackLogic 兜底全部生效；
#      决策失败回退旧固定窗（window_s）；
#   ③ 预设修正：基础档 NoPlanJson → **filterEQPresetJson**（官方基础档真身
#      MixMode=EQfilter，3BAND arr[0]=−28 指纹；旧 NoPlanJson 为过时认知）；
#   ④ 变速：官方连续变速曲线（cloud_recipe._official_tempo_stretch，
#      processInSoundTouch 0x412240 + marathon 1418 次实测互证）默认启用，
#      旧"官方无变速"结论已推翻；
#   ⑤ 交叉窗：官方语义 blend = max(InDuration, OutDuration)，
#      InDuration = OD×Out/In_c − 0.0928798（=4096/44100，一块音频）。
#      过渡长度全权由决策给出，**不受 UI 窗口参数 window_s 封顶**；
#      仅当素材（源/目标轨剩余）装不下时才收缩，且收缩会写进 meta 并告警。

def _measure_target_consumed(stretched, tgt_audio, t_start, nominal_s, sr,
                             q_s=0.6, search_s=0.8):
    """实测"变速后目标窗尾部"落在目标曲的哪个位置 → 实际消耗秒数。

    引擎每次调用都带内部延迟/量化，内容推进不会精确等于名义映射
    （实测：温和比率差 ~0.005s，激进比率（In/Out=0.75）累计差 ~0.25s）。
    完整版接缝必须按**实际**位置接续，故这里直接用一段相关性量出来；
    相关度不足/素材过短时回退名义值。
    """
    n = stretched.shape[1]
    qn = int(min(q_s * sr, n))
    if qn < int(0.15 * sr):
        return round(nominal_s, 4)
    q = stretched.mean(axis=0)[n - qn:].astype(np.float64)
    q = q - q.mean()
    ref = tgt_audio.mean(axis=0).astype(np.float64)
    end_nom = t_start + int(round(nominal_s * sr))
    a = max(0, end_nom - int(search_s * sr) - qn)
    b = min(len(ref), end_nom + int(search_s * sr))
    seg = ref[a:b]
    if seg.shape[0] <= qn + 16:
        return round(nominal_s, 4)
    N = 1 << int(np.ceil(np.log2(seg.shape[0] + qn)))
    c = np.fft.irfft(np.fft.rfft(seg, N) * np.conj(np.fft.rfft(q, N)), N)[:seg.shape[0] - qn + 1]
    i = int(np.argmax(c))
    consumed = (a + i + qn - t_start) / sr
    # 上界 = 目标轨剩余素材（不是窗长：目标轨加速时实际消耗会超过窗长）
    return round(min(max(consumed, 0.0), max(0.0, (ref.shape[0] - t_start) / sr)), 4)


def render_qqmusic(src, tgt, engine, sr, window_s, n_beats, ramp,
                   crossfade, seam_ms, tier='advanced', trace=None):
    from .qq_desidecue import transform_basic, transform_v3
    from .local_cues import (local_bpm_and_beats, synth_cue_cuts,
                             synth_cue_entrys, synth_cue2_entrys)

    # ── 官方决策层（本地 cue 合成 + 官方 DesideCue）────────────────────────
    duration_s = src.shape[1] / sr
    src_bpm, src_beats = local_bpm_and_beats(src, sr)
    tgt_bpm, tgt_beats = local_bpm_and_beats(tgt, sr)
    decision = None
    decision_meta = {}
    blend_clamped = None
    timeline: dict = {}
    try:
        if tier == 'basic':
            cuts = synth_cue_cuts(src_beats, src_bpm, duration_s)
            entrys = synth_cue_entrys(tgt_beats, tgt_bpm)
            t = transform_basic(cuts, entrys, tgt_bpm, src_bpm,
                                bars=2, mode='EQfilter')
        else:
            cuts = synth_cue_cuts(src_beats, src_bpm, duration_s)
            entrys = synth_cue2_entrys(tgt_beats, tgt_bpm)
            t = transform_v3(tgt_bpm, src_bpm, entrys, cuts, type_=3)
        if t is not None:
            out_cue = float(t['OutCue'])
            in_cue = float(t['InCue'])
            od = float(t['OutDuration'])
            idur = float(t['InDuration'])
            # 过渡长度全权由官方决策给出：不再受 UI 窗口参数 window_s 封顶
            # （window_s 只属于固定窗回退档，旧实现在决策档也拿它当上限，
            #  会把算法本可更长的过渡截短 = UI 参数越权干预决策）。
            # 唯一保留的是素材物理约束：源轨剩余 / 目标轨剩余装不下该窗时按上限收缩，
            # 并显式记录 + 告警（不静默改写算法输出）；收缩后不足 0.5s 判决策无效。
            blend = max(od, idur)
            fit_s = min(duration_s - out_cue, tgt.shape[1] / sr - in_cue)
            blend_clamped = None
            if blend > fit_s:
                blend_clamped = {'blend_decided': round(blend, 3),
                                 'blend_used': round(max(0.0, fit_s), 3),
                                 'limit': '素材可用长度（源轨剩余/目标轨剩余）'}
                blend = fit_s
            if out_cue >= 0 and od >= 0.5 and blend >= 0.5:
                decision = (out_cue, in_cue, blend)
                decision_meta = {
                    'decision': 'official DesideCue (local cues)',
                    'src_bpm_local': round(src_bpm, 4), 'tgt_bpm_local': round(tgt_bpm, 4),
                    'in_bpm_c': t['InBpm'], 'out_bpm': t['OutBpm'],
                    'out_cue': round(out_cue, 3), 'in_cue': round(in_cue, 3),
                    'out_duration': round(od, 3), 'in_duration': round(idur, 3),
                    'blend': round(blend, 3),
                    'cue_cuts_synth': cuts, 'cue_entrys_synth': entrys,
                    **({'blend_clamped': blend_clamped} if blend_clamped else {}),
                }
    except Exception as e:                                # 决策失败不致命
        decision_meta = {'decision_error': str(e)}
    in_bpm_c = float(decision_meta.get('in_bpm_c') or tgt_bpm)
    out_bpm = float(decision_meta.get('out_bpm') or src_bpm)
    if decision is not None:
        out_cue, in_cue, blend_s = decision
        # 秒级时间轴（键名与云端档 cloud_recipe.render_from_am_enable_date 的 meta 约定
        # 一致，供 server._make_full_preview / 前端时间条共用同一套语义）
        timeline = {'transition_start_s': out_cue,           # 源轨过渡起点
                    'transition_duration_s': blend_s,        # 过渡段时长
                    'source_cut_time_s': out_cue + blend_s,  # 源轨切点（过渡完成点）
                    'target_start_s': in_cue,                # 目标轨接入口
                    # 目标轨实际被消耗的素材长度（完整版后曲的接续点 = in_cue + 此值）。
                    # 变速后 ≠ 过渡段渲染长度：目标轨在窗内减速 → 消耗 < blend，
                    # 若仍按 blend 接续会在接缝处跳过 blend×(1−mean_speed) 的目标曲素材。
                    'target_consumed_s': blend_s,
                    'out_cue_s': out_cue, 'in_cue_s': in_cue, 'blend_len_s': blend_s}
        win = int(blend_s * sr)
        # 切点直接用决策值：上面的素材约束已保证窗口落在两轨之内，此处不再二次夹取
        # （旧的 sr//4 兜底夹取会在极端情况下静默挪动 OutCue/InCue）。
        s_start = max(0, int(out_cue * sr))
        t_start = max(0, int(in_cue * sr))
        # 变速输入余量：速度曲线里源轨加速（需 > 窗长 的输入）、目标轨减速（< 窗长），
        # 多取的部分由 _official_tempo_stretch 在输出域裁掉，不进最终音频。
        s_take = int(win * _tempo_mean_speed(in_bpm_c, out_bpm, False)) + sr // 4
        t_take = int(win * _tempo_mean_speed(in_bpm_c, out_bpm, True)) + sr // 4
        so = src[:, s_start:min(src.shape[1], s_start + max(win, s_take))].astype(np.float32)
        to = tgt[:, t_start:min(tgt.shape[1], t_start + max(win, t_take))].astype(np.float32)
        total = win
        tmeta = {'segments': 1, **decision_meta, 'window_source': 'official DesideCue'}
        if blend_clamped and trace is not None:
            trace.warn('transition', f'算法过渡段 {blend_clamped["blend_decided"]}s 超出素材可用长度，'
                                     f'已收缩至 {blend_s:.2f}s（源/目标轨剩余不足）')
    else:
        so, to, tmeta = tempo_matched_windows(src, tgt, engine, sr, window_s, trace)
        tmeta = {**tmeta, 'window_source': 'fixed window (decision fallback)',
                 'fallback': '本地 cue 决策未产出 → 固定窗（源尾→目标头）'}
        total = so.shape[1]

    # 官方变速曲线（processInSoundTouch 0x412240 + marathon 实测；两轨相向渐变，
    # 交棒点有效 BPM 均为 In_c）。**必须在预设链之前**：官方效果链跑在混音输出域，
    # automation 0→1 铺满过渡窗，先变速后套链才能让扫频/增益与输出时间轴对齐；
    # 变速本身按输出域映射（输出长度恒 = total，无补零 → 不会出现半段静音）。
    if engine is not None and abs(in_bpm_c / out_bpm - 1.0) > 1e-3:
        try:
            from .cloud_recipe import _official_tempo_stretch
            so = _official_tempo_stretch(so, sr, in_bpm_c, out_bpm, False, engine.fn, out_len=total)
            to = _official_tempo_stretch(to, sr, in_bpm_c, out_bpm, True, engine.fn, out_len=total)
            tmeta['tempo_curve'] = 'official lerp(Out,In_c,t)/(role) 输出域分段变速'
            tmeta['stretch_factor'] = round(in_bpm_c / out_bpm, 3)   # 交棒点净比率（UI 展示）
            if timeline:      # 变速改变目标轨素材消耗量 → 完整版接续点按实测值修正
                nominal = timeline['blend_len_s'] * _tempo_mean_speed(in_bpm_c, out_bpm, True)
                measured = _measure_target_consumed(to, tgt, t_start, nominal, sr)
                timeline['target_consumed_s'] = measured
                tmeta['target_consumed_nominal_s'] = round(nominal, 4)
        except Exception as e:
            tmeta['tempo_curve_error'] = str(e)
    so, to = so[:, :total], to[:, :total]

    # 官方预设全链：进阶=AMfilterPlanJson2；基础=filterEQPresetJson（2026-09-26 真机指纹修正）
    preset = _am_preset() if tier == 'advanced' else _filter_eq_preset()
    if preset is not None:
        so = apply_chain(so, sr, preset.get('Achain', {}))
        to = apply_chain(to, sr, preset.get('Bchain', {}))

    # 官方交叉语义（SSAutoMixInst::processInEffect@0x40d054 反汇编实证）：
    #   ramp[k] = 0.5·(1 − cos(2π·k/(2n−1))) = sin²(π·k/(2n−1))，单数组 [this+0x628] 分半：
    #   源轨用后半 1→0 渐出，目标轨用前半 0→1 渐入。
    Ntot = 2 * total
    kk = np.arange(Ntot, dtype=np.float32)
    ramps = 0.5 * (1.0 - np.cos(2.0 * np.pi * kk / (Ntot - 1)))
    gs = ramps[total:]   # 源轨渐出 1→0
    gt = ramps[:total]   # 目标轨渐入 0→1

    mixed = so * gs[None, :] + to * gt[None, :]
    mixed = ms_process(mixed, sr, side_gain_db=1.0)

    return mixed.astype(np.float32), {
        'tier': tier,
        'preset': ('AMfilterPlanJson2' if tier == 'advanced' else 'filterEQPresetJson'),
        'crossfade': '官方sin²分半窗(0.5·(1−cos2πt))',
        'mix_mode': 'amfilter2' if tier == 'advanced' else 'EQfilter',
        'cue_source': ('本地合成 cue（librosa 节拍 → 官方形状，零云端）' if timeline
                       else '固定窗回退（本地决策未产出）'),
        'source_bpm': round(src_bpm, 2), 'target_bpm': round(tgt_bpm, 2),
        'target_entry_s': timeline.get('in_cue_s'),
        **timeline, **tmeta,
    }


# ── 方案二：网易云版 ──────────────────────────────────────────────────────

def render_netease(src, tgt, engine, sr, window_s, n_beats, ramp,
                   crossfade, seam_ms, trace=None):
    """网易云本地方案 —— 与云端官方方案共用同一渲染管线（值级证据实装）。

    2026-09-21 深挖（frida + 真机 + 模拟器, 见 docs/evidence-q012）后, 旧版
    "_env 分段 + lowpass 2800Hz 固定低通 + reverb" 为无依据近似, 已删除。
    现与 netease_cloud（official 组）共用 _build_fine_local_model/_render_model:
      精细档 = 4 小节窗口（60/BPM×16拍）+ r_exp/log 抛物线音量 + EQ 80ms 对数
      扫频 Q=0.5（出曲 high_pass 20→20000 / 入曲 low_pass 20→20000）+ beat
      1-2-3-4；窗口放不下时自动回退基本档 2000ms/41点/50ms/固定S表。
    差异仅在本方案无网络层（local_synth 占位）, 引擎参数由 _render_model 引用。
    """
    from .netease_cloud import fetch_mix_info, render_cloud
    payload = fetch_mix_info('local-netease')
    audio, meta = render_cloud(src, tgt, engine, sr, payload, f'{id(src):x}|{id(tgt):x}')
    meta = dict(meta)
    meta['curves'] = ['r_exp/log parabola', 'eq sweep (biquad Q=0.5)']
    meta['render_source'] = 'netease_cloud._render_model (shared with official tier)'
    return audio.astype(np.float32), meta


# ── 方案三：优化版 ────────────────────────────────────────────────────────

def render_optimized(src, tgt, engine, sr, window_s, n_beats, ramp,
                     crossfade, seam_ms, trace=None):
    so, to, tmeta = tempo_matched_windows(src, tgt, engine, sr, window_s, trace)
    total = so.shape[1]
    meta_bpm = tmeta

    so, to = bass_swap(so, to, sr, split_hz=180.0, swap_at=0.50, width=0.12, order=4)

    sweep = filter_sweep(so, sr, start_hz=100, end_hz=800, stages=4, wet=0.7)
    w = _env(total, [(0, 0), (0.55, 0.1), (0.85, 0.6), (1, 0.85)])
    so = so * (1 - w) + sweep * w

    open_env = _env(total, [(0, 0), (0.4, 0.15), (0.8, 0.8), (1, 1)])
    to_lp = lowpass(to, sr, 2600)
    to = to_lp * (1 - open_env) + to * open_env

    if crossfade == 'linear':
        gs, gt = 1 - np.linspace(0, 1, total), np.linspace(0, 1, total)
    else:
        gs, gt = _equal_power_total(total)

    mixed = so * gs[None, :] + to * gt[None, :]
    mixed = ms_process(mixed, sr, side_gain_db=1.0, side_hp_hz=120.0)
    return mixed.astype(np.float32), {
        'bass_swap_order': 4, 'sweep_stages': 4, **meta_bpm,
    }


# ── 注册表 ────────────────────────────────────────────────────────────────
# group 分组（UI 与 /api/recipes 共用）：
#   official — 与官方机制同源（QQ 云端 MixPlan+MIR / 网易云 song_feature 云端下发+本地执行）
#   fused    — WaveForge 融合优化版（QQ 决策 × 网易云渲染 × 自研引擎）
#   local    — 本地近似/组合对照（GPL 替代衡量：audiotsm/自实现 wsola 等）

RECIPES = {
    'qqmusic_advanced': {
        'name': 'QQ音乐 · 官方智能混音（进阶交融 · 本地镜像）',
        'group': 'local',
        'source': 'libSuperSound3.so → 本地 cue 合成 + 官方DesideCue(V3) + AMfilterPlanJson2 全链（零云端）',
        'default_engine': 'audiotsm_wsola',
        'fn': render_qqmusic, 'tier': 'advanced',
        'local_mirror': True,   # 零云端：本地 cue 合成 + 官方决策；完整版按决策时间轴
        'evidence': {
            'decision': '本地 cue2 合成（降序4槽）→ 官方 DesideCueV3 原算法（qq_desidecue，oracle 1536/1536）',
            'stretch': '官方连续变速曲线 lerp(Out,In_c,t)/(role)（0x412240 + marathon 1418 次实测）',
            'preset': '官方 AMfilterPlanJson2 全链：Achain gain custom+LPF 20k→2.3k 扫频+low EQ step；Bchain gain custom+HPF 10k→20 扫频+low EQ step（预设 JSON 实证）',
            'crossfade': '官方两档共用 sin² 分半窗 ramp[k]=0.5·(1−cos2πk/(2n−1))（SSAutoMixInst ctor@0x40e630 + processInEffect@0x40d054 反汇编实证；目标轨用前半渐入/源轨用后半渐出）',
            'effects': 'HP/LP/ThreebandEQ/Gain（EffectParamBase 模板参数）',
            'smooth': 'processInSmooth + smoothJumpFrame',
            'fallback': '本地节拍检测/决策失败时回退固定窗',
        },
    },
    'qqmusic_basic': {
        'name': 'QQ音乐 · 官方智能混音（基础渐变 · 本地镜像）',
        'group': 'local',
        'source': 'libSuperSound3.so → 本地 cue 合成 + 官方DesideCue(v1·EQfilter) + filterEQPresetJson 全链（零云端）',
        'default_engine': 'audiotsm_wsola',
        'fn': render_qqmusic, 'tier': 'basic',
        'local_mirror': True,   # 零云端：本地 cue 合成 + 官方决策；完整版按决策时间轴
        'evidence': {
            'decision': '本地 cue 合成（cuts 小节网格 + entrys 升序3点）→ 官方 DesideCue(v1) EQfilter 分支原算法（候选{2,4}小节、correctBpmOut 带修正、ApplyFallbackLogic 兜底；oracle 8640 行 0 未命中）',
            'preset': '官方 filterEQPresetJson 全链（2026-09-26 真机指纹修正：基础档默认 MixMode=EQfilter，3BAND arr[0]=−28；Achain gain 0→−20dB exp + low 0→−28@0.5 + type-3 LPF 10→4000Hz exp 扫频；Bchain gain −20→0dB log + low −28→0 + type-2 HPF 20→8000Hz linear）',
            'crossfade': '官方两档共用 sin² 分半窗（与进阶交融同一 ramp）',
            'stretch': '官方连续变速曲线（两轨相向渐变，交棒点有效 BPM=In_c）',
            'mixmode': 'MixMode=EQfilter（真机 k.p 实抓 strategy=PLAY_STRATEGY_AUTO_MIX + autoMixType=EQfilter）',
        },
    },
    'netease': {
        'name': '网易云 · 本地方案（精细档值级实装）',
        'group': 'local',
        'source': '本地 RubberBand 重建 + 精细档值级实装（evidence-q012，与官方组共用渲染管线）',
        'default_engine': 'rubberband_r3',
        'fn': render_netease,
        'evidence': {
            'stretch_evidence': 'RubberBandStretcher::setTimeRatio / setPitchScale / setKeyFrameMap',
            'player_evidence': 'CNCMAudioPlayer::doCrossFadeSource / SetCrossFadeTime',
            'fine_tier': '精细档已值级实装（frida 证据闭合）：4 小节窗口(60/BPM×16拍) + r_exp/log 抛物线音量(50ms 网格+终点, rec0=128 点零误差) + EQ 80ms 对数扫频 Q=0.5(出曲 high_pass 20→20000 / 入曲 low_pass 20→20000) + beat 1-2-3-4 循环',
            'fallback': '窗口 <2000ms 自动回退基本档：crossfade 恒 2000ms、41 点/50ms 固定查表 S 曲线',
        },
    },
    'netease_cloud': {
        'name': '网易云 · 官方智能过渡（云端 song_feature + 本地执行）',
        'group': 'official',
        'source': '深挖取证（NETEASE-AUTOMIX-EVIDENCE-2026-09-21 §3/§11.5）：transitionAutoMix → getSongFeatureWithCallback 云端下发 song_a/song_b 全量曲线 → cl0/e.z()/e$b.invoke() 本地反序列化组装；/api/playlist/mix/info 确认伪造',
        'default_engine': 'rubberband_r3',
        'fn': None,
        'is_cloud': True,
        'evidence': {
            'architecture': '云端 song_feature 决策 + A() 19 键逐键反序列化透传（无本地曲线计算）；Lcl0/e::m 仅 transitionCrossFade 兜底 ORIGINAL_CROSSFADE',
            'model': 'MusicMixInfo{crossfade/volume/tempo/beat/eq} + AutoMixParams + CustomMixedResult',
            'value_level': '基本档值级实锤（frida 3 组样本）：crossfade 恒 2000ms、volume 41 点/50ms、固定查表 S 曲线 r_s-line+s-line 互补、ui_animate ±2s、silence=mix_end/mix_start、eq none/-1、beat/tempo 空',
            'fine_tier': '精细档已值级实装（evidence-q012 T1/T3/T4）：4 小节窗口(60/BPM×16拍) + r_exp/log 抛物线音量 + EQ 80ms 对数扫频 Q=0.5(FT=1 步进比≈1.778=10^(1/4), FT=0≈1.359) + beat 1-2-3-4；rec0=128 点/rec1=40 点全点零误差闭合；方向以真机 frida 实测为准（出曲高通上扫/入曲低通上扫，EqItem 仅参考结构）',
            'fake_endpoint_removed': '/api/playlist/mix/info 为伪造端，已删除',
        },
    },
    'optimized': {
        'name': '自主优化版（本地进阶方案）',
        'group': 'local',
        'source': '本项目（修 QQ音乐/网易云共有弱点 + 实测缺陷）',
        'default_engine': 'wsola_sync',
        'fn': render_optimized,
        'evidence': {
            'fix_stereo': '多声道同步 WSOLA（修实测中侧比 11.6→1.4dB 塌陷）',
            'fix_transient': 'WSOLA 相似度搜索（修实测瞬态损失 46%）',
            'fix_bassswap': '4 阶分频（修 2 阶 @180Hz 泄漏到 700Hz）',
            'fix_sweep': '连续插值扫频（修三段固定截止的听感台阶）',
            'fix_seam': '接缝短交叉（修逐拍拼接的相位跳变）',
            'fix_ms': 'MS 域轻处理（保持声场开阔）',
            'license': '全部宽松/自有',
        },
    },
    'qqmusic_cloud': {
        'name': 'QQ音乐 · 官方智能混音（基础渐变）',
        'group': 'official',
        'source': 'music.mir.MixPlanSvr + MirProxy（云端 MixPlan + MIR 数据）',
        'default_engine': 'audiotsm_wsola',
        'fn': None,  # 需要云端调用，在 server.py 里特殊处理
        'is_cloud': True,
        'evidence': {
            'mixplan': 'music.mir.MixPlanSvr::Build → OutCueCuts(beat)/InBpm/OutBpm/MixMode/InCueEntrys(秒)/type',
            'mir': 'MirProxy GetMIRByTrackIds 双请求实锤：bid=24(bpm/beats/chords) + bid=23 CUE_POINT_INFO(cue_cuts/cue_entrys，秒)',
            'preset': 'MixMode → libSuperSound3.so 内嵌 DJ 方案 JSON 的本地 DSP 重建',
            'cue': 'MIR cue_cuts(秒源切出) + cue_entrys(秒目标切入)；MixPlan OutCueCuts(beat)/InCueEntrys(秒) 兜底',
            'note': '云端数据真实；SoundTouch/DJPlan 为本地近似执行，不声称逐采样一致',
            'requires': 'QQ音乐登录 cookie',
        },
    },
    'qqmusic_cloud_advanced': {
        'name': 'QQ音乐 · 官方智能混音（进阶交融）',
        'group': 'official',
        'source': 'dex 证据 k() 进阶分支：强制 amfilter2 + MIR advanced cue(f/g)',
        'default_engine': 'audiotsm_wsola',
        'fn': None,  # 需要云端调用，在 server.py 里特殊处理
        'is_cloud': True,
        'evidence': {
            'forced_mode': '进阶=amfilter2 DJPlan（AM preset），忽略云端 MixMode',
            'advanced_cue': 'MIR bid=23 CUE2_POINT_INFO(cue2_cuts/cue2_entrys，秒) 实锤可复现（onSuccess 按含 cue2_cuts 判定）',
            'mixture': 'k() 构造 c(InBpm,OutBpm,inCueEntrys,outCueCuts,"amfilter2") → f/g=进阶 cut/entry',
            'requires': 'QQ音乐登录 cookie',
        },
    },
    # ── Apple Music 官方档（2026-09-24 新增；第一步 = 门控 + Dead-Air + Fallback）──
    # 与 QQ/网易云的本质区别：**云端只给输入数据，计划是本地算的**。
    #   transition_attributes 真实行只有 {durationInMillis, spatialOffsets, supportsSmartTransitions}；
    #   算法选择/region/pivot/增益/fx 全在本地 _SonicKit_MusicKit.TransitionPlanner。
    #   所以本档 = 归档输入数据回放 + 规划器复刻（applemusic_planner）+ 按官方计划渲染。
    'applemusic_cloud': {
        'name': 'Apple Music · 官方自动过渡（AutoMix / Smart Transition）',
        'group': 'official',
        'source': 'MediaAPI 归档输入数据 + 本地 TransitionPlanner 复刻（Apple 不下发计划）',
        'default_engine': 'rubberband_r3',
        'fn': None,  # 需要规划器 + 归档数据，在 server.py 里特殊处理
        'is_cloud': True,
        'evidence': {
            'cloud_role': '云端只下发输入数据（durationInMillis/spatialOffsets/supportsSmartTransitions + 分析数据），不下发过渡计划',
            'planner': '本地 _SonicKit_MusicKit.TransitionPlanner 复刻：8 候选门控 / 时长预算 / Dead-Air region / Fallback 几何',
            'gate_chain': '流派树（双方主流派 ∈ 白名单；Filtered 另加黑名单）→ acousticness 反向门控 → danceability → tempo（×2^k 归一八度后 ±30%）',
            'duration_budget': 'min 30s 非过渡段 → max_transition=(D-30)/2；单侧上限 60s（BM Dance 适用时入曲 90s）',
            'dead_air': '尾部最后一个连续 < -30dB 的 run 起点 → region=[onset, D_server]，入曲=[0, 同长]（16/16 值级对齐）',
            'stretch': '保调（Spectral）—— 日志 Setting TimePitchAlgorithm: Spectral 实证',
            'anchors': '三枚时间锚点 advanceTimeForOverlappedPlayback / overlappedPlaybackEndTime / forwardPlaybackEndTime',
            'GAP_gain': '重叠区增益曲线形状官方未测出（报告 §12.8）→ gain_law 开关，默认 linear',
            'GAP_score': 'Beat-Matched 候选枚举/Score 未复刻 → 有 BM 候选时不给选中算法（16 样本里 8 对）',
            'GAP_fx': 'fx/remixfx/aufilter 通道取值无证据 → 未复刻',
            'GAP_audio': '无 Apple 曲目音频（DRM）→ 用选中 corpus 音频当载体，meta 标 substitute',
            'regress': 'python automix_lab/tests/regress_apple_planner.py → 门控 16/16、Dead-Air region 16/16、Fallback 16/16',
        },
    },
    'optimized_cloud': {
        'name': 'WaveForge 融合优化版（QQ决策×网易云渲染）',
        'group': 'fused',
        'source': 'QQ 云端 MixPlan+MIR 决策 × 网易云 MusicMixInfo 形状 × wsola_sync 自研引擎',
        'default_engine': 'wsola_sync',
        'fn': None,  # 需要云端调用，在 server.py 里特殊处理
        'is_cloud': True,
        'evidence': {
            'cues': '与官方档同源：MIR bid=24 bpm + bid=23 cue2/cue（秒），advanced 优先',
            'shape': '网易云 Lcl0/e::m：等功率交叉 + 音量包络 + 目标曲 EQ 渐入 + MS 轻处理',
            'engine': 'wsola_sync（多声道共用搜索位置；无 audiotsm/rubberband 依赖，私有协议安全）',
            'stretch': '整窗一次匀速（SoundTouch 连续流 / RubberBand setTimeRatio 证据一致）',
            'fallback': 'advanced/basic cue 双缺失时回退 MixPlan OutCueCuts/InCueEntrys 并标注',
            'requires': 'QQ音乐登录 cookie',
        },
    },
}

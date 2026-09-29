#!/usr/bin/env python3
# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
# 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
# 例外：本文件 import 的 qq_automix_lab 子包为 automix-lab 的 MIT 代码（见该目录 __init__.py）。
"""AutoMix Enhanced —— QQ 官方智能混音三档接入层。

三档（与设置页 Lite / Advanced / Extreme 一一对应）：
  lite     自主优化版（本地进阶方案）：wsola_sync + 低音交换 + 连续扫频 + MS 轻处理，纯本地
  advanced QQ音乐 · 官方智能混音（基础渐变）：云端 MixPlan + MIR cue_cuts/cue_entrys
           → DesideCue(v1·EQfilter) 复刻 → filterEQPresetJson 效果链 + sin² 分半交叉
  extreme  QQ音乐 · 官方智能混音（进阶交融）：云端 MixPlan（强制 amfilter2）+ 专属 cue（cue2）
           → DesideCueV3 复刻 → AMfilterPlanJson2 效果链 + sin² 分半交叉

可直接 CLI 运行（自检/离线渲染）：
  python qq_automix.py --tier advanced --src a.mp3 --tgt b.mp3 --mid-a XXX --mid-b YYY --out out.wav
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

TIERS = ('lite', 'advanced', 'extreme')

# automix-lab server.py 的普通方案默认参数（与实验台产物保持一致）
DEFAULT_WINDOW_S = 12.0
DEFAULT_BEATS = 16
DEFAULT_RAMP = 0.1
DEFAULT_CROSSFADE = 'equal_power'
DEFAULT_SEAM_MS = 8


class _LogTrace:
    """对应 automix-lab 的 JobTrace 最小接口（info/warn/fail）。"""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def _push(self, level: str, stage: str, message: str, **data: Any) -> None:
        self.events.append({'level': level, 'stage': stage, 'message': message, 'data': data})
        print(f'[{stage}] {message}', file=sys.stderr, flush=True)

    def info(self, stage: str, message: str, **data: Any) -> None:
        self._push('info', stage, message, **data)

    def warn(self, stage: str, message: str, **data: Any) -> None:
        self._push('warn', stage, message, **data)

    def fail(self, stage: str, error: Exception | str) -> None:
        self._push('error', stage, str(error))


def resolve_cookie(explicit: str = '') -> str:
    """QQ 登录票据：显式传入优先，其次环境变量 / userData 下的 qq-cookie.txt。"""
    if explicit and explicit.strip():
        return explicit.strip()
    env = (os.environ.get('WAVEFORGE_QQ_COOKIE') or '').strip()
    if env:
        return env
    candidates: list[Path] = []
    userdata = os.environ.get('WAVEFORGE_USERDATA')
    if userdata:
        candidates.append(Path(userdata) / 'qq-cookie.txt')
    home = Path.home()
    candidates += [
        home / '.waveforge' / 'qq-cookie.txt',
        home / '.waveforge' / 'qq-cookie-web.txt',
        home / 'AppData/Roaming/Electron/qq-cookie.txt',
        home / 'AppData/Roaming/WaveForge 澜音工坊/qq-cookie.txt',
    ]
    best: tuple[float, str] | None = None
    for path in candidates:
        try:
            if not path.exists():
                continue
            value = path.read_text(encoding='utf8').strip()
        except OSError:
            continue
        if not value:
            continue
        mtime = path.stat().st_mtime
        if best is None or mtime > best[0]:
            best = (mtime, value)
    return best[1] if best else ''


def load_stereo(path: str | Path, sr: int) -> np.ndarray:
    """读成立体声 (2, n) float32。"""
    import librosa

    y, _ = librosa.load(str(path), sr=sr, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    if y.shape[0] == 1:
        y = np.repeat(y, 2, axis=0)
    return np.ascontiguousarray(y[:2], dtype=np.float32)


def _to_am_dict(trans: dict, mix_plan: dict | None = None) -> dict:
    """AutoMixInfo → 渲染层 am 结构（等价 automix-lab qq_native_transform.to_am_dict，
    此处内联以避免引入该模块的 frida 顶层依赖）。"""
    is_local = bool(trans.get('_local'))
    return {
        'InCue': trans.get('InCue', 0.0),
        'OutCue': trans.get('OutCue', 0.0),
        'InDuration': trans.get('InDuration', 0.0),
        'OutDuration': trans.get('OutDuration', 0.0),
        'InBpm': trans.get('InBpm', 0.0),
        'OutBpm': trans.get('OutBpm', 0.0),
        'MixMode': (mix_plan or {}).get('MixMode') or 'amfilter2',
        'type': trans.get('Type', -1),
        'source': 'transformInfo 本地复刻（反汇编实证）' if is_local else 'native transform',
        'strategy': 'transform_info_local' if is_local else 'native_transform',
    }


class CloudUnavailable(RuntimeError):
    """云端档不可用（未登录 / 曲目匹配不到 / 云端拒绝 / 素材不足）——按规则回退 Lite。"""


# ── QQ mid 解析（本平台曲目直接用 mid；其他平台按 标题+歌手 联想匹配）─────────
# 与 automix-lab 的网易云→QQ 打通同一套做法：smartbox 联想、歌手名必须命中，
# 结果持久化到 userData/qq-mid-map.json，避免每次播放都联网搜索。
def _mid_map_path() -> Path | None:
    userdata = os.environ.get('WAVEFORGE_USERDATA')
    if not userdata:
        return None
    return Path(userdata) / 'qq-mid-map.json'


def _load_mid_map() -> dict:
    path = _mid_map_path()
    if not path or not path.exists():
        return {}
    try:
        import json as _json
        data = _json.loads(path.read_text(encoding='utf8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_mid_map(mapping: dict) -> None:
    path = _mid_map_path()
    if not path:
        return
    try:
        import json as _json
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json.dumps(mapping, ensure_ascii=False, indent=1), encoding='utf8')
    except Exception:
        pass


def _mid_cache_key(meta: dict) -> str:
    track_id = str(meta.get('trackId') or meta.get('neteaseId') or '').strip()
    if track_id:
        return f'id:{track_id}'
    return f"t:{str(meta.get('title') or '').strip()}|{str(meta.get('artist') or '').strip()}"


def resolve_track_mid(meta: dict, cookie: str, trace: _LogTrace) -> str | None:
    """解析一首歌在 QQ 音乐侧的 mid。

    本平台（QQ）曲目 meta 里直接带 mid；其他平台（网易云/本地等）用 标题+歌手
    走 smartbox 联想匹配（歌手名必须命中，防同名误配），命中后写缓存。
    匹配不到返回 None（调用方按规则回退 Lite）。
    """
    direct = str(meta.get('mid') or '').strip()
    if direct:
        return direct
    title = str(meta.get('title') or '').strip()
    if not title:
        return None
    key = _mid_cache_key(meta)
    mapping = _load_mid_map()
    cached = str(mapping.get(key) or '').strip()
    if cached:
        trace.info('match', f'QQ mid 命中缓存：{title} → {cached}')
        return cached
    from qq_automix_lab.cloud_recipe import search_qq_mid

    try:
        mid = search_qq_mid(title, str(meta.get('artist') or ''), cookie)
    except Exception as exc:
        trace.warn('match', f'QQ mid 匹配请求失败（{title}）：{exc}')
        return None
    if mid:
        mapping[key] = mid
        _save_mid_map(mapping)
        trace.info('match', f'跨平台匹配成功：{title} → {mid}')
    else:
        trace.warn('match', f'跨平台匹配失败：{title}（QQ 曲库无对应歌曲或歌手不匹配）')
    return mid or None


def _prepare_cloud(tier: str, mid_a: str, mid_b: str, cookie: str,
                   trace: _LogTrace) -> tuple[dict, dict]:
    """云端档只取"决策"（不渲染）：返回 (am 结构, 原始 plan)。失败抛 CloudUnavailable。"""
    from qq_automix_lab.cloud_recipe import fetch_mir, fetch_mix_plan
    from qq_automix_lab.qq_desidecue import transform_basic, transform_mix_plan

    if not cookie:
        raise CloudUnavailable('QQ 音乐未登录（缺少登录票据）')
    if not mid_a or not mid_b:
        raise CloudUnavailable('未能在 QQ 音乐匹配到对应歌曲')
    trace.info('cloud', f'请求云端 MixPlanSvr (midA={mid_a}, midB={mid_b})')
    try:
        plan = fetch_mix_plan(mid_a, mid_b, cookie)
    except Exception as exc:
        raise CloudUnavailable(f'云端过渡计划请求失败：{exc}') from exc
    trace.info('cloud', 'MixPlan: mode={} OutBpm={} InBpm={} OutCueCuts={} InCueEntrys={} type={}'.format(
        plan.get('MixMode'), plan.get('OutBpm'), plan.get('InBpm'),
        plan.get('OutCueCuts'), plan.get('InCueEntrys'), plan.get('type')))

    if tier == 'advanced':
        try:
            mir = fetch_mir(mid_a, mid_b, cookie)
        except Exception as exc:
            raise CloudUnavailable(f'MIR 请求失败：{exc}') from exc
        out_mir = mir.get(mid_a) or {}
        in_mir = mir.get(mid_b) or {}
        plan['OutCueCuts'] = [float(x) for x in (out_mir.get('cue_cuts') or [])]
        plan['InCueEntrys'] = [float(x) for x in (in_mir.get('cue_entrys') or [])]
        plan['MixMode'] = 'EQfilter'
        trans = transform_basic(plan['OutCueCuts'], plan['InCueEntrys'],
                                float(plan['InBpm']), float(plan['OutBpm']),
                                bars=2, mode='EQfilter')
        if trans is None:
            raise CloudUnavailable('官方决策校验拒绝（MIR cue 数据不足）')
        trace.info('cloud', f'DesideCue(v1·EQfilter): {trans}')
    else:
        plan['MixMode'] = 'amfilter2'
        trans = transform_mix_plan(plan)
        if trans is None:
            raise CloudUnavailable('官方决策校验拒绝（MixPlan cue 数据不足）')
        trace.info('cloud', f'native transformInfo: {trans}')
    return _to_am_dict(trans, plan), plan


def _render_cloud(tier: str, src: np.ndarray, tgt: np.ndarray, sr: int,
                  mid_a: str, mid_b: str, cookie: str, trace: _LogTrace,
                  cue_timeline: dict | None = None) -> tuple[np.ndarray, dict]:
    from qq_automix_lab.cloud_recipe import render_from_am_enable_date

    am, plan = _prepare_cloud(tier, mid_a, mid_b, cookie, trace)
    timeline = _normalize_cue_timeline(cue_timeline)
    if timeline is not None:
        # P1-9：以前端 cue 时间轴覆盖云端决策，渲染取窗与前端排的过渡动画完全一致。
        am = _apply_cue_timeline(am, timeline, trace)
    try:
        audio, meta = render_from_am_enable_date(src, tgt, sr, am,
                                                 mid_src=mid_a, mid_tgt=mid_b,
                                                 engine_fn=None, trace=trace)
    except Exception as exc:
        raise CloudUnavailable(f'官方效果链渲染失败：{exc}') from exc
    meta['tier'] = tier
    meta['techniques'] = list(CLOUD_TECHNIQUES.get(tier, LITE_TECHNIQUES))
    meta['mix_plan'] = {k: plan.get(k) for k in ('OutCueCuts', 'InCueEntrys', 'InBpm', 'OutBpm', 'MixMode', 'type')}
    if timeline is not None:
        meta['cue_timeline_override'] = dict(timeline)
    return audio, meta


# 各档位「过渡手法」说明（透传到前端过渡调试弹窗，与 automix-lab 的 recipes 证据一致）
LITE_TECHNIQUES = [
    'WSOLA 多声道相位一致引擎：目标曲变速对齐源曲 BPM',
    '低音交换（180Hz 分频，过渡中点交接低频）',
    '连续扫频（100→800Hz 四段，wet 0.7）',
    '等功率交叉淡化 + 中侧处理（side +1dB / 120Hz HP）',
]
CLOUD_TECHNIQUES = {
    'advanced': [
        'QQ 官方 MixPlan 云端决策 + MIR cue_cuts/cue_entrys',
        'DesideCue(v1·EQfilter) 官方决策复刻',
        '官方 filterEQPresetJson 效果链（gain/LPF/HPF/EQ 扫频）',
        '官方 sin² 分半窗交叉淡化',
    ],
    'extreme': [
        'QQ 官方 MixPlan 云端决策（强制 amfilter2）+ 专属 cue2',
        'DesideCueV3 官方决策复刻（oracle 1536/1536）',
        '官方 AMfilterPlanJson2 效果链（Achain LPF 20k→2.3k / Bchain HPF 10k→20 扫频）',
        '官方 sin² 分半窗交叉淡化（目标轨前半渐入 / 源轨后半渐出）',
    ],
}


def _lite_timing(src_len_s: float, window_s: float) -> dict:
    return {
        'transition_start_s': max(0.0, src_len_s - window_s),
        'transition_duration_s': float(window_s),
        'target_start_s': 0.0,
        'source_cut_time_s': float(src_len_s),
    }


def _normalize_cue_timeline(cue_timeline: dict | None) -> dict | None:
    """校验/归一化前端下传的 cue 时间轴（P1-9）。

    缺失、非数值、NaN/inf、时长 ≤0 → None（调用方保持既有行为不变）。
    """
    if not cue_timeline:
        return None
    try:
        start = float(cue_timeline.get('transition_start_s'))
        duration = float(cue_timeline.get('transition_duration_s'))
        target_start = float(cue_timeline.get('target_start_s'))
    except (TypeError, ValueError):
        return None
    if not (np.isfinite(start) and np.isfinite(duration) and np.isfinite(target_start)):
        return None
    if duration <= 0.0:
        return None
    return {
        'transition_start_s': max(0.0, start),
        'transition_duration_s': duration,
        'target_start_s': max(0.0, target_start),
    }


def _apply_cue_timeline(am: dict, timeline: dict, trace: _LogTrace) -> dict:
    """用给定 cue 时间轴覆盖云端决策（P1-9：cue 是唯一事实，渲染产物与前端严格一致）。"""
    overridden = dict(am)
    overridden['OutCue'] = timeline['transition_start_s']
    overridden['InCue'] = timeline['target_start_s']
    overridden['InDuration'] = timeline['transition_duration_s']
    overridden['OutDuration'] = timeline['transition_duration_s']
    trace.info(
        'cloud',
        'cue 时间轴覆盖云端决策：OutCue={:.3f} InCue={:.3f} 时长={:.3f}s（原 OutCue={} InCue={} InDur={} OutDur={}）'.format(
            overridden['OutCue'], overridden['InCue'], overridden['InDuration'],
            am.get('OutCue'), am.get('InCue'), am.get('InDuration'), am.get('OutDuration'),
        ),
    )
    return overridden


def _write_wav_checked(out_path: str, audio: np.ndarray, sr: int) -> tuple[float, bool, int]:
    """写盘保护（与 render_worker.write_wav_atomic 同一套保护的本地等价实现）。

    - 非有限样本直接抛错（同 render_worker.write_wav_atomic 的 Refusing to write non-finite）；
    - 峰值 >0.98 走 np.tanh 软限幅（同 render_worker 各渲染分支的 peak>0.98 软限幅写法）；
    - 临时文件 + os.replace 原子替换（QQ 三档此前直接 sf.write 到目标路径，
      并发/中断会留下半截 WAV，缓存命中判定可能读到坏产物）。

    未直接 import render_worker.write_wav_atomic 的原因：(1) 它经 pedalboard AudioFile
    写出，不接受 subtype，会把三档产物从 PCM_16 换成 pedalboard 默认编码，改变既有
    输出格式与体积；(2) 生产路径下 render_worker.py 以脚本运行（sys.modules 里是
    __main__），import render_worker 会二次执行模块。
    返回 (峰值, 是否软限幅, 文件字节数)。
    """
    import soundfile as sf

    if not np.all(np.isfinite(audio)):
        raise ValueError('Refusing to write non-finite transition audio')
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    limited = peak > 0.98
    if limited:
        audio = np.tanh(audio * 0.95) * 0.95
    dest = Path(out_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp_path = f'{dest}.{os.getpid()}.{os.urandom(6).hex()}.tmp.wav'
    try:
        sf.write(temp_path, audio.T, sr, subtype='PCM_16')
        if os.path.getsize(temp_path) <= 44:
            raise ValueError('Rendered AutoMix WAV is empty')
        os.replace(temp_path, dest)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    return peak, limited, os.path.getsize(dest)


def _render_lite(src: np.ndarray, tgt: np.ndarray, sr: int, window_s: float,
                 trace: _LogTrace, cue_timeline: dict | None = None) -> tuple[np.ndarray, dict]:
    """Lite：自主优化版（本地进阶方案）。

    三段结构与云端档一致（源曲尾 → 过渡 → 目标曲头），时间轴按窗口长度给出：
    过渡起点 = 源曲末尾窗口前，目标曲从头（0s）参与，播完过渡后目标曲从 window_s 续播。

    cue_timeline 给定时（P1-9）：按 cue 的切点/时长/目标起点切片再渲染，
    使产物内容与前端 cue 时间轴严格一致（缺省 None 时行为与既有实现完全相同）。
    """
    from qq_automix_lab.engines.registry import get_engine
    from qq_automix_lab.recipes import render_optimized

    timeline = _normalize_cue_timeline(cue_timeline)
    src_len_s = src.shape[1] / sr
    render_src, render_tgt, window_used = src, tgt, window_s
    if timeline is not None:
        # lite 渲染器只支持"源尾 window 秒 + 目标头 window 秒"，因此把两窗按 cue
        # 时间轴精确切片后传入（窗口长度 = cue 时长），窗口起点/长度与 cue 完全对应。
        window_used = timeline['transition_duration_s']
        window_samples = max(1, int(round(window_used * sr)))
        start = max(0, int(round(timeline['transition_start_s'] * sr)))
        target_start = max(0, int(round(timeline['target_start_s'] * sr)))
        sliced_src = src[:, start:start + window_samples]
        sliced_tgt = tgt[:, target_start:target_start + window_samples]
        if sliced_src.shape[1] < 128 or sliced_tgt.shape[1] < 128:
            trace.warn('lite', 'cue 时间轴对应的素材不足（<128 样本），退回默认窗口时间轴')
            timeline = None
            window_used = window_s
        else:
            render_src, render_tgt = sliced_src, sliced_tgt

    engine = get_engine('wsola_sync')
    audio, meta = render_optimized(render_src, render_tgt, engine, sr, window_used,
                                   DEFAULT_BEATS, DEFAULT_RAMP,
                                   DEFAULT_CROSSFADE, DEFAULT_SEAM_MS, trace=None)
    duration_s = audio.shape[1] / sr
    if timeline is not None:
        timing = dict(timeline)
        timing['source_cut_time_s'] = timeline['transition_start_s'] + duration_s
    else:
        timing = _lite_timing(src_len_s, window_s)
    meta.update({
        'tier': 'lite',
        'engine': 'wsola_sync',
        'techniques': list(LITE_TECHNIQUES),
        # 与云端档统一的交接时间轴契约
        **timing,
        'transition_duration_s': duration_s,
    })
    if timeline is not None:
        meta['cue_timeline_override'] = dict(timeline)
        trace.info('lite', f'cue 时间轴覆盖本地窗口：起点 {timeline["transition_start_s"]:.3f}s / 时长 {duration_s:.3f}s / 目标起点 {timeline["target_start_s"]:.3f}s')
    trace.info('lite', f'自主优化版渲染完成：{duration_s:.2f}s（窗口 {window_used:.1f}s）')
    return audio, meta


def render_tier(tier: str, src: np.ndarray, tgt: np.ndarray, sr: int, *,
                mid_a: str = '', mid_b: str = '',
                source_meta: dict | None = None, target_meta: dict | None = None,
                cookie: str = '', allow_saved_cookie: bool = True,
                window_s: float = DEFAULT_WINDOW_S,
                cue_timeline: dict | None = None,
                trace: _LogTrace | None = None) -> tuple[np.ndarray, dict]:
    """按档位渲染过渡段音频，返回 (stereo float32 (2, n), meta)。

    云端档（advanced / extreme）的可用性判定与降级（用户规则）：
      1) 未登录 QQ 音乐 → 不发请求，直接用 Lite；
      2) 已登录但当前曲目不是 QQ 曲库（网易云/本地等）→ 按 标题+歌手 匹配 QQ mid 后请求；
      3) 匹配不到 / 云端拒绝 / cue 数据不足 / 渲染失败 → 回退当前这首歌的 Lite 方案。
    降级信息写进 meta['fallback']，meta['tier'] 为**实际生效**档位。

    cue_timeline（可选，P1-9）：{'transition_start_s','transition_duration_s','target_start_s'}，
    由前端 cue 路径给出；给定时覆盖云端决策/本地窗口的时间轴，缺省 None 时行为不变。
    """
    if tier not in TIERS:
        raise ValueError(f'未知档位: {tier}（可选 {"/".join(TIERS)}）')
    trace = trace or _LogTrace()
    if tier == 'lite':
        return _render_lite(src, tgt, sr, window_s, trace, cue_timeline=cue_timeline)

    cookie = (cookie or '').strip()
    if not cookie and allow_saved_cookie:
        cookie = resolve_cookie()
    try:
        if not cookie:
            raise CloudUnavailable('QQ 音乐未登录，无法使用官方过渡数据')
        meta_a = dict(source_meta or {})
        meta_b = dict(target_meta or {})
        if mid_a:
            meta_a.setdefault('mid', mid_a)
        if mid_b:
            meta_b.setdefault('mid', mid_b)
        mid_a_resolved = resolve_track_mid(meta_a, cookie, trace)
        mid_b_resolved = resolve_track_mid(meta_b, cookie, trace)
        if not mid_a_resolved or not mid_b_resolved:
            missing = '、'.join(
                [name for name, mid in ((meta_a.get('title') or '前曲', mid_a_resolved),
                                        (meta_b.get('title') or '后曲', mid_b_resolved)) if not mid])
            raise CloudUnavailable(f'未能在 QQ 音乐匹配到：{missing}')
        audio, meta = _render_cloud(tier, src, tgt, sr, mid_a_resolved, mid_b_resolved, cookie, trace,
                                    cue_timeline=cue_timeline)
        meta['requested_tier'] = tier
        meta['source_mid'] = mid_a_resolved
        meta['target_mid'] = mid_b_resolved
        return audio, meta
    except CloudUnavailable as exc:
        trace.warn('fallback', f'{tier} → lite：{exc}')
        audio, meta = _render_lite(src, tgt, sr, window_s, trace, cue_timeline=cue_timeline)
        meta['requested_tier'] = tier
        meta['fallback'] = {'requestedTier': tier, 'effectiveTier': 'lite', 'reason': str(exc)}
        return audio, meta


def plan_cue(tier: str, src_len_s: float, tgt_len_s: float, *,
             mid_a: str = '', mid_b: str = '',
             source_meta: dict | None = None, target_meta: dict | None = None,
             cookie: str = '', allow_saved_cookie: bool = False,
             window_s: float = DEFAULT_WINDOW_S,
             trace: _LogTrace | None = None) -> dict:
    """只算"交接时间轴"（不渲染、不解码音频）。

    播放前规划用：拿到切点后才能排过渡动画与目标曲续播位置。
    时间轴语义与 automix-lab 完整版一致：
      源曲播到 transition_start_s → 过渡段 transition_duration_s → 目标曲从 target_start_s + duration 续播。
    """
    trace = trace or _LogTrace()
    if tier == 'lite':
        result = {'tier': 'lite', 'effectiveTier': 'lite', 'requested_tier': 'lite', 'fallback': None}
        result.update(_lite_timing(src_len_s, window_s))
        return result

    cookie = (cookie or '').strip()
    if not cookie and allow_saved_cookie:
        cookie = resolve_cookie()
    try:
        if not cookie:
            raise CloudUnavailable('QQ 音乐未登录，无法使用官方过渡数据')
        meta_a = dict(source_meta or {})
        meta_b = dict(target_meta or {})
        if mid_a:
            meta_a.setdefault('mid', mid_a)
        if mid_b:
            meta_b.setdefault('mid', mid_b)
        mid_a_resolved = resolve_track_mid(meta_a, cookie, trace)
        mid_b_resolved = resolve_track_mid(meta_b, cookie, trace)
        if not mid_a_resolved or not mid_b_resolved:
            missing = '、'.join(
                [name for name, mid in ((meta_a.get('title') or '前曲', mid_a_resolved),
                                        (meta_b.get('title') or '后曲', mid_b_resolved)) if not mid])
            raise CloudUnavailable(f'未能在 QQ 音乐匹配到：{missing}')
        am, _plan = _prepare_cloud(tier, mid_a_resolved, mid_b_resolved, cookie, trace)
        blend = max(float(am.get('InDuration') or 0.0), float(am.get('OutDuration') or 0.0))
        if blend <= 0.0:
            raise CloudUnavailable('云端过渡时长为 0（计划异常）')
        return {
            'tier': tier, 'effectiveTier': tier, 'requested_tier': tier, 'fallback': None,
            'transition_start_s': float(am.get('OutCue') or 0.0),
            'transition_duration_s': blend,
            'target_start_s': float(am.get('InCue') or 0.0),
            'source_cut_time_s': float(am.get('OutCue') or 0.0) + blend,
            'source_mid': mid_a_resolved, 'target_mid': mid_b_resolved,
            'mix_mode': am.get('MixMode'),
        }
    except CloudUnavailable as exc:
        trace.warn('fallback', f'{tier} → lite：{exc}')
        result = {
            'tier': 'lite', 'effectiveTier': 'lite', 'requested_tier': tier,
            'fallback': {'requestedTier': tier, 'effectiveTier': 'lite', 'reason': str(exc)},
        }
        result.update(_lite_timing(src_len_s, window_s))
        return result


def plan_cue_file(tier: str, src_path: str | Path, tgt_path: str | Path, **kwargs: Any) -> dict:
    """plan_cue 的文件入口：只读时长（不解码整首歌）。"""
    import soundfile as sf

    src_info = sf.info(str(src_path))
    tgt_info = sf.info(str(tgt_path))
    return plan_cue(tier, src_info.duration, tgt_info.duration, **kwargs)


def render_file(tier: str, src_path: str, tgt_path: str, out_path: str, sr: int = 44100,
                mid_a: str = '', mid_b: str = '', cookie: str = '',
                source_meta: dict | None = None, target_meta: dict | None = None,
                allow_saved_cookie: bool = True,
                window_s: float = DEFAULT_WINDOW_S,
                cue_timeline: dict | None = None) -> dict:
    """读文件 → 渲染 → 写 WAV，返回 meta（含输出信息与降级信息）。

    cue_timeline 可选（P1-9，见 render_tier）：给定时三档产物均按该时间轴取窗。
    """
    trace = _LogTrace()
    src = load_stereo(src_path, sr)
    tgt = load_stereo(tgt_path, sr)
    audio, meta = render_tier(tier, src, tgt, sr, mid_a=mid_a, mid_b=mid_b,
                              source_meta=source_meta, target_meta=target_meta,
                              cookie=cookie, allow_saved_cookie=allow_saved_cookie,
                              window_s=window_s, cue_timeline=cue_timeline, trace=trace)
    dest = Path(out_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    peak, limited, size_bytes = _write_wav_checked(dest, audio, sr)
    if limited:
        trace.warn('write', f'输出峰值 {peak:.4f} > 0.98，已做 tanh 软限幅')
    meta = dict(meta)
    meta.update({
        'outputPath': str(dest),
        'duration': round(audio.shape[1] / sr, 4),
        'sampleRate': sr,
        'peak': round(peak, 6),
        'softLimited': limited,
        'size': size_bytes,
        'events': trace.events,
    })
    return meta


def main() -> int:
    parser = argparse.ArgumentParser(description='AutoMix Enhanced 三档离线渲染')
    parser.add_argument('--tier', required=True, choices=TIERS)
    parser.add_argument('--src', required=True)
    parser.add_argument('--tgt', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--mid-a', default='')
    parser.add_argument('--mid-b', default='')
    parser.add_argument('--src-title', default='')
    parser.add_argument('--src-artist', default='')
    parser.add_argument('--tgt-title', default='')
    parser.add_argument('--tgt-artist', default='')
    parser.add_argument('--cookie', default='')
    parser.add_argument('--no-cookie', action='store_true', help='忽略已保存票据（模拟未登录）')
    parser.add_argument('--sr', type=int, default=44100)
    parser.add_argument('--window', type=float, default=DEFAULT_WINDOW_S)
    args = parser.parse_args()
    meta = render_file(args.tier, args.src, args.tgt, args.out, sr=args.sr,
                       mid_a=args.mid_a, mid_b=args.mid_b,
                       source_meta={'title': args.src_title, 'artist': args.src_artist},
                       target_meta={'title': args.tgt_title, 'artist': args.tgt_artist},
                       cookie=args.cookie, allow_saved_cookie=not args.no_cookie,
                       window_s=args.window)
    import json as _json
    print(_json.dumps({k: v for k, v in meta.items() if k != 'events'}, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

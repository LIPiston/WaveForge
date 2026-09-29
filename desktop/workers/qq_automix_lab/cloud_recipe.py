"""AutoMix Lab —— QQ音乐云端版（MixPlan + MIR 数据驱动）"""

from __future__ import annotations

import json as _json
import os
import random
import urllib.parse
from pathlib import Path
import urllib.request
import urllib.error

import numpy as np

from .engines.registry import fix_length
from .djplan import load_presets, load_official_presets, apply_chain


def _get_cookie() -> str:
    """QQ 音乐登录态：AutoMix 自有登录优先（脱离 WaveForge），其次回退
    WaveForge 同源文件（不同版本/安装目录可能写了多份，取最新落盘的即有效会话）。
    """
    home = Path.home()
    candidates = [
        Path(__file__).resolve().parent / 'data' / 'cookies' / 'qq-cookie.txt',
        Path(os.environ.get('WAVEFORGE_USERDATA', '')) / 'qq-cookie.txt',
        home / '.waveforge/qq-cookie-web.txt',
        home / '.waveforge/qq-cookie.txt',
        home / 'AppData/Roaming/Electron/qq-cookie.txt',
        home / 'AppData/Roaming/WaveForge 澜音工坊/qq-cookie.txt',
    ]
    local_first = candidates[0]
    if local_first.exists() and local_first.read_text(encoding='utf8').strip():
        return local_first.read_text(encoding='utf8').strip()
    best: tuple[float, str] | None = None
    for path in candidates[1:]:
        if not str(path) or not path.exists():
            continue
        value = path.read_text(encoding='utf8').strip()
        if not value:
            continue
        mtime = path.stat().st_mtime
        if best is None or mtime > best[0]:
            best = (mtime, value)
    return best[1] if best else ''


def _h33(t: str) -> int:
    e = 0
    for i in range(len(t)):
        e += (e << 5) + ord(t[i])
    return 2147483647 & e


def _post(module: str, method: str, param: dict, cookie: str) -> dict:
    c = {}
    for p in cookie.split(';'):
        i = p.find('=')
        if i > 0:
            c[p[:i].strip().lower()] = p[i+1:].strip()
    uin = ''.join(ch for ch in c.get('uin', '') if ch.isdigit())
    key = c.get('qm_keyst') or c.get('qqmusic_key') or ''

    comm = {'ct': 24, 'cv': 4747474, 'platform': 'yqq.json', 'uin': uin, 'qq': uin,
            'authst': key, 'tmeLoginType': int(c.get('tmelogin_type') or c.get('login_type') or 1),
            'g_tk': _h33(key), 'format': 'json', 'inCharset': 'utf-8', 'outCharset': 'utf-8',
            'notice': 0, 'need_new_code': 1}
    body = _json.dumps({'comm': comm, 'req_0': {'module': module, 'method': method, 'param': param}}).encode('utf8')
    req = urllib.request.Request('https://u.y.qq.com/cgi-bin/musicu.fcg', data=body,
                                 headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                                          'Referer': 'https://y.qq.com/', 'Content-Type': 'application/json',
                                          'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return _json.loads(resp.read())


def fetch_mix_plan(mid_a: str, mid_b: str, cookie: str = '') -> dict:
    if not cookie:
        cookie = _get_cookie()
    r = _post('music.mir.MixPlanSvr', 'Build', {'songMids': [mid_a, mid_b], 'uin': None}, cookie)
    code = r.get('req_0', {}).get('code', -1)
    if code != 0:
        raise RuntimeError(f'MixPlanSvr code={code}')
    return _json.loads(r['req_0']['data'].get('mixPlan', '{}'))


# ── 跨平台 mid 匹配（网易云歌曲 → QQ 歌曲）────────────────────────────────
# 用途：网易云歌单对 + QQ 登录时，让网易云音频也能走 QQ 决策+渲染管线
# （server.py 的 qqmusic_* 引擎）。匹配 = smartbox 联想（标题+歌手，歌手名必须
# 命中才接受，防止同名片误配）；结果持久化 data/netease_qq_mid_map.json。
_NETEASE_QQ_MID_MAP_PATH = Path(__file__).resolve().parent / 'data' / 'netease_qq_mid_map.json'


def _load_netease_qq_mid_map() -> dict:
    try:
        return _json.loads(_NETEASE_QQ_MID_MAP_PATH.read_text(encoding='utf8'))
    except Exception:
        return {}


def _save_netease_qq_mid_map(mapping: dict) -> None:
    try:
        _NETEASE_QQ_MID_MAP_PATH.write_text(
            _json.dumps(mapping, ensure_ascii=False, indent=1), encoding='utf8')
    except Exception:
        pass


def search_qq_mid(title: str, artist: str = '', cookie: str = '') -> str | None:
    """按 标题+歌手 在 QQ 音乐找对应歌曲 mid（smartbox 联想，歌手名必须命中）。

    匹配不到 / 网络失败返回 None（调用方决定回退）。"""
    import urllib.parse as _up
    import urllib.request as _req
    title = (title or '').strip()
    if not title:
        return None
    import re as _re

    def _smartbox(q: str) -> list:
        url = ('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key='
               + _up.quote(q) + '&format=json')
        request = _req.Request(url, headers={
            'Referer': 'https://y.qq.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          'Chrome/121.0.0.0 Safari/537.36'})
        try:
            data = _json.loads(_req.urlopen(request, timeout=10).read())
        except Exception:
            return []
        return (((data.get('data') or {}).get('song') or {}).get('itemlist')) or []

    # 标题候选：原名 → 去尾部括号后缀（(feat. xx)/(Remastered)/(Live) 等）
    # → 去全部括号组。QQ 侧曲名常不带这些装饰，直接查会 0 条或匹配不上。
    titles = [title.strip()]
    stripped = _re.sub(r'\s*[（(\[【][^）)\]】]*[）)\]】]\s*$', '', title).strip()
    if stripped and stripped not in titles:
        titles.append(stripped)
    bare = _re.sub(r'[（(\[【][^）)\]】]*[）)\]】]', '', stripped or title).strip()
    if bare and bare not in titles:
        titles.append(bare)

    # 逐级查询：标题+歌手 → 仅标题（每级用不同标题候选）
    items: list = []
    for t in titles:
        items = _smartbox(f'{t} {artist}'.strip()) if artist else _smartbox(t)
        if items:
            title = t          # 用命中的候选做后续精确匹配
            break
    if not items:
        for t in titles:
            items = _smartbox(t)
            if items:
                title = t
                break
    if not items:
        return None

    # 歌手名分词匹配（"冯沁苑(买辣椒也用券)" 拆出 token 与 smartbox singer 互查）
    artist_l = (artist or '').strip().lower()
    tokens = [t for t in _re.split(r'[/、,，()（）&;；\s]+', artist_l) if t]
    picked = None
    if tokens or artist_l:
        for it in items:
            singers = str(it.get('singer') or '').lower()
            if any(t in singers or singers in t for t in tokens) or                (artist_l and (artist_l in singers or singers in artist_l)):
                picked = it
                break
    if picked is None:
        # 兜底：标题精确匹配（唯一命中才接受；多个精确命中且给了歌手时再筛）
        title_s = title.strip()
        exact = [it for it in items if str(it.get('name') or '').strip() == title_s]
        if len(exact) == 1:
            picked = exact[0]
        elif exact and (tokens or artist_l):
            for it in exact:
                if artist_l in str(it.get('singer') or '').lower():
                    picked = it
                    break
            if picked is None:
                picked = exact[0]
    if picked is None:
        # 无歌手信息或全部不命中：仅当联想只返回一首时接受（歧义保护）
        picked = items[0] if len(items) == 1 else None
    mid = str((picked or {}).get('mid') or '').strip()
    return mid or None


def resolve_netease_qq_mid(netease_id: str, title: str, artist: str = '',
                           cookie: str = '') -> str | None:
    """网易云歌曲 id → QQ mid（带持久化缓存；搜索失败返回 None）。"""
    mapping = _load_netease_qq_mid_map()
    key = str(netease_id)
    if key in mapping and mapping[key]:
        return mapping[key]
    mid = search_qq_mid(title, artist, cookie)
    if mid:
        mapping[key] = mid
        _save_netease_qq_mid_map(mapping)
    return mid


def fetch_mir(mid_a: str, mid_b: str, cookie: str = '') -> dict:
    """按真实客户端形状拉取 MIR（dex 实锤 automix/o::f：两个子请求 bid=24 + bid=23）。

    bid=24 → BEAT_INFO：bpm / beat_start_times(sec) / beat_num / chord_*
    bid=23 → CUE_POINT_INFO：cue_cuts(sec) / cue_entrys(sec)
              CUE2_POINT_INFO：cue2_cuts(sec) / cue2_entrys(sec)  ← 进阶交融洽 cue

    返回 {mid: {...合并后的字段}}；网络失败/未分析的曲目为 {}。
    """
    if not cookie:
        cookie = _get_cookie()
    out = {}
    for bid in (24, 23):
        try:
            r = _post('music.mir.MirProxy', 'GetMIRByTrackIds',
                      {'trackMIds': [mid_a, mid_b], 'bid': bid}, cookie)
        except Exception:
            continue
        code = r.get('req_0', {}).get('code', -1)
        if code != 0:
            continue
        for item in (r['req_0']['data'].get('items') or []):
            for mid, raw in (item.get('mirMap') or {}).items():
                if mid not in (mid_a, mid_b):
                    continue
                try:
                    parsed = _json.loads(raw)
                except Exception:
                    continue
                if not isinstance(parsed, dict):
                    continue
                d = out.setdefault(mid, {})
                d.update(parsed)
    return out


def parse_mix_plan(plan: dict) -> dict:
    """真实 MixPlan 键（2026-09-21 实测）：

    OutCueCuts: float 列表，源轨切点=秒（与 bid=24 beat_start_times 对齐验证：
                226.43s 精确落在第 308 拍 → 单位是秒而非 beat index，首个即主切点）
    InCueEntrys: float 列表，目标轨接入口=秒（首个如 8.24/0.39）
    OutBpm/InBpm, MixMode(如 amfilter2), type(0=无变速 / 2=变速)
    """
    out_cuts = plan.get('OutCueCuts', [-1])
    in_entries = plan.get('InCueEntrys', [-1])
    return {
        'source_cut_s': out_cuts[0] if out_cuts and out_cuts[0] >= 0 else None,
        'source_bpm': plan.get('OutBpm'),
        'target_bpm': plan.get('InBpm'),
        'mix_mode': plan.get('MixMode', ''),
        'target_entry_time_s': in_entries[0] if in_entries and in_entries[0] >= 0 else None,
        'type': plan.get('type'),
        'raw_plan_keys': sorted(plan.keys()),
        'raw_out_cuts': out_cuts,
        'raw_in_entries': in_entries,
    }


def extract_beats(mir_data: dict, mid: str) -> list[float]:
    """beats 列表(秒)：真实键 bid=24 beat_start_times；兜底 beats-start_times。"""
    d = mir_data.get(mid) or {}
    return d.get('beat_start_times') or d.get('beats-start_times') or []


def extract_sections(mir_data: dict, mid: str) -> dict:
    d = mir_data.get(mid) or {}
    fvc = d.get('Fvc_conf')
    if fvc:
        return {'fvc_conf': fvc, 'chorus_start': d.get('idx_chorus_seg_start') or []}
    return {}


# 2026-09-21 实测（真实客户端 automix/o::f + o$b::onSuccess）：
#   bid=23 响应按"mirMap 字符串是否含 cue2_cuts"判定 CUE2_POINT_INFO；
#   AutoMixMirInfo.<init>(F,[F,[F,[F,[F) 的 d/e/f/g 即 cueCutList/cueEntryList/
#   cueAdvancedCutList/cueAdvancedEntryList；k::k 进阶分支读 next.c()(g) 与
#   cur.b()(f)，基础分支读 next.e()(e) 与 cur.d()(d)。
MIR_CUE_KEYS = {
    'basic_cut': ('cue_cuts', 'cueCutList'),
    'basic_entry': ('cue_entrys', 'cueEntryList'),
    'advanced_cut': ('cue2_cuts', 'cueAdvancedCutList'),
    'advanced_entry': ('cue2_entrys', 'cueAdvancedEntryList'),
}


def _mir_cue_list(mir_data: dict, mid: str, keys: tuple) -> list | None:
    """从 MIR 中按候选键名提取 float cue 列表；找不到返回 None。"""
    d = mir_data.get(mid) or {}
    for key in keys:
        value = d.get(key)
        if isinstance(value, list) and value:
            return _valid_nonnegative(value)
    return None


window_s_default = 12.0


def _seam(audio, seams, sr, ms):
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


def _valid_nonnegative(values):
    return [float(v) for v in (values or []) if v is not None and float(v) >= 0]


def _choose_native_like_cue(src_cut_pool: list[float], tgt_entry_pool: list[float],
                            src_bpm: float, tgt_bpm: float, sr: int, src_samples: int,
                            window_s: float) -> dict:
    """按真实 cue 池（单位=秒，bid=23）复现 DesideCue 的决策近似。

    V2 偏好 4/8/12 小节入口，按 BPM 差选择，超时长兜底更早候选；
    V3 暴露 type=0（无变速）/type=2（变速）。真实 MIR 的 cut/entry 已是秒，
    直接使用而不再做 beat→sec 换算。返回决策记录而非假装精确。
    """
    source_cut_s = src_cut_pool[0] if src_cut_pool else None
    entry_pool = tgt_entry_pool[:4]
    if not entry_pool:
        entry_pool = [0.0]
    diff = abs(src_bpm - tgt_bpm) / max(src_bpm, 1e-6)

    # 源切点（秒）：真实 MIR cue_cuts/cue2_cuts 首个即主切点。
    cut_time = source_cut_s
    if cut_time is None:
        cut_time = max(0.0, src_samples / sr - window_s)

    # 入口候选：首选=响应首个；BPM 近(diff<8%)时旧 V2 曾偏好更早 bar 候选。
    duration_limit = float(window_s)
    preferred = 1 if diff < 0.08 else 0
    preferred = min(preferred, len(entry_pool) - 1)
    selected_entry = entry_pool[preferred]
    for index in range(preferred, -1, -1):
        candidate = entry_pool[index]
        if max(0.0, candidate - cut_time) <= duration_limit or index == 0:
            preferred = index
            selected_entry = candidate
            break
    return {
        'native_version': 'V2/V3-compatible decision model (秒级 cue 池)',
        'bpm_difference_ratio': diff,
        'selected_entry_index': preferred,
        'selected_entry_s': selected_entry,
        'selected_cut_time_s': cut_time,
        'duration_limit_s': duration_limit,
        'speed_mode': 0 if diff < 0.08 else 2,
    }


def render_cloud(src, tgt, sr, mix_plan, mir_data, mid_src, mid_tgt,
                 engine_fn=None, trace=None, window_s=12.0,
                 strategy: str = 'auto_mix') -> tuple:
    """连续窗口重建云端 MixPlan + MIR，主切点/接入口以 MixPlan 秒级决策为准。

    strategy（dex 证据 automix/k::k）：
      'auto_mix'          = 基础渐变：云端 MixPlan.MixMode preset + 普通 cue
                            (InCueEntrys=next.e()/cue_entrys, OutCueCuts=cur.d()/cue_cuts)
      'auto_mix_advanced' = 进阶交融：强制 amfilter2 + advanced cue
                            (InCueEntrys=next.c()/cue2_entrys, OutCueCuts=cur.b()/cue2_cuts)

    主决策优先级（2026-09-22 修正）：
      1. MixPlan OutCueCuts / InCueEntrys —— 单位=秒，官方 App 过渡起点即此值
         （灰色の涙→How crazy 实测：源切 226.43s≈3:46，官方显示 3:40）
      2. 兜底：MIR cue 池（bid=23，cue_cuts/cue2_cuts 步长≈1 小节，秒级）——
         仅在 MixPlan 未返回（-1/空）时使用
    """

    info = parse_mix_plan(mix_plan)
    s_mir = mir_data.get(mid_src) or {}
    t_mir = mir_data.get(mid_tgt) or {}
    src_bpm = float(s_mir.get('bpm') or info['source_bpm'] or 120.0)
    tgt_bpm = float(t_mir.get('bpm') or info['target_bpm'] or 120.0)
    beats_src = extract_beats(mir_data, mid_src)

    advanced = strategy == 'auto_mix_advanced'
    mode = 'amfilter2' if advanced else (info['mix_mode'] or '')
    cue_source = 'mixplan(OutCueCuts/InCueEntrys, sec)'

    # 主决策 = MixPlan 秒级
    cut_time_s = info['source_cut_s']        # OutCueCuts[0] = 过渡完成点
    entry_s = info['target_entry_time_s']    # InCueEntrys[0] = 过渡段长

    # 兜底 = MIR cue 池（秒），仅当 MixPlan 缺失时启用
    if cut_time_s is None:
        if advanced:
            src_cue = _mir_cue_list(mir_data, mid_src, MIR_CUE_KEYS['advanced_cut'])
        else:
            src_cue = _mir_cue_list(mir_data, mid_src, MIR_CUE_KEYS['basic_cut'])
        if src_cue is None:
            src_cue = _mir_cue_list(mir_data, mid_src, MIR_CUE_KEYS['basic_cut'])
        if src_cue:
            if trace:
                trace.warn('cloud', f'MixPlan OutCueCuts 缺失({mid_src})，回退 MIR cue 池')
            cut_time_s = src_cue[0]

    if entry_s is None:
        if advanced:
            tgt_cue = _mir_cue_list(mir_data, mid_tgt, MIR_CUE_KEYS['advanced_entry'])
        else:
            tgt_cue = _mir_cue_list(mir_data, mid_tgt, MIR_CUE_KEYS['basic_entry'])
        if tgt_cue is None:
            tgt_cue = _mir_cue_list(mir_data, mid_tgt, MIR_CUE_KEYS['basic_entry'])
        if tgt_cue:
            if trace:
                trace.warn('cloud', f'MixPlan InCueEntrys 缺失({mid_tgt})，回退 MIR cue 池')
            entry_s = tgt_cue[0]

    # 官方进阶交融时间轴（2026-09-22 多组人工样本 + MixPlan 交叉验证）：
    #   OutCueCuts[0]  = 过渡完成点（源曲时间轴）
    #   InCueEntrys[0] = 过渡段长 = 目标曲开头被处理(开嗓/EQ)的时长，即 UI"正在过渡"显示时长
    #   UI 切点(源曲切出点) = OutCueCuts[0] - InCueEntrys[0]
    #   验证：千屈菜→谋杀石莲 174.18-5.63=168.55s≈2:48(人工) ✓
    #         TORATORAW→ADINGO 193.3-11.6=181.7s≈3:02(人工) ✓
    #         灰色の涙→How crazy 226.43-8.24=218.19s≈3:38(人工3:40,±2s) ✓
    dur_s = entry_s if (entry_s and entry_s > 0.5) else window_s
    if cut_time_s is not None:
        transition_start = max(0.0, cut_time_s - dur_s)
    else:
        transition_start = max(0.0, src.shape[1] / sr - dur_s)
        if trace:
            trace.warn('cloud', f'MixPlan+MIR 均无源切点({mid_src})，使用尾部前推 {transition_start:.1f}s')

    win = int(dur_s * sr)
    src_start = min(max(0, int(transition_start * sr)), max(0, src.shape[1] - 1))
    tgt_start = 0  # 过渡段 = 目标曲开头[0:dur_s] 渐开
    src_win = src[:, src_start:src_start + win]
    tgt_win = tgt[:, tgt_start:tgt_start + win]
    total_in = min(src_win.shape[1], tgt_win.shape[1])
    if total_in < 128:
        raise RuntimeError('MixPlan cue 后可用音频窗口不足')
    src_win = src_win[:, :total_in]
    tgt_win = tgt_win[:, :total_in]

    # 2026-09-24 逆向修正：官方无变速（见 render_from_am_enable_date 注释，SoundTouch
    # setTempo 无调用者 + 官方录音时基扫描原速胜出）。保持源曲原速。
    stretch = 1.0
    so = engine_fn(src_win, stretch, sr) if engine_fn and abs(stretch - 1.0) > 1e-4 else src_win
    total = min(so.shape[1], tgt_win.shape[1])
    so = so[:, :total].astype(np.float32)
    to = tgt_win[:, :total].astype(np.float32)

    presets = load_presets()
    mapping = {'central_cut_out': 'CentralCutOut',
               'central_bass_swap': 'CentralBassSwap', 'fade_in_fade_out': 'FadeInFadeOut',
               'smooth_fade_in_fade_out': 'SmoothFadeInFadeOut', 'overlap': 'Overlap',
               'no_plan': 'NoPlan', 'three_band_fade': 'ThreeBandFade',
               'tail_bass_swap': 'TailBassSwap', 'hpf_cut_out': 'HPFCutOut',
               'lpf_cut_in': 'LPFCutIn'}
    if mode in ('amfilter2', 'amfilter'):
        # 进阶交融 = 官方 AMfilterPlanJson 全链（gain + LPF/HPF 扫频 + low EQ）
        preset = _am_preset()
    elif mode in ('NoPlan', 'EQfilter', '3bandEQ'):
        # 2026-09-26：基础档官方效果链 = 原生预设 blob（mangled 符号键）。
        # 真机基础档默认 MixMode=EQfilter → filterEQPresetJson（3BAND arr[0]=−28 指纹，
        # docs/QQ-LOCAL-AUTOMIX-DUG-2026-09-24.md §10.2）：low EQ −28 阶跃 +
        # 出曲 LPF 10→4000Hz(exp) / 入曲 HPF 20→8000Hz(linear) 扫频——旧实现此处查
        # recipe 预设落空 → 裸 sin² 窗（缺 EQ/扫频），已补官方 blob。
        off = load_official_presets()
        mkey = {'NoPlan': '_ZN7QMCPCOM7AUTOMIX10NoPlanJsonE',
                'EQfilter': '_ZN7QMCPCOM7AUTOMIX18filterEQPresetJsonE',
                '3bandEQ': '_ZN7QMCPCOM7AUTOMIX16k3bandPresetJsonE'}.get(mode)
        preset = off.get(mkey) if mkey else None
        if preset is None:
            pname = mapping.get(mode)
            preset = presets.get(pname) if pname else None
    else:
        pname = mapping.get(mode)
        preset = presets.get(pname) if pname else None
    if mode and not preset and trace:
        trace.warn('cloud', f'未支持的 MixMode={mode}，不套用本地 preset')
    if preset:
        so = apply_chain(so, sr, preset.get('Achain', {}))
        to = apply_chain(to, sr, preset.get('Bchain', {}))
        # 官方混音层（SSAutoMixInst::processInEffect@0x40d054 反汇编实证）：
        #   out[i] = rampA[i]·bufA[i] + rampB[i]·bufB[i]
        # ramp 单数组 [this+0x628] 共 2n 个样本（ctor 0x40e630-0x40e678 实证）：
        #   ramp[k] = 0.5·(1 − cos(2π·k/(2n−1))) = sin²(π·k/(2n−1))
        # 源轨(IsFadeIn=false)→后半段 1→0 渐出；目标轨(IsFadeIn=true)→前半段 0→1 渐入。
        Ntot = 2 * win
        kk = np.arange(Ntot, dtype=np.float32)
        ramps = 0.5 * (1.0 - np.cos(2.0 * np.pi * kk / (Ntot - 1)))
        ramp_out = ramps[win:]     # 源轨 1→0 渐出（后段）
        ramp_in = ramps[:win]      # 目标轨 0→1 渐入（前段）
        mixed = so * ramp_out[None, :] + to * ramp_in[None, :]
    else:
        # 交叉层与档位无关：引擎 (processInEffect) 恒用同一 sin² 分半窗。
        # 未套用效果链时仍保持该窗，保证不降级成旧等功率近似。
        Ntot = 2 * win
        kk = np.arange(Ntot, dtype=np.float32)
        ramps = 0.5 * (1.0 - np.cos(2.0 * np.pi * kk / (Ntot - 1)))
        mixed = so * ramps[win:][None, :] + to * ramps[:win][None, :]

    # 输出长度固定 = dur_s（= InCueEntrys 秒，官方过渡段时长）。
    # 变速(type=2)会改变 so 长度，若不修正，过渡段会被截短、full 目标曲错位。
    n_out = win
    if mixed.shape[1] < n_out:
        mixed = np.pad(mixed, ((0, 0), (0, n_out - mixed.shape[1])), mode='edge')
    elif mixed.shape[1] > n_out:
        mixed = mixed[:, :n_out]
    mixed = np.ascontiguousarray(mixed, dtype=np.float32)

    meta = {'strategy': strategy, 'cue_source': cue_source,
            'mix_mode': mode, 'mix_plan_type': info['type'], 'preset_name': pname,
            'native_cue_decision': {'cut_finish_s': cut_time_s,
                                    'transition_dur_s': dur_s,
                                    'transition_start_s': transition_start},
            'source_cut_time_s': cut_time_s,
            'transition_start_s': transition_start,
            'transition_duration_s': dur_s,
            'target_entry_s': entry_s,
            'target_start_s': 0.0,
            'source_bpm': src_bpm, 'target_bpm': tgt_bpm,
            'bpm_source': 'mir(bid=24)' if (s_mir.get('bpm') and t_mir.get('bpm')) else 'mixplan',
            'stretch_factor': stretch, 'segments': 1,
            'evidence_gap': None,
            'mir_consumed': ([k for k in ('bpm', 'beat_start_times') if k in s_mir]),
            'mir_available_not_consumed': [k for k in ('cue_cuts', 'cue2_cuts',
                                                       'cue_entrys', 'cue2_entrys',
                                                       'chords', 'key', 'touchpoint',
                                                       'Fvc_conf', 'idx_chorus_seg_start')
                                           if k in s_mir]}
    return mixed.astype(np.float32), meta


# ── 官方 AM 效果链（2026-09-24 静态逆向铁证，见 .analysis/automix_re_mapping.md）──
# 官方 AM（进阶交融）权威 JSON —— 直接从 libSuperSound3.so .rodata dump：
#   setParam@0x417a60 → MixMode → DJPlan::SetPresetDJPlan@0x3fc98c
#   "amfilter2"(len 9) → GOT 0x668e58 → AMfilterPlanJson2@0x66f840 → JSON @0x57c2d5
#   （下一段 0x57bbcc 是 AMfilterPlanJson = "AM" 快扫变体，7 字符 "amfilter"→0x668130 才用，
#    amfilter2 模式经 reviseMixMode@0x41a4b8 归一后恒用 AM2 缓扫）
# AM2（缓扫，amfilter2 实际加载）：
#   Achain（源轨）：Gain custom [0,0][0.5,0][0.75,-2][0.85,-6][0.92,-15][1,-35] + LPF(type2) custom
#     [0,20k][0.1,10k][0.25,6.5k][0.4,4.5k][0.65,4k][0.75,3.6k][0.85,2.5k] + low EQ step 0→-15@0.8
#   Bchain（目标轨）：Gain custom [0.35,-30][0.5,-15][0.7,-7][0.85,-3][0.92,0] + HPF(type3) base=10000
#     custom [0.35,10k][0.4,1.5k][0.55,800][0.75,700][0.82,550][0.92,100][1,20] + low EQ step -15→0@0.8
_OFFICIAL_AM = {
    'Achain': {'list': [
        {'effect': {'type': 1, 'value': 0.0},
         'automation': {'type': 'custom',
                        'control_points': [[0.0, 0.0], [0.5, 0.0], [0.75, -2.0],
                                           [0.85, -6.0], [0.92, -15.0], [1.0, -35.0]]}},
        {'effect': {'type': 2, 'freq': 20000.0},
         'automation': {'type': 'custom',
                        'control_points': [[0.0, 20000.0], [0.1, 10000.0], [0.25, 6500.0],
                                           [0.4, 4500.0], [0.65, 4000.0], [0.75, 3600.0],
                                           [0.85, 2500.0]]}},
        {'effect': {'type': 0, 'target_param': 'low', 'low': 0.0},
         'automation': {'type': 'step', 'm': 0, 'n': -15, 'step_pos': 0.8}},
    ]},
    'Bchain': {'list': [
        {'effect': {'type': 1, 'value': -30.0},
         'automation': {'type': 'custom',
                        'control_points': [[0.35, -30.0], [0.5, -15.0], [0.7, -7.0],
                                           [0.85, -3.0], [0.92, 0.0]]}},
        {'effect': {'type': 3, 'freq': 10000.0},
         'automation': {'type': 'custom',
                        'control_points': [[0.35, 10000.0], [0.4, 1500.0], [0.55, 800.0],
                                           [0.75, 700.0], [0.82, 550.0], [0.92, 100.0],
                                           [1.0, 20.0]]}},
        {'effect': {'type': 0, 'target_param': 'low', 'low': -15.0},
         'automation': {'type': 'step', 'm': -15, 'n': 0, 'step_pos': 0.8}},
    ]},
}


def _am_preset() -> dict | None:
    """官方 amfilter2 渲染链：so .rodata 权威 AMfilterPlanJson2（@0x57c2d5）缓扫变体 dump。

    反汇编铁证（2026-09-24）：
      SetPresetDJPlan@0x3fc98c：len9 "amfilter2" → GOT 0x668e58 → AMfilterPlanJson2@0x66f840 → @0x57c2d5
      （0x57bbcc 的 AMfilterPlanJson 快扫是 7 字符 "amfilter" 专用，amfilter2 不加载它）
    """
    return _OFFICIAL_AM


def _no_plan_fallback() -> dict:
    """NoPlan（基础渐变）本地兜底——与官方 NoPlanJson 语义一致：
    Achain gain 0→-20dB(log) + low EQ 0→-20@0.5；Bchain gain -20→0dB(exp) + low EQ -20→0@0.5。"""
    return {
        'Achain': {'list': [
            {'effect': {'type': 1, 'value': 0.0},
             'automation': {'type': 'piecewise', 'm': 0.0, 'n': -20.0,
                            'start_pos': 0.0, 'end_pos': 1.0, 'curve_type': 2}},
            {'effect': {'type': 0, 'target_param': 'low', 'low': 0.0},
             'automation': {'type': 'step', 'm': 0, 'n': -20, 'step_pos': 0.5}},
        ]},
        'Bchain': {'list': [
            {'effect': {'type': 1, 'value': -20.0},
             'automation': {'type': 'piecewise', 'm': -20.0, 'n': 0.0,
                            'start_pos': 0.0, 'end_pos': 1.0, 'curve_type': 1}},
            {'effect': {'type': 0, 'target_param': 'low', 'low': -20},
             'automation': {'type': 'step', 'm': -20, 'n': 0, 'step_pos': 0.5}},
        ]},
    }


def _tempo_speed(in_bpm_c: float, out_bpm: float, is_fade_in: bool, t: float) -> float:
    """官方 tempo 曲线在过渡进度 t∈[0,1] 处的**播放速度**（1.0 = 原速）。

    出曲（is_fade_in=False）：bpm_lerp(t)/Out，1.0 → In_c/Out（加速贴齐入轨）
    入曲（is_fade_in=True） ：bpm_lerp(t)/In_c，Out/In_c → 1.0（减速后回原速）
    """
    tt = min(max(t, 0.0), 1.0)
    bpm = out_bpm + (in_bpm_c - out_bpm) * tt
    return bpm / (in_bpm_c if is_fade_in else out_bpm)


def _tempo_mean_speed(in_bpm_c: float, out_bpm: float, is_fade_in: bool) -> float:
    """速度曲线为线性 → 窗内均值 = (s(0)+s(1))/2。

    用于算变速所需输入长度：输出 L 秒需 L×mean 秒输入（源轨加速 >L、入轨减速 <L）。
    """
    return 0.5 * (_tempo_speed(in_bpm_c, out_bpm, is_fade_in, 0.0)
                  + _tempo_speed(in_bpm_c, out_bpm, is_fade_in, 1.0))


def _official_tempo_stretch(win_audio, sr, in_bpm_c, out_bpm, is_fade_in, engine_fn,
                            out_len=None, seg_s=0.5, margin_ms=60.0):
    """官方变速渐变复刻（processInSoundTouch@0x412240 反汇编 + marathon3.log 1418 次
    setTempo 实测互证，2026-09-27 定稿）。

    官方每个音频块调一次 SoundTouch::setTempo，值 = 两 BPM 端点按过渡进度线性插值
    后按角色归一（ctor 0x40de7c 把 (OutBpm, InBpm_c) 存到 [this+0x18]/[0x1c]）：
        bpm_lerp(t)  = Out + (In_c − Out)·t          （t = 过渡进度 0→1）
        出轨 tempo(t) = bpm_lerp(t) / Out             （1.0 → In_c/Out，加速贴齐入轨）
        入轨 tempo(t) = bpm_lerp(t) / In_c            （Out/In_c → 1.0，减速贴齐后回原速）
    交棒点两轨有效 BPM 均为 In_c（beat-match 交接）。
    marathon 实测（In=120/Out=90）：0.7558→0.9996 与 1.0135→1.3328 两条 56 步斜坡
    即本式的中段采样，步长比 = 0.005805/0.0043535 = 4/3 = In/Out 逐位吻合。

    ── 2026-09-27 二次修订：连续流语义（修"逐块独立拉伸 → 半段数字静音"）──────
    旧实现按 4096 样本切块逐块独立调用引擎再拼接。每次调用都要付一次引擎内部延迟
    （帧长 1024 + 相似度搜索 ≈1500 样本，_atsm 还再裁 ~512 预热静音），实测 76 块
    只出 0.43~0.50× 音频，末段被零填充成数字静音（Cold Blood→TIME CYCLE 两档静音
    占比 50%/51%，听感即"过渡放到一半断掉"）。官方是**一条连续流**（SoundTouch 状态
    跨块持续），4096 只是处理粒度，不是 76 次互相独立的拉伸。
    另：旧实现把 speed 直接当引擎的 stretch 实参，方向也是反的（官方源轨加速 = 内容
    被压缩，引擎参数应为长度比 1/speed）。

    现实现 = 输出域映射：输出总长固定（out_len，缺省 = 输入长度），按 seg_s 分段，
    每段输出长度 L 固定，输入按曲线取 L×speed(段中点) 并多留 margin 送引擎，回读后
    裁到恰好 L 再拼接 —— 总输出严格等于目标长度，**无零填充、无静音**。输入不足时
    按边界复制补齐（不是补零）。
    """
    if engine_fn is None or in_bpm_c <= 0 or out_bpm <= 0:
        return win_audio
    n_in = win_audio.shape[1]
    n_out = int(out_len) if out_len else n_in
    if abs(in_bpm_c / out_bpm - 1.0) <= 1e-3:          # BPM 一致：官方 tempo 恒 1
        return np.ascontiguousarray(win_audio[:, :n_out], dtype=np.float32)
    if n_out <= 0 or n_in <= 0:
        return win_audio
    margin = max(1024, int(margin_ms / 1000.0 * sr))
    seg_out = max(4096, min(n_out, int(seg_s * sr)))
    out_segs = []
    pos_out = 0
    pos_in = 0.0
    while pos_out < n_out:
        L = min(seg_out, n_out - pos_out)
        speed = _tempo_speed(in_bpm_c, out_bpm, is_fade_in, (pos_out + L / 2.0) / max(n_out, 1))
        need = int(np.ceil(L * speed)) + margin
        start = int(round(pos_in))
        if start >= n_in:                              # 输入已耗尽：复用末尾一段
            start = max(0, n_in - need)
        seg = win_audio[:, start:start + need]
        if seg.shape[1] < need:                        # 输入不足：边界复制（绝不用零）
            seg = np.pad(seg, ((0, 0), (0, need - seg.shape[1])), mode='edge')
        ratio = 1.0 / max(speed, 1e-6)                 # 引擎实参 = 输出/输入 长度比
        try:
            stretched = np.asarray(engine_fn(seg, float(ratio), sr), dtype=np.float32)
        except Exception:
            stretched = seg
        if 0 < stretched.shape[1] < L:
            # 引擎每次调用都有内部延迟（分析窗填充 + 尾块不冲刷）使输出短于请求值
            # → 按缺口补偿长度比重试一次（只补长度；内容推进的残差由调用方实测处理）
            try:
                ratio2 = float(ratio) * (L / stretched.shape[1]) * 1.02
                stretched = np.asarray(engine_fn(seg, ratio2, sr), dtype=np.float32)
            except Exception:
                pass
        if stretched.shape[1] < L:                     # 仍不足：边界复制补齐（无静音）
            if stretched.shape[1] == 0:
                stretched = np.zeros((win_audio.shape[0], L), dtype=np.float32)
            else:
                stretched = np.pad(stretched, ((0, 0), (0, L - stretched.shape[1])), mode='edge')
        out_segs.append(stretched[:, :L])
        pos_out += L
        pos_in += L * speed                            # 名义映射推进（margin 不计入）
    out = np.concatenate(out_segs, axis=1) if out_segs else win_audio
    return np.ascontiguousarray(out[:, :n_out], dtype=np.float32)


def render_from_am_enable_date(src, tgt, sr, am, mid_src='', mid_tgt='',
                               engine_fn=None, trace=None,
                               tempo_ramp: bool = False) -> tuple:
    """真实 AutoMixEnableDate 13 字段直接驱动渲染（无推导）。

    tempo_ramp=True 启用官方变速渐变（见 _official_tempo_stretch；默认关闭以保持
    既有输出不变——官方两轨在过渡期按上式连续变速，BPM 不匹配歌对开启后更贴近官方）。

    2026-09-22 模拟器 frida 实抓 3 组完整数据（hook_capture4 logcat 版），
    字段与语义（Kotlin data class 构造顺序 a0..a12）：
      a0 InSongKey = 目标歌 SongKey(=2^61+songId)
      a1 OutSongKey = 源歌 SongKey
      a2 Enable / a3 IsFadeIn / a4 MixMode(amfilter2) / a5 InBpm / a6 OutBpm
      a7 InCue / a8 OutCue / a9 InDuration / a10 OutDuration / a11 CurTime / a12 type
    语义：In=目标歌(切入), Out=源歌(切出)；全部为秒级真实值。

    窗口定义（与官方 App 一致）：
      blend_len = max(InDuration, OutDuration)
      源尾窗口 = src[OutCue : OutCue+blend_len]
      目标头窗口 = tgt[InCue : InCue+blend_len]
      type=0 不变速；效果链沿用 amfilter2 AM preset（Achain=源轨, Bchain=目标轨）。

    返回 (transition_audio, meta)；完整曲目由调用方拼接：
      src[:OutCue] + transition + tgt[InCue+blend_len:]
    """
    out_cue = float(am['OutCue'])
    in_cue = float(am['InCue'])
    in_dur = float(am['InDuration'])
    out_dur = float(am['OutDuration'])
    in_bpm = float(am['InBpm'])
    out_bpm = float(am['OutBpm'])
    # 2026-09-25 终版：preset 名 = reviseMixMode(MixMode) 后按 type≤1 强制改 NoPlan
    # （SSAutoMixInst ctor 0x40e14c/0x40e150 实测：amfilter2+type=0 → SetPresetDJPlan("NoPlan")）
    from .qq_desidecue import resolve_preset_name as _resolve_preset_name
    mode = _resolve_preset_name(am.get('MixMode') or '', am.get('type'))
    if not mode:
        mode = 'NoPlan'  # 逆向实证：MixMode 为空 → NoPlan（newautomix/b.java L119-120、L133-134）
    mtype = int(am.get('type') or 0)

    blend_len = max(out_dur, in_dur)
    win = int(blend_len * sr)
    src_start = min(max(0, int(out_cue * sr)), max(0, src.shape[1] - 1))
    tgt_start = min(max(0, int(in_cue * sr)), max(0, tgt.shape[1] - 1))
    src_win = src[:, src_start:src_start + win]
    tgt_win = tgt[:, tgt_start:tgt_start + win]
    total_in = min(src_win.shape[1], tgt_win.shape[1])
    if total_in < 128:
        raise RuntimeError('真实窗口后可用音频不足: src_start={src_start} tgt_start={tgt_start}')
    src_win = src_win[:, :total_in]
    tgt_win = tgt_win[:, :total_in]

    # 变速语义沿革：
    #   2026-09-24 旧结论"官方无变速"已被推翻——当时反汇编漏了 processInSoundTouch
    #   内的 SoundTouch::setTempo 调用（0x4122f0 bl 0x182d00）。
    #   2026-09-27 定稿：官方过渡期两轨连续变速（marathon3.log 1418 次 setTempo
    #   实测：线性斜坡、步长比=In/Out、端点=(Out/In_c, 1.0)/(1.0, In_c/Out)），
    #   公式见 _official_tempo_stretch。tempo_ramp=False（默认）保持历史输出；
    #   tempo_ramp=True 按 official 曲线分段变速。
    stretch = 1.0
    so = engine_fn(src_win, stretch, sr) if engine_fn and abs(stretch - 1.0) > 1e-4 else src_win
    in_bpm_c = float(am.get('InBpm') or 0.0)
    out_bpm = float(am.get('OutBpm') or 0.0)
    if tempo_ramp:
        so = _official_tempo_stretch(so, sr, in_bpm_c, out_bpm, False, engine_fn, out_len=win)
    # 两轨窗口统一对齐 blend_len(win)：_official_tempo_stretch 现按输出域映射，
    # 返回长度恰为 win（无补零），下面的补零分支仅作兜底。自动化曲线按 win 全长铺展。
    so = so[:, :win].astype(np.float32)
    to = tgt_win[:, :win].astype(np.float32)
    if tempo_ramp:
        to = _official_tempo_stretch(to, sr, in_bpm_c, out_bpm, True, engine_fn, out_len=win)
    if so.shape[1] < win:
        so = np.concatenate([so, np.zeros((so.shape[0], win - so.shape[1]), np.float32)], axis=1)
    if to.shape[1] < win:
        to = np.concatenate([to, np.zeros((to.shape[0], win - to.shape[1]), np.float32)], axis=1)

    # 官方两档语义（2026-09-23 预设 JSON 实证）：
    #   amfilter2（进阶交融）= _am_preset() 全链：Achain gain 0→-25dB+LPF 20k→2.3k 扫频
    #     + low EQ step 0→-15@0.75；Bchain gain -30→0dB+HPF 10k→20 扫频 + low EQ step -15→0@0.75
    #   NoPlan（基础渐变，MixMode=NoPlan）= NoPlanJson 效果链：Achain gain piecewise
    #     0→-20dB(curve_type=2 → exp)+low EQ step 0→-20@0.5；Bchain gain -20→0dB(curve_type=1 → log)
    #     + low EQ step -20→0@0.5
    #   2026-09-24 修正：curve_type 1=log / 2=exp（djplan.eval_automation 处有反汇编实证）；
    #   另注：真机实测基础档默认 MixMode 是 "EQfilter" 而非 "NoPlan"，
    #   见 docs/QQ-LOCAL-AUTOMIX-DUG-2026-09-24.md §11.3
    #   两档交叉层一致 = 同一 sin² 分半钟形窗（processInEffect@0x40d054 实锤，见下）
    preset = None
    official = load_official_presets()
    # 2026-09-25 终版：MixMode→预设 按真机逆向的 SetPresetDJPlan 8 名字表解析
    # （docs/QQ-LOCAL-AUTOMIX-DUG-2026-09-24.md §4/§10.2；amfilter2→AMfilterPlanJson2 实测 -35dB 终点）。
    # 2026-09-24 修正：curve_type 1=log / 2=exp（djplan.eval_automation 处有反汇编实证）；
    #   真机实测基础档默认 MixMode 是 "EQfilter" → filterEQPresetJson（3BAND arr[0]=−28 指纹），
    #   见 docs/QQ-LOCAL-AUTOMIX-DUG-2026-09-24.md §10.2
    #   两档交叉层一致 = 同一 sin² 分半钟形窗（processInEffect@0x40d054 实锤，见下）
    if mode in ('amfilter2', 'amfilter'):
        # amfilter2 → AMfilterPlanJson2（0x57c2d5 缓扫变体，实测终点 −35dB/2500Hz/22.2Hz）
        preset = _am_preset()
    else:
        # 8 个 legacy 名字 → 符号键（SetPresetDJPlan@0x3fc98c 逐分支实证，§4）
        legacy = {'NoPlan': 'NoPlanJson', 'EQfilter': 'filterEQPresetJson',
                  'filter': 'kFilterPresetJson', '3bandEQ': 'k3bandPresetJson',
                  'echo': 'EchoDeclineJson', 'simpleexchange': 'simpleexchange',
                  'EQfilter2': 'filterEQPresetJson'}
        sym = legacy.get(mode)
        if sym:
            preset = official.get('_ZN7QMCPCOM7AUTOMIX' + {'NoPlanJson': '10NoPlanJsonE',
                                                           'filterEQPresetJson': '18filterEQPresetJsonE',
                                                           'kFilterPresetJson': '17kFilterPresetJsonE',
                                                           'k3bandPresetJson': '16k3bandPresetJsonE',
                                                           'EchoDeclineJson': '15EchoDeclineJsonE',
                                                           'simpleexchange': '14simpleexchangeE'}.get(sym, ''))
        if preset is None:
            # snake_case / 其余名 → qqmusic_mixmode_table.json（29 名解析表）→ load_presets()
            mm_table = _json.loads(Path(__file__).resolve().parent.joinpath(
                'data', 'qqmusic_mixmode_table.json').read_text(encoding='utf8'))
            pname = (mm_table.get(mode) or {}).get('preset')
            preset = load_presets().get(pname) if pname else None
    if preset:
        so = apply_chain(so, sr, preset.get('Achain', {}))
        to = apply_chain(to, sr, preset.get('Bchain', {}))
        # 官方混音层（SSAutoMixInst::processInEffect@0x40d054 反汇编实证）：
        #   out[i] = rampA[i]·bufA[i] + rampB[i]·bufB[i]
        # ramp 单数组 [this+0x628] 共 2n 个样本（ctor 0x40e630-0x40e678 实证）：
        #   ramp[k] = 0.5·(1 − cos(2π·k/(2n−1))) = sin²(π·k/(2n−1))
        #   （常量 0x54b9a4=2π 实证；PLT 0x183650→cosf 实证）
        # 源轨(IsFadeIn=false)→后半段 1→0 渐出；目标轨(IsFadeIn=true)→前半段 0→1 渐入。
        # 该窗为引擎层唯一交叉曲线（与档位无关），档位差异仅在下列效果链 Preset。
        Ntot = 2 * win
        kk = np.arange(Ntot, dtype=np.float32)
        ramps = 0.5 * (1.0 - np.cos(2.0 * np.pi * kk / (Ntot - 1)))
        ramp_out = ramps[win:]     # 源轨 1→0 渐出（后段）
        ramp_in = ramps[:win]      # 目标轨 0→1 渐入（前段）
        mixed = so * ramp_out[None, :] + to * ramp_in[None, :]
    else:
        # 同 render_cloud：交叉层恒为引擎 sin² 分半窗，与档位/效果链无关。
        Ntot = 2 * win
        kk = np.arange(Ntot, dtype=np.float32)
        ramps = 0.5 * (1.0 - np.cos(2.0 * np.pi * kk / (Ntot - 1)))
        mixed = so * ramps[win:][None, :] + to * ramps[:win][None, :]
    mixed = np.ascontiguousarray(mixed[:, :win], dtype=np.float32)

    meta = {'strategy': am.get('strategy') or 'real_am_enable_date',
            'source': am.get('source') or 'AutoMixEnableDate',
            'mix_mode': mode, 'mix_plan_type': mtype,
            'in_song_key': am.get('InSongKey'), 'out_song_key': am.get('OutSongKey'),
            'enable': am.get('Enable'), 'is_fade_in': am.get('IsFadeIn'),
            'in_bpm': in_bpm, 'out_bpm': out_bpm,
            'in_cue_s': in_cue, 'out_cue_s': out_cue,
            'in_duration_s': in_dur, 'out_duration_s': out_dur,
            'blend_len_s': blend_len,
            'transition_start_s': out_cue,
            'transition_duration_s': blend_len,
            'source_cut_time_s': out_cue + blend_len,
            'target_start_s': in_cue,
            'stretch_factor': round(stretch, 4), 'segments': 1,
            'evidence_gap': None if preset is not None
                            else 'fallback: sin² 分半窗（无效果链，官方 AM 预设不可用）'}
    return mixed.astype(np.float32), meta


# ── QQ 歌单 + 音频下载（登录态, musicu.fcg 直连）──────────────────────────

def qq_search(keyword: str, cookie: str = '', limit: int = 10) -> list[dict]:
    """QQ 歌曲搜索（client_search_cp）。

    返回 [{mid, name, duration_s, artists:[...]}]。QQ web 端用户歌单接口
    （GetUserDiss）当前已关闭（code 40000），选歌改用搜索。
    """
    import urllib.parse as _up
    if not cookie:
        cookie = _get_cookie()
    qs = _up.urlencode({'p': 1, 'n': limit, 'w': keyword, 'format': 'json'})
    url = f'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?{qs}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0',
                                               'Referer': 'https://y.qq.com/', 'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=20) as resp:
        text = resp.read().decode('utf8', errors='ignore')
    body = _json.loads(text.strip().lstrip('MusicJsonCallback(').rstrip(')'))
    out = []
    for s in (body.get('data', {}).get('song', {}).get('list')) or []:
        mid = s.get('mid') or s.get('songmid')
        if not mid:
            continue
        out.append({'mid': str(mid), 'name': s.get('name') or s.get('songname') or '',
                    'duration_s': round(float(s.get('interval') or 0), 1),
                    'artists': [a.get('name') for a in (s.get('singer') or [])]})
    return out


def _web_get(url: str, cookie: str = '') -> dict:
    """c.y.qq.com rsc/qzone web 接口 GET + JSON 解析（MusicJsonCallback 包裹自动剥离）。"""
    if not cookie:
        cookie = _get_cookie()
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://y.qq.com/', 'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read().decode('utf8', errors='ignore')
    t = raw.strip()
    if t.startswith('MusicJsonCallback'):
        t = t[len('MusicJsonCallback('):]
        if t.endswith(')'):
            t = t[:-1]
    return _json.loads(t)


def _gtk(cookie: str) -> int:
    c = {}
    for p in cookie.split(';'):
        i = p.find('=')
        if i > 0:
            c[p[:i].strip().lower()] = p[i + 1:].strip()
    return _h33(c.get('qm_keyst') or c.get('qqmusic_key') or '')


def _cookie_uin(cookie: str) -> str:
    c = {}
    for p in cookie.split(';'):
        i = p.find('=')
        if i > 0:
            c[p[:i].strip().lower()] = p[i + 1:].strip()
    return ''.join(ch for ch in c.get('uin', '') if ch.isdigit())


def qq_playlists(cookie: str = '') -> list[dict]:
    """用户歌单列表（web fcg_user_created_diss，实测可用）。

    返回 [{id: tid, name: diss_name, song_count}]。
    注：client 端 GetUserDiss 已关闭（code 40000），改用 c.y.qq.com rsc 接口。
    """
    if not cookie:
        cookie = _get_cookie()
    uin = _cookie_uin(cookie)
    if not uin:
        return []
    url = (f'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin={uin}'
           f'&sin=0&size=60&format=json&inCharset=utf8&outCharset=utf-8'
           f'&platform=yqq.json&needNewCode=1&g_tk={_gtk(cookie)}')
    body = _web_get(url, cookie)
    diss = (body.get('data') or {}).get('disslist') or []
    out = []
    for d in diss:
        tid = d.get('tid')
        if not tid:
            continue  # tid=0（我的收藏目录等特殊项）跳过
        out.append({'id': str(tid), 'name': d.get('diss_name') or '',
                    'song_count': d.get('song_cnt') or 0})
    return out


def qq_playlist_detail(dissid: int | str, cookie: str = '',
                       num: int = 500) -> list[dict]:
    """歌单歌曲列表（web fcg_ucc_getcdinfo_byids_cp，实测可用，一次返回全量）。

    返回 [{id, mid, name, duration_s, artists:[...]}]。
    """
    if not cookie:
        cookie = _get_cookie()
    url = (f'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'
           f'?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid={dissid}'
           f'&format=json&inCharset=utf8&outCharset=utf-8&g_tk={_gtk(cookie)}')
    body = _web_get(url, cookie)
    cdlist = body.get('cdlist') or []
    out = []
    for song in (cdlist[0].get('songlist') if cdlist else []) or []:
        mid = song.get('mid')
        if not mid:
            continue
        out.append({
            'id': str(song.get('id') or ''),
            'mid': str(mid),
            'name': song.get('name') or song.get('title') or '',
            'duration_s': round(float(song.get('interval') or 0), 1),
            'artists': [s.get('name') for s in (song.get('singer') or [])],
        })
    return out


# --- QQ 播放地址/下载（复刻 WaveForge local-server.mjs 流程，2026-09-22 实测）---
# 关键差异（此前一直用 songmid 拼 filename 导致 VIP 歌 CDN -46628 file not exist）：
#   1) filename 必须用 media_mid 拼（media_mid 可能 != songmid，如 004BdL7I39jc0f → 003QfVFj41KKho）
#   2) songtype 取自歌曲元数据（music.pf_song_detail_svr / get_song_detail_yqq）
#   3) comm 用最小形状 {uin, format, ct:24, cv:0, authst}，请求键 req_1，随机 guid
#   4) CDN 主机避开 http://ws 前缀（WaveForge 明确如此）
_QQ_META_CACHE: dict[str, dict] = {}


def _qq_song_detail(mid: str, cookie: str = '') -> dict:
    """歌曲元数据：media_mid + songtype + size_* 字段（WaveForge getQQPlaybackMetadata 形状）。"""
    if mid in _QQ_META_CACHE:
        return _QQ_META_CACHE[mid]
    if not cookie:
        cookie = _get_cookie()
    payload = {
        'songinfo': {
            'method': 'get_song_detail_yqq',
            'module': 'music.pf_song_detail_svr',
            'param': {'song_mid': mid},
        },
    }
    url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?' + urllib.parse.urlencode(
        {'data': _json.dumps(payload)})
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
        'Referer': 'https://y.qq.com/', 'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=25) as resp:
        body = _json.loads(resp.read().decode('utf8', errors='ignore'))
    track = (body.get('songinfo') or {}).get('data') or {}
    track = track.get('track_info') or track
    file = track.get('file') or {}
    media_mid = str(file.get('media_mid') or track.get('media_mid') or mid)
    raw_type = track.get('type')
    if raw_type is None:
        raw_type = track.get('songtype')
    if raw_type is None:
        raw_type = track.get('songType')
    try:
        songtype = int(float(raw_type)) if raw_type not in (None, '') else 0
    except (TypeError, ValueError):
        songtype = 0
    meta = {
        'media_mid': media_mid,
        'songtype': songtype,
        'name': track.get('name') or track.get('title') or mid,
        'sizes': {k: file.get(k) for k in (
            'size_flac', 'size_ape', 'size_320mp3', 'size_128mp3', 'size_48aac')},
    }
    if len(_QQ_META_CACHE) > 512:
        _QQ_META_CACHE.clear()
    _QQ_META_CACHE[mid] = meta
    return meta


def _qq_filename(media_mid: str, quality: str) -> str:
    prefix, ext = {
        'm4a': ('C400', '.m4a'), '128': ('M500', '.mp3'), '320': ('M800', '.mp3'),
        'flac': ('F000', '.flac'), 'ape': ('A000', '.ape'),
    }.get(quality, ('C400', '.m4a'))
    return f'{prefix}{media_mid}{ext}'


def qq_song_url(mid: str, cookie: str = '', quality: str = '320') -> dict:
    """单曲可播放地址（复刻 WaveForge requestDirectQQUrl：元数据 → CgiGetVkey）。

    返回 {url, filename, media_mid, songtype, size, type, sip}；
    purl 为空（无版权/不可播）→ url=''。
    """
    if not cookie:
        cookie = _get_cookie()
    c = {}
    for p in cookie.split(';'):
        i = p.find('=')
        if i > 0:
            c[p[:i].strip().lower()] = p[i + 1:].strip()
    uin = ''.join(ch for ch in c.get('uin', '') if ch.isdigit())
    key = c.get('skey') or c.get('p_skey') or c.get('qm_keyst') or c.get('qqmusic_key') or ''

    meta = _qq_song_detail(mid, cookie)
    media_mid = meta['media_mid']
    songtype = meta['songtype']
    filename = _qq_filename(media_mid, quality)

    comm = {'uin': uin, 'format': 'json', 'ct': 24, 'cv': 0}
    if key:
        comm['authst'] = key
    body = {
        'comm': comm,
        'req_1': {
            'module': 'vkey.GetVkeyServer',
            'method': 'CgiGetVkey',
            'param': {
                'guid': str(random.randint(0, 9999999)),
                'songmid': [mid],
                'songtype': [songtype],
                'uin': str(uin or '0'),
                'loginflag': 1 if uin else 0,
                'platform': '20',
                'filename': [filename],
            },
        },
    }
    r = _post_raw(body, cookie)
    req = r.get('req_1') or r.get('req_0') or {}
    data = req.get('data') or {}
    purl = ''
    size = 0
    ret_mid = ''
    for item in data.get('midurlinfo') or []:
        ret_mid = str(item.get('songmid') or '')
        if ret_mid and ret_mid != mid:
            continue  # WaveForge：songmid 校验不匹配则拒绝
        purl = item.get('purl') or ''
        size = int(item.get('size') or 0)
        break
    sip = [str(s).rstrip('/') for s in (data.get('sip') or [])]
    domain = next((s for s in sip if not s.startswith('http://ws')), None) \
        or (sip[0] if sip else 'https://dl.stream.qqmusic.qq.com')
    url = purl if purl.startswith('http') else f'{domain}/{purl}' if purl else ''
    return {'url': url, 'filename': filename, 'media_mid': media_mid,
            'songtype': songtype, 'size': size, 'type': 'mp3' if 'mp3' in filename else 'm4a',
            'sip': sip}


def _post_raw(body: dict, cookie: str) -> dict:
    """musicu.fcg POST（WaveForge 形状的完整 body，不经 _post 的重 comm）。"""
    req = urllib.request.Request('https://u.y.qq.com/cgi-bin/musicu.fcg',
                                 data=_json.dumps(body).encode('utf8'),
                                 headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
                                          'Referer': 'https://y.qq.com/', 'Content-Type': 'application/json',
                                          'Cookie': cookie})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return _json.loads(resp.read())


def download_qq_song(mid: str, dest: Path, cookie: str = '', timeout: float = 120.0) -> dict:
    """下载 QQ 曲目到 dest（缓存 data/cache/{mid}.mp3）。按 320→128→m4a 质量依次尝试。"""
    if not cookie:
        cookie = _get_cookie()
    meta = _qq_song_detail(mid, cookie)
    last_err: Exception | None = None
    for quality in ('320', '128', 'm4a'):
        info = qq_song_url(mid, cookie, quality)
        purl = info['url']
        if not purl:
            last_err = RuntimeError(f'无可用播放地址: mid={mid}（无版权/VIP 试听限制）')
            continue
        hosts = info.get('sip') or ['https://dl.stream.qqmusic.qq.com']
        data = None
        for host in hosts:
            if str(host).startswith('http://ws'):
                continue  # WaveForge 明确避开 ws 主机
            try:
                req = urllib.request.Request(f'{host}/{purl}' if not purl.startswith('http') else purl,
                                             headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y.qq.com/'})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = resp.read()
                break
            except Exception as e:
                last_err = e
        if data is None:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + '.part')
        tmp.write_bytes(data)
        tmp.replace(dest)
        return {'mid': mid, 'quality': quality, 'bytes': len(data),
                'name': meta.get('name', '')}
    raise RuntimeError(f'QQ 下载失败: mid={mid} {last_err}')
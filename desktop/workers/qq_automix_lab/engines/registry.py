"""AutoMix Lab —— 引擎注册表

每个引擎都记录它实际使用的**手法**（算法家族 / 瞬态处理 / 相位处理 / 立体声处理 /
授权），这样听感差异可以对应到具体技术选择，而不是"感觉这个好听"。

统一接口约定（重要）：
    stretch = 输出时长 / 输入时长     （>1 = 变长 / 减速）

各引擎内部自行换算：
    librosa.effects.time_stretch(rate)   rate = 1/stretch
    audiotsm  method(channels, speed)    speed = 1/stretch
    rubberband.exe -t<stretch>           直接用 stretch
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf


# ── 工具 ─────────────────────────────────────────────────────────────────

def fix_length(audio: np.ndarray, target: int) -> np.ndarray:
    """长度校正（与生产代码 fix_length 语义一致）。"""
    if audio.ndim == 1:
        audio = audio[None, :]
    cur = audio.shape[1]
    if cur == target:
        return audio
    if cur > target:
        return audio[:, :target]
    return np.pad(audio, ((0, 0), (0, target - cur)), mode='constant')


def resolve_rubberband() -> str | None:
    """定位 rubberband 可执行文件（PATH 或环境变量或同级 bin/）。"""
    import os
    env = os.environ.get('AUTOMIX_LAB_RUBBERBAND')
    if env and Path(env).exists():
        return env
    for name in ('rubberband-r3', 'rubberband'):
        found = shutil.which(name)
        if found:
            return found
    local = Path(__file__).resolve().parent.parent.parent / 'bin'
    for name in ('rubberband-r3.exe', 'rubberband.exe', 'rubberband-r3', 'rubberband'):
        p = local / name
        if p.exists():
            return str(p)
    return None


# ── 引擎实现 ──────────────────────────────────────────────────────────────

def _atsm(a: np.ndarray, stretch: float, factory) -> np.ndarray:
    from audiotsm.io.array import ArrayReader, ArrayWriter
    ch = a.shape[0]
    r = ArrayReader(np.ascontiguousarray(a, dtype=np.float32))
    w = ArrayWriter(channels=ch)
    factory(ch, speed=1.0 / stretch).run(r, w)
    out = np.asarray(w.data, dtype=np.float32)
    # audiotsm 预热：首个合成帧组装完成前输出静音（实测 ~512 样本）。
    # 只裁掉比输入多出来的前导静音，避免在过渡入口留一个 11.6ms 的坑。
    in_nz = np.abs(a).max(axis=0) > 1e-4
    out_nz = np.abs(out).max(axis=0) > 1e-4
    nz_in = int(np.argmax(in_nz)) if in_nz.any() else 0
    nz_out = int(np.argmax(out_nz)) if out_nz.any() else 0
    warm = nz_out - nz_in
    if warm > 0:
        out = out[:, warm:]
    return out


def eng_librosa_pv(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    return np.stack([librosa.effects.time_stretch(a[c], rate=1.0 / stretch)
                     for c in range(a.shape[0])])


def eng_audiotsm_wsola(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    from audiotsm import wsola
    return _atsm(a, stretch, wsola)


def eng_audiotsm_pv(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    from audiotsm import phasevocoder
    return _atsm(a, stretch, phasevocoder)


def eng_audiotsm_ola(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    from audiotsm import ola
    return _atsm(a, stretch, ola)


def eng_hpss_wsola(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    """HPSS 分离：谐波走 PV、打击乐走 WSOLA。"""
    from audiotsm import wsola
    out = []
    for c in range(a.shape[0]):
        h, p = librosa.effects.hpss(a[c].astype(np.float32))
        hs = librosa.effects.time_stretch(h, rate=1.0 / stretch)
        ps = _atsm(p[None, :], stretch, wsola)[0]
        n = max(len(hs), len(ps))
        out.append(np.pad(hs, (0, n - len(hs))) + np.pad(ps, (0, n - len(ps))))
    return np.stack(out)


def eng_wsola_sync(a: np.ndarray, stretch: float, sr: int) -> np.ndarray:
    """自实现 WSOLA —— 多声道共用搜索位置（保证声道间相位一致）。

    这是本平台的核心候选：不依赖第三方库、无授权问题、且修复了
    audiotsm 多声道各自搜索导致的立体声塌陷。

    归一化用 nrm 下限保护，避免旧实现 out/acc 在 acc 极小时爆音。
    """
    frame, hop_out, tol = 1024, 512, 256
    hop_in = max(1, int(round(hop_out / stretch)))
    win = np.hanning(frame).astype(np.float32)
    n_out = int(round(a.shape[1] * stretch))
    buf = np.zeros((a.shape[0], n_out + frame), dtype=np.float32)
    nrm = np.zeros(n_out + frame, dtype=np.float32)

    # 多声道求和的单声道参考，用于相似度搜索（关键：所有声道共用同一位置）
    mono = a.mean(axis=0)

    pos_in, pos_out = 0, 0
    first = True
    while pos_out + frame < n_out and pos_in + hop_in + frame < a.shape[1]:
        if first:
            best = pos_in
            first = False
        else:
            lo = max(0, pos_in - tol)
            hi = min(a.shape[1] - frame - 1, pos_in + tol)
            ref = buf[:, pos_out:pos_out + hop_out].mean(axis=0)
            ref = ref - ref.mean()
            rn = np.linalg.norm(ref) + 1e-9
            best, bs = pos_in, -1e9
            for off in range(0, max(1, hi - lo), 32):
                p0 = lo + off
                if p0 + hop_out > len(mono):
                    break
                seg = mono[p0:p0 + hop_out]
                seg = seg - seg.mean()
                d = float(np.dot(ref, seg)) / (rn * (np.linalg.norm(seg) + 1e-9))
                if d > bs:
                    bs, best = d, p0
        seg = a[:, best:best + frame]
        if seg.shape[1] < frame:
            break
        buf[:, pos_out:pos_out + frame] += seg * win[None, :]
        nrm[pos_out:pos_out + frame] += win
        pos_in = best + hop_in
        pos_out += hop_out

    nrm[nrm < 1e-6] = 1.0        # ← 旧实现爆音的根源在此：未做下限保护
    return buf[:, :n_out] / nrm[None, :n_out]


def _rubberband(a: np.ndarray, stretch: float, sr: int,
                engine: str, extra: list[str] | None = None,
                timemap: list[tuple[int, int]] | None = None) -> np.ndarray:
    exe = resolve_rubberband()
    if not exe:
        raise RuntimeError('rubberband 可执行文件未找到（设 AUTOMIX_LAB_RUBBERBAND 或放入 bin/）')
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        inp, outp = td / 'in.wav', td / 'out.wav'
        sf.write(str(inp), a.T, sr, subtype='PCM_16')
        cmd = [exe, f'-t{stretch:.8f}', engine, '--centre-focus', '-q']
        if timemap:
            tm = td / 'map.txt'
            tm.write_text('\n'.join(f'{s} {t}' for s, t in timemap), encoding='utf8')
            cmd += ['--timemap', str(tm)]
        if extra:
            cmd += extra
        cmd += [str(inp), str(outp)]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if r.returncode != 0 or not outp.exists():
            raise RuntimeError(f'rubberband 失败 rc={r.returncode}: {r.stderr[:200]}')
        y, _ = librosa.load(str(outp), sr=sr, mono=False)
    return y if y.ndim == 2 else np.stack([y, y])


def eng_rubberband_r3(a, stretch, sr):
    return _rubberband(a, stretch, sr, '-3')


def eng_rubberband_r2(a, stretch, sr):
    return _rubberband(a, stretch, sr, '-2')


def eng_rubberband_r2_c6(a, stretch, sr):
    """R2 + crisp=6（--no-lamination --window-short，官方注释「可能适合鼓」）。"""
    return _rubberband(a, stretch, sr, '-2', extra=['-c6'])


def eng_rubberband_r3_formant(a, stretch, sr):
    """R3 + 共振峰保持（变调时保留人声音色）。"""
    return _rubberband(a, stretch, sr, '-3', extra=['-F'])


# ── 注册表 ───────────────────────────────────────────────────────────────

@dataclass
class Engine:
    key: str
    name: str
    family: str
    fn: Callable
    license: str
    techniques: dict = field(default_factory=dict)
    available: bool = True
    note: str = ''
    is_baseline: bool = False


ENGINES: dict[str, Engine] = {
    'librosa_pv': Engine(
        key='librosa_pv', name='librosa 相位声码器', family='相位声码器',
        fn=eng_librosa_pv, license='ISC',
        techniques={
            'stft': 'n_fft=2048, hop=512',
            'transient': '无瞬态处理 —— 相位按帧线性推进，瞬态被平滑',
            'phase': '标准相位展开',
            'stereo': '各声道完全独立处理（无相干性约束）',
            'pitch': '变速与变调耦合于同一 PV',
        },
        note='WaveForge 当前生产实现（desktop/workers/render_worker.py）',
    ),
    'audiotsm_wsola': Engine(
        key='audiotsm_wsola', name='audiotsm WSOLA', family='WSOLA',
        fn=eng_audiotsm_wsola, license='MIT',
        techniques={
            'domain': '时域（不做 STFT）',
            'frame': '帧长 1024 / 合成跳距 512',
            'transient': '相似度搜索保留波形形态，瞬态自然保留',
            'phase': '时域对齐，无相位问题',
            'stereo': '多声道处理（实测立体声宽度会塌陷）',
            'pitch': '不变调（波形重排）',
        },
        note='SoundTouch TDStretch 同算法类；QQ音乐 libSuperSound3.so 用的就是它',
    ),
    'audiotsm_pv': Engine(
        key='audiotsm_pv', name='audiotsm 相位声码器', family='相位声码器',
        fn=eng_audiotsm_pv, license='MIT',
        techniques={
            'frame': '帧长 1024 / 合成跳距 512',
            'transient': '无瞬态处理',
            'phase': '标准相位声码器（与 librosa PV 同族）',
            'stereo': '多声道同步',
            'pitch': '不变调',
        },
        note='对照项：验证「是 PV 算法本身的问题，还是 librosa 实现的问题」',
    ),
    'audiotsm_ola': Engine(
        key='audiotsm_ola', name='audiotsm OLA', family='OLA（最朴素叠加）',
        fn=eng_audiotsm_ola, license='MIT',
        techniques={
            'domain': '时域，无相似度搜索',
            'transient': '无 —— 直接按固定跳距叠加，瞬态会被重复/切断',
            'stereo': '多声道同步',
        },
        note='下限对照：最朴素的算法能差到什么程度',
    ),
    'hpss_wsola': Engine(
        key='hpss_wsola', name='HPSS + 谐波PV + 打击乐WSOLA', family='混合',
        fn=eng_hpss_wsola, license='ISC + MIT',
        techniques={
            'separation': 'HPSS 分离谐波/打击乐',
            'transient': '打击乐走 WSOLA（保瞬态），谐波走 PV（保音高）',
            'phase': '谐波段用 PV',
            'stereo': '各声道独立',
        },
        note='WaveForge 代码里被关闭的路径（quality_stretch=False，全仓 0 个 True）',
    ),
    'wsola_sync': Engine(
        key='wsola_sync', name='自实现 WSOLA（多声道同步）', family='WSOLA',
        fn=eng_wsola_sync, license='自有（可随项目开源）',
        techniques={
            'domain': '时域',
            'frame': '帧长 1024 / 合成跳距 512 / 搜索窗 ±256',
            'search': '归一化互相关，**多声道共用搜索位置**（保证声道间相位一致）',
            'transient': '相似度搜索保留波形形态',
            'normalize': 'nrm 下限保护（1e-6）—— 规避旧实现 out/acc 爆音',
            'pitch': '不变调',
        },
        note='本平台核心候选：零授权成本 + 修复 audiotsm 的立体声塌陷',
    ),
    'rubberband_r3': Engine(
        key='rubberband_r3', name='RubberBand R3', family='PV + 瞬态相位重同步',
        fn=eng_rubberband_r3, license='GPL v2+ / 商业',
        techniques={
            'engine': 'R3（v3 新引擎，多分辨率窗）',
            'transient': '**瞬态处相位重同步**（phase resynchronisation）',
            'phase': '相位层积（phase lamination）+ 瞬态重同步',
            'stereo': '--centre-focus：保持中央素材聚焦 + 单声道兼容',
            'pitch': '独立 pitch/time 比',
        },
        note='网易云 libneaudioeffects.so 用的就是它（RubberBandStretcher）',
    ),
    'rubberband_r2': Engine(
        key='rubberband_r2', name='RubberBand R2（crisp=5 默认）', family='PV + 瞬态重同步（旧引擎）',
        fn=eng_rubberband_r2, license='GPL v2+ / 商业',
        techniques={
            'engine': 'R2（v3 前唯一引擎，CPU 远低于 R3）',
            'transient': '相位重同步（默认开启）',
            'phase': '相位层积（默认开启）',
            'stereo': '--centre-focus',
        },
        note='crisp=5 等价于默认处理选项（瞬态重同步 + 相位层积）',
    ),
    'rubberband_r2_c6': Engine(
        key='rubberband_r2_c6', name='RubberBand R2 crisp=6', family='PV + 短窗',
        fn=eng_rubberband_r2_c6, license='GPL v2+ / 商业',
        techniques={
            'engine': 'R2 + crisp=6',
            'crisp6': '--no-lamination --window-short（官方注释：可能适合鼓）',
            'stereo': '--centre-focus',
        },
        note='测试更短的处理窗对打击乐的适配性',
    ),
    'rubberband_r3_formant': Engine(
        key='rubberband_r3_formant', name='RubberBand R3 + 共振峰保持', family='PV + 瞬态重同步 + 共振峰',
        fn=eng_rubberband_r3_formant, license='GPL v2+ / 商业',
        techniques={
            'engine': 'R3 + -F（formant preservation）',
            'formant': '变调时保持共振峰包络，人声/乐器音色更自然',
            'stereo': '--centre-focus',
        },
        note='用于评估人声素材上的音色保持',
    ),
}


def available_engines() -> dict[str, Engine]:
    rb = resolve_rubberband()
    out = {}
    for k, e in ENGINES.items():
        if k.startswith('rubberband') and not rb:
            e = Engine(**{**e.__dict__, 'available': False,
                          'note': e.note + '（未找到 rubberband 可执行文件）'})
        out[k] = e
    return out


def get_engine(key: str) -> Engine:
    if key not in ENGINES:
        raise KeyError(f'未知引擎: {key}')
    return ENGINES[key]

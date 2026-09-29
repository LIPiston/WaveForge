# -*- coding: utf-8 -*-
"""把 automix-lab 生成的 3 份完整过渡产物裁成"演示片段"（源曲尾 + 过渡 + 目标曲头）。

一次性脚本：产出 public/automix-demo/{lite,advanced,extreme}.mp3。
片段边界与 UI 上的"源曲 / 过渡 / 目标曲"三段时间轴标注一一对应。
"""
from pathlib import Path

import numpy as np
import soundfile as sf

SRC_DIR = Path(r'D:\opencode\automix-lab\output')
OUT_DIR = Path(__file__).resolve().parent.parent / 'public' / 'automix-demo'
LEAD = 8.0    # 源曲尾部保留（秒）
TAIL = 8.0    # 目标曲开头保留（秒）

# (方案 key, 完整产物文件名, 源曲切点 section_src_end, 过渡结束 section_mix_end)
JOBS = [
    ('lite', 'full_t01_qq_00113JQa3vgrwr_mp3__optimized.wav', 314.293333, 326.293333),
    ('advanced', 'full_t01_qq_00113JQa3vgrwr_mp3__qqmusic_cloud.wav', 292.002623, 296.924036),
    ('extreme', 'full_t01_qq_00113JQa3vgrwr_mp3__qqmusic_cloud_advanced.wav', 275.651417, 290.291383),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for key, name, src_end, mix_end in JOBS:
        path = SRC_DIR / name
        if not path.exists():
            raise SystemExit(f'缺少源文件: {path}')
        audio, sr = sf.read(str(path), dtype='float32', always_2d=True)
        a = max(0, int((src_end - LEAD) * sr))
        b = min(audio.shape[0], int((mix_end + TAIL) * sr))
        clip = np.ascontiguousarray(audio[a:b])
        peak = float(np.max(np.abs(clip))) or 1.0
        if peak > 0.999:
            clip = clip * (0.999 / peak)
        dest = OUT_DIR / f'{key}.mp3'
        sf.write(str(dest), clip, sr, format='MP3', compression_level=0.6)
        print(f'{key}: {clip.shape[0] / sr:.2f}s 边界=({LEAD:.2f}s, {LEAD + mix_end - src_end:.2f}s) '
              f'-> {dest.name} {dest.stat().st_size // 1024}KB')


if __name__ == '__main__':
    main()

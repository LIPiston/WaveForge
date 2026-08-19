#!/usr/bin/env python3
"""
AI 混音（DJTransGAN）渲染 Worker —— 独立于 render_worker.py。

用带 torch 的 Python（venv / 可选下载的 AI 引擎）跑 DJTransGAN 预训练模型，
把两首曲子的过渡窗口交给模型生成"推子 + EQ 自动化"驱动的长混音（~60s）。

与 render_worker.py 协议一致：stdin 收 {type,id,params}，stdout 回 {type,id,data}。
消息类型：'render'（渲染 AI 过渡）、'probe'（探测引擎可用性）、'exit'。

依赖的 DJTransGAN 仓库路径：
  - 环境变量 WAVEFORGE_DJTRANSGAN_DIR（默认 D:\\opencode\\DJTransGAN）
模型输出为固定 ~60s 混音窗口（模型训练语义），起始/结束时间戳随结果返回，
前端据此把过渡窗口替换为模型窗口（长混音），源曲提前切入、目标曲延后恢复。
"""

import json
import os
import sys

REPO_DIR = os.environ.get('WAVEFORGE_DJTRANSGAN_DIR', r'D:\opencode\DJTransGAN')

if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)

import numpy as np  # noqa: E402

SR = 44100


def load_generator():
    """加载 DJTransGAN 预训练生成器（模型/权重都较大，仅加载一次，常驻进程）。"""
    import torch
    from djtransgan.model import get_generator
    from djtransgan.utils import load_pt

    gen = get_generator()
    weight_path = os.path.join(REPO_DIR, 'pretrained', 'djtransgan_minmax.pt')
    if not os.path.exists(weight_path):
        raise RuntimeError(f'DJTransGAN 预训练权重不存在: {weight_path}')
    gen.load_state_dict(load_pt(weight_path))
    gen.eval()
    return gen, torch


def load_track(path, torch):
    """整曲解码为 DJTransGAN 期望的 (1, N) float32 tensor（44.1k mono）。"""
    import librosa
    audio, _ = librosa.load(path, sr=SR, mono=True)
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    return torch.from_numpy(audio).unsqueeze(0)


def render_ai_transition(plan, source_path, target_path, output_path):
    """跑 DJTransGAN 长混音，返回 {success, outputPath, transitionStart, targetResumeTime, duration, ...}。"""
    from djtransgan.process import preprocess

    generator, torch = load_generator()

    prev_cue = float(plan['sourceEndTime'])
    next_cue = float(plan['targetStartTime'])

    prev_audio = load_track(source_path, torch)
    next_audio = load_track(target_path, torch)

    # DJTransGAN 库内部用 print 打进度（[1/5] ...）到 stdout，会污染 JSON 协议：
    # 库调用期间把 stdout 重定向到 stderr（日志通道），JSON 响应由 main() 在恢复后打印。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        # 模型窗口起点/终点（源曲/目标曲内的绝对时间，由 preprocess 的 timestamps 给出：
        # timestamps[i] = [start_sample, end_sample]）
        (pair_audio, timestamps), (pair_audio_for_g, cue_for_g) = preprocess(prev_audio, next_audio, prev_cue, next_cue)
        transition_start = timestamps[0][0] / SR      # 源曲内：混音窗口起始
        target_resume = timestamps[1][1] / SR          # 目标曲内：混音窗口结束

        with torch.no_grad():
            mix_audio, _ = generator.infer(*pair_audio_for_g, cue_region=cue_for_g)
    finally:
        sys.stdout = real_stdout

    mix = mix_audio.squeeze(0).numpy()

    # 峰值归一化（模型输出可能过 0dB），避免播放爆音
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.95:
        mix = mix * (0.95 / peak)

    import soundfile
    soundfile.write(output_path, mix.T, SR)

    return {
        'success': True,
        'outputPath': output_path,
        'duration': float(mix.shape[-1]) / SR,
        'transitionStart': float(transition_start),
        'targetResumeTime': float(target_resume),
        'sampleRate': SR,
        'channels': int(mix.shape[0]) if mix.ndim > 1 else 1,
        'stretchApplied': True,
        'djEffectsApplied': True,
        'rendererVersion': 'djtransgan-v1',
        'aiMixApplied': True,
    }


def probe():
    """探测 AI 引擎是否可用（torch + 权重 + 仓库可导入）。"""
    try:
        import torch  # noqa: F401
        has_torch = True
    except Exception:
        has_torch = False
    weight_ok = os.path.exists(os.path.join(REPO_DIR, 'pretrained', 'djtransgan_minmax.pt'))
    repo_ok = os.path.exists(os.path.join(REPO_DIR, 'djtransgan', 'model', '__init__.py'))
    return {
        'available': bool(has_torch and weight_ok and repo_ok),
        'hasTorch': has_torch,
        'weightReady': weight_ok,
        'repoReady': repo_ok,
        'repoDir': REPO_DIR,
        'python': sys.executable,
    }


def main():
    print(json.dumps({'type': 'status', 'data': {'ready': True, 'engine': 'djtransgan'}}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            message_type = request.get('type')
            message_id = request.get('id')
            if message_type == 'render':
                params = request['params']
                try:
                    result = render_ai_transition(
                        params['plan'],
                        params['sourceAudioPath'],
                        params['targetAudioPath'],
                        params['outputPath'],
                    )
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    result = {'success': False, 'error': str(e)}
                response = {'type': 'result', 'id': message_id, 'data': result}
            elif message_type == 'probe':
                response = {'type': 'result', 'id': message_id, 'data': probe()}
            elif message_type == 'exit':
                break
            else:
                response = {'type': 'error', 'id': message_id, 'error': f'Unknown message type: {message_type}'}
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError:
            print(json.dumps({'type': 'error', 'error': 'Invalid JSON'}), flush=True)
        except Exception as e:
            print(json.dumps({'type': 'error', 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()

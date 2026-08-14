"""
Loudness Measurement Service - 独立响度测量服务（端口 3003）

与 beat_analyzer.py（端口 3002）完全解耦的独立服务：
- 单一路由 POST /lufs：读取本地音频文件，返回 ITU-R BS.1770-4 积分响度（LUFS）
- 供响度归一化（LoudnessNormalization）按曲目调用，不影响节拍分析链路与缓存
- 音频格式白名单与 beat 服务一致（libsndfile 不支持 m4a/aac/opus/webm）

依赖：flask / flask-cors / librosa / numpy / scipy（嵌入式 Python 已预装，无需新装包）
"""

import os
import sys
import math
import time
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import librosa
import numpy as np
from scipy import signal as scipy_signal

# 设置 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

PORT = int(os.environ.get('WAVEFORGE_LOUDNESS_PORT', '3003'))

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000", "file://", "null"])

# 允许的本地音频格式（与 beat_analyzer.py 保持一致；libsndfile 不支持 m4a/aac/opus/webm）
ALLOWED_AUDIO_EXTENSIONS = {'.mp3', '.flac', '.wav', '.ogg'}
MAX_AUDIO_FILE_SIZE_BYTES = 300 * 1024 * 1024


def _k_weighting_coeffs(sr: float):
    """K-weighting 两级滤波系数（RBJ 双二阶，按采样率自适应）。

    采用 BS.1770-4 标准定义的模拟滤波器参数（与参考实现 libebur128 一致），
    经 RBJ bilinear transform 在目标采样率（本服务为 22050Hz）上设计：
    - Stage 1：二阶高通，fc=38.13547087602444Hz，Q=0.6909123976585623
    - Stage 2：高架滤波，fc=1681.974450955533Hz，增益 +3.999843853973347dB，
      Q=0.7071752369554196
    返回 (b_hp, a_hp, b_shelf, a_shelf)。
    """
    w0_hp = 2.0 * math.pi * 38.13547087602444 / sr
    alpha_hp = math.sin(w0_hp) / (2.0 * 0.6909123976585623)
    b_hp = [(1.0 + math.cos(w0_hp)) / 2.0, -(1.0 + math.cos(w0_hp)), (1.0 + math.cos(w0_hp)) / 2.0]
    a_hp = [1.0 + alpha_hp, -2.0 * math.cos(w0_hp), 1.0 - alpha_hp]
    b_hp = [coeff / a_hp[0] for coeff in b_hp]
    a_hp = [coeff / a_hp[0] for coeff in a_hp]

    a = 10 ** (3.999843853973347 / 40.0)
    w0_shelf = 2.0 * math.pi * 1681.974450955533 / sr
    alpha_shelf = math.sin(w0_shelf) / (2.0 * 0.7071752369554196)
    cos_w0 = math.cos(w0_shelf)
    sqrt_a = math.sqrt(a)
    b0 = a * ((a + 1) + (a - 1) * cos_w0 + 2.0 * sqrt_a * alpha_shelf)
    b1 = -2.0 * a * ((a - 1) + (a + 1) * cos_w0)
    b2 = a * ((a + 1) + (a - 1) * cos_w0 - 2.0 * sqrt_a * alpha_shelf)
    a0 = (a + 1) - (a - 1) * cos_w0 + 2.0 * sqrt_a * alpha_shelf
    a1 = 2.0 * ((a - 1) - (a + 1) * cos_w0)
    a2 = (a + 1) - (a - 1) * cos_w0 - 2.0 * sqrt_a * alpha_shelf
    b_shelf = [b0 / a0, b1 / a0, b2 / a0]
    a_shelf = [1.0, a1 / a0, a2 / a0]

    return b_hp, a_hp, b_shelf, a_shelf


def integrated_lufs(y, sr: float) -> float:
    """ITU-R BS.1770-4 积分响度（K-weighting + 相对门限，纯 scipy/numpy）。

    返回 LUFS（-70 ~ 0；0.0 仅表示空输入或全静音，此时无法计算响度）。
    其余计算异常会向上抛出，由路由层转为 500——不能把真实错误当成静音
    返回 0.0，否则前端会把失败曲目误判为极低响度而错误地大幅衰减。
    """
    if y is None or len(y) == 0:
        return 0.0
    samples = np.asarray(y, dtype=np.float64)
    if np.max(np.abs(samples)) <= 1e-9:
        return 0.0
    # K-weighting：高通 38Hz（二阶）+ 高架 1681Hz +4dB
    b_hp, a_hp, b_shelf, a_shelf = _k_weighting_coeffs(sr)
    weighted = scipy_signal.lfilter(b_shelf, a_shelf, scipy_signal.lfilter(b_hp, a_hp, samples))
    # 分块（400ms）计算各块响度
    block = max(1, int(0.4 * sr))
    n = len(weighted)
    block_loudness = []
    for start in range(0, n, block):
        seg = weighted[start:start + block]
        mean_square = float(np.mean(seg * seg))
        if mean_square > 1e-12:
            block_loudness.append(10.0 * math.log10(mean_square) - 0.691)
    if not block_loudness:
        return 0.0
    # 相对门限：-10 LU（BS.1770 简化门限）
    threshold = max(block_loudness) - 10.0
    active = [level for level in block_loudness if level > threshold]
    if not active:
        active = block_loudness
    integrated = 10.0 * math.log10(float(np.mean([10 ** (level / 10.0) for level in active])))
    return round(max(-70.0, min(0.0, integrated)), 2)


@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({'status': 'ok', 'service': 'loudness', 'port': PORT})


@app.route('/lufs', methods=['POST'])
def measure_lufs():
    """测量音频文件积分响度。请求体：{ trackKey: str, audioPath: str }"""
    data = request.get_json(silent=True) or {}
    track_key = str(data.get('trackKey') or '').strip()
    audio_path = str(data.get('audioPath') or '').strip()

    if not track_key or not audio_path:
        return jsonify({'error': 'Missing trackKey or audioPath'}), 400
    if not isinstance(data.get('audioPath'), str):
        return jsonify({'error': 'audioPath must be a string'}), 400
    if not os.path.exists(audio_path):
        return jsonify({'error': f'File not found: {audio_path}'}), 404

    # 扩展名白名单 + 大小上限，防止非音频文件或超大文件导致资源耗尽
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        allowed = ', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))
        return jsonify({'error': f'Unsupported audio format: {ext or "(no extension)"}. Allowed formats: {allowed}'}), 400
    try:
        size = os.path.getsize(audio_path)
    except OSError:
        return jsonify({'error': f'Unable to access file size: {audio_path}'}), 400
    if size > MAX_AUDIO_FILE_SIZE_BYTES:
        return jsonify({'error': f'File too large: {size / (1024 * 1024):.1f} MB exceeds the {MAX_AUDIO_FILE_SIZE_BYTES // (1024 * 1024)} MB limit'}), 400

    try:
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        integrated = integrated_lufs(y, sr)
        print(f"🔊 响度测量: {track_key} → {integrated} LUFS")
        return jsonify({'trackKey': track_key, 'integratedLufs': integrated})
    except Exception as e:
        print(f"[ERROR] 响度测量失败: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    logging.basicConfig(level=logging.WARNING)
    print(f"🔊 Loudness service starting on http://127.0.0.1:{PORT}")
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)

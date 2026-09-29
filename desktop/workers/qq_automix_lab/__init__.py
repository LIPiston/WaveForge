# -*- coding: utf-8 -*-
"""QQ 官方智能混音复刻模块（来自 automix-lab，MIT）。

来源：D:\\opencode\\automix-lab\\automix_lab\\（同作者项目，MIT 许可）。
本目录为**原样拷贝**，仅用于 WaveForge 的 AutoMix Enhanced 三档渲染：

  - recipes.render_optimized  → Lite（自主优化版 · 本地进阶方案）
  - cloud_recipe + qq_desidecue + djplan
                              → Advanced（QQ官方 · 基础渐变）
                                Extreme（QQ官方 · 进阶交融）

注意：`data/qqmusic_djplan_presets*.json` 系从 QQ 音乐 libSuperSound3.so 提取的
官方预设参数（腾讯版权内容），引入商用产品前需自行评估授权。

改动：本目录内文件**未做任何修改**；所需适配（cookie 传递、frida 依赖剥离）
全部在 `desktop/workers/qq_automix.py` 适配层完成。
"""

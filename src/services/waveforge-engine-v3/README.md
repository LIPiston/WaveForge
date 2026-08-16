├── src/
│   ├── types.ts                        # 全部参数类型 + 默认值（v2 命名兼容）
│   ├── dsp/                            # 纯 DSP（零依赖，实时/离线共用）
│   │   ├── fft.ts biquad.ts EqChain.ts MidSide.ts
│   │   ├── Deesser.ts Compressor.ts Limiter.ts BassEnhancer.ts
│   │   ├── Convolver.ts ReverbSimple.ts LufsMeter.ts LoudnessComp.ts
│   │   ├── Resampler.ts Stretch.ts StretchLgplAdapter.ts PitchYin.ts features.ts
│   │   └── API_SPEC.md                 # 模块契约（子代理实现规范）
│   ├── engine/                         # 引擎总成
│   │   ├── EngineV3.ts ScenePresets.ts ShareCodec.ts
│   ├── worklet/                        # AudioWorkletProcessor（融合时打包单文件）
│   ├── analysis/                       # 频谱分析、听力测试
│   └── offline/                        # 声源分离任务队列
├── vendor/soundtouchjs/                # ★ LGPL-2.1 原包副本（含 LICENSE，离线可用）
├── test/ + ui/uiSmoke.test.tsx        # vitest 单测（29 文件 / 322 用例）
└── docs/
    ├── FUSION_GUIDE.md                 # ★ 融合文档（另一个 AI 依据此融合进 WaveForge）
    ├── FEATURES_VERIFICATION.md        # ★ 功能核验报告（26 项功能 / MIT·LGPL 统计 / 候选库调研）
    └── v2-analysis.md                  # v2 模块深读分析（子代理产出）
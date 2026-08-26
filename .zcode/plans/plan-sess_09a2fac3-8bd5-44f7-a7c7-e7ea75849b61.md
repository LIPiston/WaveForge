# 空间音频 — 第一波并行实施（Phase 0 + Phase 1 + 最小 UI）

用户指令已确认：**开启多个子代理并行实施**；所有源文件只放 HSE 文件夹（`src/services/waveforge-engine-v3/`）内；接线层修改由我自决。

## 实施范围（本波）

1. **共享契约（我先行写入）**：`src/spatial/types.ts`（`SpatialParams`/`SpatialMode`/`ListenerState`/`AudioObject`/`HrtfGrid`/`SpatialRenderConfig`/`VirtualSpeaker`）+ `src/spatial/SpatialBackend.ts`（接口：loadHrtf/setConfig/processStereo/getLatencySamples/reset）。路径 = `src/services/waveforge-engine-v3/src/spatial/`。
2. **子代理 A（TS 地基 + 接线）**：`TsConvolverBackend`（复用 `dsp/Convolver.ts`，立体声 IR 对 + 方向最近邻）、`SpatialProcessor`（独立 worklet）、`SpatialNode` + 参数消息协议、`persistence.ts`（localStorage `waveforge:spatial-params`）、`scripts/build-spatial-worklet.mjs`（esbuild → `public/spatial-worklet.js`，.wasm 存在则 base64 内联）、`attachV3Engine.ts` 加 `syncSpatialChain`（v3Node → spatialNode → analyser；off 直连）+ 空间参数 store/订阅 + `exportV3Wav` 离线空间处理包裹、package.json 钩子。**EngineV3.ts/dsp/*/types.ts V3EngineParams/AudioEffectsProcessor.ts 零改动**。
3. **子代理 B（Rust 核 + WASM）**：`rust/hrtf-core/`（HSE 文件夹下）Cargo 工程，§3.2 契约函数（load_hrtf/get_hrir/render_objects/set_room/set_room_preset/set_hrtf_interp_mode/set_convolution_mode/set_distance_model）、分区卷积(rustfft/realfft)、球谐插值或最近邻、ITD/ILD、距离衰减 3 模型、空气吸收；HRTF 数据先尝试下载紧凑 KEMAR，失败则合成解析 HRTF（Woodworth ITD + 球头阴影 ILD）；wasm-pack → `WasmHrtfBackend.ts` 按共享契约调 WASM；数值对拍测试（vs TsConvolverBackend，容差 1e-6）。
4. **子代理 C（最小 UI）**：`ui/pages/SpatialPage.tsx` 顶部加模式选择器（关闭/一键空间化/其余标注"开发中"）+ 模式 A 面板（展开角度/空间强度/房间预设）+ 简易 2D 可视化（Canvas L/R 扬声器 + 展开弧）；**保留现有混响/3D环绕/立体声宽度卡片不动**；HSE 主题一致。
5. **验证**：`npm run lint` + `npx vitest run`（新增用例）+ `node scripts/... build-spatial-worklet` 产出 `public/spatial-worklet.js`；若 Rust 可用则构建 .wasm 并内联，跑数值对拍。

## 约束

- 源文件全部在 `src/services/waveforge-engine-v3/` 内；生成物 `public/spatial-worklet.js` 沿用 v3-worklet.js 先例（源在 HSE 内、产物在 public/）。
- 不改 `EngineV3.ts` / `dsp/*.ts` / `V3EngineParams` / `AudioEffectsProcessor.ts`。
- 接线层（attachV3Engine.ts/package.json/导出）改动纯增量。
- Rust 工具链缺失则子代理 B 自行安装（rustup target add wasm32-unknown-unknown + wasm-pack）。

## 所需权限

- Bash：Rust 工具链安装与 cargo/wasm-pack 构建；npm 脚本（lint/test/build-spatial-worklet/dev）；git 只读命令。
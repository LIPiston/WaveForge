# 音频引擎适配层重构方案（含 UI 双模式）

## 目标

引入统一音频引擎接口（`IAudioEngineAdapter`），v1/v2/v3 都接这个接口。App.tsx 消掉 7 处版本分支。**UI 兼容两种情况**：新引擎自带 UI（连外壳自己渲染）或无 UI（用通用调音室）。未来接入 v4 只需写 `V4Adapter.ts` + 注册表加一行，App.tsx 零改动。

## 核心设计：UI 双模式

adapter 通过 `studioMode` 字段声明 UI 模式，`renderStudio` 按模式分两条路径：

```
IAudioEngineAdapter {
  studioMode: 'custom' | 'generic'   // 引擎自带 UI / 用通用调音室
  renderStudio(commonProps): ReactNode
}
```

- **`custom` 模式**（v1/v2/v3 都是）：adapter 内部 lazy import 引擎自带的调音室组件（MixingStudio/V2/V3MixingStudio），组件**自带外壳**（遮罩+玻璃面板+头部+版本按钮+Tab 栏+动画），adapter 直接返回该组件 + 合并特有 props。不抽公共 Shell，现有三个调音室外壳不动。
- **`generic` 模式**（未来无 UI 引擎）：adapter 返回一个 `GenericMixingStudio` 组件，该组件自带外壳 + 通过 adapter 暴露的 `IAudioEngineUiBridge` 接口驱动（读参数/写参数/导出，参数以引擎原生 JSON 形态展示 + 通用 EQ/音效控件如果引擎支持）。

## 新建文件结构

```
src/services/audio-engine/
├── types.ts              # 统一接口 + 类型（IAudioEngineAdapter / IAudioEngineUiBridge / AudioGraphHandle）
├── GenericMixingStudio.tsx  # 通用调音室 UI（generic 模式用，自带外壳）
├── V1Adapter.ts          # v1 适配器（studioMode: 'custom'）
├── V2Adapter.ts          # v2 适配器（studioMode: 'custom'）
├── V3Adapter.ts          # v3 适配器（studioMode: 'custom'）
└── index.ts              # 工厂 + 注册表
```

## 统一接口设计（`types.ts`）

```ts
// 音频图句柄（三引擎同形，从 useAudioPlayer 提升）
export interface AudioGraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
}

// 跨切面公共 props（所有调音室模式共用）
export interface MixingStudioCommonProps {
  onClose: () => void
  playerTheme: 'dark' | 'light'
  anchorRect: { x: number; y: number; width: number; height: number } | null
  engineVersion: AudioEngineVersion
  onSwitchEngine: (version: AudioEngineVersion) => void
}

// 引擎能力描述（App 按能力决定行为，不写版本分支）
export interface EngineCapabilities {
  supportsSystemVolume: boolean
  supportsLoudnessNormalization: boolean
  supportsLowVolumeHint: boolean
}

// 通用调音室 UI 驱动接口（generic 模式用；custom 模式的引擎不需要实现）
export interface IAudioEngineUiBridge {
  // 参数读写（引擎原生形态，通用 UI 以 JSON + 可选结构化控件展示）
  getParams(): unknown           // 返回引擎原生参数对象
  setParams(p: unknown): void
  // 参数的可选结构化描述（若引擎提供，通用 UI 渲染 EQ 滑块/音效开关；否则只显示 JSON）
  getParamSchema(): ParamSchema | null
  // 导出
  exportWav(sourceUrl: string, durationSeconds: number): Promise<void>
  // 场景（可选）
  getScenes?(): Array<{ id: string; name: string }>
  applyScene?(id: string): void
}

export interface ParamSchema {
  eqBands?: Array<{ frequency: number; gain: number; label?: string }>
  effects?: Array<{ key: string; label: string; enabled: boolean }>
}

// UI 模式
export type StudioMode = 'custom' | 'generic'

// 统一适配器接口
export interface IAudioEngineAdapter {
  readonly version: AudioEngineVersion
  readonly capabilities: EngineCapabilities
  readonly studioMode: StudioMode

  // 生命周期
  attach(handle: AudioGraphHandle): Promise<void>
  dispose(): void
  isAttached(): boolean

  // 系统音量 → 等响度补偿（v1 no-op）
  setSystemVolume(volume: number): void

  // 响度归一化（v1/v3 no-op；v2 调外部服务）
  applyLoudnessNormalization(trackKey: string, url: string): void
  resetLoudnessNormalization(): void

  // 离线导出
  exportWav(sourceUrl: string, durationSeconds: number): Promise<void>

  // 调音室渲染（按 studioMode 分两条路径）
  renderStudio(props: MixingStudioCommonProps & {
    sourceUrl?: string
    sourceDuration?: number
  }): React.ReactNode

  // 通用 UI 桥（仅 generic 模式需要实现；custom 模式返回 null）
  getUiBridge(): IAudioEngineUiBridge | null

  // 导出进行中状态（供 custom 模式的组件读取；generic 模式由 GenericMixingStudio 内部管理）
  isExporting(): boolean
  onExportingChange?(cb: (exporting: boolean) => void): () => void
}
```

## 三个适配器实现

### V1Adapter（`studioMode: 'custom'`）
- 内部 `new AudioEffectsEngine()`（v1 实例）
- `attach`/`dispose`/`exportWav` 转发引擎方法（attach 包 `Promise.resolve()`）
- `setSystemVolume`/`applyLoudnessNormalization`/`resetLoudnessNormalization` no-op
- `renderStudio`：lazy import `MixingStudio`，返回 `<LazyMixingStudio engine={instance} sourceUrl sourceDuration {...commonProps} />`
- `getUiBridge()` 返回 null（custom 模式不需要）
- capabilities: `{ supportsSystemVolume: false, supportsLoudnessNormalization: false, supportsLowVolumeHint: false }`

### V2Adapter（`studioMode: 'custom'`）
- 内部 `new AudioEffectsEngine()`（v2 实例）+ `loudnessNormalizationService`
- `setSystemVolume` 转发 + 低音量提示（toast 回调构造时注入）
- `applyLoudnessNormalization`/`resetLoudnessNormalization` 转发 `loudnessNormalizationService.apply/reset`
- `renderStudio`：lazy import `MixingStudioV2`，返回 `<LazyMixingStudioV2 engine={instance} sourceUrl sourceDuration {...commonProps} />`
- capabilities: `{ supportsSystemVolume: true, supportsLoudnessNormalization: true, supportsLowVolumeHint: true }`

### V3Adapter（`studioMode: 'custom'`）
- 转发 `attachV3Engine`/`detachV3Engine`/`getV3Bridge`/`setV3SystemVolume`/`exportV3Wav`
- `applyLoudnessNormalization`/`resetLoudnessNormalization` no-op（v3 引擎内实时实现）
- `renderStudio`：lazy import `V3MixingStudio`，返回 `<LazyMixingStudioV3 bridge={getV3Bridge()} exportWav={...} exporting={...} {...commonProps} />`
- `isExporting`/`onExportingChange`：v3 导出状态上提到 adapter（事件驱动，App.tsx 订阅重渲染）
- capabilities: `{ supportsSystemVolume: true, supportsLoudnessNormalization: false, supportsLowVolumeHint: false }`

## 通用调音室 UI（`GenericMixingStudio.tsx`）

为未来无 UI 引擎准备。自带外壳（遮罩+玻璃面板+头部+版本按钮+Tab 栏，与现有调音室视觉一致）。通过 `IAudioEngineUiBridge` 驱动：
- **参数页**：若 `getParamSchema()` 返回结构化描述 → 渲染 EQ 滑块 + 音效开关；否则渲染 JSON 编辑器（只读 + 导入导出）
- **调音器页**：导出 WAV 按钮（调 `bridge.exportWav`）
- 接收 `commonProps`（onClose/playerTheme/anchorRect/engineVersion/onSwitchEngine）+ sourceUrl/sourceDuration

本次不实现通用 UI 的完整功能（暂为骨架 + JSON 展示），留给未来无 UI 引擎接入时填充。

## App.tsx 改造（消掉 7 处版本分支）

| 改造前 | 改造后 |
|---|---|
| 5 个引擎 import（L27-31） | 1 个 `import { getEngineAdapter } from './services/audio-engine'` |
| `v1EngineRef` + `v2EngineRef`（L1300-1303） | `engineAdapterRef = useRef(getEngineAdapter(audioEngineVersion))` |
| `handleAudioGraphReady` 三分支（L1308-1313） | `void engineAdapterRef.current.attach(handle).catch(...)` |
| 系统音量 effect v1 守卫 + v2/v3 分支（L1325-1347） | `if (!adapter.capabilities.supportsSystemVolume) return; adapter.setSystemVolume(v); if (adapter.capabilities.supportsLowVolumeHint && ...) {...}` |
| 响度归一化 effect v2 守卫（L1398） | `if (!adapter.capabilities.supportsLoudnessNormalization) return` |
| `switchAudioEngine` 三分支 dispose + attach + v2 补归一化（L1648-1670） | `adapter.dispose(); engineAdapterRef.current = getEngineAdapter(next); await adapter.attach(handle); adapter.applyLoudnessNormalization(trackKey, url)` |
| 切歌 v2 归一化（L3124-3125） | `engineAdapterRef.current.applyLoudnessNormalization(cacheKey, url)` |
| 调音室三分支渲染（L4669-4713） | `{engineAdapterRef.current.renderStudio({...commonProps, sourceUrl, sourceDuration})}` |
| v3Exporting state（L444） | 删除，改订阅 `adapter.onExportingChange` |
| toast 文案三元（L1678） | 查表 `{v1:'v1（原版）', v2:'v2（增强版）', v3:'v3（DSP 内核）'}[next]` |

## v1/v2 引擎内部剥离

- **V2Adapter 接管响度归一化外部服务调用**：`loudnessNormalizationService.apply/reset` 从 App.tsx 移到 V2Adapter 方法内。App.tsx 不再 import `loudnessNormalizationService`。
- **V2Adapter 接管低音量提示**：从 App.tsx 的系统音量 effect 移到 V2Adapter 的 `setSystemVolume` 内（toast 回调构造时注入）。
- v1 引擎源码不动（适配层只包外壳）。
- v3 融合层（attachV3Engine.ts）不动（V3Adapter 转发）。

## 实施步骤（5 步，每步独立验证）

### 步骤 1：建统一接口与类型 + 通用 UI 骨架
- 新建 `types.ts`（接口 + 类型）
- 新建 `GenericMixingStudio.tsx`（骨架：外壳 + JSON 参数展示 + 导出按钮，通过 IAudioEngineUiBridge 驱动）
- 验证：`npx tsc --noEmit` 0 错误

### 步骤 2：写三个适配器 + 工厂
- 新建 `V1Adapter.ts`/`V2Adapter.ts`/`V3Adapter.ts`/`index.ts`
- V1/V2 adapter 内部 new 引擎实例；V3 adapter 转发自由函数
- V2 adapter 注入 toast 回调；V3 adapter 管理 exporting 状态（事件驱动）
- 三个 adapter 的 `renderStudio` 内部 lazy import 各调音室组件
- 验证：`npx tsc --noEmit` 0 错误

### 步骤 3：App.tsx 接入适配层（核心改动）
- import 改为 `getEngineAdapter`
- `v1EngineRef`/`v2EngineRef` → `engineAdapterRef`
- 7 处版本分支改为 `engineAdapterRef.current.xxx()` + `capabilities` 判断
- 调音室渲染改为 `renderStudio`
- 删除 v1/v2/v3 引擎直接 import + `loudnessNormalizationService` import
- 验证：`npx tsc --noEmit` + `npm test` 全绿

### 步骤 4：v2 引擎内部剥离
- V2Adapter 的 `applyLoudnessNormalization` 调 `loudnessNormalizationService.apply(engine, trackKey, url)`
- 验证：`npm test` 全绿

### 步骤 5：清理 + 文档
- 删除 App.tsx 残留 v3Exporting state
- 更新 AGENTS.md / HANDOVER.md
- 验证：`npm run lint` 0 错误 + `npm test` 全绿 + `npm run build` 成功

## 不动的部分

- **三个现有调音室组件**（MixingStudio/V2/V3MixingStudio）不改——各自保留外壳和 props
- **三个引擎的参数模型**不统一——各自保留
- **v1 引擎源码**不改
- **v3 融合层**（attachV3Engine.ts）不改
- **版本持久化**（audioEngineVersion.ts）不改
- **音频图 hook**（useAudioPlayer.ts）不改——AudioGraphHandle 类型提升到 types.ts

## 未来接入 v4 的步骤（验证后手）

1. 写 `V4Adapter.ts` 实现 `IAudioEngineAdapter`
   - 若 v4 自带 UI：`studioMode: 'custom'`，`renderStudio` 返回 v4 调音室组件
   - 若 v4 无 UI：`studioMode: 'generic'`，实现 `getUiBridge()` 返回 `IAudioEngineUiBridge`，通用调音室自动可用
2. 在 `index.ts` 注册表加一行 `v4: () => new V4Adapter()`
3. **App.tsx 零改动**——版本切换/系统音量/归一化/导出/调音室渲染全自动

## 完成标准

- [ ] `src/services/audio-engine/` 目录建立（types.ts + GenericMixingStudio + 3 adapter + index.ts）
- [ ] App.tsx 的 7 处版本分支全部消除
- [ ] App.tsx 不再直接 import 任何引擎类/自由函数
- [ ] v1/v2/v3 三引擎切换、系统音量、响度归一化、导出功能行为不变
- [ ] `npm run lint` 0 错误 + `npm test` 全绿 + `npm run build` 成功
- [ ] 通用调音室 UI 骨架就位（generic 模式可用）
- [ ] AGENTS.md / HANDOVER.md 更新
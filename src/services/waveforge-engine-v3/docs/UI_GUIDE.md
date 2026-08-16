# WaveForge v3 调音室 UI —— 融合指南（UI_GUIDE）

> 配套 `docs/FUSION_GUIDE.md`（引擎融合手册）。本文档只讲 **UI 部分**：
> 把 `waveforge-engine-v3/ui/` 搬进 WaveForge、接线 `V3MixingStudio`、接通系统音量与听力测试播放。

## 0. UI 定位与设计语言

v3 调音室 UI 完全沿用 WaveForge v1/v2 调音室（`MixingStudio.tsx` / `MixingStudioV2.tsx`）的**设计语言**：

- **liquid glass 玻璃拟态**：`ui/theme.ts` 中的 `glassPanel / glassCard / glassBorder / glassBlur(30px saturate 185%) / glassCardBlur / glassPanelHighlight`
  与 v1/v2 面板逐像素一致（暗色 `rgba(10,12,20,0.38)`、亮色 `rgba(255,255,255,0.45)`）；
- **全局主题色**：`useAccentColor` 监听 `accentColorChanged` 事件 + localStorage `accentColor`（默认 #8b5cf6），与全局联动；
- **交互基元**：胶囊开关（accent 背景 + 发光阴影）、`wf-glass-range` 滑块（白点 thumb + accent 光晕，样式注入同 v2）、
  玻璃卡片、胶囊 Tab、chip 场景、主/幽灵按钮；
- **图标**：lucide-react（WaveForge 已依赖）；**动画**：CSS keyframes（替代 framer-motion，零新增依赖）。
- 文案与注释均为中文，与全项目一致。

## 1. 目录与依赖

```
waveforge-engine-v3/ui/
├── theme.ts              # 设计语言变量（useV3Theme）
├── primitives.tsx        # Toggle/Slider/GlassCard/Modal/Segmented/Chip/TextInput/ActionButton/InfoLine
├── hooks.ts              # useV3Params（快照 patch/replace）+ DeepPartial + deepMerge
├── bridge.ts             # V3UiBridge 接口 + createV3UiBridge(engine, sampleRate)
├── effectsPanel.tsx      # 音效场景页：场景栏 + 12 效果卡 + 响度卡片
├── modalsSpatial.tsx     # 混响（双路由+IR 导入）/ 3D 环绕（圆形拖拽）/ 低音增强（4 谐波）
├── modalsDynamics.tsx    # 压缩 / 齿音 / 夜间 / 限幅 / IEQ / 变速变调 / 立体声宽度
├── modalsLoudness.tsx    # 音量自适应补偿（auto 曲线可视化）/ 响度归一化
├── eqCurveEditor.tsx     # SVG 对数频率轴曲线编辑器（拖拽控制点）
├── eqPanel.tsx           # 均衡器页：simple/pro、10/20 段、Q 补偿、锁定、预设、导入导出
├── sharePanel.tsx        # 调音器页：分享串（v3 编解码）、WAV 导出、引擎信息
├── analysisPanel.tsx     # 分析页：LUFS/GR/频谱/特征 + 听力测试流程
├── V3MixingStudio.tsx    # 主面板组装（4 个页签 + 弹窗调度）
└── index.ts              # 公共出口
```

**依赖**：`react`（peer）+ `lucide-react`（WaveForge 已有）。本地验证用 `npm run typecheck:ui`（tsconfig.ui.json，jsx react-jsx）。
Tailwind 类名与 v1/v2 相同（`wf-glass-range` 的 thumb 样式由 `GlassRangeStyle` 组件注入，无需全局 CSS）。

## 2. 搬入 WaveForge（两步）

1. 拷贝目录：`waveforge-engine-v3/ui/` → `WaveForge/src/services/waveforge-engine-v3/ui/`；
2. 调整 import：ui/ 内引用引擎的路径为 `../src/types` 等相对路径，拷贝后层级不变（`src/services/waveforge-engine-v3/` 下 ui/ 与 src/ 同级），无需改动。

> 若 WaveForge 侧已有 `src/services/waveforge-engine-v3/`（FUSION_GUIDE 步骤 1 的引擎目录），
> ui/ 放其下与 src/ 并列；`V3MixingStudio` 默认导出已就绪。

## 3. 接线模板（App.tsx）

与 v1/v2 调音室同构（lazy + 版本切换），新增 v3 分支：

```tsx
// 1) lazy 引入（与 MixingStudio/MixingStudioV2 并列）
const loadMixingStudioV3 = () => import('./services/waveforge-engine-v3/ui')
const LazyMixingStudioV3 = lazy(loadMixingStudioV3)

// 2) 切换 v3 引擎后，用 EngineV3Host 的 engine 建桥：
import { createV3UiBridge } from './services/waveforge-engine-v3/ui'
const bridge = createV3UiBridge(host.engine, ctx.sampleRate) // host = EngineV3Host 实例

// 3) 渲染（showMixingStudio && audioEngineVersion === 'v3' 分支）：
<LazyMixingStudioV3
  bridge={bridge}
  onClose={() => setShowMixingStudio(false)}
  playerTheme={playerTheme}
  anchorRect={anchorRect}
  engineVersion={audioEngineVersion}          // 'v1' | 'v2' | 'v3'
  onSwitchEngine={switchAudioEngine}
  exportWav={exportV3Wav}                      // 可选：离线导出
/>
```

- `onSwitchEngine`：复用现有 `switchAudioEngine`（热切换语义：暂停 → dispose 旧链 → attach 新链 → 恢复播放），版本枚举扩展为 'v3'；
- `bridge` 需要稳定引用（useMemo/useRef），切换引擎后重建。

## 4. 三处宿主接线（必须）

| 能力 | 事件/接口 | 融合侧实现 |
|---|---|---|
| **听力测试播放** | 监听 `v3HearingPlay` 自定义事件：`{ freqHz, levelDb }` | Web Audio 合成正弦（如 OscillatorNode），电平按 `10^(levelDb/20)` 换算幅度；播放时长约 0.6s 后停止，或由下一次事件/用户作答停止 |
| **系统音量 → 补偿曲线** | 写 `loudnessCompensation.volumePercent`（0-100） | 监听系统音量（Electron：`navigator.mediaDevices` 不可用则用 Windows API / 播放器主音量），变化时 `bridge.setParams` 更新；无音量源时默认 80 |
| **WAV 离线导出** | `exportWav` prop | 复用 FUSION_GUIDE 步骤 5：解码 → `EngineV3.process` 分块 → 写 WAV |

> 听力测试的"播放"不在 ui/ 内实现（纯 UI 不触碰 Web Audio），事件化解耦；未接线时流程 UI 仍可走完（不发声）。

## 5. 页签与功能对照

| 页签 | 内容 | v3 特有 |
|---|---|---|
| 音效场景 | 11 场景 chips + 12 效果卡（可叠加）+ 音量自适应补偿/响度归一化独立卡 + 我的场景（上限 8） | 齿音/IEQ/限幅/变速/宽度卡片；混响双路由 |
| 均衡器 | simple 5 段 / pro 10-20 段 + **曲线编辑器拖拽** + 级联 Q 补偿 + 锁定 + 预设 + EQ JSON 导入导出 | 20 段、Q 补偿、锁定 |
| 调音器 | **v3 分享串**（完整参数，版本+校验+白名单）+ WAV 导出 + 引擎信息（采样率/延迟/LUFS/GR） | 分享串格式 |
| 分析 | LUFS/LRA/峰值/真峰值 + 限幅 GR 条 + 32 条频谱 + 5 项特征 + 听力测试（7 频点 × 5 轮） | 全部 |

## 6. 设计说明（供审查）

1. **UI 与引擎解耦**：所有面板只依赖 `V3UiBridge` 接口与参数快照，不 import EngineV3；
   融合侧可替换桥实现（如包一层 Web Audio 适配）。
2. **快照语义**：`useV3Params` 的 patch 做深合并后整包提交（`setParams` 完整快照），符合引擎契约；
   场景/分享串/恢复默认走 replace。
3. **零动画依赖**：CSS keyframes（`v3-panel-in` 支持锚点偏移变量 `--fx/--fy`），主面板弹出动画效果与 v2 的 spring 接近。
4. **测试策略**：ui/ 为纯受控组件 + 桥接口，融合侧接入后按 FUSION_GUIDE 验证清单 3/4/5/6 项人工复核；
   本地保证：`npm run typecheck:ui` 0 错误；引擎回归（313）+ UI 冒烟（9）= **322 用例全绿**。
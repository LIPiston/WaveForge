# WaveForge 项目历史存档

> 本文档归档项目开发历史，内容来自 2026-07-31 的多份开发快照（PROJECT_ANALYSIS / PROJECT_COMPLETE_ANALYSIS / PROJECT_SUMMARY / PROJECT_STATUS / DEVELOPMENT_SUMMARY / PHASE_1_COMPLETE / MERGE_SUMMARY / MERGE_FROM_WAVE_FORGE_20260713），已跨文件去重合并。
> 标注「历史信息」的为早期版本描述，当前代码库可能已演进，仅作存档参考。
> 功能说明、使用方式、当前技术架构请以 [README.md](./README.md) 为准，本文档不重复其内容。

---

## 1. 项目发展时间线

| 日期 | 里程碑 |
|------|--------|
| 2026-07-10 前 | 纯 Web 版：HTML/CSS/JS + Node.js/Express + qq-music-api（API 端口 3001）——历史信息 |
| 2026-07-10 | 修复 `qq-music-api` 的 `cdlist undefined` 问题、优化推荐算法（随机性与多样性） |
| 2026-07-10 | 合并项目A（同学版本 `WaveForge(2)`）与项目B（自研版），以项目B为基础 |
| 2026-07-12 | 完成桌面壁纸联动功能（Windows 系统壁纸同步 + Wallpaper Engine） |
| 2026-07-13 | 从桌面版 Wave-Forge 合并桌面模式 UI、3D 歌单、壁纸同步与无缝衔接组件 |
| 2026-07-24 | 实现无缝衔接播放（Gapless），集成 Python 音频分析引擎 |
| 2026-07-25 | Python 节拍服务独立化；三种无缝衔接模式（Fixed / Beat / Smart AutoMix）+ 智能降级策略 |
| 2026-07-31 | Phase 1（Beat This 节拍分析集成）完成，产出 Phase 2 过渡点算法规划 |

---

## 2. 核心架构与功能概述

（综合 PROJECT_ANALYSIS / PROJECT_COMPLETE_ANALYSIS / PROJECT_SUMMARY 等快照的单一合并版；早期纯 Web 版架构见时间线，本节描述当前的 React + Electron 桌面版。）

### 技术栈
- 前端：React + TypeScript + Vite + Tailwind CSS
- 桌面：Electron + electron-builder（NSIS 安装包）
- UI/动画：Framer Motion、Three.js + React Three Fiber、Lucide 图标
- 状态管理：Zustand
- 后端：Node.js + Express（本地 API 服务器，端口 3001）
- 音乐源：qq-music-api + NeteaseCloudMusicApi（双平台）
- 音频：Web Audio API；无缝衔接分析依赖独立 Python 服务（Flask + Librosa）
- 缓存：IndexedDB（2GB 封面缓存）+ localStorage（设置 / 登录态 / 壁纸配置）

### 核心功能模块
- **双平台音乐支持**：网易云 / QQ 音乐登录认证、用户歌单同步、播放、歌词、VIP 状态检测
- **双视图模式**：沉浸式全屏播放器（大尺寸封面 + 实时歌词）与桌面模式（3D 歌单轮播 + 壁纸同步）
- **无缝衔接播放**：
  - Fixed Crossfade（固定时长交叉淡化，默认可用，无需 Python）
  - Beat Crossfade（基于节拍的交叉淡化，需 Python 服务）
  - Smart AutoMix（智能节拍匹配 + BPM 同步，效果最佳，需 Python 服务）
  - 智能降级：Python 服务不可用时自动回退到浏览器端方案，用户无感知
- **歌词系统**：LRC 解析、QQ 逐字歌词、实时滚动、点击跳转、翻译歌词、虚拟化渲染
- **缓存系统**：封面缓存（LRU 清理、30 天有效期）、智能歌单缓存（1 小时过期、用户操作后失效、支持强制刷新）、红心与歌单操作 API（`likeSong` / `addSongToPlaylist` / `removeSongFromPlaylist`，操作后自动失效相关缓存）
- **推荐系统**：每日推荐 + 猜你喜欢（随机抽取多个歌单再混排取歌）+ 网易云多榜单（热歌榜 / 飙升榜）
- **可视化**：频谱条 / 波形 / 圆形三种模式，Three.js 实时音频分析，平滑动画过渡
- **壁纸同步（Windows）**：注册表 `HKCU\Control Panel\Desktop` + PowerShell 每 10 秒轮询 → Electron 主进程 → IPC → 前端背景更新；自定义壁纸（最多 6 张、每张 50MB、单一/顺序/随机模式、手动/定时/启动时切换）；随机壁纸（Bing 每日 / 风景 / 动漫 / 自定义 API）；Wallpaper Engine 兼容（动态壁纸显示为静态图）

#### IndexedDB 数据库结构（库名 WaveForgeCache）
- `covers`：封面缓存（url 主键、data Blob、timestamp、size、accessCount、lastAccess）
- `playlists`：歌单缓存（id 主键、platform、data、timestamp、version）
- `metadata`：元数据（key 主键、value）

缓存效果：首次加载走网络请求；二次加载从 IndexedDB 读取（近 0ms）；切歌封面无闪烁平滑过渡。

#### 壁纸优先级设计
1. 启用 Wallpaper Engine 同步 → 使用系统壁纸
2. 未启用同步 + 随机 API 模式 → 在线图片
3. 未启用同步 + 单张模式 → 用户上传的壁纸
4. 无任何设置 → 默认液态玻璃背景

#### 壁纸功能已知限制
- 仅支持 Windows（依赖 PowerShell 与注册表）
- 10 秒轮询检测，非实时；可通过代码调整间隔
- Wallpaper Engine 动态壁纸显示为静态截图
- 不支持网络路径（UNC）；早期版本对特殊字符路径敏感（已通过 `chcp 65001` 修复）

### 架构要点
- Electron 安全：`contextBridge` 暴露受限 API、`nodeIntegration: false`、`contextIsolation: true`
- 分层结构：components（UI）/ services（API、缓存、壁纸）/ hooks / store / utils
- 无缝衔接数据流：音频 → Python Beat Service（BPM / 节拍 / 能量分析，结果本地缓存）→ 过渡点匹配 → Web Audio API 淡入淡出

---

## 3. 已修复的主要问题

- **Toast 中文乱码**：更新 36 个 `.tsx` 文件，统一为 UTF-8 编码
- **Python 服务稳定性**：从嵌入 Electron 进程改为独立 Python 服务（Flask），避免 PowerShell 进程管理复杂性问题
- **QQ 音乐未登录提示**：新增网易云作为备选源，优化错误处理
- **CORS 跨域**：通过本地 Node.js 服务器代理 QQ / 网易云 API 请求解决
- **`cdlist undefined`**：`qq-music-api` 歌单返回结构为空时，添加 `(result.cdlist && result.cdlist[0]) || {}` 安全检查
- **封面切换闪烁**：`CachedImage` 使用 `useRef` 防竞态 + 双缓冲（切换时保留旧图），仅首次加载显示 loading
- **缓存容量不足**：localStorage（5-10MB）升级为 IndexedDB（2GB 总容量、500 张封面、单张 10MB、LRU）
- **中文壁纸路径乱码**：PowerShell 调用前执行 `chcp 65001` 切换 UTF-8 代码页
- **TypeScript 类型修复（2026-07-13 合并后）**：非标准 `ringColor` 改为 Tailwind 变量 `--tw-ring-color`；修复 `PlayerControls` 定时器 ref 类型；补齐 `FullScreenPlayer` 缺失的 `accentColor` 属性；歌词加载前校验歌曲 ID
- **编译问题**：`PlaylistCarousel3D.tsx` 重复的 `style` 属性合并为单个

---

## 4. Phase 2 规划（智能过渡点选择算法）—— 已实施 ✅

> 原为 PHASE_1_COMPLETE.md 的进行中规划；**已于 2026-08-13 前落地**（`src/audio/transitionPlanner.ts` 的 `planTransition()` 完整实现：候选过渡点生成 + 6 成本矩阵 timbre/chroma/loudness/vocal/section/confidence + 归一化加权选优）。以下保留原始规划存档。

Phase 1（Beat This 集成）已铺好基础：
- `server/analysis_worker.py`：Python 分析 worker（Beat This 为主、Librosa 降级），JSON 消息通信协议（stdin/stdout），支持节拍检测、BPM 估算、beat 同步特征提取
- `desktop/audio-download.cjs`：音频下载服务（HTTP/HTTPS、本地文件、`waveforge-media://` 协议、临时文件缓存与清理）
- `desktop/analysis-runtime.cjs`：worker 生命周期管理（启动 / 空闲关闭）+ 分析结果持久化缓存（LRU）
- `src/services/analysisService.ts`、`src/hooks/useAutoMixer.ts`：渲染层接入，将 Beat This 结果转换为 AudioFeatures

**Phase 2 目标**（规划存档；实际已由 `transitionPlanner.ts` 的 6 成本矩阵方案实现）：
- 使用 Beat This 的精确 beat / downbeat 数据
- 实现候选过渡点生成
- 计算 6 个成本矩阵：timbre（音色）、chroma（和声）、loudness（响度）、vocal（人声）、section（段落）、tempo（速度）
- 基于成本矩阵选择最佳过渡点

预计工作量：2-3 天（已达成）
关键文件：`src/audio/transitionPlanner.ts`（已完善）、`server/analysis_worker.py`（增强特征提取）

**Phase 1 性能指标（历史快照数据）**：
- 首次分析 10-30 秒（3 分钟歌曲）；缓存命中 < 50ms；worker 首次启动 2-5 秒
- Python worker 常驻内存约 400MB（含模型）；临时文件约 10MB/首；缓存条目约 10KB/首
- Beat 检测 F-score > 0.9、BPM 估算误差 < 2%、Downbeat 检测 F-score > 0.85（论文数据）

**Phase 1 降级策略**（Beat This 不可用时的回退链）：
1. Python 未安装 → 浏览器端 Web Audio API 分析
2. 模型加载失败 → Librosa 简单分析
3. 分析超时 → 返回默认值（120 BPM）
4. 网络错误 → 使用歌曲元数据估算

**分析缓存位置**：`analysis-cache` 目录（Windows 在 `%APPDATA%\WaveForge\analysis-cache`，macOS/Linux 对应平台 Application Support / 配置目录）；结构含 `tracks/{sha256}.json`、`temp/{md5}.mp3` 等；可在「设置 → AutoMix → 清除分析缓存」或在应用内删除该目录清空

---

## 5. 合并记录

### 5.1 2026-07-10：同学版本合并（MERGE_SUMMARY.md）
- 项目A（同学版本）：`D:\opencode\中转\WaveForge(2)`
- 项目B（自研版）：`D:\opencode\waveforge`，作为合并基础
- 策略：项目B 为升级版（缓存系统与 API 优化更先进），保留其全部能力，仅并入项目A 的独有功能

**项目B 保留的能力（未改动）**：IndexedDB 2GB 缓存、智能歌单缓存（1 小时过期）、请求队列管理、全局图片缓存、API 重试机制与多源聚合、QQ 音乐猜你喜欢、网易云多榜单支持、完整技术文档

**从项目A 合并的功能**：
- 个人中心（ProfileView）：网易云 / QQ 双平台个人资料、歌单与收藏查看、双平台切换（同时登录时）、直接播放歌曲、平台登出
- 自定义背景模糊度：透明模式下背景模糊可调（0-100px，默认 30px，建议 20-50px），localStorage 持久化，实时生效；其他模式使用固定优化值（模糊模式 40px、沉浸模式 50px）
- 视觉优化：更柔和的背景缩放（1.1-1.15）

### 5.2 2026-07-13：Wave-Forge 桌面版合并（MERGE_FROM_WAVE_FORGE_20260713.md）
- 来源：`C:\Users\unive\Desktop\Wave-Forge`
- 合并前备份：`WaveForge-backup-20260713-113110`
- 合并内容：桌面模式 UI 与播放器组件、Wallpaper Engine / Windows 壁纸同步、Electron IPC 桥（读取与监听系统壁纸）、壁纸管理器服务、3D 歌单轮播 / 网格 / 详情视图、全屏播放器与无缝衔接相关组件，以及桌面模式、壁纸集成、测试、开发笔记等文档
- 合并后修复：放宽未使用变量的 TypeScript 检查以匹配现有代码风格、`ringColor` 改为 `--tw-ring-color`、修复定时器 ref 类型、补齐 `accentColor` 属性、规范化歌词显示位置、歌曲 ID 缺失时的歌词加载守卫、移除 JSX 内联 `console.log`
- 验证：`npm run lint` 与 `npm run build` 均通过，`dist` 构建输出已重新生成

---

## 附：归档来源说明

| 源文件 | 内容要点 |
|--------|----------|
| MERGE_SUMMARY.md | 2026-07-10 同学版本合并：策略、功能对比、文件变更 |
| MERGE_FROM_WAVE_FORGE_20260713.md | 2026-07-13 Wave-Forge 桌面版合并及类型修复 |
| DEVELOPMENT_SUMMARY.md | 2026-07-12 桌面壁纸联动功能开发总结 |
| PROJECT_ANALYSIS.md | 早期纯 Web 版架构分析（已过时，仅时间线引用） |
| PROJECT_COMPLETE_ANALYSIS.md | React + Electron 版完整架构、壁纸同步与安全架构 |
| PROJECT_SUMMARY.md | 封面缓存升级与 IndexedDB / 歌单缓存 / 红心操作 API |
| PROJECT_STATUS.md | 2026-07-25 状态报告：无缝衔接系统、性能指标、已修复问题 |
| PHASE_1_COMPLETE.md | Phase 1（Beat This）完成总结与 Phase 2 规划 |

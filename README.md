# WaveForge 澜音工坊

沉浸式桌面音乐播放器（Windows / Electron），支持 **QQ 音乐 + 网易云音乐**双平台：搜索、播放、歌词、可视化、智能推荐、无缝衔接（DJ 级转场）、桌面模式与壁纸联动。

## 快速开始

```bash
npm install                    # 安装依赖
npm run dev:electron           # 一键启动：Vite(3000) + API(3001) + Electron 窗口
```

- **高级功能（Smart AutoMix 节拍匹配）**：项目已内置 Python 3.13 运行时（`resources/python-embed/`），直接可用；启动 `start-full.bat` 或先运行 `python-beat-service/start.bat` 启动节拍服务（端口 **3002**）。
- 节拍服务未启动时，应用自动降级为 Fixed Crossfade，不影响基础播放。

## 核心功能

- **双平台搜索与推荐**：QQ 音乐 + 网易云实时搜索、每日推荐、热歌榜/飙升榜、猜你喜欢
- **QQ 音乐 API Key 领取**：内置引导窗口直达 y.qq.com 领取 qmk API Key（独立隔离 session，每次打开清空登录态）
- **无缝衔接播放**：三种模式 —— Smart AutoMix（智能节拍匹配+BPM 同步，需 Python）/ Beat Crossfade（节拍交叉淡化）/ Fixed Crossfade（固定时长，默认）
- **歌词系统**：LRC 解析、逐字歌词（QQ）、实时滚动、点击跳转
- **可视化**：频谱柱 / 波形 / 环形 / 3D 可视化
- **桌面模式**：桌面小组件、专注计时、生产力工具、自定义壁纸
- **Wallpaper Engine 联动**：读取本地 WE 配置并同步音频可视化
- **缓存系统**：IndexedDB（封面双缓冲、歌单缓存、免闪切换）

## 技术架构

```
前端:    React 19 + TypeScript + Tailwind CSS 4 + Vite 6
桌面:    Electron 42（主进程 CommonJS，preload 桥接）
后端:    Node.js + Express（local-server.mjs，单文件，端口 3001）
音频:    Web Audio API + 节拍分析（Python 3.13 + librosa）
音乐源:  qq-music-api + NeteaseCloudMusicApiEnhanced
可视化:  Three.js + React Three Fiber
```

```
WaveForge/
├── src/                        # React 前端
│   ├── components/            # 组件（App.tsx 懒加载）
│   ├── services/              # API 客户端、缓存、无缝衔接逻辑
│   ├── audio/                 # 播放引擎（队列/转场规划/渲染器）
│   ├── hooks/  api/  utils/  types/
├── desktop/                   # Electron 主进程 + preload（.cjs）
├── server/                    # 后端附加路由（hazard/location/comment）
├── local-server.mjs           # Express 后端（约 8k 行，单文件）
├── python-beat-service/       # 节拍分析服务（Flask，端口 3002）
│   └── packages/              # 离线 wheel 缓存（cp313，对应内置 3.13）
├── resources/python-embed/    # 嵌入式 Python 3.13.15（npm run bundle-python 重建）
└── scripts/                   # dev/build/打包脚本
```

## 开发命令

```bash
npm run dev:electron    # 完整开发（前端+后端+Electron）
npm run dev             # 仅 Vite（3000）
npm run dev:api         # 仅 API（3001）
npm run lint            # TypeScript 类型检查（tsc --noEmit）
npm run build           # 生产构建 -> dist/
npm run build:electron  # 打包 NSIS 安装版 -> release/（发布用）
npm run build:full      # 完整发布：bundle-python + build:electron
npm run build:electron:dir  # 构建 + 未打包目录（本地调试用，不发布）
npm run bundle-python   # 重建嵌入式 Python 运行时（3.13.15）
npm run test:license    # 设备授权自测
npm run sync:sponsors   # 刷新爱发电赞助名单（构建前会自动以可选模式运行）
test-python-service.bat # 检测节拍服务（3002）
```

## 发布（GitHub Releases）

**只发 NSIS 安装版**（`release/WaveForge-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 仅本地调试）。安装版为每用户安装、**不携带任何用户数据/配置**——首次运行在该机 `%APPDATA%\WaveForge 澜音工坊\` 自动生成全新配置并适配当前用户。

```bash
npm run build:electron          # 构建安装版
git tag v<version> && git push origin v<version>
gh release create v<version> release/WaveForge-<version>-Setup.exe --title "v<version>" --notes "..."
```

## 端口一览

| 端口 | 服务 | 说明 |
|---|---|---|
| 3000 | Vite / 生产 preview | 前端（后端 CORS 白名单） |
| 3001 | Express API | 后端（绑定 127.0.0.1，仅放行 localhost:3000 / file:// / null） |
| 3002 | Python 节拍服务 | Flask（Smart AutoMix） |

## 已知限制

1. 部分歌曲因版权/VIP 无法播放（未登录可播免费曲）
2. Smart AutoMix 依赖节拍服务，未启动时自动降级
3. 歌词第三方源（lrclib / amll-ttml-db）部分歌曲无词，属正常
4. 首次播放网易云高音质需后端启动时联网拉取 xeapi 公钥（已自动化）

## 文档

- [AGENTS.md](./AGENTS.md) — 给 AI 代理的项目指令（必读）
- [HANDOVER.md](./HANDOVER.md) — 交接文档：状态、已知问题、未决事项
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — 故障排除
- [CACHE_SYSTEM.md](./CACHE_SYSTEM.md) — 缓存系统设计
- [LICENSE_SYSTEM.md](./LICENSE_SYSTEM.md) — 设备授权机制
- [AFDIAN_SPONSORS.md](./AFDIAN_SPONSORS.md) — 爱发电赞助名单同步说明
- [CODEX_RECENT_PLAYBACK_CHECKPOINT.md](./CODEX_RECENT_PLAYBACK_CHECKPOINT.md) — 最近播放功能检查点
- [WALLPAPER_GUIDE.md](./WALLPAPER_GUIDE.md) / [DESKTOP_MODE.md](./DESKTOP_MODE.md) — 壁纸与桌面模式
- [PROJECT_HISTORY.md](./PROJECT_HISTORY.md) — 历史开发记录与 Phase 2 规划
- [PYTHON_EMBEDDING_GUIDE.md](./PYTHON_EMBEDDING_GUIDE.md) — 嵌入式 Python 构建

## 许可证

MIT（第三方依赖见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）

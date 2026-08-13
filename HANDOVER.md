# WaveForge 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、已知问题、未决事项、历史决策摘要。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。

---

## 1. 项目状态（2026-08-13）

- **阶段**：功能基本完整，处于维护/收尾阶段。核心功能（双平台搜索/播放/歌词/无缝衔接/桌面模式/壁纸联动）均已实现且通过自动化验证。
- **稳定性**：最近一次完整回归通过 —— `npm run lint` 0 报错、`vite build` 成功、Python 节拍服务与分析/渲染 worker 在嵌入式 3.13 上端到端实测通过（分析→渲染全链路）、后端安全修复点复测通过、Playwright 生产构建冒烟通过（首页加载/标签切换/播放/进度推进）。
- **代码规模**：前端 142 个 TS/TSX，后端 `local-server.mjs` 单文件约 8k 行，Python 服务 2.1k 行。

## 2. 环境（重要）

| 组件 | 版本/说明 |
|---|---|
| 嵌入式 Python（生产运行时） | **3.13.15**，位于 `resources/python-embed/`（gitignore，可 `npm run bundle-python` 重建） |
| 关键 Python 依赖 | numpy 2.5.2 / scipy 1.18.0 / librosa 0.11.0 / pedalboard 0.9.24 / numba 0.67.0 |
| 离线 wheel 缓存 | `python-beat-service/packages/`（41 个 cp313 wheel，`start.bat` 离线安装用，**已入库**） |
| 系统 Python | PythonEvm312（3.12.7）、PythonEvm314 —— 仅作回退，生产用嵌入式 |
| Node/前端 | Electron 42、React 19、Vite 6、TS 5.8 |

**运行时升级历史**：2026-08-13 从 3.11.9 升级到 3.13.15（此前 README 宣称 3.13 但实际 bundle 的是 3.11.9，属修复性升级）。离线 wheels 随之重建为 cp313 全集。

## 3. 端口

| 端口 | 服务 |
|---|---|
| 3000 | Vite dev / preview（后端 CORS 白名单仅放行此端口 + file:// + null） |
| 3001 | Express API（127.0.0.1） |
| 3002 | Python 节拍服务（Flask） |

> ⚠️ 历史文档中 5001 均为过时信息；`test-python-service.bat` 已修正为 3002。

## 4. 已知问题 / 踩坑记录

1. **网易云 xeapi 公钥**：`/api/netease/song/url` 报 `xeapi public key is missing` 时，说明 `os.tmpdir()/xeapi_public_key` 被系统清理了 —— 重启后端即可（`initNeteaseAPI()` 启动时自动 `generateConfig()` 重新拉取）。已提交 `d367cf9`。
2. **SSRF 守卫与内部代理链**：`proxy-image → cover`（`localhost:3001`）是本应用合法内部代理链，SSRF 守卫必须放行本服务自身端口 3001，否则评论区/歌单封面裂。**不要在守卫中一刀切封 localhost**。见 `local-server.mjs` 中 `isBlockedFetchUrl` 内的放行分支。
3. **wallpaper-engine 路径穿越防护**：`/api/wallpaper-engine/preview|media` 用 `resolve + startsWith(base+sep)` 校验，改动时保持。
4. **Electron will-navigate 守卫**：主/播放器/歌词三窗口已加导航白名单（dev: localhost:3000/127.0.0.1:3000；prod: 三个 file:// 入口）。QQ 登录窗**不能**加（它要导航 y.qq.com）。
5. **热路径日志**：播放/动画热路径必须用 `debugLog()`（`src/utils/debugLog.ts`），裸 console.log 会造成内存增长。`PlaylistGrid3D.tsx` 已全部改用。
6. **音频格式白名单**：`beat_analyzer.py` 仅接受 `.mp3/.flac/.wav/.ogg`（运行时 libsndfile 不支持 m4a/aac/opus/webm，且无 ffmpeg）。
7. **离线安装**：`start.bat` 的 `--no-index --find-links=packages` 依赖 `packages/` 里的 cp313 wheels —— 若再升级 Python 主版本，需重建 wheel 集（`pip download --only-binary=:all: -d packages`）。

## 5. 未决事项（可选做）

- [ ] **license 机制未强制执行**：`desktop/device-license.cjs` 计算授权但无功能门控（纯展示）。若未来要付费功能，需在主进程强制校验而非仅 UI。
- [ ] **cuefield 时间线执行器为死代码**：`gaplessIntegration.ts` 的 `startMonitoring()` 无调用点，cuefield 自动触发路径整体不可达（仅手动/降级路径在用）。可清理或接通。
- [ ] **TransitionRenderer 缓存 key**：`transitionPlanner.ts` 的 `plan.id` 未含 strategy/endTime/rendererVersion，极端情况下不同策略同 id 碰撞（当前实际影响低）。若要动缓存逻辑需一并考虑。
- [ ] **server/render_worker 单声道 vs desktop 立体声**：两 worker 输出声道行为不一致（server 折叠为 mono、desktop 保留立体声），属既有契约差异，未来可统一。
- [ ] **CHUNK 体积警告**：`vite build` 报 `locationHierarchy` 8.7MB 等 chunk 过大（数据文件），可考虑 manualChunks/懒加载优化。
- [ ] **测试覆盖**：无自动化测试套件（无 jest/vitest 配置），当前靠手动 + Playwright 冒烟 + 命令行脚本验证。若长期维护建议补核心逻辑单测。

## 6. 历史决策速览（详见 PROJECT_HISTORY.md）

- 2026-07-10/07-13：两次项目合并（同学版本 + Wave-Forge 桌面版）
- 2026-07-24~25：无缝衔接三模式（Fixed/Beat/Smart AutoMix）落地，Python 服务独立化 + 降级策略
- 2026-07-31：Phase 1（Beat This 集成）完成，Phase 2（智能过渡点）规划在案
- 2026-08-13：代码安全修复（SSRF/路径穿越/IPC 启动通道/will-navigate）→ 运行时升级 3.13.15 → 全链路回归 → 文档整理（29→13 个 md）

## 7. 常用操作速查

```bash
# 开发
npm run dev:electron          # 完整开发环境
test-python-service.bat       # 检查节拍服务 3002

# 验证
npm run lint                  # 类型检查
npm run build                 # 生产构建
./resources/python-embed/python.exe -m pip install --no-index --find-links=python-beat-service/packages --dry-run -r python-beat-service/requirements.txt  # 验证离线安装可解析

# 运行时重建
npm run bundle-python         # 重建嵌入式 3.13.15（需联网）

# 回滚
git log --oneline             # 查看历史；git reset --hard <sha> 回退
```

# WaveForge 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、已知问题、未决事项、历史决策摘要。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。

---

## 1. 项目状态（2026-08-13）

- **阶段**：功能基本完整，处于维护/收尾阶段。核心功能（双平台搜索/播放/歌词/无缝衔接/桌面模式/壁纸联动）均已实现且通过自动化验证。
- **代码基线**：当前仓库来自远程 `YoshinoRinn/WaveForge` 的**朋友优化合并版**（`f5d59b9`）——本地 git 历史已重置为远程 2 条提交（原本地 11 条提交被清除，其成果绝大部分已并入远程版）。
- **稳定性**：最近一次完整回归通过 —— `npm run lint` 0 报错、`vite build` 成功、Python 节拍服务与分析/渲染 worker 在嵌入式 3.13 上端到端实测通过（分析→渲染全链路）、后端安全修复点复测通过、Playwright 生产构建冒烟通过（首页加载/标签切换/播放/进度推进）。
- **代码规模**：前端 137 个 TS/TSX，后端 `local-server.mjs` 单文件约 8.2k 行，Python 服务约 2.1k 行。

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

1. **网易云 xeapi 公钥**：`/api/netease/song/url` 报 `xeapi public key is missing` 时，说明 `os.tmpdir()/xeapi_public_key` 被系统清理了 —— 重启后端即可（`initNeteaseAPI()` 启动时自动 `generateConfig()` 重新拉取）。此修复已合入远程基线 `f5d59b9`（本地历史已重置，旧提交号 `d367cf9` 不再存在于本地）。
2. **SSRF 守卫与内部代理链**：`proxy-image → cover`（`localhost:3001`）是本应用合法内部代理链，SSRF 守卫必须放行本服务自身端口 3001，否则评论区/歌单封面裂。**不要在守卫中一刀切封 localhost**。见 `local-server.mjs` 中 `isBlockedFetchUrl` 内的放行分支。
3. **wallpaper-engine 路径穿越防护**：`/api/wallpaper-engine/preview|media` 用 `resolve + startsWith(base+sep)` 校验，改动时保持。
4. **Electron will-navigate 守卫**：主/播放器/歌词三窗口已加导航白名单（dev: localhost:3000/127.0.0.1:3000；prod: 三个 file:// 入口）。**QQ 音乐 QMK API Key 领取窗口是唯一被允许打开 `y.qq.com` 的窗口**（`QMK_SESSION_PARTITION = 'waveforge-qq-skill-key'`，独立 session 且每次打开前清空避免复用登录态）——不要为其他窗口放宽守卫。
5. **热路径日志**：播放/动画热路径必须用 `debugLog()`（`src/utils/debugLog.ts`），裸 console.log 会造成内存增长。`PlaylistGrid3D.tsx` 已全部改用。
6. **音频格式白名单**：`beat_analyzer.py` 仅接受 `.mp3/.flac/.wav/.ogg`（运行时 libsndfile 不支持 m4a/aac/opus/webm，且无 ffmpeg）。
7. **离线安装**：`start.bat` 的 `--no-index --find-links=packages` 依赖 `packages/` 里的 cp313 wheels —— 若再升级 Python 主版本，需重建 wheel 集（`pip download --only-binary=:all: -d packages`）。
8. **prebuild 钩子**：`npm run build` 会自动执行 `sync:sponsors --optional`，依赖 `WaveForge-Afdian.env` 中的爱发电 Token；未配置时软失败，不影响构建（详见 `AFDIAN_SPONSORS.md`）。

## 5. 未决事项（可选做）

> 2026-08-14 已并行处理大部分（见 §6 历史决策）。剩余：

- [ ] **license 机制未强制执行**：`desktop/device-license.cjs` 计算授权但无功能门控（纯展示）。曾尝试加入"激活后拦截未授权播放"的门控，因会**限制现有功能**而被撤销——正确方向是"激活解锁**新**功能"而非限制已有功能，等付费功能规划时再做。
- [x] ~~**cuefield 时间线执行器为死代码**~~：✅ 已清理（2026-08-14）——删除 `cuefieldAutoMix.ts`/`cuefieldTimelineExecutor.ts`/`cuefieldApi.ts` 三文件 + `gaplessIntegration.ts` 约 400 行不可达代码（三方案分流/albumGapless 完整保留）。**遗留**：后端 `local-server.mjs:8027` 的 `/api/cuefield/transition` 路由无前端调用方，可后续清理。
- [x] ~~**TransitionRenderer 缓存 key**~~：✅ 已修复——`plan.id` 加入实际裁决策略/起止时长/rendererVersion（`RENDERER_VERSION` 常量）。
- [x] ~~**render_worker 声道不一致**~~：✅ 已统一为立体声（server 去掉 mono 折叠 + 修复 librosa 帧布局 bug；desktop 补 mono→stereo 上采样），19 项音频冒烟断言全过。
- [x] ~~**CHUNK 体积警告**~~：✅ 已优化——`locationHierarchy` 8.8MB → 752KB（`city.json` 按国家拆分 + 动态 import），build 无告警。
- [x] ~~**测试覆盖**~~：✅ 已补 vitest 套件（10 文件 / 111 用例全过）——`npm run test`。

## 6. 历史决策速览（详见 PROJECT_HISTORY.md）

- 2026-07-10/07-13：两次项目合并（同学版本 + Wave-Forge 桌面版）
- 2026-07-24~25：无缝衔接三模式（Fixed/Beat/Smart AutoMix）落地，Python 服务独立化 + 降级策略
- 2026-07-31：Phase 1（Beat This 集成）完成，Phase 2（智能过渡点）规划在案
- 2026-08-13：代码安全修复（SSRF/路径穿越/IPC 启动通道/will-navigate）→ 运行时升级 3.13.15 → 全链路回归 → 文档整理（29→13 个 md）
- 2026-08-13：合并朋友优化版（WaveForge(4)）—— 安全加固 + 音频/渲染修复 + **QQ 音乐 QMK API Key 领取功能** + 打包修复；本地仓库重置为远程基线（2 条提交）
- 2026-08-14：无缝衔接三方案分流（专辑直接拼接/非专辑 60ms 淡入淡出）、调音室（3D 环绕无声修复 + liquid glass UI + 锚点动画）、设置页 Tab 蓝色滑动指示条、启动 splash 黑/白屏修复（软件合成适配）；确立 **Releases 只发安装版** 的发布策略
- 2026-08-14：并行收尾未决事项 —— vitest 测试套件（111 用例）、cuefield 死代码清理、TransitionRenderer 缓存 key 修复、渲染 worker 声道统一立体声、CHUNK 体积优化（8.8MB→752KB）+ 壁纸前端改进（立即同步/动态壁纸提示/UNC 容错）；license 门控尝试后撤销（避免限制现有功能）

## 7. 常用操作速查

```bash
# 开发
npm run dev:electron          # 完整开发环境
test-python-service.bat       # 检查节拍服务 3002

# 验证
npm run lint                  # 类型检查
npm run build                 # 生产构建
npm run test:license          # 设备授权自测
./resources/python-embed/python.exe -m pip install --no-index --find-links=python-beat-service/packages --dry-run -r python-beat-service/requirements.txt  # 验证离线安装可解析

# 运行时重建
npm run bundle-python         # 重建嵌入式 3.13.15（需联网）

# 爱发电赞助名单
npm run sync:sponsors         # 手动刷新 src/data/afdianSponsors.generated.json

# 发布（⚠️ Releases 只发 NSIS 安装版，不发便携版 win-unpacked/）
npm run build:electron        # 构建安装版 release/WaveForge-<version>-Setup.exe
git tag v<version> && git push origin v<version>
gh release create v<version> release/WaveForge-<version>-Setup.exe --title "v<version>" --notes "changelog"
# 安装版每用户安装、不携带用户数据；用户配置生成于各机 %APPDATA%\WaveForge 澜音工坊\

# 回滚
git log --oneline             # 查看历史；git reset --hard <sha> 回退
```

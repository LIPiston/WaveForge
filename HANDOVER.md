# WaveForge 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、已知问题、未决事项、历史决策摘要。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。

---

## 1. 项目状态（2026-08-14）

- **阶段**：功能基本完整，处于维护/收尾阶段。核心功能（双平台搜索/播放/歌词/无缝衔接/桌面模式/壁纸联动）均已实现且通过自动化验证。
- **代码基线**：当前 HEAD `b0a487a`（2026-08-14 双会话合并提交：遥控器/SongDetail/模式切换重构 + 完整浅色模式与 UI 修复，详见 SESSION_SUMMARY(3)/(4)）；更早历史来自远程 `YoshinoRinn/WaveForge` 的**朋友优化合并版**（`f5d59b9`）。
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
| 3002 | Python 节拍服务（Flask，beat_analyzer.py） |
| 3003 | Python 响度测量服务（Flask，loudness_server.py，`/lufs`） |
| 3004 | Python 频响补偿设计服务（Flask，compensation_server.py，`/compensation`） |

> ⚠️ 历史文档中 5001 均为过时信息；`test-python-service.bat` 已修正为 3002。响度服务 3003、频响补偿服务 3004 均独立于节拍服务：dev 由 `dev-electron.mjs` 拉起、打包版由 `main.cjs` startLocalBackend() 拉起、手动可用 `start-full.bat`。

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
- [x] ~~**UpNext「即将播放下一首」弹窗在 gapless 模式不显示**~~：✅ 已修复（2026-08-14）——`src/App.tsx` 的 `eventTime = useTransitionCountdown ? transitionStartTime : duration` 无 fallback，`transitionStartTime` 为 null（preparing-next/加载/取消路径）时弹窗永不触发；改为 `transitionStartTime ?? duration` 回退歌曲剩余时长倒计时。已实测弹窗恢复。
- [x] ~~**license 机制未强制执行**~~：保留——方向为"激活解锁新功能"而非限制旧功能，等付费功能规划时再做。
- [x] ~~**音效模块升级**~~：✅ 已完成（2026-08-14）——效果可叠加、场景方案（内置 7 + 我的场景 8 上限、快照式 + 覆盖/保存确认）、混响类型（大厅/房间/板式/弹簧/舞台 + 预延迟/衰减可调）、动态压缩、夜间模式、频响补偿（等响度动态补偿：低频 0-12dB/高频 0-6dB shelf 结构防中频污染，auto 按系统音量线性提升，与 EQ、响度归一化互斥）、响度归一化（独立服务 3003 + 目标 -14 LUFS）、导出 WAV 与实时链共享构建。详见 CONTEXT.md + docs/adr/。

## 6. 历史决策速览（详见 PROJECT_HISTORY.md）

- 2026-07-10/07-13：两次项目合并（同学版本 + Wave-Forge 桌面版）
- 2026-07-24~25：无缝衔接三模式（Fixed/Beat/Smart AutoMix）落地，Python 服务独立化 + 降级策略
- 2026-07-31：Phase 1（Beat This 集成）完成，Phase 2（智能过渡点）规划在案
- 2026-08-13：代码安全修复（SSRF/路径穿越/IPC 启动通道/will-navigate）→ 运行时升级 3.13.15 → 全链路回归 → 文档整理（29→13 个 md）
- 2026-08-13：合并朋友优化版（WaveForge(4)）—— 安全加固 + 音频/渲染修复 + **QQ 音乐 QMK API Key 领取功能** + 打包修复；本地仓库重置为远程基线（2 条提交）
- 2026-08-14：无缝衔接三方案分流（专辑直接拼接/非专辑 60ms 淡入淡出）、调音室（3D 环绕无声修复 + liquid glass UI + 锚点动画）、设置页 Tab 蓝色滑动指示条、启动 splash 黑/白屏修复（软件合成适配）；确立 **Releases 只发安装版** 的发布策略
- 2026-08-14：并行收尾未决事项 —— vitest 测试套件（111 用例）、cuefield 死代码清理、TransitionRenderer 缓存 key 修复、渲染 worker 声道统一立体声、CHUNK 体积优化（8.8MB→752KB）+ 壁纸前端改进（立即同步/动态壁纸提示/UNC 容错）；license 门控尝试后撤销（避免限制现有功能）
- 2026-08-14：**Gapless 业务代码模块化** —— 从 `useAudioPlayer.ts`（1948 行）抽离到 `src/services/gapless/` 独立模块（`gaplessConstants.ts` / `seamlessJoinController.ts` / `gaplessTransition.ts`，共 413 行），hook 只剩调用接口（净减 254 行）；行为等价（lint 0 / 111 用例 / build 通过）。后续改无缝逻辑优先改 `src/services/gapless/`
- 2026-08-14：**UpNext 弹窗修复** —— gapless 启用时「即将播放下一首」通知不显示（`transitionStartTime` null 无 fallback），改为回退 `duration` 倒计时；**EPIPE 防护**（stdout/stderr 管道关闭时主进程不再崩溃）；**版本号更迭机制**（`npm run version:*`）
- 2026-08-14：**音效模块全面升级** —— 可叠加模型 + 快照式场景方案（覆盖/保存确认）、混响类型切换、动态压缩、夜间模式、频响补偿（与 EQ 互斥）、响度归一化（独立 loudness_server.py 端口 3003）、导出 WAV 与实时链共享 `buildEffectChain`（修漂移）；调音室 UI 改版（场景区 + 独立开关）；单测 111→119
- 2026-08-14：**音效引擎 v1/v2 双版本** —— 本地增强版定为 v2（`src/services/audio-effects-v2/` + `MixingStudioV2.tsx`），远程原版恢复为 v1（`src/services/audioEffects/` + `MixingStudio.tsx`，默认）；`audioEngineVersion.ts` 记录选择（localStorage）；调音室头部 v1/v2 切换 → 热切换（暂停→换链→恢复）或冷切换（未就绪时下次启动生效），右上角 2s 切换弹窗；两引擎 dispose 全断 masterGain + 摘 soundtouch/limiter 防并联打架；响度归一化/频响补偿按 v2 路由
- 2026-08-14：**频响补偿升级** —— 新增独立服务 `compensation_server.py`（端口 3004，`/compensation` 端点）：目标曲线 = ISO 226 等响度自适应（按系统音量）+ 场景预设（flat/bass/vocal/warm/bright/night）+ 自定义频段，离散为多段 Biquad 链（lowshelf/peaking/highshelf）；前端 `compensationService.ts` 调 3004 并按 mode+preset+volume 档位缓存，服务不可用回退内置近似；三启动入口（dev-electron.mjs / main.cjs / start-full.bat）同 3003 模式拉起；**算法重写（081401/081402 方法论）**——修复旧实现 ISO 226 数据表错误（全频段 ±12dB 钳制）与多 peaking 级联过冲（1kHz 被拉到 +5dB），改为简化等响度公式（音量→SPL 线性映射）+ shelf 结构（LowShelf 120Hz / HighShelf 12000Hz，防中频污染），数值验证 1kHz 级联响应 0.00dB；与响度归一化（3003）互斥/解耦
- 2026-08-14：**遥控器 / SongDetail / 模式切换重构 / QQ 音乐修复（远程会话）** —— 合并为提交 `3c2fc6a`：
  - **遥控器**（新增 `desktop/remote-server.cjs`、`desktop/remote-ui.html`、`src/components/RemoteControlModal.tsx`、`RemoteControlSettingsModal.tsx`、`RemoteCursor.tsx`）—— 手机扫码 → 局域网 WebSocket 控制 + 虚拟鼠标 overlay（合成点击/右键/hover、6s 自动隐藏）。
    - 改 `desktop/main.cjs`：遥控 IPC（start/stop/get-status/get-settings/update-settings）+ 控制桥 + 光标事件 + 快照补 `volume`/`muted`；
    - 改 `desktop/preload.cjs`：新增 `window.electron.remote`；`src/electron.d.ts`：补 `remote` 类型；
    - 改 `src/App.tsx`：控制桥扩展（seek/volume/mute/back/home/show-song/show-comment/show-artist）+ 渲染 RemoteControlModal/RemoteCursor/SongDetailModal；
    - 改 `src/components/ExploreView.tsx` / `HomeView.tsx` / `DesktopView.tsx`：三模式各加遥控按钮（搜索按钮左侧）；`SettingsPanel.tsx`：个性化新增「远程遥控器」节；
    - 改 `package.json` + `package-lock.json`：新增 `ws`、`qrcode.react`。
  - **SongDetailModal**（新增 `src/components/SongDetailModal.tsx`）—— 歌曲详情弹窗；改 `SongContextMenu.tsx`（右键「查看歌曲详情」）、`PlaybackRadialMenu.tsx`（8 方向 + 左上「查看详情」）、`App.tsx`（监听 `waveforge:show-song-detail`）。
  - **模式切换重构** —— `App.tsx` 抽 `applyMode()` + `.catch` 兜底，修正事件名 `viewModeChange` → `viewModeChanged`。
  - **desktop 快照扩展** —— `src/desktop-lyrics/DesktopLyricsApp.tsx` / `src/desktop-player/DesktopPlayerApp.tsx` 的 DEFAULT_STATE 补 `volume`/`muted`/`page`。
  - **QQ 音乐**（`local-server.mjs`）—— 收藏歌单旧接口 `fcg_qm_order_diss.fcg` 由 GET 改为 POST + 表单体（实测 `qqmusic_key` 返回 `code 0` 成功）；AI 歌单详情逐首 `qqSongDetail` 补封面/时长；歌曲详情时长毫秒÷1000 + 音质徽章/音质行。
  - **PlaylistDetailPanel** —— 新增「收藏/已收藏」按钮（`subscribePlaylist`）。
- 2026-08-14：**完整浅色模式（远程会话）** —— 播放页/简约首页/探索模式全表面浅色落地（桌面模式不生效）；设置-个性化新增深浅色开关（`localStorage.playerTheme` + `playerThemeChanged` 事件 + `<html data-wf-theme>`）；修复 2 个交互 bug（「即将播放」提示不再关闭用户面板、首页自定义 BlurAdjustModal 因 SettingsPanel 卸载被销毁 → 改为保持挂载）；60+ 探索 token 集中 CSS 映射。

## 7. 常用操作速查

```bash
# 开发
npm run dev:electron          # 完整开发环境
test-python-service.bat       # 检查节拍服务 3002

# 验证
npm run lint                  # 类型检查
npm run test                  # vitest 单测（119 用例）
npm run build                 # 生产构建
npm run test:license          # 设备授权自测
./resources/python-embed/python.exe -m pip install --no-index --find-links=python-beat-service/packages --dry-run -r python-beat-service/requirements.txt  # 验证离线安装可解析

# 版本更迭
npm run version:patch         # 0.1.0 -> 0.1.1（自动 commit/tag/push）
npm run version:dry           # 预览更迭（不落地）

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

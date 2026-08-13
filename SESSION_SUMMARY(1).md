# WaveForge 会话总结（2026-08-13）

> 本文件记录 2026-08-13 这一轮完整工作的全过程：代码审查、安全修复、运行时升级、自动化测试、文档整理、桌面打包。
> 从「启动 AGENTS.md 初始化」到「产出安装版/便携版安装包」，共 10 个 git 提交，全程可回滚。

---

## 一、会话概览

| 项目 | 说明 |
|---|---|
| 起始状态 | 非 git 仓库；嵌入式 Python 3.11.9；29 个冗余 md 文档；从未打过包 |
| 结束状态 | git 仓库（10 提交）；嵌入式 Python 3.13.15；14 个精简文档；NSIS 安装版 + 便携版（270MB） |
| 核心目标 | 功能可用且无异常、安全加固、文档精简、可分发 |
| 关键发现 | 打包版从未启动后端（重大缺陷）、网易云 xeapi 公钥未初始化、SSRF 守卫误伤内部代理链 |

---

## 二、阶段明细

### 阶段 1：初始化 + 首次代码审查（/init + /code-review）

- **AGENTS.md 创建**：生成了给未来 AI 代理的项目指令文件（命令、目录边界、约定、需先读的文档）。
- **临时文件清理**：删除 `.codex-perf/`（163 个备份/抓取文件）、`.codex-*.log`、`.browser-*`、`local-page.*` 等会话痕迹，约 30MB+。
- **5 个并行审查子代理**（本目录无 PR，改为直接审代码库）发现 **14 个问题**，按严重度：
  - **高危安全**：壁纸接口路径穿越（任意文件读取）、`/api/cover`+`/api/proxy-image` SSRF（内网代理+无超时无上限）、Electron IPC 启动通道任意执行、主窗口缺 `will-navigate` 防护
  - **中危正确性**：Python 节拍服务任意路径、交叉淡化 BPM 失配偏移、Home 模块子请求竞态、播放回调陈旧闭包、瞬时分析失败被固化缓存
  - **约定违规**：热路径裸 `console.log`（PlaylistGrid3D 等）

### 阶段 2：git 仓库初始化

- `git init`（分支 master），配置身份。
- `.gitignore` 追加：`resources/python-embed/`（460MB 可重建运行时）、`.playwright-mcp/`。
- 决策：`python-beat-service/packages/`（102MB 离线 wheels）**入库**（保留离线安装能力）。

### 阶段 3：code review 修复（5 个并行修复子代理）

| 模块 | 修复内容 |
|---|---|
| 后端 `local-server.mjs` | 路径穿越：`resolve + startsWith(base+sep)` 包含校验；SSRF：私网/环回/链路本地拦截 + 8s 超时 + 20MB 上限 |
| Electron `main.cjs`/`preload.cjs` | IPC 启动通道扩展名白名单；三窗口 `will-navigate` 白名单 |
| 音频引擎 | 交叉淡化目标跨度定长 + 源窗缩放；渲染器不再改写共享 plan；瞬时失败不再入缓存 |
| 渲染层 | App 回调依赖补全（ref 解 TDZ）；Home 子请求带 signal + aborted 检查；闹钟 ref 化；JSON.parse 防护 ×2；PlaylistGrid3D 改 `debugLog()` |
| Python `beat_analyzer.py` | 音频格式白名单（mp3/flac/wav/ogg）；静音 BPM 回退 120 |

**验证**：`npm run lint` 0 报错、`vite build` 成功、`node --check`/`py_compile` 全过、后端冒烟 + 安全点复测 5/5、Playwright 运行时冒烟（首页 50 首歌加载、0 运行时错误）。

### 阶段 4：Python 环境审计 + 嵌入式运行时升级

- **审计发现版本矩阵严重不一致**：
  - 嵌入式运行时是 **3.11.9**，但离线 wheels 几乎全是 **cp313**（numpy/scipy/numba 等）→ 离线安装 100% 失效
  - README 宣称"内置 Python 3.13"，实际 3.11.9
  - `server/setup_python_env.py` 是死代码且会在线破坏锁定环境
- **升级方案**（context7 + 官方文档验证兼容性：librosa 0.11 支持 numpy 2.x）：
  - 经代理（127.0.0.1:7890）下载 **Python 3.13.15** embed 包，嵌入 `resources/python-embed/`
  - 配置 `python313._pth` + 装 pip 26.2.1 + 清华镜像装依赖（numpy 2.5.2 / scipy 1.18.0 / librosa 0.11.0 / pedalboard 0.9.24 / numba 0.67.0）
  - `packages/` 重建为 **41 个 cp313 wheel**，离线安装 dry-run 验证通过
  - `bundle-python.mjs` 版本号 → 3.13.15；`VERSION.json` 重写为真实环境
- **端到端验证**（嵌入式 3.13）：分析服务 /health、/analyze（正常+静音回退+白名单拦截）、双渲染 worker 完整转场，全部通过。

### 阶段 5：4 模块复核（第二轮 /code-review）

4 个并行子代理在嵌入式 3.13 上实跑复核：
- 分析管线、渲染管线：**零错误零修复**
- 后端/Electron：安全修复点全部复测通过、无回归
- 脚本/环境：离线安装解析通过；**删除死代码 `server/setup_python_env.py`**（同步更新 2 处文档引用）

### 阶段 6：构建 + Playwright 自动化测试

- `npm run build` 生产构建成功；起 API(3001) + preview(3000) 用 Playwright 实测。
- **发现并修复 2 个真实 bug**（提交 `d367cf9`）：
  1. **SSRF 守卫误拦内部代理链**：`proxy-image → cover`（`localhost:3001`）是本应用合法代理链，守卫一刀切封 localhost 导致封面裂。修复：放行本服务自身（localhost/127.0.0.1/::1 + 端口 3001），内层 cover 仍做 CDN 公网校验，无安全绕过（实测链到云元数据仍 400）。
  2. **网易云播放 URL 全 502**（`xeapi public key is missing`）：库的 `generateConfig()`（注册匿名 token + 拉取 xeapi 公钥）从未被调用。修复：`initNeteaseAPI()` 启动时调用。实测 `/api/netease/song/url` 返回真实 320kbps 地址。
- **功能测试通过**：首页 50 首加载（封面 11/11）、标签切换、点击播放「隐藏相册」、歌词同步、进度推进、暂停控制。未触发登录墙（未登录可播免费曲）。

### 阶段 7：文档整理（29 → 14 个 md）

- **合并**（2 个并行子代理去重）：
  - 8 份历史报告 → `PROJECT_HISTORY.md`（161 行：时间线/架构/已修复问题/Phase 2 规划/合并记录）
  - 6 份壁纸文档 → `WALLPAPER_GUIDE.md`（144 行，3 份重复测试指南合一）
  - 2 份桌面模式 → `DESKTOP_MODE.md`（86 行）
- **删除** 19 个（16 个被合并覆盖 + 3 个一次性报告：ENCODING_FIX_REPORT / DEBUG_PLAYLIST_ISSUE / PERFORMANCE_OPTIMIZATION）
- **修复 4 处悬空引用**（README ×3 含本就不存在的「无缝衔接完整使用指南.md」、CHECKLIST、TROUBLESHOOTING）
- **重写 README**（509 行 → 约 120 行，去重/对齐当前状态）
- **新增 HANDOVER.md**：交接文档（环境/踩坑/未决事项/历史决策）
- **更新 AGENTS.md**：对齐当前状态（git 仓库、端口 3002、嵌入式 3.13、安全守卫约定）

### 阶段 8：桌面打包（electron-builder）

- **首次打包**（NSIS 安装版 + 便携版）→ 发现**重大缺陷：打包版后端从未启动**（API/Python 只在开发模式由 dev 脚本拉起），只剩空壳 UI。
- **修复**（提交 `b9f7b76`）：
  - `main.cjs` 新增 `startLocalBackend()`：打包版 `whenReady` 时用 `utilityProcess.fork` 拉起 `local-server.mjs`（3001）+ spawn 嵌入式 Python 跑 `beat_analyzer.py`（3002），退出清理子进程
  - `package.json`：`python-beat-service/**` 纳入打包并 asarUnpack（此前完全缺失）
- **端到端复验**：3001/3002 双端口监听、搜索/健康/分析全部返回真实数据。
- **瘦身**（提交 `7e90e92`）：`python-beat-service/packages/`（102MB wheels，打包版用不到）排除出打包，**391MB → 270MB**；AGENTS.md 记录打包规则。
- **最终产物**：`WaveForge-0.1.0-Setup.exe`（NSIS 安装版，270MB）+ `WaveForge 澜音工坊 0.1.0.exe`（便携版，269MB），自包含（内置后端 + 嵌入式 Python 3.13.15）。

---

## 三、提交记录（10 个）

```
7e90e92  打包优化: 排除离线wheels出打包 + AGENTS.md 记录打包规则
b9f7b76  打包修复: 打包版主进程拉起后端(API 3001 + Python 3002)
b82f7de  重写 README + 新增 HANDOVER.md
738e51d  更新 AGENTS.md 对齐当前状态
10218a9  文档整理: 29个md精简至13个
608374b  chore: gitignore Playwright 测试产物
d367cf9  修复Playwright测试发现的2个问题(SSRF代理链 + xeapi)
b4eea23  验证: 4模块在嵌入式3.13全链路通过; 删除死代码
3b8fb05  运行时升级: 嵌入式 Python 3.11.9 -> 3.13.15
d51052e  基线: 修复code review问题 + Python 版本审计修复
```

---

## 四、最终状态

| 项 | 值 |
|---|---|
| 嵌入式 Python | 3.13.15（numpy 2.5.2 / librosa 0.11.0 / pedalboard 0.9.24） |
| 文档 | 14 个 md（README / AGENTS / HANDOVER / 功能与合规文档） |
| 打包产物 | 安装版 + 便携版，各约 270MB |
| 后端 | `local-server.mjs`（3001）+ `python-beat-service`（3002），打包版自启动 |
| 验证 | lint 0 报错、构建成功、Python 全链路实测、Playwright 功能冒烟通过 |

---

## 五、关键经验 / 踩坑记录（已沉淀进 AGENTS.md / HANDOVER.md）

1. **打包版必须自带后端启动**：Electron 应用若依赖本地 HTTP 服务，主进程必须在打包模式下自行拉起（`utilityProcess.fork`），否则只有空壳 UI。
2. **SSRF 守卫要放行应用自身的内部代理链**：拦截内网地址时保留 `localhost:3001` 白名单（内层再校验最终目标），否则内部 `proxy-image → cover` 链路断裂。
3. **网易云 xeapi 公钥**：库的 `generateConfig()` 必须在启动时调用；系统临时目录被清理后重启即可恢复。
4. **嵌入式 Python 与离线 wheels 必须同版本**：wheels 是 cp313 而运行时是 3.11.9 会导致离线安装静默失效。
5. **文档要随项目演进更新**：AGENTS.md/README 中的端口、Python 版本、仓库状态都会过时，需定期对齐。
6. **一切变更走 git**：手动备份目录已被 git 提交取代（可 `git reset --hard` 回滚）。

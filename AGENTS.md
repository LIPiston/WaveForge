# AGENTS.md — WaveForge 澜音工坊

Desktop music player (Windows/Electron) for QQ Music + NetEase Cloud Music. Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express, Python beat-analysis service for DJ-style gapless playback. UI text and code comments are predominantly **Chinese** — keep new user-facing strings consistent with the existing language.

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3000) + API server (3001) + Electron window
npm run dev              # Vite dev server only (port 3000)
npm run dev:api          # Express backend only (local-server.mjs, port 3001)
npm run lint             # Typecheck: tsc --noEmit (covers src/ only; no ESLint in repo)
npm run test             # vitest 单测 (test/*.test.ts, 111 用例)
npm run build            # vite build -> dist/ (multi-entry: every *.html in repo root)
npm run build:electron   # build + electron-builder NSIS -> release/
npm run build:full       # bundle-python + build:electron (完整发布流水线)
npm run build:electron:dir  # build + electron-builder --win dir (未打包目录, 便于调试)
npm run bundle-python    # Rebuild embedded Python runtime (3.13.15) -> resources/python-embed/
npm run test:license     # 设备授权自测 (scripts/test-device-license.cjs)
npm run sync:sponsors    # 从爱发电 API 刷新 src/data/afdianSponsors.generated.json
npm run version:patch|minor|major|pre  # 版本号更迭 (scripts/bump-version.mjs, 自动 commit/tag/push)
npm run version:dry      # 预览版本更迭 (不落地)
start-full.bat           # One-click: Python beat service (3002) + app
test-python-service.bat  # Health-check Python service on port 3002
```

注意：`prebuild` 钩子会在每次 `build`/`build:electron` 前自动运行 `sync:sponsors --optional`（需 `WaveForge-Afdian.env` 爱发电密钥文件，缺失时 `--optional` 软失败，不影响构建）。

Python beat service runs on **port 3002** (not 5001 — historical docs are stale). Offline wheel cache in `python-beat-service/packages/` is cp313 and matches the embedded 3.13 runtime; `start.bat` installs from it with `--no-index --find-links=packages`.

**打包规则（electron-builder）**：`python-beat-service/packages/`（102MB 离线 wheels）**必须排除出打包**（package.json `build.files` 中的 `!python-beat-service/packages/**/*`）——打包版直接用嵌入式 Python（`resources/python-embed/`，依赖已预装）spawn 运行 `beat_analyzer.py`，从不执行 pip 安装；wheels 仅服务源码分发/开发环境的离线安装。若嵌入式运行时升级或依赖缺失需要重装，重新生成 wheel 集而不是改打包配置。

**发布策略（releases）**：**GitHub Releases 只发 NSIS 安装版**（`npm run build:electron` → `release/WaveForge-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 是本地调试产物，不随 releases 分发）。发布时：打 `v<version>` tag → push tag → `gh release create v<version> release/WaveForge-<version>-Setup.exe`（附 changelog）。安装版为每用户安装（`nsis.perMachine: false`），**不携带任何用户数据/配置**——用户配置生成于各机 `%APPDATA%\WaveForge 澜音工坊\`，安装后自动适配当前用户。

**版本号更迭机制**：版本号唯一事实来源是 `package.json` 的 `version`（设置→关于页显示 `v{version} Beta`，"检查新版本"功能对比 GitHub tag 与本地 version）。使用 `scripts/bump-version.mjs` 自动更迭：

```bash
npm run version:patch   # 0.1.0 -> 0.1.1（修复）
npm run version:minor   # 0.1.0 -> 0.2.0（新功能）
npm run version:major   # 0.1.0 -> 1.0.0（破坏性）
npm run version:pre     # 0.1.0 -> 0.1.1-beta.0（预发布）
npm run version:dry     # 预览将要执行的操作（不落地）
```

脚本默认流程：更新 `package.json` + `package-lock.json` 版本 → commit `chore: bump version to vX.Y.Z` → 打 `vX.Y.Z` tag → push 分支与 tag。选项：`--no-commit` / `--no-tag` / `--no-push` / `--force`（工作区有未提交改动时默认拒绝，避免污染版本提交）。bump 后走发布流程：`npm run build:electron` → `gh release create`。

**打包三大约束（破坏任一条便携版就会黑屏/缺资源）**：
1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置，不要移进 `build` 子对象）——打包版用 `loadFile()`（file://）加载 `dist/index.html`，若 base 是 `'/'`，资源以 `/assets/...` 绝对路径引用全部 404，React 不挂载 → 整窗黑屏（症状：启动日志 `Renderer resources: 0`）。
2. `package.json` `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——`desktop/splash.html` 引用 `../logo.png`，主窗口/登录窗口 icon 用 `../build/icon.ico`，漏打包则启动 logo 丢失。
3. `package.json` `build.electronDist` 保持 `node_modules/electron/dist`——本机网络无法下载 electron zip，electron-builder 离线构建全靠这个本地副本。

## Layout & boundaries

- `src/` — React frontend. `components/` (App.tsx lazy-loads nearly everything), `services/` (API clients, cache, gapless/AutoMix logic), `audio/` (playback engine: `PlaybackQueue.ts`, `transitionPlanner.ts`, `TransitionRenderer.ts`, `playbackTimeStore.ts`), `hooks/`, `api/`, `utils/`.
- `src/services/gapless/` — **无缝衔接独立模块**（从 `useAudioPlayer.ts` 抽离）：`gaplessConstants.ts`（设置/常量）、`seamlessJoinController.ts`（首选拼接控制器：预热缓存/静音预启动/ended 拼接/边界调度/兜底，依赖注入）、`gaplessTransition.ts`（60ms 等功率双 deck 淡入淡出）。`useAudioPlayer.ts` 只保留调用接口（注入依赖 + 事件接线），改动无缝逻辑优先改此处。
- `desktop/` — Electron main process, **CommonJS** (`main.cjs`, `preload.cjs`, `config-manager.cjs`, `device-license.cjs`). Not covered by `tsc --noEmit`.
- `src/desktop-lyrics/` + `src/desktop-player/` — standalone renderer entries for `desktop-lyrics.html` / `desktop-player.html`.
- `local-server.mjs` — single-file Express backend (~8k lines, port 3001). Extra route modules in `server/` are registered here. QQ cookie state must flow through the single `qqMusicCookie` source of truth.
- `desktop/main.cjs` 还含 **QQ音乐 QMK API Key 领取窗口**（`QMK_OFFICIAL_KEY_URL` y.qq.com；独立 session partition `waveforge-qq-skill-key`，每次打开前清空避免复用登录态）——编辑时保留隔离分区与导航守卫逻辑。
- `scripts/` — dev 启动器（`dev-electron.mjs`、`start-api.mjs`、debug/hidden VBS）、`bundle-python.mjs`（重建嵌入式 Python）、`sync-afdian-sponsors.mjs`、`test-device-license.cjs`。
- `python-beat-service/` — Flask beat analysis (port 3002) for Smart AutoMix; app degrades to Fixed Crossfade when down.
- **Git repo** (has history — use `git log`/`git blame`; rollback via `git reset`). `data/`, `cache/`, `logs/`, `dist/`, `release/` are ignored runtime artifacts.

## Conventions

- **Relative imports everywhere** — `@/` alias is configured but unused; match the `./`/`../` style.
- **No ESLint** — `npm run lint` is typecheck only. Strict TS in `src/`.
- **Use `debugLog()` (src/utils/debugLog.ts) instead of `console.log` in hot paths** — gated behind `localStorage['waveforge:verbose-log']` to avoid console memory growth.
- **Files must be UTF-8** — Windows encoding issues previously broke Chinese UI text.
- Ports: 3000 Vite / 3001 backend (127.0.0.1, CORS allows only localhost:3000, file://, null origins) / 3002 Python.

## Backend security invariants (do not break when editing)

- **Electron 主进程**：所有窗口（主窗口/桌面播放器/歌词窗）都挂 `guardAgainstExternalNavigation()`（will-navigate 拦截外部跳转）；QQ QMK 领取窗口是唯一被允许打开 `y.qq.com` 的窗口——不要为其他窗口放宽守卫。
- `/api/cover` and `/api/proxy-image` have an SSRF guard blocking private/loopback/link-local IPs and DNS names resolving to them. **The internal proxy chain `proxy-image → cover` is legitimate**: guard must keep allowing `localhost:3001` (the app's own origin) — inner `/api/cover` still validates the final CDN target, so blocking localhost:3001 would break comment/playlist avatars.
- `/api/wallpaper-engine/preview` & `/media` enforce path containment under the WE base dir (resolve + startsWith(base+sep)).
- **Netease xeapi**: `initNeteaseAPI()` in local-server.mjs calls the lib's `generateConfig()` at startup to register an anonymous token and fetch the xeapi public key (cached in `os.tmpdir()/xeapi_public_key`). If `/api/netease/song/url` starts returning `xeapi public key is missing`, the tmp cache was cleared — restart the server.

## Read before touching

- `README.md` — feature map (seamless gapless modes, lyrics, visualizers, desktop/wallpaper mode).
- `LICENSE_SYSTEM.md` — device licensing (Ed25519; generator is a **separate** project, never rotate keys casually).
- `CACHE_SYSTEM.md` — IndexedDB cache design; `CachedImage` double-buffering.
- `AFDIAN_SPONSORS.md` — 爱发电赞助配置/流程（`sync:sponsors` 的数据源说明）。
- `CODEX_RECENT_PLAYBACK_CHECKPOINT.md` — 近期播放/恢复相关的开发检查点记录。
- `PROJECT_HISTORY.md` — historical dev milestones / Phase 2 planning (archive; don't treat as current spec).
- `WALLPAPER_GUIDE.md` / `DESKTOP_MODE.md` — wallpaper & desktop-mode feature docs.
- `PYTHON_EMBEDDING_GUIDE.md` — embedded Python build/rebuild process.

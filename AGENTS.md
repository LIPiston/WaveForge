# AGENTS.md — WaveForge 澜音工坊

Desktop music player (Windows/Electron) for QQ Music + NetEase Cloud Music. Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express, Python beat-analysis service for DJ-style gapless playback. UI text and code comments are predominantly **Chinese** — keep new user-facing strings consistent with the existing language.

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3000) + API server (3001) + Electron window
npm run dev              # Vite dev server only (port 3000)
npm run dev:api          # Express backend only (local-server.mjs, port 3001)
npm run lint             # Typecheck: tsc --noEmit (covers src/ only; no ESLint in repo)
npm run build            # vite build -> dist/ (multi-entry: every *.html in repo root)
npm run build:electron   # build + electron-builder NSIS -> release/
npm run bundle-python    # Rebuild embedded Python runtime (3.13.15) -> resources/python-embed/
start-full.bat           # One-click: Python beat service (3002) + app
test-python-service.bat  # Health-check Python service on port 3002
```

Python beat service runs on **port 3002** (not 5001 — historical docs are stale). Offline wheel cache in `python-beat-service/packages/` is cp313 and matches the embedded 3.13 runtime; `start.bat` installs from it with `--no-index --find-links=packages`.

**打包规则（electron-builder）**：`python-beat-service/packages/`（102MB 离线 wheels）**必须排除出打包**（package.json `build.files` 中的 `!python-beat-service/packages/**/*`）——打包版直接用嵌入式 Python（`resources/python-embed/`，依赖已预装）spawn 运行 `beat_analyzer.py`，从不执行 pip 安装；wheels 仅服务源码分发/开发环境的离线安装。若嵌入式运行时升级或依赖缺失需要重装，重新生成 wheel 集而不是改打包配置。

**打包三大约束（破坏任一条便携版就会黑屏/缺资源）**：
1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置，不要移进 `build` 子对象）——打包版用 `loadFile()`（file://）加载 `dist/index.html`，若 base 是 `'/'`，资源以 `/assets/...` 绝对路径引用全部 404，React 不挂载 → 整窗黑屏（症状：启动日志 `Renderer resources: 0`）。
2. `package.json` `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——`desktop/splash.html` 引用 `../logo.png`，主窗口/登录窗口 icon 用 `../build/icon.ico`，漏打包则启动 logo 丢失。
3. `package.json` `build.electronDist` 保持 `node_modules/electron/dist`——本机网络无法下载 electron zip，electron-builder 离线构建全靠这个本地副本。

## Layout & boundaries

- `src/` — React frontend. `components/` (App.tsx lazy-loads nearly everything), `services/` (API clients, cache, gapless/AutoMix logic), `audio/` (playback engine: `PlaybackQueue.ts`, `transitionPlanner.ts`, `TransitionRenderer.ts`, `playbackTimeStore.ts`), `hooks/`, `api/`, `utils/`.
- `desktop/` — Electron main process, **CommonJS** (`main.cjs`, `preload.cjs`, `config-manager.cjs`, `device-license.cjs`). Not covered by `tsc --noEmit`.
- `src/desktop-lyrics/` + `src/desktop-player/` — standalone renderer entries for `desktop-lyrics.html` / `desktop-player.html`.
- `local-server.mjs` — single-file Express backend (~8k lines, port 3001). Extra route modules in `server/` are registered here. QQ cookie state must flow through the single `qqMusicCookie` source of truth.
- `python-beat-service/` — Flask beat analysis (port 3002) for Smart AutoMix; app degrades to Fixed Crossfade when down.
- **Git repo** (has history — use `git log`/`git blame`; rollback via `git reset`). `data/`, `cache/`, `logs/`, `dist/`, `release/` are ignored runtime artifacts.

## Conventions

- **Relative imports everywhere** — `@/` alias is configured but unused; match the `./`/`../` style.
- **No ESLint** — `npm run lint` is typecheck only. Strict TS in `src/`.
- **Use `debugLog()` (src/utils/debugLog.ts) instead of `console.log` in hot paths** — gated behind `localStorage['waveforge:verbose-log']` to avoid console memory growth.
- **Files must be UTF-8** — Windows encoding issues previously broke Chinese UI text.
- Ports: 3000 Vite / 3001 backend (127.0.0.1, CORS allows only localhost:3000, file://, null origins) / 3002 Python.

## Backend security invariants (do not break when editing)

- `/api/cover` and `/api/proxy-image` have an SSRF guard blocking private/loopback/link-local IPs and DNS names resolving to them. **The internal proxy chain `proxy-image → cover` is legitimate**: guard must keep allowing `localhost:3001` (the app's own origin) — inner `/api/cover` still validates the final CDN target, so blocking localhost:3001 would break comment/playlist avatars.
- `/api/wallpaper-engine/preview` & `/media` enforce path containment under the WE base dir (resolve + startsWith(base+sep)).
- **Netease xeapi**: `initNeteaseAPI()` in local-server.mjs calls the lib's `generateConfig()` at startup to register an anonymous token and fetch the xeapi public key (cached in `os.tmpdir()/xeapi_public_key`). If `/api/netease/song/url` starts returning `xeapi public key is missing`, the tmp cache was cleared — restart the server.

## Read before touching

- `README.md` — feature map (seamless gapless modes, lyrics, visualizers, desktop/wallpaper mode).
- `LICENSE_SYSTEM.md` — device licensing (Ed25519; generator is a **separate** project, never rotate keys casually).
- `CACHE_SYSTEM.md` — IndexedDB cache design; `CachedImage` double-buffering.
- `PROJECT_HISTORY.md` — historical dev milestones / Phase 2 planning (archive; don't treat as current spec).
- `WALLPAPER_GUIDE.md` / `DESKTOP_MODE.md` — wallpaper & desktop-mode feature docs.
- `PYTHON_EMBEDDING_GUIDE.md` — embedded Python build/rebuild process.

# 开发共识：TV/平板/手机端通过内置无线调试做热更新（Dev 阶段）

> 本共识面向所有参与 WaveForge 开发的 AI 与开发者。阅读本文件后，
> 对 TV/平板/手机端的任何前端功能修改，请**直接走无线调试热更新**验证，
> 不要在 Dev 阶段通过"设置 → 检查更新"发行版本。

## 一、为什么

- WaveForge 是 PC（Electron）+ Android（TV/平板/手机）多端应用，共用同一套前端代码。
- PC 端功能改动 → 打包发行（正常流程）。
- **TV/平板/手机端：Dev 阶段每改一个功能都发 APK 不现实**（版本碎片化、安装繁琐）。
- 因此内置了**局域网无线调试 + 热更新**：改完前端代码 → 一条命令推送到设备 → 页面自动刷新，无需重装 APK、无需 adb。

## 二、机制（原理）

| 组件 | 说明 |
|---|---|
| 开发者模式 | TV 端**默认开启**（`localStorage.developerMode` 无记录 → TV 默认 true；手动关闭后持久化，重启保持关闭）。设置面板可开关。 |
| 调试服务 `:3002` | node 后端启动时按持久化的开发者模式状态启停，绑定 `0.0.0.0`（局域网可达）。 |
| 热更新端点 | `POST http://<设备IP>:3002/update`，body `{ files: [{ path, data(base64) }] }`（`path` 相对 `dist/`）→ 设备替换文件 → 广播 `reload` → 前端自动刷新。 |
| 调试台 | `http://<设备IP>:3002/`：后端日志（2s 自动刷新）、node 崩溃堆栈、前端 console 日志/JS 错误、遥控 App（播放/方向键/OK/返回/主页/搜索/设置）、热更新上传 UI（网页选文件）。 |
| 崩溃定位 | node 未捕获异常写 `filesDir/tv-crash.log`，前端错误上报同文件；重启后 `:3002/crash` 仍可查。 |

## 三、如何操作（改完代码后推送）

```bash
# 一键：构建 android 前端 + 推送到设备（推荐）
node scripts/push-hot-update.mjs 192.168.88.125 --rebuild

# 只推送（不重新构建，用现有 dist）
node scripts/push-hot-update.mjs 192.168.88.125
```

推送脚本读取 `android/app/src/main/assets/nodejs-project/dist/`（vite android 构建产物），
把全部文件 base64 打包上传 → 设备替换 → 页面自动刷新，改动即刻生效。

**前提**：设备开发者模式已开启（当前默认开启）、设备与电脑同一局域网、能访问 `:3002`。

## 四、边界与注意

- **热更新只覆盖前端资源（dist/）**。后端（`main.cjs`，含 android-server/tv-extensions/local-server）
  改动需要**重新构建并重装 APK**（node 无法自重启），或重装后由设备重新解压 assets。
- **不要**在 Dev 阶段用"设置 → 检查更新"发行每个小改动——那是正式发布通道。
- 正式发布时：`build-android-assets.mjs` + 版本号 + 更新清单照常，不受本共识影响。
- 涉及原生层（MainActivity/SplashView/键位）的改动必须重装 APK，热更新无法覆盖。

## 五、给其他 AI 的协作约定

1. 判断是否 TV/平板/手机端：`html.tv-mode` 类 / `isTvModeActive()`（浏览器 `?tv=1` 可模拟）。
2. 你改的是 TV/平板/手机相关前端代码时，验证方式是：**构建后 `node scripts/push-hot-update.mjs <设备IP> --rebuild` 推送到真机/模拟器**，而不是等发行版本。
3. 设备局域网 IP 以实际为准（投影仪常见 `192.168.88.x`；MuMu 模拟器可用 `adb forward tcp:13002 tcp:3002` 后访问 `http://localhost:13002`）。
4. 改完推送后，通过 `:3002/logs`（后端+前端日志）与 `:3002/crash`（崩溃）确认效果，必要时用调试台遥控设备操作验证。
5. 后端/原生改动请明确告知"需重装 APK"，不要混在热更新里。
6. 本共识与 HANDOVER-AI-COLLAB.md（双 AI 协作交接）配合使用：工作区共享时先看交接文档。

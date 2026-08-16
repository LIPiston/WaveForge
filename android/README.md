# WaveForge Android（TV 优先）移植说明

本目录是 WaveForge 的 Android 工程：**Kotlin 原生 WebView 壳 + 设备内置 Node.js（nodejs-mobile）**。
所有工作都在 `android-tv` 分支上进行，`master`（Windows 桌面版）不受影响。

## 架构

```
APK
├── libnode.so（arm64-v8a / armeabi-v7a / x86_64，来自 nodejs-mobile v18.20.4）
├── assets/nodejs-project/          ← 构建脚本生成（git 忽略，不入库）
│   ├── main.cjs                    ← esbuild 打包的后端（local-server.mjs + API 路由 + 静态托管）
│   ├── dist/                       ← vite 构建的前端单页应用
│   └── node_modules/               ← 设备端依赖（@neteasecloudmusicapienhanced/api 及依赖树）
└── MainActivity（Kotlin）
    ├── 启动 Node（JNI → node::Start → main.cjs）
    ├── 轮询 http://localhost:3001/health 就绪
    └── WebView 加载 http://localhost:3001/
```

页面与 API **同源同端口（3001）**：无需 CORS、没有 http 音频 CDN 的混合内容问题；
登录 cookie 与设置存在 WebView 的 localStorage（按 http://localhost:3001 源持久化）。

## 构建步骤

前置要求：
- **Android Studio**（或 Android SDK + NDK r24+ + CMake + JDK 17/21/25）
- Node.js（本项目依赖已 `npm install`）
- 本机 JDK 为 25 时，Gradle wrapper 已选 9.1.0（支持 JDK 25 运行）；若构建报兼容错误，
  安装 JDK 17/21 并设置 `JAVA_HOME` 后重试。

```bash
# 1) 拉取 nodejs-mobile 运行时（libnode.so + 头文件）→ android/app/libnode/（一次性，git 忽略）
npm run fetch:nodejs-mobile

# 2) 组装安卓资产：vite 前端构建 + esbuild 后端打包 + 设备端 node_modules 安装 + 版本号自增
npm run build:android

# 3) 用 Android Studio 打开 android/ 目录，等待 Gradle 同步（会自动下载 Gradle 9.1），
#    或命令行：
cd android
./gradlew assembleDebug   # Windows 用 gradlew.bat
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

每次改动前端代码后只需重跑 `npm run build:android`（`ASSETS_VERSION` 会自动递增，
设备端下次启动会重新解压资产），然后重装 APK。

## 连接电视调试

```bash
# 电视开启"开发者选项 → USB 调试 / 网络调试"，与电脑同一局域网
adb connect <电视IP>:5555
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
# 查看设备端 Node 日志（WebView console 与 Node stdout 都打到 logcat）
adb logcat | grep -iE "waveforge|node|chromium"
```

## 遥控器交互（已内置，无需配置）

- **方向键**：空间导航（按屏幕几何移动焦点，带蓝色焦点环）
- **OK / Enter**：激活（等效点击）
- **BACK**：关闭面板/软键盘/播放器；无面板时返回桌面
- **媒体键**（播放/暂停/上一首/下一首）：映射到播放控制
- **文本输入**（搜索框、QQ cookie）：自动弹出屏幕软键盘（TV 无系统输入法）
- **桌面专属 UI**（窗口按钮、桌面小组件、壁纸、遥控、GPU 设置）在 TV 上自动隐藏/不可用

## 已知限制与后续

- **媒体会话元数据**（电视状态栏"正在播放"的封面/歌名）暂未设置：需要在
  `App.tsx`/`useAudioPlayer` 补 `navigator.mediaSession.metadata`，待 Apple Music 集成分支
  合入后一并处理（避免与本仓库另一个并行任务冲突）。
- **桌面模式（Desktop View）入口**：设置/模式切换相关 UI 在 `App.tsx`（并行任务占用的文件），
  TV 上暂时仍可见但点进去会退化（壁纸等桌面 API 不存在）；合入后按 `isDesktop()` 隐藏。
- **AutoMix 智能过渡 / 混音台 / 离线下载**：依赖桌面 Python/Electron 服务，TV 上自动
  降级为固定交叉淡化 / 不可用。
- **QQ 登录**：网易云扫码登录可用；QQ 需要粘贴 cookie（软键盘 + 粘贴键，或手机复制后
  在 TV 剪贴板同步——部分电视支持）。
- **APK 体积**：libnode 三 ABI + 69MB 资产，debug 包较大；后续可只保留 arm64-v8a
  （`app/build.gradle.kts` 的 `abiFilters`）并把 node_modules 裁剪到运行时必需项。
- **平板端**：触摸/分屏适配未做，`src/platform.ts` 已留出 `android-tablet` 分支。

## 相关文件

| 文件 | 作用 |
|---|---|
| `android/app/src/main/java/com/waveforge/android/MainActivity.kt` | 壳：Node 启动 + 就绪轮询 + WebView + 键位转发 |
| `android/app/src/main/cpp/native-lib.cpp` | JNI 桥（node::Start） |
| `android-server.mjs` | 设备端后端入口（复用 local-server.mjs 全部路由 + 静态托管） |
| `src/tv/tvCore.ts` | TV 交互核心：空间导航/焦点环/聚焦域/BACK 栈 |
| `src/tv/TvKeyboard.tsx` | 遥控器屏幕软键盘 |
| `src/tv/mediaKeyBridge.ts` | 遥控器媒体键 → 播放控制 |
| `src/platform.ts` / `src/electronShim.ts` | 平台检测 / 非桌面环境 electron 桩 |
| `scripts/build-android-assets.mjs` | 资产组装（vite + esbuild + npm + 版本自增） |
| `scripts/fetch-nodejs-mobile.mjs` | 拉取 libnode 运行时 |

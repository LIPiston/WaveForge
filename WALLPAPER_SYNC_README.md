# 桌面壁纸联动功能说明

## 功能概述

WaveForge 现已支持与 Windows 系统桌面壁纸（包括 Wallpaper Engine）的实时联动功能。当您在桌面模式下启用此功能后，应用的背景将自动同步显示您的系统桌面壁纸。

## 技术实现

### 1. Electron 主进程 (desktop/main.js)
- 通过 PowerShell 读取 Windows 注册表获取当前桌面壁纸路径
- 每10秒自动检测壁纸变化
- 当检测到壁纸变化时，通知渲染进程更新

### 2. Preload 脚本 (desktop/preload.cjs)
- 暴露安全的壁纸 API 给渲染进程
- `getCurrentWallpaper()`: 获取当前系统壁纸
- `onWallpaperChange(callback)`: 监听壁纸变化事件

### 3. 前端实现
- **类型声明** (src/electron.d.ts): TypeScript 类型支持
- **壁纸管理器** (src/services/desktopWallpaperManager.ts): 优先检查 Electron API
- **桌面视图** (src/components/DesktopView.tsx): 监听并应用壁纸变化
- **设置面板** (src/components/DesktopSettingsModal.tsx): 提供开关控制

## 使用方法

### 开发环境测试
1. 启动 Vite 开发服务器：
   ```bash
   npm run dev
   ```

2. 在另一个终端启动 Electron：
   ```bash
   npm run dev:electron
   ```

3. 进入桌面模式，点击设置按钮

4. 在"壁纸联动"部分，启用"Wallpaper Engine 同步"开关

5. 背景将自动显示您的系统桌面壁纸

### 生产环境
1. 构建应用：
   ```bash
   npm run build:electron
   ```

2. 安装打包后的应用

3. 在应用中启用壁纸同步功能

## 支持的系统
- ✅ Windows 10/11
- ✅ 支持静态图片壁纸
- ✅ 支持 Wallpaper Engine 动态壁纸（显示为静态截图）
- ❌ macOS（暂不支持）
- ❌ Linux（暂不支持）

## 功能特点
1. **自动同步**: 每10秒检测壁纸变化，无需手动刷新
2. **实时更新**: 切换壁纸后自动在应用中生效
3. **平滑过渡**: 壁纸切换时有淡入淡出动画效果
4. **降级处理**: 如果无法获取系统壁纸，自动使用默认背景

## 故障排查

### 壁纸无法显示
1. 确认系统是 Windows 10/11
2. 检查是否有设置桌面壁纸
3. 查看开发者工具控制台的错误信息

### 壁纸不更新
1. 检查是否启用了"Wallpaper Engine 同步"开关
2. 等待最多10秒让系统检测到变化
3. 尝试关闭并重新打开应用

## 未来改进
- [ ] 支持视频壁纸实时播放
- [ ] 支持 macOS 和 Linux 系统
- [ ] 可配置检测间隔时间
- [ ] 添加壁纸缓存机制
- [ ] 支持多显示器壁纸选择

## 开发说明

### 相关文件
```
desktop/
  ├── main.js           # Electron 主进程，壁纸获取逻辑
  └── preload.cjs       # API 暴露

src/
  ├── electron.d.ts     # TypeScript 类型声明
  ├── components/
  │   ├── DesktopView.tsx              # 桌面视图，壁纸应用
  │   └── DesktopSettingsModal.tsx     # 设置面板
  └── services/
      └── desktopWallpaperManager.ts   # 壁纸管理器
```

### 核心 API

**获取壁纸**
```typescript
const result = await window.electron.wallpaper.getCurrentWallpaper()
if (result.success) {
  console.log('壁纸路径:', result.path)
}
```

**监听壁纸变化**
```typescript
window.electron.wallpaper.onWallpaperChange((wallpaperPath) => {
  console.log('壁纸已变化:', wallpaperPath)
})
```

## 更新日志

### v0.1.0 (2026-07-12)
- ✨ 新增桌面壁纸联动功能
- ✨ 支持 Windows 系统壁纸自动同步
- ✨ 支持 Wallpaper Engine 壁纸
- ✨ 添加壁纸变化监听
- ✨ 平滑的壁纸切换动画

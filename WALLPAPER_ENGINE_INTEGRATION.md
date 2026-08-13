# Wallpaper Engine 集成指南

## 概述

WaveForge 桌面模式支持与 Wallpaper Engine 的壁纸联动功能，可以将您的动态桌面壁纸作为播放器背景。

## 功能状态

✅ **已实现的功能：**
- 桌面模式设置中的 Wallpaper Engine 开关
- 壁纸同步状态管理
- 壁纸 URL 存储和加载
- 自动背景切换逻辑

⚠️ **需要进一步开发的功能：**
- Electron 主进程集成
- Wallpaper Engine API 调用
- 实时壁纸检测

## 实现方案

### 方案一：通过 Wallpaper Engine Web API（推荐）

Wallpaper Engine 提供了 Web 集成功能，可以通过 HTTP API 获取当前壁纸信息。

#### 1. 启用 Wallpaper Engine Web 集成

在 Wallpaper Engine 设置中：
1. 打开 Wallpaper Engine
2. 进入 **设置 → 常规**
3. 启用 **Web API** 功能
4. 记录 API 端口（默认：52025）

#### 2. 实现代码（需要在 Electron 主进程中添加）

在 `desktop/main.js` 中添加：

```javascript
const axios = require('axios');

// Wallpaper Engine API 端点
const WE_API_BASE = 'http://localhost:52025';

// 获取当前壁纸信息
async function getCurrentWallpaper() {
  try {
    const response = await axios.get(`${WE_API_BASE}/api/v1/wallpaper`);
    return {
      path: response.data.path,
      preview: response.data.preview,
      title: response.data.title,
    };
  } catch (error) {
    console.error('获取 Wallpaper Engine 壁纸失败:', error);
    return null;
  }
}

// 监听当前壁纸变化
function watchWallpaperChanges(mainWindow) {
  setInterval(async () => {
    const wallpaper = await getCurrentWallpaper();
    if (wallpaper) {
      // 将壁纸路径转换为 file:// URL
      const wallpaperUrl = `file:///${wallpaper.path.replace(/\\/g, '/')}`;
      
      // 发送到渲染进程
      mainWindow.webContents.send('wallpaper-changed', {
        url: wallpaperUrl,
        preview: wallpaper.preview,
        title: wallpaper.title,
      });
    }
  }, 5000); // 每5秒检查一次
}

// 在主窗口创建后调用
app.whenReady().then(() => {
  const mainWindow = createWindow();
  
  // 注册 IPC 处理器
  ipcMain.handle('get-current-wallpaper', async () => {
    return await getCurrentWallpaper();
  });
  
  // 开始监听壁纸变化
  watchWallpaperChanges(mainWindow);
});
```

#### 3. 在渲染进程中接收（更新 DesktopView.tsx）

```typescript
// 在 DesktopView.tsx 中添加
useEffect(() => {
  if (!wallpaperSyncEnabled) return;
  
  // 监听来自主进程的壁纸更新
  const handleWallpaperChanged = (_event: any, data: { url: string }) => {
    setWallpaperUrl(data.url);
    localStorage.setItem('currentWallpaperPath', data.url);
  };
  
  // @ts-ignore - Electron IPC
  window.electron?.ipcRenderer.on('wallpaper-changed', handleWallpaperChanged);
  
  // 初始加载当前壁纸
  // @ts-ignore
  window.electron?.ipcRenderer.invoke('get-current-wallpaper').then((wallpaper: any) => {
    if (wallpaper) {
      const url = `file:///${wallpaper.path.replace(/\\/g, '/')}`;
      setWallpaperUrl(url);
      localStorage.setItem('currentWallpaperPath', url);
    }
  });
  
  return () => {
    // @ts-ignore
    window.electron?.ipcRenderer.removeAllListeners('wallpaper-changed');
  };
}, [wallpaperSyncEnabled]);
```

### 方案二：通过文件系统监听

监听 Wallpaper Engine 配置文件的变化来检测壁纸切换。

配置文件位置：
```
C:\Users\[用户名]\AppData\Local\Wallpaper Engine\wallpaper_engine_config.json
```

#### 实现代码

```javascript
const fs = require('fs');
const path = require('path');

const WE_CONFIG_PATH = path.join(
  process.env.LOCALAPPDATA,
  'Wallpaper Engine',
  'wallpaper_engine_config.json'
);

function watchWallpaperConfig(mainWindow) {
  if (!fs.existsSync(WE_CONFIG_PATH)) {
    console.error('Wallpaper Engine 配置文件不存在');
    return;
  }
  
  fs.watch(WE_CONFIG_PATH, (eventType) => {
    if (eventType === 'change') {
      try {
        const config = JSON.parse(fs.readFileSync(WE_CONFIG_PATH, 'utf8'));
        const currentWallpaper = config.wallpapers?.[0]; // 主屏幕壁纸
        
        if (currentWallpaper?.file) {
          const wallpaperPath = path.join(
            process.env.PROGRAMFILES(X86) || 'C:\\Program Files (x86)',
            'Steam\\steamapps\\workshop\\content\\431960',
            currentWallpaper.file
          );
          
          mainWindow.webContents.send('wallpaper-changed', {
            url: `file:///${wallpaperPath.replace(/\\/g, '/')}`,
          });
        }
      } catch (error) {
        console.error('解析 Wallpaper Engine 配置失败:', error);
      }
    }
  });
}
```

### 方案三：使用 Wallpaper Engine 插件

为 Wallpaper Engine 创建一个自定义插件，通过 WebSocket 与 WaveForge 通信。

这需要更高级的开发，但可以实现：
- 实时壁纸预览
- 双向控制（从 WaveForge 切换壁纸）
- 音频可视化联动

## 使用方法

### 用户操作步骤

1. **启动 Wallpaper Engine**
   - 确保 Wallpaper Engine 正在运行
   - 已设置好您喜欢的动态壁纸

2. **在 WaveForge 中启用同步**
   - 进入桌面模式
   - 点击底部小白条展开控制药丸
   - 点击设置按钮
   - 开启"Wallpaper Engine 同步"开关

3. **享受联动效果**
   - 壁纸将自动作为播放器背景显示
   - 切换壁纸时会自动同步
   - 可以随时关闭同步恢复默认背景

## 故障排查

### 问题：壁纸不显示

**可能原因：**
1. Wallpaper Engine 未运行
2. Web API 未启用
3. 端口被占用

**解决方案：**
- 检查 Wallpaper Engine 是否正在运行
- 在 Wallpaper Engine 设置中启用 Web API
- 重启 WaveForge

### 问题：壁纸延迟更新

**可能原因：**
- 检测间隔太长

**解决方案：**
- 在代码中调整检测间隔（当前为 5 秒）

### 问题：壁纸路径无效

**可能原因：**
- Steam 安装路径不标准
- 壁纸文件已删除

**解决方案：**
- 检查 Wallpaper Engine 安装位置
- 重新下载壁纸

## 性能优化

### 建议

1. **缓存壁纸预览图**
   - 避免频繁读取大文件
   - 使用低分辨率预览版本

2. **控制检测频率**
   - 不要过于频繁检查壁纸变化
   - 使用防抖/节流机制

3. **异步加载**
   - 壁纸加载应该在后台进行
   - 不阻塞 UI 渲染

## 安全考虑

1. **文件访问权限**
   - 只读取必要的配置文件
   - 不修改 Wallpaper Engine 文件

2. **路径验证**
   - 验证文件路径合法性
   - 防止路径注入攻击

3. **错误处理**
   - 优雅降级到默认背景
   - 记录但不暴露敏感错误信息

## 未来改进

- [ ] 支持多显示器壁纸选择
- [ ] 壁纸效果参数同步（亮度、对比度等）
- [ ] 音频可视化反馈到壁纸
- [ ] 自定义壁纸过滤器（模糊、色调等）
- [ ] 壁纸切换动画效果

## 参考资源

- [Wallpaper Engine Steam Workshop](https://steamcommunity.com/app/431960/workshop/)
- [Wallpaper Engine 开发文档](https://docs.wallpaperengine.io/)
- [Electron IPC 通信文档](https://www.electronjs.org/docs/latest/api/ipc-main)

---

**注意：** 当前实现为占位符，需要根据上述方案选择一个进行完整实现。推荐使用方案一（Web API）作为首选方案。

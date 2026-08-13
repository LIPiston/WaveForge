# WaveForge 音乐播放器

基于 QQ音乐API 和网易云音乐API 的桌面音乐播放器，支持搜索、播放、可视化、智能推荐和**专业级无缝衔接播放**。

## ⚡ 快速开始

### 方式 1：基础版（推荐新手）

```bash
# 1. 安装依赖
npm install

# 2. 启动应用
npm run dev:electron
```

✅ 自动启动所有服务  
✅ 支持固定交叉淡化  
⚠️ 无高级节拍匹配

---

### 方式 2：完整版（推荐高级用户）

**获得 DJ 级别的无缝衔接效果！**

✅ **项目已内置 Python 3.13**，无需额外安装 Python！

#### 步骤 1：安装 Node.js 依赖
```bash
npm install
```

#### 步骤 2：首次运行 - 安装 Python 依赖

**选项 A（推荐）：自动安装**
```bash
# 双击运行，会自动检测并安装依赖
cd python-beat-service
start.bat
```

**选项 B：手动安装（国内用户推荐，更快）**
```bash
# 双击运行，选择清华镜像源
cd python-beat-service
install-deps.bat
```

#### 步骤 3：启动完整版

**一键启动（推荐）：**
```bash
# Windows: 双击运行
启动完整版.bat
```

**手动启动（两个窗口）：**

**窗口 1 - Python Beat Service:**
```bash
cd python-beat-service
start.bat
```

**窗口 2 - WaveForge 主应用:**
```bash
npm run dev:electron
```

#### 验证安装
```bash
# 测试 Python 服务
test-python-service.bat
```

📖 **详细指南**: [无缝衔接完整使用指南.md](./无缝衔接完整使用指南.md)

## 核心功能

### 🎵 音乐播放
- 高音质播放（支持320kbps/FLAC）
- 播放控制（播放/暂停/上一曲/下一曲）
- 三种播放模式（顺序/随机/单曲循环）
- 进度条拖拽和音量调节
- **🌟 专业级无缝衔接播放**：三种模式可选
  - **Smart AutoMix**: 智能节拍匹配 + BPM 同步（需要 Python）⭐⭐⭐⭐⭐
  - **Beat Crossfade**: 基于节拍的交叉淡化（需要 Python）⭐⭐⭐⭐
  - **Fixed Crossfade**: 固定时长交叉淡化（默认可用）⭐⭐⭐

### 🔍 搜索与推荐
- 实时音乐搜索（QQ音乐 + 网易云）
- 每日推荐（基于官方推荐）
- 猜你喜欢（智能歌单推荐算法）
- 热门榜单

### 🎨 可视化效果
- **频谱条**: 竖直频谱柱状图
- **波形**: 音频波形曲线  
- **圆形**: 环形频谱可视化
- **动态壁纸同步**：实时音频可视化

### 📝 歌词系统
- LRC 格式歌词解析
- 逐字歌词支持（QQ音乐）
- 实时滚动同步
- 点击歌词跳转播放

## 技术架构

```
前端: React + TypeScript + Tailwind CSS
桌面: Electron
后端: Node.js + Express
音频: Web Audio API
可视化: Three.js + React Three Fiber
音乐源: qq-music-api + NeteaseCloudMusicApiEnhanced（含可关闭的免费灰色歌曲跨平台补全）
无缝衔接: Python + Librosa (节拍分析)
```

## 无缝衔接功能 ⭐

WaveForge 提供**三种无缝衔接模式**，从简单到专业：

### 模式对比

| 模式 | 说明 | 效果 | 要求 |
|------|------|------|------|
| **Fixed Crossfade** | 固定时长交叉淡化 | ⭐⭐⭐ | 无（默认） |
| **Beat Crossfade** | 基于节拍的交叉淡化 | ⭐⭐⭐⭐ | Python Service |
| **Smart AutoMix** | 智能节拍匹配 + BPM 同步 | ⭐⭐⭐⭐⭐ | Python Service |

### Smart AutoMix 特性

- ✅ **精确的节拍检测**：使用 Librosa 进行专业级音频分析
- ✅ **BPM 同步**：自动匹配两首歌的节奏
- ✅ **智能过渡点选择**：自动寻找最佳的过渡位置
- ✅ **能量曲线匹配**：确保过渡流畅自然
- ✅ **缓存系统**：首次分析后缓存结果，响应时间 < 50ms

### 启用高级模式

1. 启动 **Python Beat Service**（独立服务）
2. 在设置中开启 **"AutoMix"** 开关
3. 播放音乐，享受专业级无缝衔接！

📖 **详细说明**: [无缝衔接完整使用指南.md](./无缝衔接完整使用指南.md)

## 项目结构

```
WaveForge/
├── src/                        # React 前端源码
│   ├── components/            # React 组件
│   ├── hooks/                 # 自定义 Hooks（含无缝衔接）
│   ├── services/              # API 服务
│   │   └── autoMixAnalysisService.ts  # 音频分析服务
│   ├── store/                 # 状态管理
│   └── utils/                 # 工具函数
├── desktop/                   # Electron 主进程
│   ├── main.cjs              # Electron 入口
│   └── preload.cjs           # 预加载脚本
├── server/                    # API 路由
│   ├── qq.js                 # QQ音乐 API
│   └── netease.js            # 网易云 API
├── python-beat-service/       # 🆕 独立的节拍分析服务
│   ├── beat_analyzer.py      # Python 分析引擎
│   ├── start.bat             # 启动脚本
│   └── requirements.txt      # Python 依赖
├── local-server.mjs          # 后端服务器
├── start-full.bat            # 🆕 一键启动所有服务
└── package.json              # Node.js 依赖
```

## 无缝衔接功能

无缝衔接（Gapless Playback）功能通过智能音频分析和交叉淡入淡出技术，实现歌曲之间的平滑过渡。

### 三种模式

#### 1. Fixed Crossfade（默认可用）
- ✅ 无需额外配置
- ✅ 平滑的音量过渡
- ⚠️ 节拍可能不匹配

#### 2. Beat Crossfade（需要 Python）
- ✅ 基于节拍的过渡
- ✅ 更精确的时间点
- ⚠️ 需要启动 Python Beat Service

#### 3. Smart AutoMix（推荐 - 需要 Python）
- ⭐ **DJ 级别效果**
- ⭐ 节拍完美对齐
- ⭐ BPM 平滑过渡
- ⭐ 智能选择过渡点
- ⚠️ 需要启动 Python Beat Service

### 工作原理

1. **音频分析**：使用 Librosa 分析歌曲的 BPM（节奏）和节拍位置
2. **智能过渡**：根据两首歌的特征自动调整过渡时长和策略
3. **交叉淡入淡出**：使用精确的音量曲线进行平滑混合

### 快速启用

#### 方法 1：仅使用基础模式
```bash
npm run dev:electron
```
✅ 立即可用，无需配置

#### 方法 2：启用高级模式
```bash
# 窗口 1：启动 Python Beat Service
cd python-beat-service
start.bat

# 窗口 2：启动主应用
npm run dev:electron
```

#### 方法 3：一键启动（推荐）
```bash
# 双击运行
start-full.bat
```

### 在设置中配置

1. 点击右上角设置图标
2. 找到"无缝衔接"相关开关：
   - **Crossfade**: 交叉淡化开关
   - **Gapless**: 无间隙播放
   - **AutoMix**: 智能混音（需要 Python）
3. 开启后，播放列表中的歌曲会自动进行无缝过渡

### 技术依赖

**基础模式（Fixed Crossfade）：**
- 无需额外依赖

**高级模式（Beat Crossfade / Smart AutoMix）：**
- **Python 3.8+**：运行音频分析服务
- **Librosa**：专业音频分析库
- **Flask**：API 服务框架

如果没有启动 Python Beat Service，系统会自动降级到基础模式。

### 后端接口（端口3001）

```javascript
POST   /api/search              // 搜索音乐
POST   /api/song/urls           // 获取播放链接
GET    /api/lyric?songmid=xxx   // 获取歌词
GET    /api/recommendations     // 获取推荐歌曲
```

## 开发命令

```bash
# 基础开发模式（启动主应用）
npm run dev:electron

# 完整开发模式（启动所有服务，包括 Python）
start-full.bat

# 仅启动前端开发服务器
npm run dev

# 仅启动 API 服务器
npm run dev:api

# 测试 Python Beat Service 是否运行
test-python-service.bat

# 构建生产版本
npm run build

# 打包成桌面应用
npm run build:electron
```

## 开发记录

### 2026-07-25 重大更新 🎉
- ✅ **独立的 Python Beat Service**：节拍分析服务独立运行，不依赖 Electron
- ✅ **三种无缝衔接模式**：Fixed Crossfade / Beat Crossfade / Smart AutoMix
- ✅ **智能降级策略**：Python 服务不可用时自动使用浏览器回退方案
- ✅ **一键启动脚本**：`启动完整版.bat` 自动启动所有服务
- ✅ **完整的用户指南**：详细的使用和故障排除文档
- ✅ **性能优化**：缓存系统、预加载、并行处理

### 2026-07-24 更新
- ✅ 实现无缝衔接播放功能（Gapless Playback）
- ✅ 集成 Python 音频处理引擎
- ✅ 添加智能 BPM 和能量分析
- ✅ 创建 Python 依赖安装脚本
- ✅ 更新项目文档

### 2026-07-10 更新
- ✅ 修复 `qq-music-api` 库中 `cdlist undefined` 错误
- ✅ 优化推荐算法，增加随机性和多样性
- ✅ 完善错误处理和日志输出
- ✅ 添加歌单数据验证

## 浏览器兼容性

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 已知限制

1. 部分歌曲因版权限制无法播放
2. 推荐功能依赖音乐API稳定性
3. 某些歌单可能因隐私设置无法访问（正常现象）
4. **Smart AutoMix 模式需要 Python Beat Service**，如果未启动，将自动降级到 Fixed Crossfade 模式

## 打包和分发

### 打包前准备

确保已安装所有依赖：
```bash
npm install
cd python-beat-service
pip install -r requirements.txt
```

### 方式 1：基础版（不含 Python）

用户需要自行配置 Python 环境：

```bash
npm run build:electron
```

生成的安装包位于 `release/WaveForge-0.1.0-Setup.exe`。

**用户安装后需要：**
1. 安装 Python 3.8+
2. 进入 `python-beat-service` 文件夹
3. 运行 `pip install -r requirements.txt`
4. 使用 `start-full.bat` 启动应用

### 方式 2：完整版（推荐）

将整个项目文件夹打包，用户无需配置：

1. **准备分发包**：
   ```bash
   # 压缩整个 WaveForge 文件夹
   # 确保包含：
   # - node_modules/
   # - python-beat-service/
   # - start-full.bat
   # - 所有源代码
   ```

2. **用户使用流程**：
   - 解压到任意位置
   - 确保已安装 Python 3.8+（如果需要高级模式）
   - 双击 `start-full.bat`

**优势**：
- ✅ 完整的开发环境
- ✅ 所有功能开箱即用
- ✅ 易于调试和修改
- ✅ 用户可以自行定制

### 方式 3：嵌入式 Python（未来支持）

将 Python 运行时内置到应用中，完全免配置。

## 故障排除

### Python Beat Service 无法启动

1. **检查 Python 版本**：
   ```bash
   python --version
   # 或
   py --version
   ```
   需要 Python 3.8 或更高版本

2. **检查依赖是否安装**：
   ```bash
   cd python-beat-service
   pip list | findstr "librosa flask"
   ```

3. **手动安装依赖**：
   ```bash
   cd python-beat-service
   pip install -r requirements.txt
   ```

4. **查看错误日志**：
   启动 `start.bat` 后，查看控制台输出的错误信息

### 无缝衔接功能不工作

1. **检查 Python Beat Service 是否运行**：
   ```bash
   test-python-service.bat
   ```
   如果显示 "❌ Python Beat Service 未运行"，则需要启动服务

2. **检查设置开关**：
   - 打开应用设置
   - 确认 "Crossfade" 或 "AutoMix" 已开启

3. **查看浏览器控制台**：
   - 按 F12 打开开发者工具
   - 查看是否有错误信息（红色文字）
   - 特别注意 "Failed to fetch" 或 "Network error" 错误

### Toast 消息显示乱码

✅ 已修复！如果仍然出现，请检查文件编码：
- 所有 `.tsx` 和 `.ts` 文件应为 UTF-8 编码
- 特别检查 `src/App.tsx`

### Python 依赖安装失败

**使用国内镜像**：
```bash
pip install librosa flask flask-cors numpy soundfile resampy -i https://pypi.tuna.tsinghua.edu.cn/simple
```

**或官方源**：
```bash
pip install librosa flask flask-cors numpy soundfile resampy
```

### 端口冲突

如果提示端口被占用：

**Python Beat Service (5001)**：
- 编辑 `python-beat-service/beat_analyzer.py`
- 修改 `app.run(port=5001)` 为其他端口
- 同时修改前端代码中的 API 地址

**主应用后端 (3001)**：
- 编辑 `local-server.mjs`
- 修改 `const PORT = 3001`

**前端开发服务器 (5173)**：
- 编辑 `vite.config.ts`
- 修改 `server.port`

## 扩展开发

### 添加新的可视化效果

编辑 `src/components/Visualizer3D.tsx` 组件，使用 Three.js 和 React Three Fiber 创建新的 3D 可视化效果。

### 自定义推荐算法

编辑 `local-server.mjs` 中的 `/api/recommendations` 路由。

### 修改无缝衔接参数

#### 前端（基础交叉淡化）
编辑 `src/hooks/useSeamlessTransition.ts`：
```typescript
// 调整过渡时长
const TRANSITION_DURATION = 3; // 秒

// 调整音量曲线
const fadeOutCurve = 'linear'; // 'linear' | 'exponential'
```

#### Python（智能节拍匹配）
编辑 `python-beat-service/beat_analyzer.py`：
```python
# 调整节拍检测灵敏度
tempo, beats = librosa.beat.beat_track(
    y=y, 
    sr=sr,
    start_bpm=120,  # 初始 BPM 猜测
    tightness=100   # 节拍检测紧密度 (1-1000)
)

# 调整过渡时长范围
min_transition = 2.0  # 最短过渡时间（秒）
max_transition = 8.0  # 最长过渡时间（秒）
```

### 添加新的音乐源

1. 在 `server/` 目录下创建新的 API 路由文件
2. 在 `local-server.mjs` 中注册路由
3. 在前端添加对应的服务调用

### 自定义 UI 主题

编辑 `src/App.tsx` 和 `tailwind.config.js`，修改颜色、字体等样式。

## 许可证

MIT License

## 完整文档

详细技术文档请查看 [PROJECT_ANALYSIS.md](./PROJECT_ANALYSIS.md)

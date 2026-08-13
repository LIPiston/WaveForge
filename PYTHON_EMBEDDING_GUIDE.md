# Python 嵌入式环境打包指南

## 概述

WaveForge 支持将 Python 运行时嵌入到应用中，这样用户就不需要单独安装 Python 了。

## 两种部署方案对比

### 方案 1：依赖系统 Python（当前默认）

**优点**：
- 打包体积小（约 200MB）
- 构建速度快
- 适合开发和测试

**缺点**：
- 用户需要手动安装 Python 3.10+
- 用户需要运行 `install-python-deps.bat` 安装依赖
- 多一步配置流程

**适用场景**：
- 开发测试
- 技术用户
- 快速迭代

---

### 方案 2：嵌入式 Python（推荐用于生产）

**优点**：
- 开箱即用，无需用户安装 Python
- 依赖版本固定，避免兼容性问题
- 用户体验好

**缺点**：
- 打包体积较大（约 350-400MB）
- 首次构建需要下载和配置（约 5-10 分钟）

**适用场景**：
- 生产环境分发
- 普通用户
- 追求最佳用户体验

---

## 如何使用嵌入式 Python

### 步骤 1：打包 Python 环境

运行以下命令自动下载、配置并打包 Python：

```bash
npm run bundle-python
```

这个命令会：
1. 下载 Python 3.11.9 嵌入式版本（约 20MB）
2. 安装 pip 包管理器
3. 安装项目依赖（pedalboard、numpy、scipy）
4. 清理缓存文件
5. 保存到 `resources/python-embed/` 目录

**预计耗时**：5-10 分钟（取决于网络速度）

**输出示例**：
```
🐍 WaveForge Python 嵌入式环境打包工具

📁 创建目录结构...
📥 下载: https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip
   进度: 100.0% (19.23 MB)
✅ 下载完成
📦 解压到: D:\opencode\WaveForge\resources\python-embed
✅ 解压完成
🔧 配置 pip 支持...
✅ pip 支持已启用
📦 安装 pip...
✅ pip 安装完成
📦 安装项目依赖...
✅ 依赖安装完成
🧹 清理缓存文件...
✅ 清理完成
✅ 版本信息已保存

✅ Python 嵌入式环境打包完成！
📂 位置: D:\opencode\WaveForge\resources\python-embed
```

### 步骤 2：构建应用

使用新的构建命令，它会自动包含嵌入式 Python：

```bash
npm run build:full
```

或者，如果已经运行过 `bundle-python`，可以直接：

```bash
npm run build:electron
```

### 步骤 3：测试

构建完成后，安装程序位于 `release/WaveForge-0.1.0-Setup.exe`。

**测试清单**：
- [ ] 在干净的 Windows 系统上安装（无 Python 环境）
- [ ] 启动应用，检查是否正常运行
- [ ] 播放音乐，检查基本功能
- [ ] 开启无缝衔接设置
- [ ] 测试歌曲切换，检查过渡效果
- [ ] 查看日志，确认使用的是嵌入式 Python

---

## 目录结构

### 开发环境

```
WaveForge/
├── resources/
│   └── python-embed/          # 嵌入式 Python（运行 bundle-python 后生成）
│       ├── python.exe         # Python 解释器
│       ├── python311.dll      # Python 运行时
│       ├── Lib/               # 标准库
│       │   └── site-packages/ # 第三方包
│       │       ├── pedalboard/
│       │       ├── numpy/
│       │       └── scipy/
│       └── VERSION.json       # 版本信息
├── scripts/
│   └── bundle-python.mjs      # 打包脚本
└── desktop/
    └── render-runtime.cjs     # 自动检测嵌入式 Python
```

### 打包后（生产环境）

```
Program Files/WaveForge/
├── WaveForge.exe              # 主程序
├── resources/
│   ├── app.asar               # 应用代码（压缩）
│   └── python-embed/          # Python 运行时（未压缩）
│       ├── python.exe
│       ├── python311.dll
│       └── Lib/
│           └── site-packages/
└── ...其他文件
```

---

## 工作原理

### 自动检测逻辑

`desktop/render-runtime.cjs` 中的 `_getPythonPath()` 方法：

```javascript
_getPythonPath() {
  // 1. 生产模式：检查 resources/python-embed/python.exe
  if (app.isPackaged) {
    const embedPath = path.join(process.resourcesPath, 'python-embed', 'python.exe')
    if (fs.existsSync(embedPath)) {
      return embedPath  // 使用嵌入式 Python
    }
  }
  
  // 2. 开发模式：检查 resources/python-embed/python.exe
  else {
    const devEmbedPath = path.join(__dirname, '..', 'resources', 'python-embed', 'python.exe')
    if (fs.existsSync(devEmbedPath)) {
      return devEmbedPath  // 使用嵌入式 Python
    }
  }
  
  // 3. 回退到系统 Python
  return process.platform === 'win32' ? 'py' : 'python3'
}
```

**检测顺序**：
1. 嵌入式 Python（如果存在）
2. 系统 Python（回退方案）

### Electron Builder 配置

`package.json` 中的关键配置：

```json
{
  "build": {
    "extraResources": [
      {
        "from": "resources/python-embed",
        "to": "python-embed",
        "filter": ["**/*"]
      }
    ],
    "asarUnpack": [
      "resources/python-embed/**/*"
    ]
  }
}
```

**说明**：
- `extraResources`: 将 Python 复制到 `resources/` 目录
- `asarUnpack`: Python 文件不压缩到 asar，保持原始结构

---

## 常见问题

### Q1: bundle-python 下载很慢怎么办？

**A**: 使用国内镜像或手动下载：

1. 手动下载 Python 嵌入式版本：
   https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip

2. 放到项目根目录的 `temp-python-download/python-embed.zip`

3. 运行 `npm run bundle-python`（会跳过下载步骤）

### Q2: 可以使用其他 Python 版本吗？

**A**: 可以，修改 `scripts/bundle-python.mjs` 中的版本号：

```javascript
const PYTHON_VERSION = '3.11.9'  // 改为你需要的版本
```

支持的版本：Python 3.8+（推荐 3.11）

### Q3: 打包后体积太大怎么办？

**A**: 可以优化：

1. **删除不必要的包**：编辑 `requirements.txt`，只保留必需依赖
2. **使用 UPX 压缩**：压缩 Python DLL 和 EXE（可节省 30-40%）
3. **回退到系统 Python**：不使用嵌入式 Python

### Q4: 如何验证嵌入式 Python 是否正常工作？

**A**: 查看应用日志（开发者工具），应该看到：

```
[Render Runtime] Using embedded Python: C:\...\resources\python-embed\python.exe
```

如果看到：
```
[Render Runtime] Using system Python
```

说明嵌入式 Python 未被使用。

### Q5: 开发时也能用嵌入式 Python 吗？

**A**: 可以！运行 `npm run bundle-python` 后，开发模式也会自动使用嵌入式 Python。

好处：
- 开发环境和生产环境一致
- 不依赖系统 Python 配置
- 团队成员环境统一

---

## 两种方案的构建命令对比

### 方案 1：系统 Python（默认）

```bash
# 用户需要做的：
1. 安装 Python 3.10+
2. 运行 install-python-deps.bat

# 开发者构建：
npm run build:electron
```

**构建时间**：约 2-3 分钟  
**输出大小**：约 200MB

---

### 方案 2：嵌入式 Python（推荐）

```bash
# 用户需要做的：
无（开箱即用）

# 开发者构建：
npm run bundle-python      # 首次：5-10 分钟
npm run build:full          # 后续：2-3 分钟
```

**首次构建时间**：约 10-15 分钟  
**后续构建时间**：约 2-3 分钟  
**输出大小**：约 350-400MB

---

## 推荐工作流程

### 开发阶段

```bash
# 选项 A：使用系统 Python（快速开发）
py -m pip install -r requirements.txt
npm run dev:electron

# 选项 B：使用嵌入式 Python（环境一致）
npm run bundle-python
npm run dev:electron
```

### 测试阶段

```bash
# 在干净的虚拟机中测试
npm run build:full
# 安装 release/WaveForge-0.1.0-Setup.exe 并测试
```

### 发布阶段

```bash
# 构建最终版本
npm run bundle-python      # 如果还没运行过
npm run build:full
# 分发 release/WaveForge-0.1.0-Setup.exe
```

---

## 技术细节

### Python 嵌入式版本与标准版本的区别

| 特性 | 标准版 | 嵌入式版 |
|------|--------|---------|
| 大小 | ~100MB | ~20MB |
| pip | 自带 | 需手动安装 |
| tkinter | 包含 | 不包含 |
| 安装器 | MSI/EXE | ZIP |
| 注册表 | 写入 | 不写入 |
| PATH | 可选 | 不修改 |

### 为什么选择 Python 3.11？

- ✅ 稳定性好（已发布 2+ 年）
- ✅ 性能优秀（比 3.10 快 10-25%）
- ✅ pedalboard 完全兼容
- ✅ 嵌入式版本可用
- ⚠️ Python 3.12/3.13 可能有兼容性问题

---

## 总结

**简单决策树**：

```
你想要最佳用户体验吗？
├─ 是 → 使用嵌入式 Python
│         npm run bundle-python
│         npm run build:full
│
└─ 否，打包速度更重要 → 使用系统 Python
          npm run build:electron
          提供 install-python-deps.bat 给用户
```

**我的推荐**：
- 开发测试：系统 Python（快速迭代）
- 生产发布：嵌入式 Python（用户体验）

---

## 获取帮助

如果遇到问题：
1. 检查 `resources/python-embed/VERSION.json`
2. 查看构建日志
3. 在干净环境中测试
4. 查看 Electron 日志（开发者工具）

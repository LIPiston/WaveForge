# WaveForge 设置指南

## 给新用户的快速入门

### 第一步：安装 Python（必需）

无缝衔接功能需要 Python 环境。

1. 下载 Python 3.10 或更高版本：https://www.python.org/downloads/
2. **重要**：安装时务必勾选 "Add Python to PATH"
3. 安装完成后，打开命令提示符验证：
   ```bash
   py --version
   ```
   应该显示类似 `Python 3.13.2` 的版本号

### 第二步：安装 Node.js 依赖

在项目根目录打开命令提示符，运行：

```bash
npm install
```

### 第三步：安装 Python 依赖

**方式 1：使用自动安装脚本（推荐）**

双击运行项目根目录下的 `install-python-deps.bat` 文件。

**方式 2：手动安装**

```bash
py -m pip install -r requirements.txt
```

如果下载速度慢，可以使用国内镜像：

```bash
py -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### 第四步：启动应用

```bash
npm run dev:electron
```

这个命令会自动启动：
- 前端开发服务器（React + Vite）
- 后端 API 服务器（Node.js + Express）
- Electron 桌面应用

## 功能说明

### 无缝衔接播放

无缝衔接功能会在歌曲切换时进行智能的交叉淡入淡出，让播放体验更加流畅。

**如何启用：**

1. 点击应用右上角的设置图标（齿轮）
2. 找到"无缝衔接 (Gapless)"开关
3. 打开开关即可启用

**工作原理：**

- 自动分析每首歌的 BPM（节奏）和能量
- 根据歌曲特征智能调整过渡时长（1-4秒）
- 使用高质量音频混合技术实现平滑过渡

**注意事项：**

- 首次使用时会分析歌曲，可能需要几秒钟
- 分析结果会被缓存，下次播放同一首歌时会更快
- 如果 Python 依赖未安装，功能会自动禁用但不影响正常播放

## 故障排除

### 问题：无缝衔接功能不工作

**解决方案：**

1. 确认 Python 已正确安装：
   ```bash
   py --version
   ```

2. 确认 Python 依赖已安装：
   ```bash
   py -c "import pedalboard; print('OK')"
   ```
   如果显示 `OK` 则安装成功

3. 检查设置中的开关是否已打开

4. 重启应用

### 问题：Python 依赖安装失败

**解决方案：**

1. 尝试更新 pip：
   ```bash
   py -m pip install --upgrade pip
   ```

2. 分别安装各个依赖：
   ```bash
   py -m pip install pedalboard
   py -m pip install numpy
   py -m pip install scipy
   ```

3. 如果仍然失败，检查是否有防火墙或网络限制

### 问题：应用启动后显示"未登录"错误

这是**正常现象**。WaveForge 支持 QQ 音乐和网易云音乐，部分功能需要登录账号，但基本播放功能不受影响。

## 打包分发

如果你想将这个项目分发给其他用户：

1. **包含的文件：**
   - 整个项目文件夹
   - `install-python-deps.bat` 安装脚本
   - `requirements.txt` Python 依赖列表
   - `README.md` 项目说明

2. **用户需要做的：**
   - 安装 Python 3.10+
   - 运行 `npm install`
   - 运行 `install-python-deps.bat`
   - 运行 `npm run dev:electron`

3. **构建独立安装包：**
   ```bash
   npm run build:electron
   ```
   生成的安装程序在 `release/` 目录下

   **注意：** 独立安装包不包含 Python 环境，用户仍需自行安装 Python 和依赖。

## 技术支持

如果遇到其他问题，请检查：

1. Node.js 版本是否 >= 16
2. Python 版本是否 >= 3.10
3. 网络连接是否正常
4. 防火墙是否阻止了应用

更多详细信息请查看 `README.md`。

# WaveForge 故障排除指南

## 常见问题和解决方案

### 1. test-python-service.bat 运行后立即关闭

**原因**: Python Beat Service 未启动

**解决方案**:
1. 首先启动 Python 服务：
   - 进入 `python-beat-service` 文件夹
   - 双击 `start.bat`
   - 等待看到 "Running on http://127.0.0.1:5001" 消息
   - **保持这个窗口打开**

2. 然后在另一个窗口测试：
   - 双击项目根目录的 `test-python-service.bat`
   - 应该显示 "Python Beat Service 运行正常！"

### 2. Python 未安装

**症状**: 启动脚本提示 "Python 未安装"

**解决方案**:
1. 下载并安装 Python 3.8 或更高版本
   - 访问: https://www.python.org/downloads/
   - 下载最新版本（推荐 Python 3.10 或 3.11）
   - **重要**: 安装时勾选 "Add Python to PATH"

2. 验证安装：
   ```bash
   python --version
   ```
   应该显示类似 "Python 3.11.x"

### 3. pip 依赖安装失败

**症状**: "依赖安装失败" 或 "ModuleNotFoundError"

**解决方案**:

#### 方案 A: 手动安装依赖
```bash
cd python-beat-service
pip install flask flask-cors librosa numpy soundfile
```

#### 方案 B: 使用国内镜像（如果网络慢）
```bash
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

#### 方案 C: 升级 pip
```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 4. 端口 5001 被占用

**症状**: "Address already in use" 或 "端口被占用"

**解决方案**:

#### 方案 A: 查找并关闭占用端口的程序
```bash
# 查找占用 5001 端口的进程
netstat -ano | findstr :5001

# 关闭进程（替换 PID）
taskkill /PID <进程ID> /F
```

#### 方案 B: 修改端口
编辑 `python-beat-service/beat_analyzer.py`，将最后一行改为：
```python
app.run(host='0.0.0.0', port=5002, debug=True)
```

然后修改前端代码 `src/services/autoMixAnalysisService.ts`：
```typescript
const PYTHON_SERVICE_URL = 'http://localhost:5002';
```

### 5. 无缝衔接不工作

**症状**: 歌曲切换时没有平滑过渡

**检查清单**:
- [ ] 设置面板中的 Crossfade 开关是否打开？
- [ ] Python Beat Service 是否正在运行？
- [ ] 检查浏览器控制台是否有错误信息
- [ ] 歌曲是否已经预加载完成？

**降级行为**:
- 如果 Python 服务不可用，系统会自动使用 Fixed Crossfade 模式
- Fixed Crossfade 仍然提供基础的交叉淡化效果
- Smart AutoMix 需要 Python 服务才能工作

### 6. npm run dev:electron 启动失败

**症状**: 命令执行失败或报错

**解决方案**:

#### 检查 Node.js 版本
```bash
node --version
```
需要 Node.js 16 或更高版本

#### 重新安装依赖
```bash
# 删除旧的依赖
rmdir /s /q node_modules
del package-lock.json

# 重新安装
npm install
```

#### 清理缓存
```bash
npm cache clean --force
npm install
```

### 7. 音乐搜索或播放失败

**症状**: 搜索无结果或播放报错

**可能原因**:
- QQ音乐 API 需要登录
- 网易云音乐 API 服务未启动
- 网络连接问题

**解决方案**:
1. 尝试切换音乐源（QQ音乐 ↔ 网易云音乐）
2. 检查网络连接
3. 重启应用

### 8. 歌词显示乱码

**症状**: 歌词显示为问号或乱码

**解决方案**:
- 这是音乐平台的数据问题
- 尝试切换到另一个音乐平台
- 某些歌曲可能没有歌词数据

### 9. start-full.bat 启动失败

**症状**: 批处理脚本报错

**检查清单**:
1. Python 是否已安装并在 PATH 中？
2. Node.js 是否已安装？
3. 是否已运行过 `npm install`？
4. python-beat-service/requirements.txt 依赖是否已安装？

**逐步测试**:
```bash
# 测试 1: 手动启动 Python 服务
cd python-beat-service
start.bat

# 测试 2: 在新窗口启动主应用
npm run dev:electron
```

### 10. 内存占用过高

**症状**: 应用运行缓慢或内存占用大

**正常范围**:
- 基础播放: 约 150-200MB
- 含可视化: 约 200-300MB
- Python 服务: 约 100-150MB

**优化建议**:
1. 关闭不使用的可视化效果
2. 减少播放列表中的歌曲数量
3. 定期重启应用

## 完整启动流程

### 基础版（无需 Python）
```bash
1. npm install（首次使用）
2. npm run dev:electron
```

功能：
- ✅ 音乐搜索和播放
- ✅ 基础交叉淡化
- ❌ 无高级节拍匹配

### 完整版（推荐）
```bash
1. npm install（首次使用）
2. cd python-beat-service
3. pip install -r requirements.txt（首次使用）
4. 双击 start.bat（启动 Python 服务）
5. 在新窗口运行 npm run dev:electron
```

或者使用一键启动：
```bash
双击 start-full.bat
```

功能：
- ✅ 所有基础功能
- ✅ Smart AutoMix 无缝衔接
- ✅ 节拍同步

## 日志和调试

### 查看前端日志
1. 按 F12 打开开发者工具
2. 查看 Console 选项卡
3. 搜索 "SeamlessTransition" 或 "AutoMix"

### 查看 Python 服务日志
- Python 服务的启动窗口会显示所有请求日志
- 查看是否有错误信息

### 查看 API 服务日志
- 运行 `npm run dev:electron` 的窗口会显示 API 日志
- 查看音乐 API 的请求和响应

## 获取帮助

如果以上方案都无法解决问题：

1. **检查项目文件完整性**
   - 确保所有文件都已正确解压
   - 确保 node_modules 文件夹存在

2. **查看项目文档**
   - README.md（主文档）
   - PROJECT_HISTORY.md（项目历史存档）
   - CHECKLIST.md（功能检查清单）

3. **系统要求**
   - Windows 10/11
   - Node.js 16+
   - Python 3.8+（可选，用于高级功能）
   - 至少 4GB RAM
   - 稳定的网络连接

## 已知限制

1. **Python 服务必须独立运行**
   - 需要保持命令行窗口打开
   - 关闭窗口会停止服务

2. **音乐 API 限制**
   - QQ音乐某些功能需要登录
   - 网易云音乐可能有地区限制

3. **首次音频分析较慢**
   - 每首歌首次分析需要 2-5 秒
   - 分析结果会缓存，后续播放很快

4. **Electron 窗口**
   - 开发模式下可能有性能损耗
   - 生产打包后性能更好

---

**最后更新**: 2026-07-25  
**版本**: 1.0.0

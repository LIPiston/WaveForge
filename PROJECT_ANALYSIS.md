# WaveForge 项目完整分析

## 项目概述
WaveForge 是一个基于 Web 的音乐播放器应用，集成了 QQ音乐 API，提供音乐搜索、播放、推荐等功能。

## 技术栈
- **前端**: HTML5, CSS3, JavaScript (Vanilla)
- **后端**: Node.js + Express
- **音乐API**: qq-music-api
- **音频处理**: Web Audio API
- **可视化**: Canvas API

## 项目架构

### 目录结构
```
WaveForge/
├── index.html              # 主页面
├── player.html             # 播放器页面
├── local-server.mjs        # 本地服务器
├── styles.css              # 主样式
├── player-styles.css       # 播放器样式
├── script.js               # 主页脚本
├── player.js               # 播放器核心逻辑
├── config.js               # 配置文件
├── package.json            # 项目依赖
└── node_modules/           # 依赖包
```

## 核心功能模块

### 1. 本地服务器 (local-server.mjs)
- **端口**: 3001
- **功能**:
  - 代理QQ音乐API请求
  - 处理跨域问题
  - 提供音乐搜索、获取播放URL、获取歌词等接口
  - 实现推荐系统（每日推荐、猜你喜欢）

#### API端点
- `POST /api/search` - 搜索音乐
- `POST /api/song/urls` - 获取播放链接
- `GET /api/lyric` - 获取歌词
- `GET /api/recommendations` - 获取推荐歌曲

#### 推荐算法
1. **每日推荐**: 基于QQ音乐每日推荐API
2. **猜你喜欢**: 
   - 获取推荐歌单列表
   - 随机选择5个歌单
   - 从每个歌单随机抽取歌曲
   - 打乱顺序后返回

### 2. 播放器核心 (player.js)

#### 音频管理
```javascript
class AudioManager {
  - audio: HTMLAudioElement
  - context: AudioContext
  - analyser: AnalyserNode
  - gainNode: GainNode
}
```

**功能**:
- 音频加载与播放控制
- 音量调节
- 播放进度控制
- 频谱分析数据提供

#### 播放列表管理
```javascript
class PlaylistManager {
  - playlist: Array<Song>
  - currentIndex: number
  - playMode: 'order' | 'random' | 'loop'
}
```

**功能**:
- 播放列表增删改查
- 播放模式切换（顺序/随机/单曲循环）
- 上一曲/下一曲逻辑

#### 可视化效果
```javascript
class Visualizer {
  - canvas: HTMLCanvasElement
  - ctx: CanvasRenderingContext2D
  - type: 'bars' | 'wave' | 'circle'
}
```

**可视化类型**:
1. **频谱条**: 竖直频谱柱状图
2. **波形**: 音频波形曲线
3. **圆形**: 圆形频谱可视化

#### 歌词系统
```javascript
class LyricsManager {
  - lyrics: Array<{time, text}>
  - currentIndex: number
}
```

**功能**:
- 解析LRC格式歌词
- 实时同步显示
- 点击跳转播放

### 3. 用户界面

#### 主页 (index.html)
- **搜索功能**: 实时搜索音乐
- **推荐系统**: 显示推荐歌曲
- **播放列表**: 管理待播放歌曲

#### 播放器页面 (player.html)
- **播放控制**: 播放/暂停、上一曲/下一曲、进度条
- **音量控制**: 音量滑块、静音按钮
- **可视化**: 三种可视化效果切换
- **歌词显示**: 滚动歌词面板
- **播放模式**: 顺序/随机/循环切换

## 数据流

### 音乐搜索流程
```
用户输入 → script.js → /api/search → QQ音乐API → 返回结果 → 显示列表
```

### 播放流程
```
选择歌曲 → 获取songmid → /api/song/urls → 获取播放链接 → AudioManager加载 → 播放
```

### 推荐流程
```
页面加载 → /api/recommendations → 后端推荐算法 → 返回推荐列表 → 显示
```

## 配置说明 (config.js)

```javascript
const CONFIG = {
  API_BASE_URL: 'http://localhost:3001',
  DEFAULT_QUALITY: 320,          // 默认音质：320kbps
  MAX_SEARCH_RESULTS: 20,        // 最大搜索结果数
  VISUALIZER_FPS: 60,            // 可视化帧率
  LYRICS_SYNC_OFFSET: 0          // 歌词同步偏移
}
```

## 已知问题与解决方案

### 1. ✅ CORS跨域问题
**问题**: 前端直接请求QQ音乐API被CORS阻止  
**解决**: 通过本地Node.js服务器代理请求

### 2. ✅ 歌单API异常
**问题**: `qq-music-api`库中`result.cdlist`可能为undefined  
**解决**: 在`songlist.js`中添加安全检查：
```javascript
data: (result.cdlist && result.cdlist[0]) || {}
```

### 3. ⚠️ 音频格式支持
**问题**: 部分浏览器不支持某些音频格式  
**建议**: 优先使用MP3格式，fallback到其他格式

### 4. ⚠️ 移动端适配
**问题**: 当前主要针对桌面端设计  
**建议**: 添加响应式布局和触摸事件支持

## 性能优化建议

### 1. 音频预加载
```javascript
// 预加载下一首歌曲
preloadNext() {
  const nextSong = this.playlist[this.currentIndex + 1];
  if (nextSong) {
    // 创建隐藏的audio元素预加载
  }
}
```

### 2. 可视化性能
- 使用`requestAnimationFrame`而非定时器
- 降低频谱分析FFT大小
- 实现帧率自适应

### 3. 歌词缓存
```javascript
// 缓存已获取的歌词
const lyricsCache = new Map();
```

### 4. 搜索防抖
```javascript
// 延迟搜索请求，避免频繁API调用
debounce(searchFn, 300);
```

## 扩展功能建议

### 1. 用户系统
- 用户登录/注册
- 个人收藏夹
- 播放历史记录
- 用户偏好设置

### 2. 高级播放功能
- 均衡器（EQ）
- 音效（混响、回声等）
- 变速播放
- AB循环

### 3. 社交功能
- 歌单分享
- 评论系统
- 好友推荐

### 4. 离线功能
- 本地音乐导入
- 缓存已播放歌曲
- PWA支持

### 5. 智能推荐增强
- 基于播放历史的推荐
- 基于用户行为的协同过滤
- 情绪/场景推荐

## 部署指南

### 开发环境
```bash
# 安装依赖
npm install

# 启动服务器
node local-server.mjs

# 访问应用
# 主页: http://localhost:3001
# 播放器: http://localhost:3001/player.html
```

### 生产环境
1. **服务器要求**:
   - Node.js 14+
   - 至少512MB RAM
   - 支持WebSocket（如需实时功能）

2. **部署步骤**:
   ```bash
   # 安装依赖
   npm install --production
   
   # 使用PM2管理进程
   npm install -g pm2
   pm2 start local-server.mjs --name waveforge
   pm2 save
   pm2 startup
   ```

3. **Nginx反向代理**:
   ```nginx
   server {
     listen 80;
     server_name your-domain.com;
     
     location / {
       proxy_pass http://localhost:3001;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection 'upgrade';
       proxy_set_header Host $host;
       proxy_cache_bypass $http_upgrade;
     }
   }
   ```

## 安全性考虑

### 1. API密钥保护
- 不要在前端暴露QQ音乐cookie
- 使用环境变量存储敏感信息

### 2. 请求限制
```javascript
// 添加请求频率限制
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分钟
  max: 60 // 最多60次请求
});
app.use('/api/', limiter);
```

### 3. 输入验证
- 验证用户搜索输入
- 过滤SQL注入、XSS攻击

### 4. HTTPS
- 生产环境必须使用HTTPS
- 避免中间人攻击

## 测试指南

### 功能测试清单
- [ ] 搜索功能正常
- [ ] 播放/暂停控制
- [ ] 上一曲/下一曲切换
- [ ] 音量调节
- [ ] 进度条拖拽
- [ ] 播放模式切换
- [ ] 可视化效果切换
- [ ] 歌词同步显示
- [ ] 推荐系统加载

### 兼容性测试
- [ ] Chrome 90+
- [ ] Firefox 88+
- [ ] Safari 14+
- [ ] Edge 90+

### 性能测试
- [ ] 页面加载时间 < 3秒
- [ ] 音频切换延迟 < 1秒
- [ ] 可视化帧率 > 30fps
- [ ] 内存占用 < 200MB

## 维护日志

### 2026-07-10
- ✅ 修复了`qq-music-api`库中的`cdlist undefined`问题
- ✅ 优化了推荐算法，增加随机性
- ✅ 完善了错误处理和日志输出

## 贡献指南

1. Fork本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启Pull Request

## 许可证
MIT License

## 联系方式
- 项目地址: D:\opencode\WaveForge
- 问题反馈: 请在项目中创建Issue

---
最后更新: 2026-07-10

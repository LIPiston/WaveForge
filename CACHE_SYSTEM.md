# WaveForge 缓存系统文档

## 概述

WaveForge 已升级到全新的 IndexedDB 缓存系统，提供：
- ✅ **大容量存储**：支持最大 2GB 缓存（相比之前的 5-10MB）
- ✅ **智能封面缓存**：最多缓存 500 张封面，单张最大 10MB
- ✅ **歌单智能缓存**：自动缓存歌单，支持实时刷新
- ✅ **无闪烁切换**：使用双缓冲技术，切歌时封面不会闪烁
- ✅ **自动缓存失效**：用户操作后自动刷新相关缓存

---

## 已修复的问题

### 1. 封面显示bug
**问题**：点开歌曲会显示正确封面，但几秒后变成随机图片（picsum.photos）

**根本原因**：
- `CachedImage` 组件在切换时会清空图片，导致短暂显示默认封面
- 竞态条件：多个加载请求同时进行，后到的旧请求覆盖了新请求

**解决方案**：
1. 使用 `useRef` 跟踪当前加载的 URL，防止竞态条件
2. 采用双缓冲技术：切换时保持旧图片显示，新图片加载完成后再切换
3. 只在第一次加载且无图片时显示 loading 状态

### 2. localStorage 容量限制
**问题**：缓存很快就满了（5-10MB），无法缓存高清图片

**解决方案**：
- 从 localStorage 迁移到 IndexedDB
- 支持 2GB 总缓存，单张图片最大 10MB

---

## 缓存配置

### 封面缓存
```typescript
最大缓存数量: 500 张
总缓存大小: 2 GB
单张图片限制: 10 MB
缓存有效期: 30 天
清理策略: LRU（最少使用优先清理）
```

### 歌单缓存
```typescript
缓存有效期: 1 小时（自动刷新）
清理触发: 用户操作后立即失效
支持的操作:
  - 红心/取消红心
  - 添加歌曲到歌单
  - 从歌单删除歌曲
```

---

## API 使用指南

### 封面缓存（自动）

封面缓存完全自动化，使用 `CachedImage` 组件即可：

```tsx
import CachedImage from './components/CachedImage'

<CachedImage
  src={song.coverUrl}
  alt="Album Cover"
  className="w-96 h-96 object-cover"
  fallback={<img src={defaultCover} alt="No Cover" />}
/>
```

**特性**：
- 自动从 IndexedDB 读取缓存
- 没有缓存时通过代理服务器获取
- 自动缓存到 IndexedDB
- 切换图片时无闪烁

### 歌单缓存

#### 获取用户歌单列表

```typescript
import { getUserPlaylists } from './services/playlistService'

// 自动使用缓存（1小时内）
const playlists = await getUserPlaylists(userId, 'netease')

// 强制刷新
const playlists = await getUserPlaylists(userId, 'netease', { forceRefresh: true })
```

#### 获取歌单详情

```typescript
import { getPlaylistDetail } from './services/playlistService'

// 自动使用缓存
const playlist = await getPlaylistDetail(playlistId, 'netease')

// 强制刷新
const playlist = await getPlaylistDetail(playlistId, 'netease', { forceRefresh: true })
```

#### 获取我喜欢的音乐

```typescript
import { getLikedSongs } from './services/playlistService'

// 自动使用缓存
const liked = await getLikedSongs(userId, 'netease')

// 强制刷新
const liked = await getLikedSongs(userId, 'netease', { forceRefresh: true })
```

### 红心功能（新）

```typescript
import { likeSong } from './services/playlistService'

// 喜欢歌曲
await likeSong(songId, userId, 'netease', true)
// 自动使"我喜欢的音乐"缓存失效，下次获取时会刷新

// 取消喜欢
await likeSong(songId, userId, 'netease', false)
```

### 歌单操作（新）

#### 添加歌曲到歌单

```typescript
import { addSongToPlaylist } from './services/playlistService'

await addSongToPlaylist(playlistId, songId, userId, 'netease')
// 自动使该歌单的缓存失效，下次获取时会刷新
```

#### 从歌单删除歌曲

```typescript
import { removeSongFromPlaylist } from './services/playlistService'

await removeSongFromPlaylist(playlistId, songId, userId, 'netease')
// 自动使该歌单的缓存失效
```

### 手动刷新

```typescript
import { refreshPlaylist, refreshLikedSongs } from './services/playlistService'

// 刷新特定歌单
await refreshPlaylist(playlistId, 'netease')

// 刷新我喜欢的音乐
await refreshLikedSongs(userId, 'netease')
```

---

## 缓存管理

### 查看缓存统计

```typescript
import { indexedDBCache } from './services/indexedDBCache'

const stats = await indexedDBCache.getCacheStats()
console.log('封面数量:', stats.coverCount)
console.log('封面大小:', indexedDBCache.formatSize(stats.coverSize))
console.log('歌单数量:', stats.playlistCount)
```

### 清理缓存

```typescript
import { indexedDBCache } from './services/indexedDBCache'

// 清除所有封面缓存
await indexedDBCache.clearCovers()

// 清除所有歌单缓存
await indexedDBCache.clearPlaylists()

// 清除所有缓存
await indexedDBCache.clearAll()
```

---

## 缓存策略详解

### 封面缓存策略

1. **加载流程**
   ```
   1. 检查 IndexedDB 缓存
   2. 有缓存 → 立即显示
   3. 无缓存 → 通过代理获取 → 缓存 → 显示
   ```

2. **LRU 清理**
   - 缓存达到 500 张或 2GB 时触发
   - 清理最少使用的 50 张（或 10%）
   - 考虑访问次数和最后访问时间

3. **过期策略**
   - 缓存有效期：30 天
   - 访问时自动检查，过期则删除并重新获取

### 歌单缓存策略

1. **缓存时机**
   ```
   获取歌单时自动缓存
   有效期：1 小时
   ```

2. **自动失效**
   ```
   用户操作后立即失效：
   - 红心/取消红心 → 失效"我喜欢的音乐"
   - 添加/删除歌曲 → 失效对应歌单
   ```

3. **实时同步**
   ```
   在音乐平台操作 → 本软件下次获取时自动刷新（1小时后）
   在本软件操作 → 立即失效缓存 → 下次获取时实时同步
   ```

---

## 性能优化

### 1. 竞态条件防护
使用 `currentLoadingUrlRef` 跟踪当前请求，避免旧请求覆盖新请求。

### 2. 双缓冲显示
切换封面时保持旧图片显示，新图片加载完成后再切换，避免闪烁。

### 3. 异步缓存
图片获取后立即显示，缓存操作异步进行，不阻塞 UI。

### 4. 智能预加载（未来）
可以实现：
- 预加载播放列表中下一首的封面
- 预加载当前歌单的所有封面（后台任务）

---

## 故障排查

### 封面不显示
1. 检查代理服务器是否运行（localhost:3001）
2. 检查浏览器控制台是否有 CORS 错误
3. 检查图片 URL 是否有效
4. 尝试清除缓存：`indexedDBCache.clearCovers()`

### 歌单不刷新
1. 检查缓存是否已过期（1小时）
2. 使用 `forceRefresh: true` 强制刷新
3. 检查网络请求是否成功

### IndexedDB 错误
1. 检查浏览器是否支持 IndexedDB
2. 检查是否在隐私/无痕模式（可能禁用）
3. 清除浏览器数据后重试

---

## 未来计划

### 即将实现
- [ ] 红心功能 UI（收藏按钮）
- [ ] 添加到歌单功能 UI
- [ ] 缓存管理界面（查看/清理）
- [ ] 歌单刷新按钮

### 性能优化
- [ ] 封面预加载
- [ ] 歌词缓存
- [ ] 离线播放支持

### 高级功能
- [ ] 缓存导出/导入
- [ ] 多设备同步
- [ ] 智能缓存建议（最常听的歌曲优先缓存）

---

## 技术细节

### IndexedDB 结构

```
数据库: WaveForgeCache
版本: 1

存储对象:
1. covers (封面缓存)
   - keyPath: url
   - 索引: lastAccess, timestamp
   
2. playlists (歌单缓存)
   - keyPath: id
   - 索引: platform, timestamp
   
3. metadata (元数据)
   - keyPath: key
```

### 数据结构

```typescript
// 封面缓存项
interface CoverCacheItem {
  url: string          // 图片 URL（主键）
  data: Blob           // 图片数据
  timestamp: number    // 缓存时间
  size: number         // 文件大小
  accessCount: number  // 访问次数
  lastAccess: number   // 最后访问时间
}

// 歌单缓存项
interface PlaylistCacheItem {
  id: string                        // 歌单 ID（主键）
  platform: 'netease' | 'qq'       // 平台
  data: any                        // 歌单数据
  timestamp: number                // 缓存时间
  version: number                  // 版本号
  etag?: string                    // ETag（未来用于服务器验证）
}
```

---

## 贡献

欢迎提交 Issue 和 PR！

如有问题，请在 GitHub 上提交 Issue。

# 最近播放功能检查点（2026-08-11）

项目：`D:\opencode\WaveForge(3)`

## 本轮需求完成情况

1. 简约模式右栏的最近播放已经移动到平台切换按钮下方、头像上方。
2. QQ 音乐与网易云音乐的“已播歌曲”摘要封面改为前 4 首歌曲封面的 2×2 四宫格。
3. 摘要显示“已播歌曲”和平台记录总数，点击进入个人中心的“最近播放”页。
4. 设置 → 账号中的登录说明已改为：
   - 网易云音乐：`使用手机扫码登录`
   - QQ 音乐：`使用网页扫码登录`
5. 设置 → 账号新增“隐藏主页账号ID信息”开关：
   - 开启后隐藏简约模式个人信息中的 `QQ号：`。
   - 开启后隐藏简约模式个人信息中的 `网易云ID：`。
   - 设置写入 `localStorage.hideHomeAccountId`，并通过事件即时刷新主页。
6. 最近播放页已删除：
   - `来自当前平台账号的同步记录，不使用本地播放历史`
   - `QQ 音乐平台同步的歌曲最近播放`
7. WaveForge 播放歌曲达到有效播放阈值后，会向歌曲所属平台上报云端最近播放。

## 简约模式已播歌曲摘要

文件：`src/components/HomeView.tsx`

- 登录当前平台后读取平台云端歌曲最近播放。
- QQ 音乐读取：

```text
GET /api/qq/record/recent/song
```

- 网易云音乐读取：

```text
GET /api/netease/record/recent/song
```

- 不使用 WaveForge 本地播放历史作为回退。
- 使用前 4 条有效歌曲封面组成 2×2 四宫格。
- QQ 使用后端返回的 `total`；网易云优先使用平台返回的 `data.total`。
- 收到 `waveforge-recent-playback-reported` 事件后自动刷新摘要。

## WaveForge 播放后同步云端

文件：`src/App.tsx`

上报条件：

- 歌曲正在播放。
- 已达到有效播放阈值。
- 同一播放会话尚未成功上报。
- 当前歌曲所属平台已登录。

阈值规则：

```text
最长 30 秒；通常至少播放 10 秒或歌曲时长的 10%；极短歌曲会在结束前上报。
```

可靠性处理：

- 上报失败不影响正常播放。
- 单次播放会话最多尝试 2 次。
- 失败后间隔 15 秒再重试。
- 单曲循环或重新从头播放时会建立新的上报会话。
- 成功后发送 `waveforge-recent-playback-reported`，供主页摘要刷新。

## 网易云云端上报

文件：`local-server.mjs`

路由：

```text
POST /api/netease/record/recent/report
```

使用 `@neteasecloudmusicapienhanced/api` 的：

```js
NeteaseAPI.scrobble({ id, sourceid, time, cookie })
```

依赖实现会提交网易云 `startplay` 和 `play` 日志，使歌曲进入平台最近播放并更新播放统计。

## QQ 音乐云端上报

文件：`local-server.mjs`

路由：

```text
POST /api/qq/record/recent/report
```

MusicU 协议：

```text
module: music.musicasset.PlayRecentlyWrite
method: ReportPlayRecentlyInfo
```

参数：

```js
{
  data: [{
    id: String(songId),
    type: 2,
    lastTime: Math.floor(Date.now() / 1000),
    listenCnt: 1
  }]
}
```

重要结论：

- 写入参数字段虽然叫 `id`，但必须传 QQ 音乐的数值歌曲 ID。
- 传歌曲 MID 时接口会返回成功码，但不会改变云端最近播放顺序。
- 传数值歌曲 ID 后，已验证目标歌曲会移动到 QQ 云端最近播放首位。
- 因此前端现在发送 `currentSong.id`，后端也强制校验为纯数字 ID，避免“假成功”。

## 脱敏真实账号验证

验证过程中没有输出或保留 Cookie、账号 ID、歌曲 ID/MID、令牌、OpenID、GUID/QIMEI 或完整平台响应。测试只复用了账号最近播放中已经存在的歌曲。

### 网易云音乐

- 最近播放读取 HTTP：200。
- 云端上报 HTTP：200。
- `synced: true`。
- 使用已有第二条记录测试后，该歌曲移动到云端最近播放首位。

### QQ 音乐

- 最近播放读取 HTTP：200。
- 云端上报 HTTP：200。
- `synced: true`。
- 使用已有第二条记录和数值歌曲 ID 测试后，该歌曲移动到云端最近播放首位。

因此两个平台的“WaveForge 播放后同步平台最近播放”均已完成真实云端验证。

## 构建验证

2026-08-11 已通过：

```powershell
node --check local-server.mjs
npm run lint
npm run build
```

生产构建成功。仅保留项目原有的 CSS 非标准属性和大 chunk 警告，没有 TypeScript、esbuild 或构建错误。

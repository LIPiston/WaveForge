# WaveForge 会话总结（2026-08-14 · 浅色模式完整实现会话）

> 本文件记录 **浅色模式（light theme）完整实现会话** 的全部变动与文件清单，供合并操作参考。
> 起始基线：`8940204`（Merge remote-tracking branch 'origin/master'）。
> **推送状态：本会话未 push。** 工作区含本会话与并行会话（遥控器/SongDetail 等）两边的全部未提交改动，由并行会话统一 commit + push（见文末「合并说明」）。

---

## 一、会话概览

| 项目 | 说明 |
|---|---|
| 起始基线 | `8940204`（origin/master） |
| 本轮成果 | 浅色模式在 播放页/简约模式/探索模式 全表面落地（桌面模式不生效）；设置-个性化新增深浅色开关；多处浅色不可读修复；2 个交互 bug 修复 |
| 设计原则 | 浅色 = 淡白半透明玻璃 + 深色文字，「可读又不白得刺眼」；深色主题全部现有样式原样保留（三元分支） |
| 技术抓手 | App 将主题同步到 `<html data-wf-theme>`；首页玻璃/探索模式 token 用 index.css 集中覆写；其余组件沿用 `playerTheme === 'dark' ? … : …` 既有模式 |
| 验证 | `npx tsc --noEmit` 0 错误；浏览器实测截图确认：首页浅色（含真实数据）、设置页（新开关可用）、搜索面板、播放页（标题/控件/歌词）均可读 |

---

## 二、功能与修复清单

### 2.1 主题开关
- **设置 → 个性化** 新增「外观主题」卡片（深色/浅色按钮），与播放页 QuickSettings 共用 `localStorage.playerTheme` + `playerThemeChanged` 事件，App 统一监听更新。
- 开关作用于播放页、简约模式、探索模式；桌面模式不受影响。

### 2.2 交互 bug 修复
| Bug | 根因 | 修复 |
|---|---|---|
| 「即将播放」提示弹出前先把设置/个人/搜索面板关掉 | App.tsx 音频回调里有「弹出前 1 秒关闭所有弹窗」逻辑 | 删除该逻辑，提示只淡出自身，不再动用户打开的面板 |
| 首页自定义 →「调整卡片模糊度」点击后不呼出 BlurAdjustModal | App 关闭设置时整个 SettingsPanel 卸载，把 HomeCustomizeModal 内待弹出的 BlurAdjustModal 一起销毁 | SettingsPanel 改为**保持挂载**（`show={showSettings}` 内部控制显隐），子弹窗链路存活 |

### 2.3 浅色可读性修复（对应用户截图反馈）
- **设置页**：账号行（LoginButton 硬编码白字）→ 主题感知；开关**黑圆点** → 统一白圆点+阴影（与其他页一致）；卡片 hover、面板遮罩浅色化。
- **搜索界面**：根背景/子面板（历史、建议）由硬编码近黑 → 淡白玻璃；边框/滚动条/平台切换按钮/占位符全部浅色化；遮罩改淡白。
- **歌单/歌单详情弹层**：遮罩由淡灰/深灰 → 淡白半透明；行卡片、文字、空态深色化。
- **播放页**：白雾遮罩密度下调（blur 0.55/0.45/0.6 → 0.42/0.32/0.46；沉浸 0.4/0.65/0.5 → 0.3/0.52/0.4），不再「过白」；**两处**标题/艺术家块（纯音乐 text-4xl 块 + 现代布局 text-3xl 块）与沉浸左上标题改深色字；**循环/随机/顺序按钮**图标主题感知；歌词显示样式面板、沉浸翻译/罗马音文字浅色化；**逐字歌词**（激活/未激活/翻译/罗马音/文字阴影）经 LyricsDisplay 新增 `playerTheme` prop 适配。
- **简约首页**：默认背景改淡彩渐变、5 个光晕浅色降透明、壁纸遮罩黑→白；三栏玻璃面经 CSS 改淡白；栏目文字/歌曲行/歌单卡/个人信息/空态/平台切换全部深色化；顶栏模式触发 chip 浅色化。
- **探索模式**：根背景与装饰渐变浅色化；60+ 白 alpha token（text/bg/border/hover）经 index.css 以 `:root[data-wf-theme='light'] .explore-view-root …` 集中映射为黑 alpha；封面上的深色小标签反转为淡白底+深字。
- **模式选择面板**（顶部下拉）：面板背景/边框/设置按钮/自定义 popover/收起按钮浅色化；模式卡片为模式预览，保持深色设计。
- **即将播放提示**：新增浅色设计（白玻璃 + 深色文字 + 浅阴影）。

---

## 三、变动文件清单（本会话）

| 文件 | 变动内容 |
|---|---|
| `src/App.tsx` | ① 删除「播放提示弹出前关闭所有弹窗」逻辑及其 deps；② SettingsPanel 保持挂载（`show: showSettings`）；③ `useEffect` 同步 `document.documentElement.dataset.wfTheme`；④ 播放页浅色白雾遮罩降密度、沉浸附加光效主题感知；⑤ 两处歌曲标题/艺术家块 + 沉浸左上标题改深色字；⑥ 歌词显示样式面板（顶部下拉）浅色适配；⑦ 向 UpNextNotification / PlaylistPanel / LyricsDisplay(×2) 传 `playerTheme` |
| `src/index.css` | ① 浅色下 home 玻璃面（`home-glass-panel-surface` / `home-recent-card-glass` / `home-bottom-pill-glass` / `home-playlist-card-glass` / 滚动条 / `profile-glass-panel-surface`）淡白覆写；② 探索模式 `.explore-view-root` 下 60+ token 集中浅色映射（含 hover） |
| `src/components/SettingsPanel.tsx` | 个性化新增「外观主题」开关卡片；开关圆点 `after:bg-black` → 白圆点+阴影（×7 处）；卡片 hover 用 `hoverBg`；遮罩 `bg-black/60` → 浅色 `bg-white/40`；LoginButton 传 `playerTheme`；新增 `handlePlayerThemeChange` |
| `src/components/LoginButton.tsx` | 新增 `playerTheme` prop；已登录胶囊（背景/用户名/登出图标）浅色化 |
| `src/components/UpNextNotification.tsx` | 新增 `playerTheme` prop；浅色：白玻璃背景、淡边框、浅阴影、深色文字、封面背景降透明 |
| `src/components/PlayerControls.tsx` | 循环/随机/顺序图标（×2 处块）主题感知；沉浸翻译/罗马音文字浅色化 |
| `src/components/SearchPanel.tsx` | 根遮罩/主背景/光泽/边框、历史与建议子面板背景边框、滚动条、平台切换按钮、融合提示条、关闭按钮、输入框占位符与 focus 边框 全部浅色化 |
| `src/components/PlaylistPanel.tsx` | 新增 `playerTheme` prop（`isDark`）；遮罩、面板背景/边框/阴影、头部、智能重排/关闭按钮、空态、行卡片（背景/边框/序号/封面/标题/艺人/播放图标）、ScrollToCurrentSong/ScrollToTop 传主题 |
| `src/components/PlaylistDetailPanel.tsx` | 遮罩、容器边框/阴影、液态玻璃遮罩与默认背景、封面 blur brightness、头部/详情按钮/滚动条/加载/空态/行（序号/封面/歌名/艺人/专辑/时长/hover）浅色化 |
| `src/components/HomeView.tsx` | 壁纸遮罩黑→白；默认渐变背景浅色组；5 光晕 `opacity` 浅色 0.45；顶部 chip 与箭头；三栏头部边框/刷新/创建按钮；模块 tab；歌曲行/歌单行/歌单网格卡/个人信息/平台切换/已播卡片/空态/退出登录 全部浅色化；PlaylistDetailPanel 传 `playerTheme` |
| `src/components/ExploreView.tsx` | 根加 `explore-view-root` 类；装饰渐变浅色组；PlaylistDetailPanel 传 `playerTheme` |
| `src/components/ModeSelectionPanel.tsx` | 自读 `playerTheme`（localStorage + 事件）；面板背景/边框/阴影、设置按钮、自定义 popover、收起按钮浅色化 |
| `src/components/LyricsDisplay.tsx` | 新增 `playerTheme` prop；`activeLyricColor`/`inactiveLyricColor` 常量；逐字填充色（×6）、soft/clear 两套 effectConfig（inactiveColor/三种 textShadow）、主行/翻译/罗马音 className 浅色化 |
| `src/components/FullScreenPlayer.tsx` | 标题/艺术家浅色改深色字 |

> 说明：`PlaylistDetailPanel.tsx` 的背景/遮罩部分由本会话派生的子代理完成、文字部分由本会话补完，均在本会话范围内。

---

## 四、合并说明（给执行 push 的会话 / 合并人）

1. 本会话**未 push**；工作区当前 = 本会话浅色改动 + 并行会话改动（遥控器、SongDetailModal、viewMode `applyMode` 重构、desktop 控制修复等）的合并态，`npx tsc --noEmit` 通过（exit 0）。
2. 由并行会话执行 `git add -A && git commit && git push origin master`（若 origin 有新提交先 `git pull --rebase`）。
3. 仓库存在 dangling 提交 `92d8b49`（本会话曾提交后 reset 的快照），**忽略即可**，工作区比它更新更全。
4. 请并行会话 likewise 新增 `SESSION_SUMMARY(4).md`，记录其本轮变动与文件清单（遥控器服务端/客户端、SongDetailModal、applyMode、desktop/* 等），与本文件一起提交，便于合并人对照。
5. 两会话曾短暂并行写文件：并行会话后续对 `App.tsx` 的重写已自然包含被本会话临时剥离的遥控器接线，无需额外恢复；提交前再跑一次 tsc 确认。

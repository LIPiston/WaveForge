# WaveForge 会话总结（2026-08-14 · v0.1.0 发布后）

> 本文件记录 **v0.1.0 发布（git push 至 `144bbf5`）之后** 的完整工作：并行子代理收尾、构建与自动化测试、版本机制、gapless 模块化、UpNext 弹窗修复。
> 对应 git 提交：`d9b720b` → `6eada58`（11 个）+ 后续 UpNext 修复，均在本次会话内完成。

---

## 一、会话概览

| 项目 | 说明 |
|---|---|
| 起始基线 | v0.1.0 已发布（GitHub Release `v0.1.0`，NSIS 安装版），远程 HEAD `144bbf5` |
| 本轮成果 | 11 个提交：测试套件、死代码清理、声道统一、缓存 key、chunk 优化、版本机制、EPIPE 防护、gapless 模块化 |
| 遗留修复 | UpNext「即将播放下一首」弹窗在 gapless 模式不显示（App.tsx eventTime 兜底） |
| 验证 | `npm run lint` 0 报错、`npm run test` 111/111、`npm run build` 无告警、便携版冒烟启动 + 后端双端口健康 |

---

## 二、并行子代理收尾（6 个未决事项，提交 d9b720b → 6abc497）

| 事项（HANDOVER §5） | 结果 | 提交 |
|---|---|---|
| 测试覆盖（#6） | ✅ vitest 套件：10 文件 / 111 用例（PlaybackQueue、transitionPlanner、playbackTimeStore、albumGapless、utils 纯函数），未改生产代码 | d9b720b |
| cuefield 死代码（#2） | ✅ 删 3 文件（cuefieldAutoMix / cuefieldTimelineExecutor / cuefieldApi）+ gaplessIntegration 约 400 行不可达代码；三方案分流与 albumGapless 完整保留 | b655e89 |
| render_worker 声道（#4） | ✅ 统一立体声：server 去 mono 折叠 + 修复 librosa 帧布局 bug；desktop 补 mono→stereo 上采样；19 项音频冒烟断言全过 | 9376646 |
| TransitionRenderer 缓存 key（#3） | ✅ plan.id 加入实际裁决策略/起止时长/rendererVersion（RENDERER_VERSION 常量） | c3814d5 |
| CHUNK 体积（#5） | ✅ locationHierarchy 8.8MB → 752KB（city.json 按国家拆分 + 动态 import），build 无告警；壁纸前端改进（立即同步按钮/动态壁纸分类提示/UNC 容错） | 36728dc |
| 文档收尾 | ✅ HANDOVER 标记 5/6 完成、license 门控撤销记录、PROJECT_HISTORY Phase2 标注已实施、CHECKLIST 对齐 React 19 | 6abc497 |

> **license 门控（#1）撤销**：曾尝试"激活后拦截未授权播放"，会**限制现有功能**（激活解锁的新功能还没做），按用户指示整体回退。正确方向是"激活解锁新功能"而非限制已有功能。

---

## 三、构建与自动化测试（发现并修复 EPIPE 崩溃）

- 便携版多次构建 + CDP 调试端口自动测试：
  - 后端全链路通过：网易云/QQ 搜索、歌曲详情、播放 URL（320kbps）、歌词、热歌榜
  - 首页加载正常（每日推荐/歌单渲染）、调音室弹窗 + Tab 切换、全程 **0 控制台错误**
  - 启动日志时序正常：splash → 主窗，无加载失败
- **发现主进程崩溃**：`Uncaught Exception: EPIPE: broken pipe`（后台启动脚本取消时 stdout 管道关闭，console.log 写入崩溃）
  - **修复**（提交 6eada58）：`desktop/main.cjs` 对 stdout/stderr 的 `error` 事件捕获 EPIPE 静默吞掉
  - 正常 GUI 双击不受影响，属加固
- UI 交互自动化受本机软件合成（GPU disabled_software）+ CDP 限制，部分点击不稳定，如实标注

---

## 四、版本号更迭机制（提交 35d583c）

- 新增 `scripts/bump-version.mjs`：semver bump（patch/minor/major/pre/指定版本）+ 同步 package-lock + commit/tag/push + 发布指引
- npm scripts：`version:patch` / `version:minor` / `version:major` / `version:pre` / `version:dry`
- 安全防护：工作区有未提交改动默认拒绝（`--force` 绕过）、tag 已存在跳过、lock 版本不一致警告
- AGENTS.md 记录版本更迭流程（版本唯一事实来源 = package.json version，关于页显示 + "检查新版本"对比 GitHub tag）

---

## 五、Gapless 业务代码模块化（提交 5bb68cd + 1cd3e35）

**目标**：把深嵌在 `useAudioPlayer.ts`（1948 行）的 gapless 业务代码抽离为独立模块，hook 只留调用接口。

**新增 `src/services/gapless/`（413 行）**：
| 文件 | 职责 |
|---|---|
| `gaplessConstants.ts` | GaplessSettings 类型 + 全部 GAPLESS 常量（60ms 淡入淡出、预热窗口等） |
| `seamlessJoinController.ts` | **首选拼接控制器**（createSeamlessJoinController 依赖注入工厂）：预热缓存前 10s / 静音预启动 / ended 直接拼接 / 边界调度三方案分流 / 兜底回退 / 竞态互斥 |
| `gaplessTransition.ts` | 60ms 等功率双 deck 淡入淡出（runGaplessDeckFade） |

**useAudioPlayer.ts 改造**：1948 → 1694 行（gapless 内联逻辑净减 254 行）；删除 7 个 gapless refs + 预热/首选拼接/边界调度/60ms 全块；保留依赖注入（7 处）与事件接线（timeupdate/ended 各一行调用）。

**验证**：lint 0、test 111/111、build 成功、旧引用残留 0、便携版构建进包确认、冒烟启动 + 后端健康。

---

## 六、UpNext「即将播放下一首」弹窗修复（App.tsx，待提交）

**现象**：gapless 启用时切歌不弹"即将进入过渡/即将播放"通知。

**根因**：`src/App.tsx` 1167 行
```js
const eventTime = useTransitionCountdown ? transitionStartTime : duration
```
gapless/autoMix 启用时 `eventTime = transitionStartTime`，**无 fallback**；而 `transitionStartTime` 在 preparing-next、播放加载、取消等路径为 **null** → 下方 `eventTime !== null` 检查失败 → 弹窗永不显示。

**修复**：`eventTime = useTransitionCountdown ? (transitionStartTime ?? duration) : duration`（null 时回退歌曲剩余时长倒计时）。

**运行时验证（修复前）**：日志确认 gapless 三方案分流真实执行（`prepareGaplessTransition` → `跨专辑歌曲使用普通无缝边界切换` → `当前歌曲不使用专辑融合，使用普通 gapless`），但弹窗文案「即将进入过渡」未出现。

---

## 七、提交清单（本次会话，相对 v0.1.0 发布）

```
6eada58 fix(main): EPIPE 防护
35d583c feat: 版本号更迭机制
1cd3e35 docs: gapless 模块化记录
5bb68cd refactor(gapless): 无缝衔接业务模块化
6abc497 docs: 未决事项收尾
36728dc perf+feat: locationHierarchy 拆分 + 壁纸改进
c3814d5 fix(transition): plan.id 缓存 key
9376646 fix(render): 渲染 worker 声道统一立体声
b655e89 refactor: 清理 cuefield 死代码
d9b720b test: vitest 测试套件
+ 待提交：UpNext 弹窗修复（App.tsx）
```

---

## 八、验证汇总

| 项 | 结果 |
|---|---|
| `npm run lint` | 0 报错 |
| `npm run test` | 111/111 通过 |
| `npm run build` | 成功，无 chunk 告警 |
| 便携版构建 | 成功（含全部改动进包验证） |
| 冒烟启动 | splash/主窗正常、后端 3001/3002 健康、0 控制台错误 |
| Gapless 运行时 | 日志实证三方案分流被真实调用（跨专辑→60ms 淡入淡出） |

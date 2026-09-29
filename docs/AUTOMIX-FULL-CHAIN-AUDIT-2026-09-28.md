# AutoMix 全链路审计（2026-09-28）

审计对象：WaveForge 桌面端 AutoMix（Pro v2 / Enhanced lite·advanced·extreme / 回退交叉淡化 / gapless 相邻边）全链路：
准备（分析 → 规划 → QQ 时间轴 → 渲染 → 缓存 → armed）→ 触发 → 播放过渡缓冲 → handoff → 提交 → 动画/表现层 → 与其它功能的交互。

本文档只记录**有代码或运行时证据**的问题。严重度定义：
- **P0**：用户可感知的音频错误（双播/漏音/错位）或整屏视觉故障，且高频复现。
- **P1**：特定条件下可感知的音频/视觉错误，或状态机死路。
- **P2**：一致性、可维护性、可诊断性问题。

环境：用户在 `engine=enhanced`、`tier=extreme`、`intensity=strong`、`crossfade/gapless 关闭`、`maxDuration=12`、`mvBackground 开启`、`lyricDisplayMode=modern`、`volume=1` 下复现。

---

## 结论速览

共 **60 条主项**（P0 ×4、P1 ×26、P2 ×23，另有 P3 低危项若干）。第一轮（第一~六部分）覆盖链路一致性/竞态/动画/门控；**第二轮（第七部分）补充端到端实测、规划器与分析质量的音乐正确性、渲染后端内部实现、测试覆盖缺口**。四条 P0：

| 编号 | 一句话 | 用户感受 |
| --- | --- | --- |
| **P0-1** | 双 deck 会脱离 WebAudio 音频图（源节点无 JS 引用），而 `setDeckGain` 仍在改"没有作用"的 gain 并把 `element.volume` 强制成 1 | 过渡期/切歌听到两首歌同时响；可视化与 DG-LAB 采集无信号；只能靠暂停清掉（第二轮补充：脱钩不是每场必然发生，但该状态已在用户会话中实测到） |
| **P0-2** | 引擎拿到的曲目元数据没有 `mid/title/artist` ⇒ 云端档匹配必然失败（第二轮端到端实测：网易云曲目 100% `plan:qq-fallback` + `render:qq-fallback`） | lite/advanced/extreme 三档全部退化为 lite（设置的 extreme 从未生效，且降级不可见） |
| **P0-3** | 同专辑相邻曲 + AutoMix 开启时，专辑无缝与 AutoMix 双双失效 | 听专辑时每个交界都是硬切 + 整曲重载的静音缝 |
| **P0-4** | 同一组合连续失败 2 次后整场会话再无任何过渡；seek/暂停恰好会清掉最后的兜底计划（第二轮实测：30 秒试听片段必触发，且弹出误导性提示"疑似过期缓存或换源"） | 该组合从此硬切，且没有任何提示 |

第二轮新增里最该先修的两条：**调性检测旋转方向反了**（P1-21，一个字符，影响所有涉及移调的过渡）与 **folia 的 resume 与 v2 不一致**（P1-25，一行，Pro 默认后端在 handoff 处重播约半拍）。

---

## 第一部分：已确证问题（含运行中应用实测）

### P0-1　双 deck 与 WebAudio 图脱钩 ⇒ 所有 gain 淡化/静音全部失效（"下一首和当前曲一起响"的根因）

**症状族**：过渡期/切歌后听到"两首歌同时放"（用户历史反馈"第三首音乐叠加上去了"，见 `src/audio/TransitionRenderer.ts:896-900` 注释；本次反馈"第三个音乐和第二首在一起放"）；暂停再继续就消失。

**运行时证据**（对正在运行的应用做只读探针，脚本 `.tmp-probe-audio.mjs` / `.tmp-test-routing.mjs` / `.tmp-test-analyser-audible.mjs` / `.tmp-probe-nodes.mjs`）：

```
播放前：MediaElementAudioSourceNode: []            ← 一个都没有
        deck1(186.68s, 当前曲) vol=1 paused=true  routedToGraph=false
        deck2(120.08s, 预载下一首) vol=1 paused=true routedToGraph=false
        GainNode 0 ×2（standby 意图静音）、1 ×11
        引擎图（3×Analyser / ChannelSplitter / 14×Gain）位于 state=suspended 的 AudioContext
播放中（deck1 paused=false，ct 33.04→35.08）：MediaElementAudioSourceNode: []   ← 依然没有
还原后（pause + volume=1）：两个 deck paused=true vol=1
```

**追加验证（排除"静音导致读数不可信"的歧义）**：

- 正常音量（volume=1）播放 2 秒时读引擎 `AnalyserNode`：**主分析器与其中一个侧分析器均为 0**（`avg=0, max=0, timeDomain=0`），而同一批里有一个分析器读到真实信号（`avg≈86, timeDomain≈0.34`）——说明**读数方法有效**，引擎主通路确实没有 deck 信号。
- 全图节点枚举：`AudioNode` 共 47 个（含 3×Analyser、14×Gain、1×AudioWorklet"wl"、ChannelSplitter/Merger 等），**`MediaElementAudioSourceNode` = 0、`MediaStreamAudioSourceNode` = 0、`AudioBufferSourceNode` = 0、Oscillator/ConstantSource/ScriptProcessor = 0**：整个引擎图里没有任何"元素/流/缓冲"类的音源节点。
- 结论：deck 的音频**完全没有进入引擎音频图**，而引擎（`setDeckGain` 分支判断）仍以为在靠 gain 节点控音量。

**代码证据**：

| 位置 | 问题 |
| --- | --- |
| `src/hooks/useAudioPlayer.ts:504-505` | `context.createMediaElementSource(first).connect(firstGain).connect(master)`：**返回值（MediaElementAudioSourceNode）没有被任何地方保存**，JS 侧零引用 |
| `src/hooks/useAudioPlayer.ts:477-480` | `ensureAudioGraph` 只要 `audioContextRef.current` 非空就 `return`：节点一旦被 GC/失效，**本场会话永不重建** |
| `src/hooks/useAudioPlayer.ts:465-474` | `setDeckGain`：`if (gain && audioContextRef.current)` 成立时**强制 `audio.volume = 1`**，只调制 gain；音量兜底分支（else）永远走不到 |
| `src/hooks/useAudioPlayer.ts:1197-1209` | 渲染过渡期"源曲 deck 立即静音但保持播放"：**只靠 gain** 降到 0.0001 |
| `src/hooks/useAudioPlayer.ts:1256-1269` | overlap handoff：目标 deck `setDeckGain(...,0)` → `play()` → **只靠 gain** 线性升到 1 |
| `src/hooks/useAudioPlayer.ts:2620-2623` | 预载下一首：`standby.pause()` + `setDeckGain(standby, 0)`，同样只有 gain |
| `src/hooks/useAudioPlayer.ts:1563-1571` | 等功率交叉淡化：`setValueCurveAtTime` 全部打在 gain 上 |

**后果链**（以本次日志中的 1→2、2→3 为例，均为 Enhanced 云端降级到 lite：过渡段 = 源曲最后 12s，target_start=0，见 `desktop/workers/qq_automix.py:286-293`）：

1. 过渡缓冲（源曲尾 + **目标曲开头 12 秒**）在播；
2. 源曲 deck 同时**满音量**在播（本应被 gain 静音，实际无效）；
3. ⇒ 用户听到"当前曲 + 下一首开头"同时响 = "第三个音乐和第二首在一起放"；
4. 暂停会同时 pause 两个 deck（`src/hooks/useAudioPlayer.ts:3016-3022`）⇒"暂停再继续就没了"；
5. 因为 `ensureAudioGraph` 早退，这个状态在一次会话内固定 ⇒ **100% 复现**。

**修法**：
1. `ensureAudioGraph` 保存两个 source node（如 `mediaSourceRef = { primary, secondary }`），并在 `setDeckGain` 里维护"元素是否仍在图上"的显式判定；
2. `setDeckGain` 不再无条件 `audio.volume = 1`：未确认接入图时退化为 element volume 控制（`next * volumeRef`）；
3. 加一条启动/首次播放自检日志：source node 数量、deck 的 `volume`、gain 值，异常时重建音频图。

---

### P1-1　MV 背景在提交帧被重置透明度 ⇒ 过渡结束后"整屏刷新一下"

**位置**：`src/components/BilibiliMvBackground.tsx:464-486`（`transitionActive = Boolean(transitionToTrack?.trackKey)`；`slotOpacity`：staged 槽返回 `transitionProgress`）、`:798-838`（提交接管：先清旧槽，再 `beginCrossfade(staged)` 走 0.65s 淡入）；`src/App.tsx:2633-2650`（同一批次 `setIsTransitioning(false)` + `setTransitionProgress(0)` + 清 `transitionFrom/ToTrack`）、`:9101`（`transitionProgress={overlayProgress}`）。

**逐帧时序**（现有实现）：

| 帧 | 状态 | 画面 |
| --- | --- | --- |
| 过渡最后 4s | `overlayProgress` 0→1，`transitionActive=true` | 目标 MV 以 `transitionProgress` 叠在旧 MV 上渐入（设计如此） |
| 提交帧 | 同批：`transitionProgress=0`、`transitionToTrack=null` ⇒ `transitionActive=false`、staged 槽 opacity=`transitionProgress`=0 | **新 MV 瞬间消失，露出仍未清空的旧槽（z-index 1）⇒ 画面跳回上一首的 MV** |
| 提交后 effect 帧 | 清旧槽 + `beginCrossfade(staged)`：incoming → opacity 1，CSS `opacity 0.65s ease` | 背景先空/透明，再从头 0.65s 淡入新 MV |

**后果**：过渡结束后整屏"闪一下 + 重新淡入"（用户："整个界面刷新了一下 没有在过渡段后直接不动 造成画面割裂感"）。

**修法**：提交时让 staged 槽**直接晋升**而不经过 0：新增 `transitionState === 'committed'` 之类的信号，或在 `slotOpacity` 中对"过渡刚结束的 staged 槽"保留 `Math.max(transitionProgress, …)`，或 `beginCrossfade` 增加"已就位直切"分支（`activeSlot = staged; incoming = null`，不跑淡入）。

---

### P1-2　提交帧整屏视觉跳变（配色 / 时间基 / 90% 预切换失效）

1. **主色调闪灰**：提交时封面 URL 变化 ⇒ `useColorThief` 把状态重置为 `loading`（`src/hooks/useColorThief.ts:218-247`）⇒ `playbackCoverColor` 退回 `PLAYBACK_NEUTRAL_COLOR`（`#6b7280`，`src/App.tsx:112/3781-3784`）⇒ 整个播放页配色（背景渐变/强调色/歌词高亮/控件）闪一下灰再跳到新色；同时 `transitionToAccentColor` 在同一帧被清空（`src/App.tsx:2646-2649`），过渡期淡入到的目标色也被丢弃。
   **修法**：新封面取色 ready 之前保留"过渡目标色 / 上一次 ready 的主色"，不要降到中性灰。
2. **进度条时间基切换**：`commitCurrentTime(commit.targetTime)`（`src/App.tsx:5083`）+ `setDuration`（5084）在同一帧把进度条从源曲时间轴（如 5:2x）跳到目标曲时间轴（如 0:12）。
3. **90% 视觉预切换从未生效**：`useAudioPlayer` 在进度 90% 发 `visualSwitchCommit`（1110-1127 / 1465-1477 / 1526-1533 / 1585-1592），App 也把它转发给 `commitPreparedSong`（`src/App.tsx:2628-2630`），但 `commitPreparedSong` 第一行就 `if (commit.isVisualSwitch) return`（`src/App.tsx:5059`）⇒ 标题/封面/歌词/队列高亮/配色全部堆到提交帧一次性切换。这与 `src/App.tsx:3802-3806`（`visualSwitchedToTarget`）和 `:10221` 注释所假设的"90% 已切到新曲、之后只需淡入"相反。
   **修法**：实现真正的"仅视觉提交"（更新视觉状态，不动时钟/queueRevision），或显式删掉这条死链路与相关注释，避免误判。

---

## 第二部分：Enhanced 三档链路

### P0-2　云端档身份字段丢失 ⇒ lite / advanced / extreme 三档永远退化为 lite（用户设置的 extreme 从未生效）

**证据链**：

1. `src/hooks/useAudioPlayer.ts:1856-1861`：Enhanced 分支把 `qqTrackRef(current)` / `qqTrackRef(next)` 交给 cue：
   ```ts
   plan.qq = { tier, source: qqTrackRef(current), target: qqTrackRef(next) }
   ```
   其中 `current/next` 来自 `currentMetadataRef.current` / `nextMetadataRef.current`，类型是 `DeckMetadata extends PreloadTrack`（`src/hooks/useAudioPlayer.ts:107-109`、`src/audio/types.ts:293-304`）。
2. `PreloadTrack` 只有 `url/trackKey/index/duration/albumId/albumCover/appleHls/onPreloadSettled`——**没有 `mid`、没有 `name/title`、没有 `artists`**；`qqTrackRef`（`src/hooks/useAudioPlayer.ts:59-73`）恰恰只从 `mid/songmid/songMid/name/artists/id` 取身份 ⇒ **返回空对象 `{}`**。
3. App 侧所有 6 个喂元数据的调用点都只传这些字段，没有任何一处带 `mid/title/artist`：
   `src/App.tsx:4685-4694`、`:4718-4725`、`:4754-4761`（preloadNext）、`:5470-5477`、`:5524-5530`、`:5568-5573`（loadAndPlay）。
4. 后端：`desktop/workers/render_worker.py:1602-1640`（cue）与 `:1568-1590`（render）都把 `params.sourceMid/sourceTitle/sourceArtist` 塞进 `source_meta`，并且**两跳都是 `allow_saved_cookie=False`（一致，无分叉）**；`desktop/workers/qq_automix.py:168-200` 的 `resolve_track_mid`：`mid` 为空 → 看 `title`，`title` 为空 → **直接 return None**。
5. 于是 `plan_cue`（`qq_automix.py:376-433`）抛 `CloudUnavailable('未能在 QQ 音乐匹配到：前曲、后曲')` → `except` 分支返回 lite 时间轴（`_lite_timing`：`transition_start_s = src_len - 12`、`target_start_s = 0`）。
6. 与用户日志完全一致：本次会话**每一对曲目**都打印 `[plan:qq-fallback] tier=extreme -> lite reason=未能在 QQ 音乐匹配到：前曲、后曲`。

**后果**：
- advanced / extreme 的云端 MixPlan、真实切点（OutCue/InCue）、官方效果链、`qqTechniques` 手法清单**全部拿不到**；实际听感永远是本地 lite DSP（WSOLA 同步 + 低音交换 + 扫频 + 等功率交叉）。
- 过渡窗口永远是"源曲最后 12s + 目标曲 0-12s"（`DEFAULT_WINDOW_S=12` 或 cue 入参），**用户的 minDuration/maxDuration 设置不参与**（cue 只收 `window` 且 App 未传）。
- 由于 lite 的 `target_start_s=0`，过渡缓冲**必然包含目标曲开头 12 秒**；叠加 P0-1（源曲 deck 未被真正静音）就得到用户听到的"第三首和第二首一起放"。
- 调试弹窗只按 `commit.strategy === 'smart-rendered-qq'` 显示"AutoMix Enhanced 智能混音"（`src/App.tsx:2682-2683`），而 `plan.fallbackReason` 在 QQ 路径为 `undefined` ⇒ **降级到 lite 对用户完全不可见**（`plan.qqAppliedTier` 只被写入、无处展示）。
- 附带：`qqAutomix` 的渲染缓存键 `_generateCacheKey` 含时间轴字段；由于应用用的永远是同一套 lite 时间轴，跨会话极易命中"历史 lite 产物"，掩盖了档位问题。

**修法（高收益、低风险）**：
1. 让引擎拿到完整曲目身份：在 `PreloadTrack` 增加 `mid?/title?/artists?`（或直接多传一个 `song` 引用），或在 App 侧 6 个调用点补 `mid: song.mid || song.songmid, title: song.name, artist: artists.join(' / ')`；
2. `prepareAutoMix` 组装 `plan.qq` 前做一次断言日志（mid/title 为空就打印告警），避免再次"静默全量降级"；
3. 把 `plan.qqAppliedTier` / `cue.fallback.reason` 透出到过渡调试弹窗与日志，让"实际档位"可见；
4. 把 `window`（以及 min/maxDuration）按用户设置传给 cue/render，而不是写死 12s。

### P1-9　cue 与 render 是两次独立取数，且 render 先吃磁盘缓存 ⇒ 触发时间轴与缓冲内容可分叉（我复核：键与命中路径已确认）

- `useAudioPlayer.ts:1879-1891` 先调 `qqAutomixCue` 拿时间轴 A 并写进 plan；`TransitionRenderer.ts:289-301` 再单独发起一次 `qqAutomix` 渲染（`render_worker.py:1535-1575` 的入参里**没有** cue 的 `transition_start_s/duration/target_start_s`）。
- 磁盘命中直接返回旧 meta、不重新决策：`render-runtime.cjs:522-533`。
- 缓存键（`render-runtime.cjs:505-520`，我已逐字段核对）：`sha1(tier | 源路径 | size:mtime | 目标路径 | size:mtime | trackSig)`，其中 `trackSig` = mid/标题/歌手/平台 id + **仅布尔级**登录标记 —— **不含 window、不含算法版本、不含"当时云端是否真的成功"、也不含 effectiveTier**。
- App 从不把渲染结果的时间轴写回触发/续播（`useAudioPlayer.ts:2009-2031` 只回填 `qqTechniques`，以及仅在 `v2.aiMix` 时的两个字段）。
- **分叉触发**（不需要云端结果漂移）：上一轮同 (tier, 文件, 登录态) 的渲染曾降级 lite（云端抖动/MIR 失败）→ 磁盘留下 `qq-<tier>-<hash>.wav`（meta.effectiveTier=lite）；本轮 cue 成功给出云端时间轴 A，render 命中旧产物 B=lite ⇒ 触发点用 A、缓冲内容是 B、交接后 `target.currentTime = plan.targetEndTime`（`TransitionRenderer.ts:979` → `useAudioPlayer.ts:1329`）跳到错误位置（跳段/回退重播），UI 进度与听到的内容不对应。
- 另外：P0-2 修好后，**用空身份渲染的历史 lite 产物仍会命中**（键不变）⇒ "修了也不生效，得先清缓存"。
- **修法**：把 cue 的时间轴作为唯一事实下传（`render_qq_automix` 增加时间轴入参并在 `_prepare_cloud` 后覆盖 `am` 的 OutCue/InCue/InDuration/OutDuration）；在 `TransitionRenderer.ts:569-583` 与 `useAudioPlayer.ts:2009-2031` 比较 A/B，超阈值（如 0.15s）按 B 重写 plan 四个时间字段并标记 `fallbackReason`；QQ 缓存键补 `window` + `ALGO_VERSION` + `effectiveTier`，命中时校验（复用 `:391-395` 的 cacheIdentityMatches 写法）。

### P1-10　cue 路径没做格式转换 ⇒ 源/目标含 m4a/aac/opus 时 Enhanced 整链被放弃（连 lite 也用不上）

渲染前会转码成 WAV（`TransitionRenderer.ts:369-372` 的 `ensureRenderableAudio`，注释明确"否则 Python 渲染/AI worker 每次都会失败"），而 cue 直接把 `audioDownload.prepare` 的原始路径交给 `plan_cue_file`（`useAudioPlayer.ts:1875-1879`），后者用 `sf.info`（`qq_automix.py:438-441`，libsndfile 不认 m4a/aac/opus）；下载缓存确实会产出这些扩展名（`audio-download.cjs:528-551`）。
**后果**：`plan_qq_automix` 返回 `{success:false}` → `useAudioPlayer.ts:1905-1922` 把 `plan.strategy` 整体改回 `smart-rendered-v2` → 用户选了 Enhanced（哪怕是纯本地 lite）却得到 Pro 渲染，且只有 verbose 日志可见原因。
**修法**：cue 前对两个路径复用同一个 `ensureRenderableAudio`（或让 `plan_qq_automix` 内部做同样预处理）。

### P1-11　PCM 缓存 TTL/逐出后不是"复用磁盘产物"，而是直接降级固定交叉淡化（目标续播点退回 targetStartTime）

- `getRendered`（`TransitionRenderer.ts:841-848`）过期即删条目并返回 null；调用点 `useAudioPlayer.ts:1044` 拿不到就整段走 fixed-crossfade（`:1365-1384`）—— **因此 `playTransition` 内部的 `rehydrateRendered`（`:881-887`）实际不可达**（只有"getRendered 刚命中、条目又在微秒级内消失"才可能进入；两位独立审计对此有分歧，我复核后以本结论为准）。
- 磁盘 WAV 复用形同虚设：TTL=5min（`:80`），准备发生在曲目开始（`useAudioPlayer.ts:2533-2543`），触发在 `plan.sourceStartTime`（lite = 曲尾前 12s）⇒ **源曲时长 > 312s 或中途暂停累计 > 5min 必然降级**。
- 降级后果比"没有智能过渡"更糟：目标曲续播点退回 `plan.targetStartTime`（`useAudioPlayer.ts:1022`），**lite 为 0 ⇒ "过渡完成回到第二首开头"**（正是代码注释里明确要避免的听感）。
- 可观测性：该降级分支连 `fallbackReason` 都不写（`useAudioPlayer.ts:1365-1371`）。
- **修法**：把 `getRendered` 换成 `await ensureRendered(planId)`（内存 → `rehydrateRendered` → null）；降级分支补日志与 reason；必要时把 TTL 与源曲时长关联。

### P1-12　展示档位 ≠ 实际档位：面板/手法清单/渲染器标签来源三处不同，渲染降级原因不传播

- 面板档位取自 cue 的 `plan.qqAppliedTier`（`useAudioPlayer.ts:1900`）；手法清单取自 render（`:2016-2019`）；`rendererVersion` 在 `:1863` 按**请求**档位写死为 `qq-automix-${tier}-r1`，`:2011-2014` 用 renderedPlan 覆盖时仍是该值（`TransitionRenderer.ts:666-680` 没取 worker 返回的 `result.rendererVersion`）⇒ worker 真实版本被丢弃。
- 渲染侧 `fallbackReason`（含"extreme → lite"）只写在 renderPlan 上（`TransitionRenderer.ts:582`），hook 从不回填；`cue.fallback.reason` 只进 verbose 日志与 runtime 日志；切歌 toast 完全不带档位（`App.tsx:2682-2683`）。
- **后果**：面板可能显示"Enhanced(extreme)"+ Lite 手法 + `qq-automix-extreme-r1`，用户以为在用云端档。
- **修法**：`:2009-2031` 同时回填 `qqAppliedTier/fallbackReason/rendererVersion`（render 侧改为 `rendererVersion: result.rendererVersion ?? renderPlan.rendererVersion`）；toast/调试弹窗带上实际档位与降级原因。

### P2-5　QQ 整链失败后的"回退 v2 DSP"实际派发到 v1 渲染器

`TransitionRenderer.ts:559-562` 用 `buildDspFallbackPlan`（`rendererVersion='automix-v2-dsp-r1'`）但**不改 strategy**（仍是 `smart-rendered-qq`）；`render-runtime.cjs:435-437` 按 strategy 派发 ⇒ 走 v1 `render`（且缓存键退化为 v1 字段集，缺 v2 的 gainCurve/gainOffsetDb）。
**后果**：渲染器标签与实际实现不符（调试与 RCA 误导）；v1 不含 v2 的分轨/编排。
**修法**：`buildDspFallbackPlan` 补 `strategy: 'smart-rendered-v2'`，或让 `render-runtime.cjs:435-437` 对 `smart-rendered-qq` 也派发 `render_v2`。

### P2-6　lite 的手法文案与实现不符（声称变速对齐 BPM，实际零变速）；extreme→advanced 这级降级并不存在

- `qq_automix.py:265-270` 的 `LITE_TECHNIQUES[0]` 写"WSOLA 变速对齐源曲 BPM"，`_render_lite`（`:304-310`）还取了 `wsola_sync` 引擎，但 `recipes.py:35-53` 的 `tempo_matched_windows` 从不使用 engine，meta 恒为 `stretch_factor:1.0`（注释自陈"官方无变速"）。设置页文案同源（`autoMixTiers.ts:63`）。
- 三档降级只有 `tier → lite`（`qq_automix.py:368-373、426-433`），没有 extreme→advanced 这一级（设置页文案与用户预期需要澄清）。

### 已核对但不构成问题（第二/三部分）

- cue 与 render 的 **tier 白名单校验一致**、`allow_saved_cookie` 都是 False、`window` 都是 12.0 默认值（不存在"一个登录一个未登录"或"窗口不同"的固有分叉）。
- `plan.id` 的 `-qq-${tier}` 后缀在 `preRender` 之前拼好，`preRender/getRendered/getRenderedPlan/playTransition` 四处用同一个 id；`backendForPlan` 在 PCM 命中判定里比较档位（可自愈"档位回退导致的缓存语义变化"）。
- `renderCrossfade` 的"源窗按比例拉伸"（`TransitionRenderer.ts:729-763`）QQ 档从不走，故与档位一致性无关。
- `_generateCacheKey`（v1/v2 用）不含 tier 不是缺陷：QQ 产物走自己的键，且 v1/v2 键含四个窗口时间 + rendererVersion。

## 第三部分：过渡执行期竞态与资源收尾

> 本部分由独立审计产出一份清单，**每条我都回到源码复核过**；对其中一条的后果描述做了修正（标注"审计修正"）。

### P1-3　非 overlap handoff 在 `await waitForSeek/waitForPlayable` 之后没有任何 revision/状态复查

`src/hooks/useAudioPlayer.ts:1326-1351`：异步续体只在入口（`:1316`）复查一次 revision；之后 `target.currentTime=…` → `await waitForSeek(target,400)` → `await waitForPlayable(target,3000)` → **`setDeckGain(getStandbyGain(), target, 1)`（1334）→ `await target.play()`（1335）** 期间无任何复查。同函数的 overlap 分支（`:1255`）与 `startDeckEarly`（`:1245/1255`）都有复查，唯独这条最关键的路径没有。
**触发**：缓冲 ended（或兜底 timer）后的 0.4s–3.4s 窗口内发生暂停 / seek / 切歌 / 换设置 / 预载重跑 → 续体仍把 standby 拉满增益并起播。
**后果**：
- 暂停态下下一首以满增益开播，而 `handlePlay` 只认 active deck（`:2328`）→ UI 显示"暂停/当前曲 A"、实际在放 B；
- seek 后源曲（`cancelScheduledTransition:835` 把 active 增益恢复为 1）与下一首**同满增益齐奏**，且 `commitTransition`（`:884`）因 revision 失配被跳过 → 无人纠正，直到下次用户操作；
- 点一次"下一首"可能实际跳过两首。
**修法**：`1334` 之前插入 `if (!isExecutionCurrent() || transitionStateRef.current !== 'running-transition') return`；`1335` 之后再复查一次，失败则 `if (!target.paused) target.pause()` + `setDeckGain(getStandbyGain(), target, 0)`。

### P1-4　`startDeckEarly` 在 `play()` 前就置 `deckStarted=true` ⇒ 可能"永久静音但状态为播放中"

`src/hooks/useAudioPlayer.ts:1238-1241` 在任何 await 之前就 `deckStarted = true`；handoff 的 overlap 分支（`:1317-1324`）据此只做 `playbackRate=1 + setDeckGain(...,1) + commitTransition(...)`，而 **`commitTransition` 全程不调用 `play()`**（`:877-980`）。
**触发**：deck 启动 timer（`:1354`，`remaining-overlap`）触发后余量小于 `waitForSeek(400)+waitForPlayable(3000)` 的实际耗时（流媒体目标未缓冲、主线程长阻塞）。DSP 路径 overlap=1.5s；`deckStart` 在 `speedRatio>1` 时落在预缓冲窗口之前（`:1224` vs `:1250`），需要重新拉流，最容易超时。
**后果**：缓冲播完后源曲已 pause/清 src、target 在 gain=1 但 paused、状态被置 `playing` → 永久静音 + 进度冻结 + UI 显示在播；需用户再操作一次才能恢复。
**修法**：`deckStarted = true` 移到 `:1260` 成功之后（前面用独立的 in-flight 标志防重入）；`:1317` 条件收紧为 `overlap > 0 && deckStarted && !target.paused`，否则回落到会 `play()` 的非 overlap 分支。

### P1-5　`playTransition` 的 await（缓存 rehydrate）期间被取消 ⇒ 源 deck 被静音且无人恢复

`src/hooks/useAudioPlayer.ts:1157-1210`：`await playTransition(...)` 内部可能 `await rehydrateRendered()`（fetch 多 MB WAV + `decodeAudioData`，`src/audio/TransitionRenderer.ts:881-886`）；返回后 `1197-1209` **直接**把源 deck 增益降到 0.0001 并置 `transitionBufferActiveRef=true`，没有复查。`cancelScheduledTransition` 的 `stopPlayback()`（`:824`）只能停"当时已存在"的 buffer source，停不掉之后才 `source.start()`（`TransitionRenderer.ts:973`）的那个。
**触发**：PCM 内存缓存被逐出（上限 5 条 / 64MB）或 TTL 过期（5 分钟）后的过渡期间暂停/seek/切歌。
**后果**：暂停或切歌后过渡缓冲仍满增益播放（AI 长混音可达 60s），播完后 handoff 因 revision 失配直接 return（`:1316`）→ 目标没有接管、源 deck 已被静音 → **无声但进度照走**，直到再次操作。
**修法**：`1157` 的 await 之后立即 `if (!isExecutionCurrent()) { transitionRendererRef.current?.stopPlayback(); return }`。

### P1-6　`transitionBufferActiveRef` 在 handoff 入口即清 ⇒ 源曲 `ended` 在 await 窗口内被当作"自然播完"，App 立刻整曲重载

`src/hooks/useAudioPlayer.ts:1307-1316`：`handoff()` 先 `transitionBufferActiveRef.current = false`（1310，注释说明这是为了"缓冲结束由 handoff 接管"），**之后**才查 revision。而 `handleEnded`（`:2394-2397`）正是靠这个标志忽略"源 deck 已播完"的 ended。
**触发（lite 档几乎必然）**：lite 的缓冲内容 = 源曲最后 12s，且缓冲因触发粒度（timeupdate 粒度 ≈0.3s）会**比源曲真实结尾早约 0.3s 结束** ⇒ handoff 续体在 await 时，源 deck 的 `ended` 到达，此时标志已清、`handoff` 尚未提交，`2417` 的 `running-transition && standby && !standby.paused` 也不成立（target 还没 play）→ 落到 `2441` 发 `idle + ended` ⇒ `App.tsx:2739` 走"整曲自然结束" → `handleNext()` 整曲重载（并 `cancelTransition(..., false)` 清 standby src）。
**后果**：过渡尾与"重载下一首"打架：可能听到下一首从 0 重新开始的碎片、`play()` 被拒后 `failed + ended:true` 再推进一次（跳曲）、或与 P0-1 叠加成"两段音乐错位"。
**修法**：新增 `handoffPendingRef`（handoff 入口 true，提交/失败后 false），`2394` 改为 `if (transitionBufferActiveRef.current || handoffPendingRef.current) return`；或把 `1310` 的清零移到提交成功处（`1321/1349`）。

### P1-7　引擎/档位切换不重准备：设置 effect 依赖与 preparationKey 都漏了 `engine` / `enhancedTier`

- `src/hooks/useAudioPlayer.ts:2554-2570`：依赖里有 `enabled/enableBeatMatching/skipSilence/minDuration/maxDuration/enhanced/intensity/aiMix`，**没有 `engine`、`enhancedTier`**；
- `src/hooks/useAudioPlayer.ts:1691-1703`：`preparationKey` 同样只有 `enhanced === true` 等，**没有 `engine`/`enhancedTier`**。

**后果**：当前边已 armed/正在过渡时切换引擎（standard↔pro↔enhanced）或 Enhanced 档位（lite↔advanced↔extreme），既不 cancel 也不重准备（即便再次进入 `prepareAutoMix`，`:1704` 的 key 相等也会 return）⇒ UI 显示已切换、实际仍播旧引擎/旧档位的产物（确定性不一致，非竞态）。
**修法**：两处都补 `autoMixSettings.engine`、`autoMixSettings.enhancedTier`。

### P1-8　`cancelScheduledTransition` 不重置 gaplessIntegration（albumGapless 外部预载 deck / masterGain）

`src/hooks/useAudioPlayer.ts:800-860` 全文没有 `gaplessIntegrationRef` 相关调用；恢复 `masterGain` 与释放预载 deck 只在 `gaplessIntegration.reset()`（`src/services/gaplessIntegration.ts:223-234`）。用户 seek（`seek()`，`:3047-3106`）也不调用它。
**触发**：albumGapless/Cuefield 混音或预载进行中拖动进度条。
**后果**：托管 deck 被 seek，外部预载 deck 仍从旧位置出声（双声源）；`setOutputGain` 若停在混音中途值，整体响度偏低直到下次 reset。
**修法**：`cancelScheduledTransition` 里 `:823` 之后加 `gaplessIntegrationRef.current?.reset()`。

### P2-1　PCM 缓存一次性删除导致"同一窗口重新准备必然重解码/重渲染"（审计修正：非"数秒级重渲染"）

`src/audio/TransitionRenderer.ts:894`：`playTransition` 一进入就把条目从内存缓存删掉（源码注释"one-shot"）；`preRender`（`:152-161`）与 `renderTransition`（`:184-195`）都只看内存缓存 ⇒ 暂停/换设置后同一 plan.id 重新准备必然 miss。
**审计修正**：QQ 档在**主进程还有一层磁盘/后端缓存**（日志中的 `render:qq-entry` + `render:qq-cache-hit`），因此代价是"再次 IPC + 读 WAV + `decodeAudioData`"（可感知但远小于重跑渲染）；真正"重跑渲染"的是没有后端缓存的 AI/DJTransGAN 与纯 v2 DSP 分支（其耗时未实测）。
**后果**：暂停恢复/改设置后可能白等一次解码；若期间已越过新的 `sourceStartTime`，该次智能过渡会被吞掉（降级为固定交叉）。
**修法**：`preRender` 在内存 miss 后先尝试 `rehydrateRendered`（磁盘产物）再决定是否重渲染；或把 `894` 的删除移到 ended 回调。

### P2-2　`preloadNext` 的复用分支不复位增益/不 pause，无法收敛已跑偏的 standby

`src/hooks/useAudioPlayer.ts:2589-2612`：`sameTrackAlreadyAttached` 分支只归位 `playbackRate`（`:2605-2608`），**不 pause、不 `setDeckGain`**；非复用分支（`:2614-2623`）会 `cancelScheduledTransition('next track changed', true)` + pause + gain 0 + 换 src。
**后果**：若 standby 因 P1-3/P1-6 处于"满增益播放"状态，且队列 effect 再次以同一首调用 `preloadNext`，复用分支会原样保留该状态（异常固化）；非复用分支在过渡/交接进行中重跑则会与在途 `target.play()` 竞争，导致 `failed + ended:true` 二次推进。
**修法**：复用分支补"非 running-transition 时 `pause + currentTime=0 + setDeckGain(...,0)`"；非复用分支在 `running-transition` 时延迟到提交后再换 src。

### P2-3　AI/长混音过渡中暂停，恢复会对"已播完的源 deck"调用 `play()`

`src/hooks/useAudioPlayer.ts:1197-1209`（源 deck 静音但保持播放以驱动时间线）+ `:2994-2996`（恢复时 `await active.play()`）+ `:833-837`（取消只恢复增益并 pause，不判断源是否已 ended）。AI 路径缓冲 60s 而源曲窗口从曲尾前 ~26s 起，缓冲后 1/3 内源 deck 已 ended。
**后果**：恢复后**源曲从头重播**（UI 仍显示该曲），并触发同 plan.id 的重准备（叠加 P2-1）。
**修法**：恢复分支在"过渡期间源已 ended"时走显式路径（清 plan + `seek(0)`，或直接对 standby 目标续播）。

### P2-4　`tooLate` 阈值注释与实现不符（85% vs 20%）

`src/audio/TransitionRenderer.ts:896-904`：注释写"越过缓冲 85% 一律放弃"，实现是 `rawOffset > Math.max(1.2, buffer.duration * 0.2)`。阈值自洽（过于宽松地放弃不如现在激进），但注释会误导后续维护。
**修法**：改注释或统一为 85%。

### 已复核不成立 / 已澄清

- **"gain 角色漂移会把下一首 deck 解除静音"不成立**（`getStandbyGain()` 在 await 后求值虽然会打到已退休源 deck 的 gain 节点，`useAudioPlayer.ts:1256/1334`；但该 deck 在提交时已 pause + 清 src，且下次 `preloadNext` 非复用分支必然把它复位为 0/清 src）。这条不影响 P0-1 的结论（P0-1 是"根本没接进音频图"，与增益角色无关）。
- `commitTransition` 的增益/角色配对次序（先取旧角色增益、再翻转 `activePrimaryRef`，`:949-951`）正确。
- 定时器/rAF 生命周期逐个核对（`transitionTimerRef`/`transitionDeckStartTimerRef`/`visualSwitchTimerRef`/`retiredDeckCleanupTimerRef`/`transitionProgressAnimationRef`/`fallbackAnimationRef`/`autoMixPrepareRetryTimerRef`/`preloadReadyCleanupRef`/`trackStemPumpTimerRef`）：卸载与快速连切路径均覆盖，未发现可达泄漏；仅 `rampPlaybackRate` 的 rAF 未入 ref（靠 revision 自停，最多多跑一帧）。
- `seamlessJoinController.onEnded` 的异步续体守卫最完整（generation + revision + 双 deck 身份 + src + 开关 + 状态），无需改动。
- `stopPlayback` 单 `activeSource`，不会停错；唯一漏停场景见 P1-5。
- 变速恢复路径完备（settle rAF / handoff 强制 1 / cancel 归位 / preload 归位），未构造出"整曲变速"可达路径。

## 第四部分：过渡动画/表现层

> 已复核项标注"（已复核）"，其余为审计给出、我未逐行验证的项。

### P1-13　回退交叉淡化期间整条 UI 时间线被冻结，commit 时一次性跳变（已复核）

- `useAudioPlayer.ts:2318-2320`：`running-transition` 期间**丢弃所有 timeupdate**；渲染路径有自己的合成时钟（`:1087-1098` → emit `currentTime`），但**标准交叉淡化路径的 rAF 只发 progress/duration**（`:1513-1558`），gapless 视觉路径同理（`:1454-1495`）。
- 进入该分支的三条路：计划本身降级 fixed-crossfade（`:1929-1933`、`:1989-1991`）、渲染不可用（`:1365-1384`）、`playTransition` tooLate（`:1169-1184`）。
- 消费端直接用 store：`PlayerControls.tsx:496-502`（无插值）、`App.tsx:2496-2500`（倒计时用 `state.currentTime`）。
- **画面**：过渡开始那一帧起，进度条填充 / 已播时间 / 总时长 / 无逐字时的歌词高亮**全部定格**（定格在 duration−crossfadeDuration 附近）持续 D 秒，然后 commit 帧一次性跳到下一首续播点；有逐字歌词时词进度仍在 30fps 前进 ⇒ 同屏两个时钟。
- **修法**：该 rAF 内按 `:1087-1098` 同法合成并 emit `currentTime`；或把 `:2318` 的 return 收紧为"仅渲染缓冲路径"。

### P1-14　90% 视觉预切换链路整体失效，歌词与歌名在 commit 不同步（已复核）

见 P1-2 第 3 条（`visualSwitchCommit` 被 `App.tsx:5059` 丢弃）。追加下游后果：`App.tsx:10222` 的 `transitionFadeProgress={isVisualTransitioning && !visualSwitchedToTarget ? overlayProgress : 0}` 因 `visualSwitchedToTarget` 恒为 false（`App.tsx:3804-3806`）而恒等于 `overlayProgress` ⇒ 旧歌词一路淡到 0.12（`LyricsDisplay.tsx:2415-2417`），commit 帧新歌词树以 `initial={{opacity:0}}` 挂载（`:2413`）再 0.45/0.55s 交叉（`:2416-2423`）⇒ 观感"歌名已经换了、歌词还在往上爬"。`PvLyricsPage.tsx:365-369` 的 0.1 暗态同样靠 commit 才复位。
**修法**：二选一——① 引入"视觉轨道"（`visualCurrentSong`）让过渡期封面/标题/歌词读它，`visualSwitchCommit` 只更新它；② 放弃 90%/50% 链路（删 `useAudioPlayer.ts:1576-1595` 等发送点），并把 commit 的歌词交叉做成对称（新树起始透明度 = 旧树当前透明度，而不是 0）。

### P1-15　MV 预载槽在过渡淡入期间"只 seek 不播"⇒ 渐入的是静止帧序列（已复核）

- `shouldPlaySlot`（`BilibiliMvBackground.tsx:484-486`）与 `resumeSlot`（`:489-498`）都只允许 active/incoming；全文件仅 3 处 `play()`（`:457、:496、:1478/1500`），全部排除 staged。
- 过渡期同步循环对 staged 槽**只 seek**（`:1137-1152`，`stagedVideo.currentTime = stagedTarget; return`，1.5s 一次）。
- **画面**：过渡最后 4 秒新 MV 以 2–4fps 的静止帧叠在旧 MV 上渐入；commit 后 `beginCrossfade`→`resumeSlot` 才开始流畅播放 ⇒ "过渡期新背景是卡住的"。
- **修法**：过渡期允许 staged 槽播放（`shouldPlaySlot` 增加 `|| (transitionActive && stagedSlotRef.current === slot)`，或在 `overlayProgress>0` 时对其 `play()`；muted，无音频风险）。

### P1-16　armed 阶段（AI 档可达 60s）`transitionActive` 已为真 ⇒ 当前曲自己的 MV 即使就绪也被拦在隐藏槽（已复核）

- armed 就下发目标 key（`useAudioPlayer.ts:2060-2064` → `App.tsx:2572-2611` → `:9098`），而 `transitionActive = Boolean(transitionToTrack?.trackKey)`（`BilibiliMvBackground.tsx:464`）。
- `handleCanPlay`（`:1423-1431`）：`if (transitionActive || preloadingOtherSong) return` ⇒ 就绪也不晋升；晋升看门狗只在 `!transitionActiveRef.current` 时跑（`:1154-1163`）；armed 阶段 `getTransitionTargetTimeSeconds` 返回 NaN（`App.tsx:3814-3818`）⇒ 同步循环两个分支都不走。
- **画面**：该就绪视频长期停在隐藏槽，背景继续显示旧/错误候选 MV，最长到 commit 后才兜底晋升；期间 1.5s 校正整段跳过，旧 MV 会漂移。
- **修法**：用"真的在播过渡"（`transitionState === 'running-transition'`）而不是"有过渡目标"做门控；`typeof targetClock !== 'number'` 时不要 return。

### P1-17　stagedOnly 预载可能写进 **active 槽**：当前曲显示下一首的 MV（已复核；代码与其注释自相矛盾）

- `BilibiliMvBackground.tsx:554-557` 的注释写"预载绝不进入直接进槽分支"，但 `!stagedOnly` 只保护了 `songJustSwitched` 条件与 ref 重置；分支条件 `if (!currentActiveUrl || currentActiveUrl === newVideoUrl || songJustSwitched)`（`:558`）对预载**同样成立** ⇒ `:561-572` 会把**下一首**的 URL/owner 写进 `activeSlotRef.current`，并 `stagedSlotRef.current = null`。
- 触发：AutoMix armed（AI 提前量最大）时当前曲**还没有 active 视频**（搜索中/失败/MV 背景刚开）。
- **画面**：当前曲背景直接变成下一首的 MV（张冠李戴），持续到 commit；commit 时因 staged 已空走"1.5s 等落槽 → 重新搜索兜底"（`:839-858`）⇒ 清背景回封面再重新匹配拉流（又数秒封面背景）。
- **修法**：该分支前加 `if (stagedOnly && (!currentActiveUrl || currentActiveUrl === newVideoUrl)) return`（预载一律只落空闲槽），并修正注释。

### P2-7　只有 modern/封面歌词用了"最后 4 秒"时钟，其余歌词面在整个动画窗口就变暗（AI 档 20 秒）

`App.tsx:3794-3800`（overlayProgress=最后 4s）只被 modern 传下去（`:10218-10222`）；immersive（`:9888-9903` 未传 `transitionFadeProgress`）、wallpaper/glorious/multidimensional（`WallpaperLyrics.tsx:358`、`GloriousLyrics.tsx:166-169`、`MultidimensionalLyrics.tsx:66-69` 的 `opacity: isTransitioning ? 0.12 : 1`）、PV（`PvLyricsPage.tsx:365-369` 的 0.1）、modeng 右栏（`ModengPlayerPage.tsx:2221-2226` 的 0.12，注释却自称"最后 4 秒窗口"）都用整窗口门控 ⇒ AI 档歌词先暗 20 秒、歌名最后 4 秒才换。
**修法**：所有歌词面统一接 `overlayProgress`（把 0.12/0.14 改为 `1 - 0.88*overlayProgress`）。

### P2-8　AI 长混音：进度条钉在 100%、总时长数字自增 26 秒，commit 时回跳

`useAudioPlayer.ts:1087-1094` 的 `syntheticCap = max(source.duration, sourceStartTime + transitionAudioDuration)` + AI 起点回伸 ~34s、窗口 60s ⇒ 合成时间可到 `duration+26`；`PlayerControls.tsx:497-502/602` 的 `effectiveDuration = Math.max(duration, displayTime)` 跟着上探 ⇒ 进度条在 ~56.7% 处填满不落、总时长数字从 `duration` 涨到 `duration+26`，commit 帧回跳。
**修法**：渲染路径额外 emit 合成的 `duration`，并对"过渡中"显示不定进度态，别让 `effectiveDuration` 无限上探。（用户当前 aiMix=false，非首要。）

### P2-9　gapless 的动画门控用元数据时长、比元素时长（向下量化 0.25s）大 ⇒ 普通 gapless 的可视过渡整体不生效

`useAudioPlayer.ts:2106/2167/2176` 用 `transitionStartTime: current.duration`（元数据），`App.tsx:3791` 门控 `currentTime >= transitionStartTime`，而 `currentTime` 是元素时间**向下量化 0.25s**（`:2323`）且过渡期 timeupdate 被抑制、成功过渡只给 `visualDuration=0.4`（`:1020`）⇒ 0.4s 的交叉/歌词淡出/HUD 全被吞，视觉等于硬切；album-gapless 因提前 1.8s（`:2159`）反而正常。
**修法**：gapless 的窗口起点改为 `Math.max(0, duration - 1)` 或 `null`（视为始终在窗口内）。

### P2-10　纯交叉淡化（未开 AutoMix）没有 MV 预载通道 ⇒ commit 起必然回退封面数秒

`transitionToTrack` 只由 `prepareAutoMix` 下发（`useAudioPlayer.ts:2060-2064`），交叉淡化 armed 分支不带 key（`:3099-3103`）⇒ `BilibiliMvBackground.tsx:862-867` 走 `searchAndLoad()` → `hideOldMv()` 清两槽 → 重新匹配 + 拉流；期间还可能短暂看到上一首封面（`CrossfadeBackground.tsx:56-98`）。
**修法**：交叉淡化也在 `crossfadeDuration` 之前下发 `transitionToTrack`（复用 798-858 的接管逻辑）。

### P2-11　`adoptExternalAudio` 不复位 `transitionStartTime`；若干死代码与口径不一致（低）

- `useAudioPlayer.ts:3269-3288` 的 `committed/playing` emit 都不带 `transitionStartTime`，且 `:3163` 的 cancel 传 `announceCancellation=false` ⇒ App 保留上一首的窗口起点（`App.tsx:2547` 只在 key 存在时更新）直到下次 armed 覆盖。**修法**：这两处 emit 显式带 `transitionStartTime: null`。
- 死代码：`App.tsx:2561-2565` 的 `shouldHoldCompletedFrame`（没有任何 emit 同时满足其三个条件）；`useAudioPlayer.ts:1576-1595` 的中点 visualSwitch（H2 的一部分）。
- Folia 两个组件用裸 `transitionProgress`（`App.tsx:10263/10281-10283`）而同屏 PlayerControls 用 `overlayProgress` ⇒ 同屏两套进度语言；`transitionDebug` 弹窗停在 armed 快照（`App.tsx:3830-3838`），运行期降级不反映，Enhanced 档 engine 仍标 `'v2'`（`:2064` + `:1834`）。
- 封面叠层 10fps 提交节流（`App.tsx:2557-2567`）+ `AlbumCoverPlayer.tsx:136-141` 直接写 opacity 无 CSS transition ⇒ 4 秒叠加约 40 步硬步进（MV 槽有 120ms linear，见 `BilibiliMvBackground.tsx:473-474`）。

### 已核对但不构成问题（第四部分）

- commit 的原子性正确（`App.tsx:2633-2650` 同批提交 + 清叠加层），有 `transitionCommit` 的路径不会残留叠加层。
- `overlayProgress` 的"最后 4 秒"归一化数学正确（分母=剩余缓冲，窗口开启瞬间恰为 0）。
- 渲染路径不会出现双 rAF 抢分母（回退前显式 cancel，`:1374-1384`）。
- 其他表面（mini player / 桌面歌词 / taskbar widget）没有第二套过渡动画。
- `AutomixHudBadge` 的记忆键设计合理（同曲 seek 不重复通知）。

## 第五部分：门控、状态机与跨功能交互

### P0-3　同专辑相邻曲 + AutoMix 开启 ⇒ 专辑无缝与 AutoMix 双双失效，每次换歌都是硬切 + 整曲重载静音缝（已复核）

- `useAudioPlayer.ts:141`：`resolvePairTransitionStrategy` 里 `if (settings.autoMix) return applePair ? 'gapless' : 'automix'` —— **专辑信息不参与取值**。
- `useAudioPlayer.ts:2286` 的触发条件要求 `pairStrategy === 'automix' && !albumPlayback`；`2298` 的 gapless 分支要求 `pairStrategy === 'gapless'`（AutoMix 开启时永不为 gapless）⇒ **专辑场景两个分支都不走**。
- `handleEnded`（`:2415-2444`）：控制器 `onEnded` 的 `isGaplessEnabled()` = `resolvePairTransitionStrategy(...) === 'gapless'`（`:2254-2258`）为 false → `2417` 的 `running-transition` 不成立 → `2421` 的 gapless 分支不成立 → 落到 `2443` `setTransitionState('idle', { ended: true })` ⇒ `App.tsx:2739` 走 `handleNext()` ⇒ `App.tsx:5684` `cancelTransition(..., false)` + 整曲 `loadAndPlaySong`。
- 代码注释写的是相反意图：`:455-458`、`:2276-2277`「同专辑时即使 AutoMix 启用也优先走首尾拼接」，`:2653-2658` 在 preload 就绪时还专门 `armed + gapless`。
- 用户的设置正是「只开 AutoMix」（`crossfadeEnabled/gaplessEnabled=false`）⇒ **只要播放列表里相邻两曲同专辑，每个交界都是硬切 + 重载空隙**。
- **修法**：把专辑优先级落到分流条件上，例如 `const gaplessBoundary = pairStrategy === 'gapless' || (pairStrategy === 'automix' && albumPlayback)`，在 `:2286/2298/2415/2421` 与 `:2254` 的 `isGaplessEnabled` 回调用它判定。

### P0-4　同一歌曲组合连续失败 2 次后，整场会话内该组合再无任何过渡（连 4s 兜底也没有），而 seek/暂停恰好会清掉最后的兜底计划（已复核）

- 节流：`useAudioPlayer.ts:1713-1719` —— `attempts >= AUTO_MIX_MAX_PREPARE_ATTEMPTS(2)` 或冷却期内**直接 return，既不改 `transitionPlanRef` 也不改状态**；`attempts` 只在成功时删除（`:2071/1829`）。
- 但 `seek`（`:3065`）与暂停（`:3016`）都会先 `cancelScheduledTransition` → `:844` `transitionPlanRef.current = null`。
- 于是：计划为 null（触发条件要求 plan 非空，`:2286`）⇒ 本曲再无过渡 ⇒ 硬切 + 整曲重载；且无任何 UI 提示（降级原因只在调试开关下可见）。
- **修法**：节流分支不要空手 return，至少重新武装兜底（`if (!transitionPlanRef.current) transitionPlanRef.current = buildFallbackCrossfadePlan('throttled')` + `armed`）；把 `buildFallbackCrossfadePlan` 定义提到节流判定之前（现定义在 `:1745`，作用域在判定之后）。

### P1-18　改任一 AutoMix 设置会当场掐断正在进行的过渡（含只影响 v1/v2 的时长滑条）

`useAudioPlayer.ts:2533-2543` 的 settings effect 无条件 `cancelScheduledTransition('transition settings changed')`（`:824` 停过渡缓冲、`:835-837` 把 active 增益写回 1 并暂停 standby、`:811-812` 清 commit 定时器、`:844` 清计划），依赖数组 `:2554-2570` 覆盖 `enableBeatMatching/skipSilence/minDuration/maxDuration/enhanced/intensity/aiMix/crossfadeSettings.duration/gaplessSettings.*`，**没有"正在过渡则推迟"的判断**；滑条每格都派发事件（`SettingsPanel.tsx:2076-2084`）。
**听感**：淡出到一半**突然弹回原曲满音量**（源曲增益被写回 1），随后从当前位置重排，边界处再来第二次（通常更短）；若新准备被上一条节流挡住，则连第二次都没有。
**修法**：effect 内先判断 `transitionStateRef.current === 'running-transition'` → 打 `pendingReprepareRef`，commit 后再重排；并把 `crossfadeSettings.duration`、v2 根本不消费的 `minDuration/maxDuration`（`transitionPlanner.ts:757-761`）从依赖里剔除。

### P1-19　`seek` 里"越过过渡点才作废计划"的判断是死代码 ⇒ 任何 seek（含向后退到窗口前）都会毁掉已武装的计划

`seek`（`:3065`）先 `cancelScheduledTransition` → `:844` 已把 `transitionPlanRef.current` 置 null；随后 `:3086-3089` 读到的必然是 null，条件恒假（注释 `:3084-3085` 与实现不符）。作废后 `:3097` 重新 `prepareAutoMix`，期间 `:1773` 置 `preparing-next`——而触发分支只接受 `armed|playing`（`:2286`）⇒ **重排期间连兜底交叉都不会启动**；若叠加失败节流，则本曲再无过渡。
**修法**：把 plan 读在 `cancelScheduledTransition` 之前，仅当 `newTime >= plan.sourceStartTime`（或落在窗口内/之后）才作废；窗口之前保留计划。

### P1-20　`beat-crossfade` 不收敛时长 ⇒ 8~20 秒双曲同响（"双重奏"），且该策略在生产里可达

`useAudioPlayer.ts:1014-1017` 取 `plan.sourceEndTime - plan.sourceStartTime` 作为过渡时长，只有 `fixed-crossfade` 会收敛到设置值（`:1392-1401`）；`requiresSmartRender`（`:1948`）不含 `beat-crossfade` ⇒ 直接走等功率交叉；该策略由 `transitionPlanner.ts:395-401/890-895` 在"网格可靠且 BPM 接近"时给出（v1 在 `beatMatching=false` 时反而必然给 `beat-crossfade`，`:268`）。
**后果**：用户以为关掉节拍匹配过渡会变短/变干净，实际得到 8–20s 两首歌同时满响（叠加 P0-1 更明显）；HUD 只写"节拍交叉淡化"，无时长说明。当前用户配置下 Enhanced 会覆盖该策略，故主要影响 Pro/Standard 用户。
**修法**：对 `beat-crossfade` 也加时长上限（如 `Math.min(configured * 2, window)`），或 `beatMatching=false` 时直接判 `fixed-crossfade`。

### P2-12　REPREPARE 重试可能整体丢失（单槽定时器 + 全局 revision 门禁）

`useAudioPlayer.ts:1734-1742`：`autoMixPrepareRetryTimerRef` 是单槽（20s 窗口内若另一组合也失败，后者永远不挂重试），且回调内用**全局** `preparationRevisionRef` 校验（`cancelScheduledTransition` 会 +1）⇒ 期间任何 seek/暂停/切歌都会静默丢弃重试；丢弃后 `attempts=1` 且无后续触发源 ⇒ 本曲停在 fallback（或"无过渡"）。
**修法**：改用 `Map<preparationKey, timer>`；校验改为"该 key 是否仍是当前相邻边"。

### P2-13　看歌模式进出后当前曲的过渡计划不会重建 ⇒ 本曲剩余部分硬切

进入时 `App.tsx:3611` → hook `:3310-3314` 清计划；退出时 `App.tsx:6001-6002` 只置 `setWatchHold(false)`，**没有任何 prepare 调用**，且退出走裸 `engineEl.play()`/直接写 `currentTime`（`:6011-6021`、`:3616`）不经过 `togglePlay/seek` ⇒ 不会触发 `prepareAutoMix`（注释 `App.tsx:6001` 声称"automix 重新可用"与实现不符）。
**修法**：`setWatchHold(false)` 后补 `if (nextMetadataRef.current?.url) void prepareAutoMix()`。

### P2-14　外部播放（WebView2）期间仍会为"陈旧本地组合"做分析 + 重渲染

`enableExternalPlayback`（`:2892-2916`）只 cancel + 暂停本地 deck，`currentMetadataRef` 仍是上一首本地曲；`prepareAutoMix` 无 `externalActiveRef` 门控（`:1625-1690`）；`preloadUpcomingSongs` 的守卫（`App.tsx:4715/4751`）也不含外部播放 ⇒ 会为"没在播的组合"整曲分析 + 一次重渲染（可能干扰 WebView2 音频，**是否可闻未验证**），并污染 `preparedOk/attempts`。
**修法**：`prepareAutoMix` 开头 `if (externalActiveRef.current) return`；预载守卫加 `!externalPlaybackActive`。

### P2-15　分轨在 AutoMix 之后不会自动恢复（UI 文案说"已冻结"暗示临时）

`setTransitionState('running-transition')`（`:433-446`）会 `trackStemDesiredRef=false` + `locked:true` + `returnToOriginal()` + `trackStems.cancel`；`commitTransition:899` 又 `resetTrackStemMixer('idle')`（`:575-598` 置 `status:'idle'`、`mixer=null`），而 `:444-445` 只在 playing/cancelled/failed 解锁 `locked` ⇒ 用户开着的分轨调节被静默关闭，需手动重开（`StemMixerPopover.tsx:141` 文案为"过渡进行中，已冻结当前增益"）。
**修法**：过渡前记录是否 active，commit 后自动 `enableTrackStems()`。

### P2-16　`renderedDuration` 回填是死分支 ⇒ AI 长混音的动画窗口恒按 60s 兜底

`TransitionRenderer.ts:673-678` 把真实时长放进渲染结果，但 `useAudioPlayer.ts:2008-2032` 的合并只回填 `v2/qqTechniques/overlapSeconds`（及 aiMix 时两个时间字段），**从不写 `plan.renderedDuration`**（全仓仅 `:2045-2052` 消费一处）⇒ 模型窗口变化时倒计时/流光出现时机与真实缓冲错位（不影响音频）。
**修法**：合并时补 `renderedDuration`。

### P2-17　`commitPreparedSong` 的两个脆弱点

`App.tsx:5063-5069`：① 目标曲若在过渡途中被移出队列 ⇒ `findIndex` 得 -1 ⇒ `if (!song) return` 静默返回：**音频已切到目标 deck，而 UI 的 currentIndex/currentTrack/歌词全不更新**（永久错位；只有桌面队列删除/移动/智能重排三条路径会 `cancelTransition`，其它移除路径不会）；② `getSongKey` 不含 `id` 之外的唯一性 ⇒ 队列里有重复曲时 `findIndex` 命中靠前的那条，`currentIndex` 跳错位置。
**修法**：`if (!song)` 分支兜底重载或至少 toast + 修正 currentIndex；重复曲用条目唯一 uid。

### P3（低，仅登记）

- `handlePause` 缺 `externalActiveRef` 判断 ⇒ 切外部播放瞬间最多 0.2s 的播放态/进度回跳（`:2345-2362` vs `:2916`）。
- `transitionFallbackReason` 是死状态（`App.tsx:1480/2548-2550` 只写不读）⇒ 所有静默降级对普通用户不可见。
- TV 档位下 `effectiveAutoMixEnabled=false`（`App.tsx:1469`）但设置面板仍显示"已开启"，且此时若 crossfade/gapless 也关则全为硬切。
- fallback 计划的窗口固定 4s、实际淡化取 `crossfadeRef.current.duration`（本机 =1s）⇒ 触发点与时长脱耦（`:1755-1759` vs `:1392-1398`）。
- 失败重试只有按组合节流、没有全局熔断 ⇒ 渲染 worker 长期不可用时会沿播放时间轴持续"分析→渲染失败→20s 后重试"（只有日志，无 UI 噪音）。
- `aiMix=true` 且引擎为 enhanced 时 AI 混音被静默忽略（计划先按 v2 建、再被覆写为 `smart-rendered-qq`）。
- `autoMixPreparationAttemptsRef` 永不清理（随会话累积，量级很小）。

### 已核对但不构成问题（第五部分）

- 设置三选一由 UI 强制（`SettingsPanel.tsx:1990-2062`），不存在"AutoMix 与 gapless 同时开"的现实组合。
- `AUTO_MIX_REPREPARE_DELAY_MS(20s) > COOLDOWN(15s)` ⇒ 正常路径的重试不会被自身冷却挡住。
- compat 预检与陈旧 30s 缓存处理（`:1799-1831`）链路完整：`invalidateTrack` + `deleteCached` IPC 真实存在，首次重试确实会重新下载；重试仍失败则进上文的"永久降级"（P0-4）。
- 分析任务的"取消"只让等待方提前退出，共享分析与渲染不会真取消（快速连切会在同一 worker 上排队）——已确认为设计取舍，非泄漏。
- AirPlay 采集取自音频图（`App.tsx:2366` `setCaptureSource(context, analyser, outputGain)`），过渡缓冲经 masterGain 入图 ⇒ 可被投送；共振走单曲队列 + cancel，不会为本地 deck 生成计划。
- `'committed'` 状态唯一生产者是 `:3269`（adoptExternalAudio 专辑交叉 handoff）；主路径 commitTransition 走 `'playing' + transitionCommit` —— 状态取值语义清楚。

## 第六部分：修复优先级与验收清单

### 第一梯队（P0，直击用户症状，改动都很小）

| # | 修什么 | 位置 | 为什么先修 |
|---|---|---|---|
| 1 | 保留两个 `MediaElementAudioSourceNode` 引用；`setDeckGain` 增加"元素是否真在图里"的判定，未确认时退化为 element volume 控制；首次播放加自检日志 | `useAudioPlayer.ts:504-505`、`:465-474`、`:477-480` | 修掉"两首歌一起放/过渡期串音/可视化与 DG-LAB 无信号"整族问题（P0-1） |
| 2 | 引擎 metadata 补 `mid/title/artist`（或让 `qqTrackRef` 能按 trackKey 反查完整 Song） | `App.tsx` 6 处调用点 + `types.ts`/`useAudioPlayer.ts:59-73` | 让 lite/advanced/extreme 真正生效（P0-2）；修完需清一次 QQ 渲染缓存（键不变会命中旧 lite 产物） |
| 3 | 专辑场景的分流条件：`gaplessBoundary = pairStrategy === 'gapless' \|\| (pairStrategy === 'automix' && albumPlayback)`，在 `:2286/2298/2415/2421` 与 `:2254` 的 `isGaplessEnabled` 回调用它 | `useAudioPlayer.ts:141/2254/2286/2298/2415/2421` | 修掉"同专辑相邻曲硬切 + 重载静音缝"（P0-3）——只开 AutoMix 的用户只要听专辑就必现 |
| 4 | 失败节流分支重新武装兜底计划；`buildFallbackCrossfadePlan` 定义前移 | `useAudioPlayer.ts:1713-1719`、`:1745` | 修掉"连续失败 2 次后整场会话该组合再无任何过渡"（P0-4） |
| 5 | 非 overlap handoff 在 await 前后各加一次 revision/状态复查；handoff 引入 `handoffPendingRef` 参与 `handleEnded` 的忽略判定；`startDeckEarly` 的 `deckStarted` 移到 play 成功之后 | `useAudioPlayer.ts:1310/1316/1334-1335`、`:1240/1260/1317`、`:2394` | 修掉"暂停中放下一首 / seek 后双 deck 齐奏 / 假 ended 重载 / 偶发跳曲"竞态（P1-3、P1-4、P1-6） |

### 第二梯队（P1，观感与一致性）

4. **MV 背景四连修**：commit 帧不把 staged 槽透明度归零（P1-1）；过渡期允许 staged 槽 `play()`（P1-15）；armed 期不拦 canplay 晋升（P1-16）；预载不写 active 槽（P1-17）。
5. **回退交叉淡化期间合成时间线**（P1-13）——用户最容易复现的"进度条定格再跳"。
6. **90% 视觉链路二选一**（P1-14）：要么实现"视觉轨道"，要么删链路并把 commit 的歌词交叉改为对称。
7. **缓存与档位可见性**：`ensureRendered` + 降级写 reason（P1-11）；QQ 缓存键补 `window`/`ALGO_VERSION`/`effectiveTier`（P1-9/P2-5）；回填 `qqAppliedTier/fallbackReason/rendererVersion` 到面板与 toast（P1-12）。
8. **cue 转码**（P1-10）、**设置依赖补 `engine`/`enhancedTier`**（P1-7）、**配色不回退中性灰**（P1-2 第 1 条）。

### 第三梯队（P2）

AI 档进度条/时长展示（P2-8）、其它歌词面统一 4s 时钟（P2-7）、gapless 窗口门控（P2-9）、纯交叉淡化 MV 预载（P2-10）、`preloadNext` 复用分支复位（P2-2）、`cancelScheduledTransition` 补 `gaplessIntegration.reset()`（P1-8）、AI 过渡中恢复重播源曲（P2-3）、QQ 失败兜底派发 v1 的标签问题（P2-5）、lite 手法文案（P2-6）、tooLate 注释阈值（P2-4）、其余低项（P2-11）。

### 验收清单（建议按此回归）

1. `node .tmp-probe-audio.mjs`：播放中 `mediaElementAudioSources` 应为 2、deck 的 `routedToGraph: true`、两个 deck 的 gain/volume 一一对应；暂停后仍为 2 个（不再消失）。
2. 播完一整条 AutoMix 过渡（QQ 曲目、Enhanced extreme）：日志应出现 `plan:qq-ok`（或至少 `tier=extreme` 不再 100% 带 `plan:qq-fallback`），调试弹窗显示实际档位。
3. 过渡期间用监听/录音确认：只有过渡缓冲在响（源曲 deck 应真的静音），交接后只有目标曲。
4. 过渡最后 4 秒看 MV 背景：新 MV 应为连续画面（不是 2–4fps 静止帧），commit 帧不应闪回上一首。
5. 把进度条拖进过渡窗口内 3–5s：应得到与自然触发一致（或干净降级且 UI 时间线不冻结）的过渡，commit 后目标曲位置连续。
6. 过渡进行中暂停/继续/切歌各 5 次：不出现双声源、不出现跳曲、不出现"无声但进度在走"。
7. 修改引擎/档位设置后立刻切歌：新设置必须在下一对边生效（当前边允许保持旧档，但需在 UI 上自洽）。


---

## 第七部分：第二轮深挖（端到端实测 + 规划器/渲染后端/测试覆盖）

### 7.1 端到端静默实测（方法、结果与限制）

**方法**：CDP attach 运行中的应用 → 给两个 deck 的 `volume` 装"意图记录器"（实际写 0 保证全程无声、记录引擎想设的值）→ 播放用户「automix测试」歌单第 1 首 → 采样媒体元素/音频图节点/play-pause 轨迹（带调用栈）+ `Page.startScreencast` 截帧（1356 帧）→ 全部还原。

**结果**：

1. **本次会话的 deck 是接进音频图的**（`MediaElementAudioSourceNode = 2`，且 `HeapProfiler.collectGarbage` 后仍是 2）⇒ "deck 脱钩"不是每场必然发生；但**昨天在用户会话里实测到的"图在（3×Analyser/14×Gain）、源节点 0、deck 以 element volume 直出"确实存在**（观测事实）。成因未能在本次按需复现：V8 级 GC 无效，推测需要 Blink/Oilpan GC（DOM 侧对象），未构造出稳定复现手段 ⇒ **P0-1 的"何时发生"仍属未定，但"发生后的后果"已在昨天实测**。
2. **网易云曲目 100% `plan:qq-fallback` + `render:qq-fallback`**（"未能在 QQ 音乐匹配到：前曲、后曲"）⇒ **P0-2 端到端坐实**（非 QQ 曲目的 mid 本来就空，又因 metadata 无 title/artist，跨平台搜索也不可能发生）。
3. **试听片段连锁**：日志 `prepareAutoMix:compat-block`「下一曲分析时长与流时长不一致（analysis=30.0s vs stream=226.5s），疑似过期缓存或换源」→ `stale-invalidate` → `reprepare attempts=1/2` ⇒ 该曲对**永久降级**（P0-4）；实际执行的是 **4 秒 fallback 计划 + 1 秒等功率交叉**（目标 deck 从 `ct=3` 起播 = `plannedTargetEnd(4) − configured(1)`，与代码完全吻合），**全程未出现任何 `AudioBufferSourceNode`**（预渲染缓冲从未被使用）⇒ **P1-11「PCM 过期 → 降级固定交叉」端到端坐实**。
4. **误诊是用户可见的**：截帧（`.tmp-e2e/keep/toast-compat-block.jpg`）显示应用右上角弹出上述 compat-block 文案；但真相是**流本身就是 30 秒试听片段**（deck 时长 30.0s、URL 为 netease `jd-musicrep-ts` 试听流），所以"失效 + 重下"永远修不好，重试 2 次后该曲对整场会话再无智能过渡 ⇒ **P0-4 + 误导性诊断文案**。
5. 试听片段叠加 fallback 计划，表现为"每 20~30 秒切一首"的连锁（像过渡风暴，实为试听片段 + 4s 回退）。
6. **隔离实验（物理无声）测得 `element.volume`/`muted` 会按线性比例影响进入音频图的信号**（td：1.0→0.234、0.5→0.117、0→0）⇒ ① 静音看门狗安全可用；② **P0-1 的修法（未接入图时退化为 element volume 控制）成立**；③ 反过来说明"接入图时把 `volume` 强制为 1、只靠 gain 控音量"（`setDeckGain`）的设计脆弱——一旦脱钩，element volume 已是 1，静音彻底失效。

### 7.2 规划器/分析质量（新）

- **P1-21（已复核）调性检测旋转方向反了**：`src/audio/transitionPlanner.ts:505` `krummhansl[(pitch + tonic) % 12]` 应为 `(pitch - tonic + 12) % 12`。推导：A 大调（tonic=9）的 chroma 会被判成 tonic=3（镜像调）；除 C/F#（0/6 自镜像）外**所有调都被镜像** ⇒ `keyPitchShiftSemitones` 方向取反、和声距离翻倍（1 半音错成 2 半音）；关系大小调（C↔Am）被判成最差兼容度（0.85→0.25）⇒ 选窗成本、`atmospheric` 强制、移调决策全链路失真。**修法一个字符**；同时必须改 `test/transitionPlanner.test.ts` 的 fixture（现 fixture 与实现同向旋转，永远测不出）。附注：`camelotNumber` 公式本身正确（C 大调=8B、A 小调=8A，已验证），此前报告里"小调被算成 camelot 2"是误检的连带结果。
- **P1-22（已复核）桌面默认 provider 下风格恒为 `atmospheric`**：`python-beat-service/beat_analyzer.py:312` `'energy': rms * rms`（量级 0.001~0.09）vs 浏览器回退 `src/services/autoMixAnalysisService.ts:799` 归一到 0~1；而判据 `transitionPlanner.ts:614-616` 按 `>=0.3 / <0.25` 写死 ⇒ `energetic`/`clean` 不可达（只有 RMS > -6dBFS 的砖墙母带能越过 0.25），`energy` 成本项跨 provider 不可比。
- **P1-23（已复核）partialSync（整数倍救援）被"原始 BPM 差 ≤100"预筛掉**：搜索被包在 `bpmDifference > MAX_SMART_MIX_BPM_DIFFERENCE_V2 && <= MAX_V2_EFFECTS_BPM_DIFFERENCE`（`:739-744`）内，而 `>100` 直接走 `fixed-crossfade`（`:870-871`）⇒ 206.9/103.45 这类**最该救的倍频对**静默退化；N=4 数学上不可达（`safeBpm` 下限 40 → diff ≥ 120）。
- **P1-24（已复核）`skipSilence` 反向劣化**：`:784-785` `targetStartMax = max(targetStartMin, target.duration * 0.2)` ⇒ 当目标曲头部静音 > 20% 时长时区间塌成一点、`pairs=[]` ⇒ 整条计划退化为"片尾 12s 固定交叉"（用户开"跳过首尾静音"反而更差）；窗口末端无上界（可越过 `outroSilence`），且现有测试因成本全等取首窗而**空过**。
- **P2-18** `withoutBeatGrid` 路径的 `djEffects` 由覆盖前的 choreography 生成 ⇒ 仍执行 bassSwap/filterSweep（渲染端无条件执行），与"关闭依赖节拍网格的特效"的注释相反，调试弹窗清单也与实际不符。
- **P2-19** 分轨切点时间轴错位：`stemTransitionPlanner` 产出的是**源曲真实秒**的 downbeat，`render_worker.py:1086-1089` 直接按输出秒取点，而输出是逐拍拉伸网格 ⇒ cue 落在非拍点（10% 拉伸 → 4s 处偏 ~0.4s）。
- **P2-20** `gainOffsetDb` 四条后端钳制不一致（逐点 min(1.0) / 标量 min(2.0) / min(1.25)）⇒ 同一 plan 跨后端响度不同，主路径上"目标更轻→抬"在曲线后段被撤销。

### 7.3 渲染后端（新）

- **P1-25（已复核）folia 的 resume 与 v2 不一致**：`desktop/workers/render_worker.py:1219` `target_resume_time = targetStart + min(duration, target_span)`，而 v2 DSP 是 `plan['targetEndTime']`（`:1367`）。folia 是 Pro 默认后端，目标更慢时 resume 早 0.5~0.9s ⇒ handoff 处目标曲尾段被重播一遍（叠加 1.5s overlap 双层错位）。
- **P1-26（已复核，含对审计结论的修正）** 无网格分支 `output_length = source_audio.shape[1]` + 补零/截断（`:1305-1320`）：**目标更快**时目标层在缓冲后段被补零（静音洞，而 gain 仍按曲线升到 1）⇒ 可闻"进曲半途断掉"；**目标更慢**时是内容截断且 `resume = targetStart + min(src_span, tgt_span)` 与内容一致 ⇒ **不构成跳段**（原审计的"反向跳段"不成立）。
- **P2-21（已复核）QQ 三档写盘无 NaN/峰值保护**：`desktop/workers/qq_automix.py:462` 直接 `sf.write(..., subtype='PCM_16')`，而 v1/v2/folia 都有 `Refusing to write non-finite` + `tanh` 限幅（`render_worker.py:33/712-715/1214-1215/1496-1498`）⇒ 云端档可能静默硬削波（soundfile 默认开裁剪）且无任何日志。
- **P2-22** 主进程 `RenderRuntime` 无在途去重（`AiMixRuntime` 有）⇒ 同曲对可能重复渲染并互相覆盖输出（QQ 侧非原子写）；渲染超时只 reject 不取消 ⇒ worker 串行队列级联超时；空闲关闭可能中途 kill 在跑任务；**`StemRuntime`/`TrackStemRuntime` 无启动超时** ⇒ onnxruntime 挂起时首条 stem 请求永久挂住且不会回退 DSP。
- **P2-23** HTDemucs 路径用线性插值重采样（无抗混叠、10k 处约 -1.5dB）⇒ folia 过渡段整体发闷；QQ 档整曲常驻内存（只用 12~30s 窗口）；stderr 转发正则吞掉全部中文关键行（`[qq-automix]`/`[fallback]`/`[cloud]` 不进日志）且 traceback 截 300 字符 ⇒ 报障时拿不到根因。

### 7.4 测试覆盖缺口（为什么这些问题没被测出来）

- **结构性根因：`src/hooks/useAudioPlayer.ts`（3383 行）从未被任何测试挂载**（全仓 `renderHook` 只出现一次），`App.tsx` 同理；本轮所有 P0/P1 的竞态、门控、接线问题都落在这片"测试到不了"的区域。
- **4 个测试文件是纯源码字符串断言**（`appleManagedTransitionWiring` / `transitionOverlayProgress` / `autoMixBackendIsolation` / `autoMixLearnedAutomation`）：只证明字符串还在，行为被破坏照样绿；另有计数式断言（`detachCalls >= 6`）与"注释负断言"。
- 真覆盖且值得当模板的：`transitionRendererMemory.test.ts`（假 AudioContext）、`trackStemMixer.test.ts`、`seamlessJoin.test.ts`、`transitionPlanner.test.ts`（但 fixture 与实现同向旋转 ⇒ 测不出 P1-21）、`BilibiliMvBackground.test.tsx`（较厚，但恰好漏掉提交帧透明度 / staged 不播放 / 预载写 active 槽三处）。
- **建议的最小可测接缝重构（按性价比）**：
  1. `selectTransitionAction()`：把 `handleTimeUpdate` 的 if/else 链 + `handleEnded` 的分支 + 专辑门控收敛成纯函数 ⇒ 解锁表驱动测试（含 P0-3 的专辑组合）；
  2. `buildDeckMetadata()` 单一注入点 + `PreloadTrack` 补 `mid/name/artists` ⇒ 顺带修 P0-2，且字段不会再"只加一处"；
  3. `slotVisualState()` / `resolvePreloadTakeover()` ⇒ MV 槽位时序可测；
  4. `computeDeckGainCommand()` + 保存 source node 引用 ⇒ P0-1 可测；
  5. `createAutoMixPrepareThrottle()`，并把"任何早退路径都必须保证有 fallback 计划"写成不变量 ⇒ P0-4；
  6. `createTransitionHandoff()` + `createTransitionClockEmitter()` ⇒ P1-3/4/6/13；
  7. QQ 渲染缓存键纯函数 + meta 校验（对齐 v2 的 `cacheIdentityMatches`）⇒ P1-9。

### 7.5 第二轮新增优先级（并入第六部分）

- **并入 P0 梯队**：P1-21（调性旋转，一个字符）、P1-25（folia resume，一行）、P1-22（energy 量纲统一）、P0-2 的 metadata（同第 2 项）。
- **并入 P1 梯队**：P1-23（partialSync 预筛顺序）、P1-24（skipSilence 区间）、P2-21（QQ 限幅/NaN）、P2-22（渲染在途去重 + stem 启动超时）、P2-19（分轨 cue 时间轴）。
- **新增验收项**：网易云/试听片段曲目应给出**准确的**降级文案（"该曲仅试听片段，无法智能混音"），而不是"疑似过期缓存或换源"；且不得因此把曲对永久锁死。

---

## 第八部分：修复状态（2026-09-29）

校验基线：`npx tsc --noEmit` → **0 错误**；`npx vitest run test/` → **194 文件 / 1825 用例全绿**（2 文件 / 6 用例为既有 skip）。

### 已修复（含验证方式）

| 条目 | 改动落点 | 验证 |
| --- | --- | --- |
| **P0-1** 保留 source node + 路由判定 | `useAudioPlayer.ts`：新增 `mediaSourcesRef`（创建时持有、卸载时清空）、`isDeckRouted()`、`setDeckGain` 仅在"确实接在图里"时强制 `volume=1`，否则退化为 element volume | tsc + 全量测试；行为需真机复测（`probe-audio` 应长期显示 2 个 source node） |
| **P0-2** 曲目身份注入 | `types.ts` 的 `PreloadTrack` 增 `songId/mid/name/artists`；`App.tsx` 新增单一构造点 `buildDeckMetadata(song, url, index, extras)` 并替换 **7 处**注入点（含审计外新发现的 `adoptExternalAudio`） | tsc + 全量测试；真机需确认 `plan:qq-ok`（或至少降级原因为"未登录"而非"未匹配到"） |
| **P0-3** 专辑边界分流 | 新增导出纯函数 `resolveBoundaryStrategyFor(pair, albumPlayback)`；`handleTimeUpdate`/`handleEnded`/settings effect/seamlessJoinController 的 `isGaplessEnabled` 统一改用它 | 新增 `test/transitionBoundaryStrategy.test.ts`（表驱动 8 组 + 常态组合 + Apple） |
| **P0-4** 节流不再"空手 return" | `prepareAutoMix`：`buildFallbackCrossfadePlan` 前移，节流早退前 `if (!transitionPlanRef.current) armFallbackCrossfade(...)`；preparationKey 补 `engine/enhancedTier` | tsc + 全量测试（无专用单测，建议后续补状态机测试） |
| **P1-1/15/16/17** MV 背景槽位 | commit 帧保位（`transitionFadedRef`）、过渡期 staged 槽可播放、armed 期当前曲自己槽可晋升、预载绝不写 active 槽 | `test/BilibiliMvBackground.test.tsx` 新增 4 条（逐条"还原修复→用例失败"验证）+ 既有 21 条全过 |
| **P1-2** 主色闪灰 | `App.tsx`：`lastReadyCoverColorRef` 沿用上次 ready 主色（含 palette），commit 批次不再清 `transitionToAccentColor` | tsc + 相关测试全绿 |
| **P1-3/4/6** handoff 护栏 | await 前后各加 `isExecutionCurrent()` 复查（失效则收回收音/gain）；`deckStarted` 移到 `play()` 成功之后（新增在途标记）；`handoffPendingCountRef` 参与 `handleEnded` 忽略判定；失败路径交还源曲或交还 App 推进 | tsc + 全量测试 |
| **P1-7** 引擎/档位设置生效 | settings effect 依赖 + preparationKey 补 `engine/enhancedTier` | tsc + 全量测试 |
| **P1-8** gapless 外部 deck 复位 | `cancelScheduledTransition` 增 `gaplessIntegrationRef.current?.reset()` | tsc + 全量测试 |
| **P1-9** cue 时间轴唯一事实 | 渲染侧传 `cueTransitionStartSeconds/Duration/TargetStart`（`electron.d.ts` 同步）；后端 `render_qq_automix`/`qq_automix` 提供 `cue_timeline` 覆盖（含 lite 路径）；QQ 缓存键补 `window`+`ALGO_VERSION`+cue 三元组并在命中时校验 `effectiveTier/rendererVersion/algoVersion`；App 侧对"时间轴偏差 >0.15s"以渲染产物为准并记日志 | 后端：`node --check` + `py_compile` + 纯函数级 6 项检查；渲染侧：tsc + 全量测试 |
| **P1-11** 复用磁盘产物 | `TransitionRenderer.ensureRendered()`（内存 → rehydrate → null）；`startTransition` 改用它并记录"缓冲不可用"降级日志 | tsc + `transitionRendererMemory`（one-shot 用例已按新契约更新） |
| **P1-12** 档位可见性 | 回填 `renderedPlan` 的 `qqAppliedTier/rendererVersion/fallbackReason/renderedDuration`；`TransitionDebugInfo` 增 `qqAppliedTier/tierFallbackReason`；切歌 toast 追加"实际档位 + 降级原因" | tsc + 全量测试 |
| **P1-13** 交叉淡化期间时间线 | 交叉淡化与 gapless 的进度 rAF 补发源曲合成 `currentTime`（渲染路径原有） | tsc + 全量测试 |
| **P1-14** 歌词 commit 帧跳变 | `LyricsDisplay.tsx`：新树初始不透明度对齐旧树退场前实际值（只读上一提交快照，StrictMode 安全） | tsc + `lyricsDisplayMotion` 等测试全绿 |
| **P1-18** 过渡中改设置不再掐断 | 过渡进行中打 `pendingReprepareRef`（不改 deps 触发 cancel），`commitTransition` 结束后消费重排 | tsc + 全量测试 |
| **P1-19** seek 保留可用计划 | seek 前先取 `planBeforeSeek`；落在窗口前 0.5s 之外且同曲对时重新武装、不重排；否则清空重排（判断不再恒假） | tsc + 全量测试 |
| **P1-20** 节拍匹配关闭时的时长 | `isDeckCrossfade` 纳入 `beat-crossfade && beatMatching=false`，收敛到设置时长 | tsc + 全量测试 |
| **P1-21** 调性旋转 | `krummhansl[(pitch - tonic + 12) % 12]`；测试 fixture 改为音乐学正确方向 | `transitionPlanner.test.ts` 65→99 用例（含 24 调矩阵、440 组距离表驱动）；逐条"还原→失败"验证 |
| **P1-22** energy 量纲 | planner 内 per-track 5%/95% 分位归一（`energyNormalizer`），风格判据与成本项统一走归一值；分析器格式未动 | 新增"同形状不同标度 → 同 style"用例；还原验证 |
| **P1-23** partialSync 预筛 | 整数倍救援移出 ≤100 守卫，100 上限改判 `effectiveBpmDifference`（`|fast/N - slow|`） | 新增 206.9↔103.45→ps2、160↔40→ps4、非整数倍仍降级 等用例；还原验证 |
| **P1-24** skipSilence | 新增 `buildCandidateWindows`：区间最小宽度 `max(min+4, 20%)`、窗口末端上界 `duration-outroSilence`、剪空时回退未裁剪候选并记 reason（v1/v2 共用） | 新增 5 条用例；还原验证 |
| **P2-18** djEffects 一致 | 无网格分支按 `finalChoreography` 重建 `djEffects` | 新增 2 条用例；还原验证 |
| **P1-25** folia resume | 有网格分支改 `plan['targetEndTime']`（与 v2 一致）；无网格分支用输出时长 | 纯函数级验证（含"网格 8.80s ≠ 目标窗 9.60s"的反例量化） |
| **P1-26** 无网格静音洞 | v2 无网格输出长度取两窗较小者 + resume 与之一致；**folia 无网格同样修复**（输出长度取 min 跨度、resume = targetStart + 输出时长） | 纯函数级边界验证 |
| **P2-1** PCM 保留 | 取消 playTransition 的"一进播放就删缓存"，由 TTL/容量与 source 释放兜底 | `transitionRendererMemory` 用例按新契约更新并通过 |
| **P2-2** 预载复用分支复位 | 复用分支在非过渡/非 handoff 期间发现 standby 在播则 pause + 归零增益 | tsc + 全量测试 |
| **P2-4** tooLate 日志口径 | 日志改为 `max(1.2s, 20%)`（与实现一致） | tsc |
| **P2-17** 队列变化兜底 | `commitPreparedSong` 找不到目标曲时不再静默 return：toast + `handleNext()` 重新同步 | tsc + 全量测试 |
| **P2-21** QQ 写盘保护 | 新增 `_write_wav_checked`：NaN/Inf 抛错 + 峰值 >0.98 tanh 软限幅 + 原子替换，peak/softLimited 写入 meta | `py_compile` + 纯函数级验证（PCM_16 保持、限幅生效、无临时残留） |
| **P2-22** 渲染在途去重 | `RenderRuntime.inflightRenders`（QQ 与 v1/v2 都按缓存键共享 promise）；QQ 产物原子写 | 注入假 electron 的 6 项检查全过 |
| **P2-23** 可诊断性 | stderr 正则扩为 `PY_RENDER_LOG_PATTERN`（含 qq-automix/fallback/cloud/match/lite/folia 等）并逐行转发；Traceback 段不截断 | 同上 6 项检查 |

### 本轮未做（及原因）

- **P1-14 的"真正 90% 视觉预切换"**：需要引入"视觉轨道"（`visualCurrentSong`）把展示层与 canonical 状态解耦，属较大 UI 重构 → 先用"歌词对称交叉"最小缓解；`commitPreparedSong` 仍按设计丢弃 `isVisualSwitch`。
- **P2-19 分轨 cue 时间轴映射**：需要把"源曲真实秒"经逐拍拉伸映射到输出网格，改动面大且需听感验证。
- **P2-20 `gainOffsetDb` 跨后端钳制统一**：四条渲染路径的响度语义不同，需测量/听感确认后再统一。
- **P2-22 的"渲染超时 kill worker"与 stem/track-stem worker 启动超时**：涉及 worker 重启语义与在飞任务，风险高于收益，本轮只做在途去重与原子写。
- **其它歌词面/表面一致性**（P2-7 的 AI 档进度条与时长展示、M2/L1/L2/L3/L7 的 immersive/wallpaper/PV 歌词面、P2-9 gapless 窗口门控、P2-10 纯交叉淡化 MV 预载、P2-11 Folia 裸 progress 与封面叠层缓动）与全部 **P3 低危项**：未动。
- **测试覆盖的结构性重构**（`selectTransitionAction` / `createTransitionHandoff` / `createDeckGraph` 等可测接缝、`useAudioPlayer` 挂载测试）：未动；本轮只新增了边界策略纯函数测试（1 文件）、MV 槽位 4 条、planner 40+ 条。

### 建议的回归顺序（真机）

1. 重启应用（开发环境的"重建即刷新"会自动带上新 bundle）→ `node .tmp-probe-audio.mjs` 应显示 `MediaElementAudioSourceNode = 2` 且 `routedToGraph: true`。
2. 播一对 **QQ** 曲目：日志应出现 `plan:qq-ok`；若仍降级，原因应是"未登录"而非"未匹配到"（说明身份已注入、只剩登录态）。
3. 播一对 **同专辑** 曲目：不应再是硬切，应有 gapless 拼接（或至少 60ms 淡入淡出）。
4. 过渡期观察：MV 背景连续播放（非静止帧）、commit 帧不闪回上一首、进度条不冻结。
5. 过渡进行中拖动进度条 / 改设置：不应出现"两首歌一起响"或"淡出弹回满音量"。
6. 播一首**试听片段**（30s）：应给出准确降级文案（分析时长与流时长不一致 → 直接说明"该曲仅试听片段"），且不得把该曲对永久锁死（节流兜底已修，仍建议人工确认）。

---

## 第九部分：过渡视觉重构设计（视觉轨道 / Visual Track，2026-09-29）

### 9.1 要解决的三个观感问题（用户反馈）

1. **过渡看起来"卡"**：逐帧进度原本走 `onStateChange` → App `setState`，还被 App 侧 10fps 节流（`App.tsx` 的 `lastTransitionProgressThrottle`）；而**封面叠加层直接写 opacity、没有 CSS 过渡**（`AlbumCoverPlayer`）⇒ 交叉淡化是 10 步/秒的台阶。
2. **切到第二曲后"差点意思"**：视觉切换（歌名/封面/歌词）被推迟到**音频提交帧**，于是提交那一刻整屏跳变（"过渡完毕刷新了一下"）。
3. **歌词不丝滑**：过渡期歌词被压暗到 ~12%（整段动画窗口），提交帧才换成新歌；且歌词面板的**内容是 canonical 的**，而时钟已随过渡走 ⇒ 时间线/内容错配。

### 9.2 架构：把"视觉权威"从"播放权威"里拆出来

| | canonical（播放权威） | visual（画面归属） |
| --- | --- | --- |
| 内容 | `currentIndex` / `currentTrack` / 播放时钟 / 队列 revision / 歌词归属 / 音频 deck | `visualTrack`（trackKey/index/封面/歌名/歌手/歌词） |
| 何时变 | **真正的提交帧**（音频 deck 已经切到目标曲） | **进度 90%**（视觉轨道切换点） |
| 谁写 | `commitPreparedSong`（引擎的 `transitionCommit`） | `applyVisualSwitch`（引擎的 `visualSwitchCommit`，原本被 `commitPreparedSong` 丢弃） |

播放页的展示全部经 `currentSong` / `lyrics` 两个绑定读取（`src/App.tsx`：`const currentSong = visualTrack ? playlist[visualTrack.index] ?? canonicalSong : canonicalSong`）——视觉轨道生效时它们指向目标曲，其余时间等于 canonical。
**提交帧零变化**由此成立：90% 已把画面切到目标曲，提交帧只是把 canonical 换成同一首曲目并在同一批清空视觉轨道。

不变量（新增代码里显式校验）：`visualTrack.trackKey` 必须等于提交曲目，否则 `console.warn` 并回退到 canonical。

### 9.3 逐帧通道：`transitionVisualStore`（订阅式，不再经 App 整树）

- `src/audio/transitionVisualStore.ts`：`{active, progress, duration, sourceTime, targetTime, switched, fromTrackKey, toTrackKey}` + `begin/publish/markSwitched/end/reset`；生命周期挂在 `setTransitionState` 上（`running-transition` → `begin`，`playing` → `end(hold=true)` 保最后一帧，`cancelled/failed/idle` → `end(false)`）。
- 引擎在三条过渡 rAF（渲染缓冲 / 交叉淡化 / gapless）里 `emit({transitionProgress, transitionDuration, transitionTargetTime, …})`，`emit` 顺手把进度广播进 store（~30fps）。
- 叶子组件用 `useTransitionVisualProgress(store, fallback)`（`src/hooks/useTransitionVisual.ts`，`useSyncExternalStore`）**只重渲染自己**，并用 `transition: opacity 120ms linear` 把 30fps 采样平滑成连续画面：
  - 封面：`AlbumCoverPlayer`（新增 `transitionProgressStore` prop）
  - 歌名/歌手：**新组件** `src/components/TransitionTrackTitles.tsx`（双层交叉，App 里两处内联块已替换）
  - 整页封面背景：`PulsingCrossfadeBackground` / `CrossfadeBackground`（App 内联组件，透传 store）
  - MV 背景：`BilibiliMvBackground`（新增 `transitionVisualStore` prop，staged 槽渐入吃逐帧进度）

### 9.4 时间线：90% 换轨 + 连续时钟

- 90% 之前：UI 时间线 = 源曲合成时间（原有行为）。
- 90% 之后：引擎把 `playTransition` 的目标时间轴（`transitionTargetTime`）作为 `currentTime` 发进 `playbackTimeStore`，并带上**目标曲时长** ⇒ 进度条/已播时间/歌词高亮一起切到目标曲，且因为 `progress=1` 时 `transitionTargetTime ≡ targetEndTime`，**提交帧时间线与 deck 真实位置严格连续，不跳**。
- `overlayProgress`（叠加层归一化进度）端点从"过渡结束"改为 **90% 切换点**：交叉淡化在切换那一帧到 100%，随后叠加层退休，canonical 展示接替 —— 画面没有任何过渡残留。

### 9.5 歌词

- 歌词内容（`lyrics` 绑定）跟随视觉轨道；时钟已在 9.4 切到目标曲 ⇒ 内容/时钟一致，不再"新时钟配旧歌词"。
- 过渡期不再压暗到 12%：视觉切换后 `isVisualTransitioning` 已为 false，`transitionFadeProgress` 归零；`LyricsDisplay` 自身的切换交叉（含上次修复的"初始不透明度对齐旧树"）负责丝滑过渡。

### 9.6 可观测性

每次过渡在 `automix-backend.log` 落两行：
```
[VisualTrack] switch → <trackKey> @<targetTime>s（叠加层退休，画面交给 canonical）
[VisualTrack] commit → <trackKey>（视觉轨道=<key>，两者一致时画面零变化）
```
先 `switch` 后 `commit`、两者 trackKey 相同 ⇒ 设计生效。

### 9.7 验证状态（诚实记录）

- ✅ `tsc --noEmit` 0 错误；`vitest run test/` 全绿（含新增 `test/transitionOverlayProgress.test.ts` 的视觉轨道断言；`TraditionalView` 为已知偶发用例，重跑即过）；`vite build` 成功。
- ⚠️ **端到端运行时验证未完成**：驱动播放时页面恰好被开发环境的重建刷新，且双击命中了一行本地 MV（不是音频曲目），因此没有采到 `VisualTrack switch/commit` 日志。请在真机上按下面步骤确认（1 次过渡即可）：
  1. 播放任意两首相邻歌曲（QQ 曲目最佳，能看到 Enhanced 档位）；
  2. 过渡最后几秒观察：封面/歌名/背景/歌词应在**同一进度**下交叉，且**提交帧不再有跳变**；
  3. `automix-backend.log` 应出现 `[VisualTrack] switch → X` 紧接 `[VisualTrack] commit → X`（同一 trackKey）。
- 已知未覆盖（有意保留）：队列/列表行的"正在播放"高亮仍在**提交帧**切换（它按 canonical 的 `songKey` 比较，属次要表面，未做 prop 透传）；`modeng`/`pv`/`wallpaper` 等其它歌词面的 12% 暗态与各自的内联歌名块未改（主播放页两处 + 封面 + 背景 + MV 已统一）。

### 9.8 后续优化（同日第二轮）

1. **统一"叠加层展示进度"为一个共享纯函数** `transitionOverlayProgress(progress, duration, animationLeadSeconds)`
   （`src/hooks/useTransitionVisual.ts`）——此前封面/标题用 App 侧"最后 4 秒窗口"归一化，而我第一版把 MV/整页背景直接接到 store 的**整段过渡进度**上，两者口径不一致（背景会在 12 秒里慢慢crossfade）。现在四处（封面 / 歌名歌手 / 整页背景 / MV）都走同一个函数：
   ① 窗口门控（`progress < 1 - lead/duration` 时保持 0）；② 最后 4 秒窗口；③ **终点 = 90% 切换点**；④ **smoothstep 缓动**（两端更缓、中段更快，观感从"推过去"变成"滑过去"）。
   引擎在 `setTransitionState('running-transition')` 时把 `animationLeadSeconds`（AI 长混音 20s / 其余 10s）写进 store，保证与 App 侧 `transitionStartTime` 口径一致。
2. **进度条"换轨滑行"**（`src/components/PlayerControls.tsx`）：视觉轨道在 90% 把时间线从源曲切到目标曲，进度条/时间数字本会瞬间跳（例：5:12 → 0:34）。现在只在**过渡期间**（`transitionStartTime != null`，用户拖动与普通 seek 不受影响）对这个 ≥1.5s 的跳变做 ~420ms 的 smoothstep 滑行，并把显示值夹在当前曲时长内 ⇒ 进度条从接近满格**平滑回卷**到目标曲位置，时间数字同步变化。
3. 其它歌词面（modeng / pv / wallpaper / glorious / multidimensional / immersive）保持原状：它们的暗态门控用 `isVisualTransitioning`，视觉轨道切换后即恢复满亮 ⇒ 切换点自然变成"新曲歌词亮起"，不需要额外改动；若要进一步统一，可把它们的内联歌名块也换成 `TransitionTrackTitles` 并接 store（列在待办）。

### 9.9 修复"半套切换 / 串台"（用户实测：歌名与歌词已是下一首，封面还是上一首）

三条根因，都属"视觉轨道只切了一半"：

1. **播放页优先用 `appleCoverUrl` 而不是 `coverUrl`**（Modeng/Pv 等页面都是 `appleCoverUrl || coverUrl`），而 `applyVisualSwitch` 当时没有清它 ⇒ 切轨后封面仍渲染上一首的 Apple 高清封面。
   修：切轨时同样 `setAppleCoverUrl(null)` + `resolveAppleCover(目标曲)`，封面随视觉轨道一起走。
2. **动态封面（Apple HLS 动画封面）按 canonical 曲目给** ⇒ 页面会渲染旧曲的动画封面并盖掉静态封面。
   修：视觉轨道生效期间 `animatedCoverUrl/animatedCoverPoster` 一律置空（回退静态封面 = 目标曲），提交后自动恢复。
3. **健壮性**：此前只有"提交帧"会清视觉轨道，而视觉切换发生在提交之前 ⇒ 一旦过渡被取消/失败/直接 `idle`（未走到提交），就会永久停在"歌词/背景已是下一首、封面/歌名还是上一首"的半套状态。
   修：在 `cancelled/failed/idle` 这三个终态里也回退视觉轨道（带 `console.warn` 记录），保证"要么整套切过去、要么整套退回来"。

切轨点的语义（不变）：视觉在过渡 **90%** 处整套切换，音频提交在其后约 10% 的时间（12s 过渡 ≈ 1.2s）发生，提交帧画面零变化。若希望视觉领先更少，把 `overlayProgress`/`markSwitched` 的 `end = 0.9` 调大即可（单一常量）。

### 9.10 修复"歌曲开始 1~2 秒后 MV 背景串到下一首"（视觉轨道自身引入的回归）

**现象**：播放 "Thank you for dears." 的第 1 秒背景还是本曲 MV，第 2 秒变成下一首（Cold Blood）的画面并一直保持；此时过渡根本还没开始（调试弹窗显示"即将在 5:11 开始智能混音"）。

**根因（本轮视觉轨道引入）**：
1. `transitionVisualStore.end(holdFinalFrame=true)` 在每次过渡提交后**保留最后一帧**（`progress` 停在 1，`active=false`）——这个保帧是为 App 同一批渲染准备的；
2. 而叶子组件的订阅 hook（`useTransitionOverlayProgress`）**只读 progress、没检查 `active`** ⇒ 非过渡期也返回 1；
3. 现在云端 cue 很快（身份注入修复后 extreme 档真的生效了），**歌曲开始约 1~2 秒就进入 armed** ⇒ `transitionActive`（有过渡目标）为真，且下一首 MV 的预载槽已经落槽 ⇒ 该槽按 `opacity = 1` 显示，盖住了本曲 MV。
   时间线因此正好是"1 秒本曲 MV → 2 秒下一首 MV"。

**修法**：
1. `useTransitionOverlayProgress`：`snapshot.active === false` 一律返回 **0**（保帧只留给 App 侧同批渲染）。
2. 顺带收紧 MV 的 `isTransitioningStagedSlot`：staged 槽只在"动画窗口内（叠加进度 > 0）"才播放/显示——预载期不再以 1080p 空转解码数分钟。

**回归锁**：新增 `test/transitionVisualProgress.test.ts`（4 例）——含"store 保帧后叶子组件必须读 0"这条行为断言，以及窗口归一化 + smoothstep 的单调/边界断言。

### 9.11 过渡 HUD 药丸：对齐 / 语义 / 配色 / 动画（用户反馈四条）

1. **「关闭」不在水平线**：按钮改为 `inline-flex + alignItems:center + lineHeight:1 + 对称内边距`（`AutomixHudBadge.tsx`），与主文案同一基线；顺带补了 `title`/`aria-label` 说明语义。
2. **「关闭」的语义 = 本曲不做智能混音**（想完整听完这首歌），不是"隐藏通知"：
   - 引擎新增 `skipAutoMixForCurrentPair()`：按 `source->target` 记入跳过集合，丢弃在飞的准备/渲染并立即把计划换成"末尾短交叉"安全网（`preserveNext` 保住 standby 与元数据、不重载音频、不对外播 cancelled 状态）；
   - `prepareAutoMix` 把跳过检查提到"已准备"缓存判断**之前** → 本曲对不再分析/渲染，也不再进节流重试链；
   - 只影响这一对曲目，下一首自己的过渡照常走智能混音；
   - App 侧对该曲不再显示药丸（`automixHudSkippedTrackKey`），并顺带**只对"智能过渡"显示药丸**——降级成普通交叉淡化时不再弹"开始智能混音"这种误导文案。
3. **底色改用当前封面主题色**（淡）：`accentColor` 通过 `color-mix(in srgb, <主题色> 26%, <原底色>)` 混入，modern 页与 modeng 页都接上了（保持文字对比度）。
4. **渐入/渐出更快**：0.4s/0.6s → **0.22s/0.3s**，CSS 过渡改为 `opacity 0.24s ease-out` —— 既跟手，又把播放时间轴 ~250ms 量化造成的台阶抹平（此前 0.16s 线性过渡看着"慢又顿"）。

回归锁：新增 `test/automixHudBadge.test.tsx`（3 例：color-mix 底色 + 0.24s 过渡 / 关闭按钮对齐与回调触发 / 淡入淡出预算收紧）。

### 9.12 「关闭」对齐：从"垂直居中"升级为"整行基线对齐"（实测校准）

用户复看截图仍觉得「关闭」不在水平线上。原因不是按钮盒子没居中，而是**字号不同**：
- 旧实现整行 `items-center` → `关闭`(10.5px) 与主文案(11.5px) 各自垂直居中，两者**文字基线**相差约 0.6px（字号越小，居中时基线越偏低）。小字体下这点差值肉眼可辨。
- 现实现整行 `items-baseline`（文字基线严格同线），图标单独 `alignSelf:center`（SVG 的"基线"是底边，跟随基线会往下沉）。

**实测校准**（在运行中的应用里用真实样式表渲染 5 个候选布局，探针法精确测基线：行内插 `width/height:0` 的 inline-block，其 bottom 边即基线）：

| 变体 | 行 align | 按钮 | Δ基线(关闭−主文案) | Δ图标中心 |
|---|---|---|---|---|
| **A（现实现）** | `items-baseline` | inline-flex + align-items:center | **0.00px** | 0.00px |
| B | `items-baseline` | inline-flex + align-items:baseline | 0.00px | 0.00px |
| C（旧实现） | `items-center` | inline-flex + center | **−0.64px** | 0.00px |
| D | `items-baseline` | display:inline | 0.00px | 0.00px |

→ 采用 A：对齐误差 0px，图标中心 0px，布局盒子（16.5px 高）不变。回归锁 `test/automixHudBadge.test.tsx` 已改为断言"整行 items-baseline 且不得回到 items-center + 图标 alignSelf:center + 按钮对称内边距 + 主文案 line-height 1.15"；诊断脚本保留为 `.tmp-probe-hud-align.mjs`（不入库）。

### 9.13 过渡体验第二轮（用户七条反馈：倒计时/文案/断层/歌词交叉/控件抽动/纯音乐版面/控件帧率）

**① 药丸改成 8 秒倒计时（不含淡入淡出）**
- 文案由「即将在 m:ss 开始智能混音」改为「即将在 N 秒后开始智能混音」，N 取 `ceil(剩余)` 并钳在 1..8。
- 显示窗口 = 切点前 `8 + 0.22s`（淡入）出现、淡入结束那一刻恰好还剩 8 秒常显；切点到达即淡出（0.3s）后卸载。
- 通知不再"每曲只播一遍就消失"：窗口外不显示、窗口内（含 seek 回到窗口内）都会显示；过渡开跑（`phase!=armed`）或点「关闭」才记为已通知。

**② 去掉「介入中」文案，直接显示引擎名 + 辉光**
- `PlayerControls` 的 `AutoMix Enhanced 正在介入` → 只显示 `AutoMix Enhanced`（`AutomixHudProgressHint` 的「即将介入/过渡效果」同样去掉，统一显示引擎名）。
- 辉光保留并加强（等待期 9px、过渡中 12px+24px 双层金色 textShadow）。

**③ 交接断层（"过渡播完像跳过去"）—— 引擎侧**
根因：无 overlap 的渲染过渡（QQ Enhanced / 旧版智能渲染）在**缓冲结束之后**才 `seek + waitForPlayable + play()`，
中间是纯静音（seek ≤400ms + 等待 ≤3000ms），随后 deck 以瞬时满增益硬起播。
修复：
- `TransitionRenderer.playTransition` 新增 `handoffFadeSeconds`（默认由调用方传 0.35），无 overlap 时也给缓冲挂总线 gain：
  头段满增益 → 尾段 `0.35s` 线性渐出 → 缓冲结束归零；并把 **缓冲结束的 AudioContext 时刻** `bufferEndCtxTime` 回传。
- `useAudioPlayer`：两条路径统一「提前起播」——缓冲结束前 `lead`（overlap 路径 = overlap 秒；无 overlap = 固定 0.6s）
  把目标 deck 以 0 增益起播（预载早已 seek 到 `resume - lead`，此处只是"按播放键"），
  增益渐入**锚在 `bufferEndCtxTime` 这条 AudioContext 时钟上**（不再依赖 `play()` 返回时机）。
- `handoff`：deck 已起播即 `setDeckGain(1) + commitTransition`（不 seek、不 play）；
  提前起播仍在途时先等它结算（≤450ms）再决定，避免两条路径抢同一个 deck。
- 回归锁：`test/transitionHandoff.test.ts`（4 例：尾段渐出锚点/20% 钳制/overlap 曲线不变/未传参不插 gain）。

**④ 歌词交叉淡化（按过渡时长）+ 切歌不再"归位/上滚"**
- 新增 `transitionLyricsCrossfadeProgress`（0→1 覆盖**整段过渡**，终点锚在 90% 视觉切换帧，不做最后 4 秒窗口门控）
  与 `useTransitionLyricsCrossfade` / `useTransitionVisualIdentity`（只订阅离散事实，逐帧进度不触发宿主重渲染）/ `useTransitionTargetTime`。
- App 用预载缓存里的**下一首歌词**在过渡期渲染一个"先行淡入层"（`TransitionIncomingLyrics`，用目标曲时间轴驱动），
  与主歌词树形成交叉（旧 `1-q` / 新 `q`）；视觉切换帧由 canonical 歌词**同位置、同样式、无入场动画**接替 —— 切换帧零可见变化。
- 切歌"向上滚"的三处根因一并修掉：
  1. 滚动定位改成在**当前歌词树内部**查询行节点（旧实现在整个滚动容器里查，切歌瞬间命中仍在退场的旧树 → 滚到旧位置再平滑追回去）；
  2. 托管窗口内滚动一律瞬时（`managedCrossfadeRef`），摩登风格的弹簧 `springY.jump` 而非 `set`；
  3. 行入场动画（y:18 + blur）在托管窗口内关闭。
- 托管切歌的锚点由"先行淡入层"上报（`onActiveIndexChange` → `indexHint`），避免"先闪一帧第一句再跳到正确句"。
- 回归锁：`test/lyricsCrossfade.test.tsx`（5 例）+ `test/transitionVisualProgress.test.ts` 新增 3 例。

**⑤ AutoMix 文案进出不再"抽一下"**
- 文案从"文档流里插一行"改为**绝对定位**挂在药丸/白条上方（出现/消失不再把控件顶动）；
- 去掉 `key={transitionLabel}`：文案变化不再触发卸载/重挂载（remount 是"抽"的另一半原因），只做 0.32s 不透明度淡入。

**⑥ 有词 ↔ 纯音乐 过渡的版面**
- `isPureMusic` 以前只在**音频提交帧**更新 → 过渡播完那一刻版面才跳到居中/双栏（用户实测最难看的一处）。
  现在与视觉轨道**同帧**更新（在 `applyVisualSwitch` 里按目标曲预载歌词重算）。
- 默认播放页的两个分支（纯音乐居中 / 有词双栏）**合并成一棵树**（`key="default-player"`）：
  同一个封面元素 + `layout="position"` 动画 → 封面在两态之间**滑过去**，不再重挂载（MV/封面不再被重建），
  也不再有"抽一下到中间"。歌词列在纯音乐时收起、过渡期（下一首有词）临时展开，让歌词交叉可见。
- 其它歌词模式（immersive/wallpaper/folia/glorious/pv/modeng）保持原版面（`PURE_MUSIC_OWN_LAYOUT_MODES`）。

**⑦ 播放控件（底部药丸）帧率/丝滑度**
- 进度条滑轨：`transition-all duration-200` → `transition-[height] duration-200`。
  背景是随播放进度变化的 `linear-gradient` 字符串，`transition-all` 会让浏览器每次 timeupdate 去插值整条渐变（重绘滑轨）——
  这是"控件动画卡、帧率不够"的主要来源。
- `@keyframes glow` 由"同时动 text-shadow + opacity"改为只动 opacity（合成器友好）；静态辉光交给 inline textShadow。
- 其余 `transition-all` 收窄为 `transition-colors`。

**本轮验证**：`tsc --noEmit` 0 错；`vitest run test/` 198 文件 / 1863 用例通过（TraditionalView 那条老偶发用例本次通过）；
`vite build` → `index-BjAsNHcX.js`；在运行中的应用里重新加载并检查：无异常、播放页（合并后的版面）正常渲染、歌词行不透明度/焦点行正常。

### 9.14 无人值守实测核查（用户不在场，CDP 驱动 + 音频探针）

用 CDP 原生输入驱动应用真实播放（automix测试 歌单，QQ Enhanced/extreme 档），在页面 world 里给每条
GainNode 挂旁路 AnalyserNode（不接 destination、不影响出声），以 40ms 采样跨越 **3 次真实过渡**：

| 核查项 | 结果 |
|---|---|
| 药丸倒计时 | 3 次过渡全部按 **8→1** 整秒递减（截图：`即将在 8 秒后开始智能混音 关闭`，正是 Thank you for dears → Cold Blood 这一对） |
| 交接静音缝 | 560 个快速采样（覆盖 3 次过渡的交接窗）中，"所有支路同时静音"的时刻为 **0**；全程最大支路 RMS 的最小值 0.0205（无数字静音）。修复前该路径必然出现 seek+等待造成的数百毫秒全静音 |
| 歌词交叉 | 过渡期出现**两棵歌词树共存**（行数 102 → 136，旧树淡出未卸完、新树已挂），截图可见旧词整体按过渡进度变暗；进入纯音乐那一段（行数 0）走合并版面无异常 |
| 视觉轨道 | 3 组 `VisualTrack switch → commit` 成对出现（切换帧零变化的既定设计） |
| 稳定性 | 全程 0 异常；播放页/歌单页/纯音乐页均正常渲染 |

顺带修复：右上角预告卡的档位徽章写死 `Pro`，与「Enhanced 过渡」文案打架 → 现在跟随实际档位显示 `EN`/`Pro`。

**未能覆盖（如实记录）**：① 交接的**听感**（是否还有"一瞬没接上"）无法机器判定，需用户实听；
② 歌词叠加层的 0→1 不透明度轨迹没抓到——探针选择器命中了别的节点，但"两树共存 + 旧词变暗"两张截图已能证明交叉在跑；
③ 探针采到的 44 条增益支路无法逐一对应到"缓冲总线/deck"，用"全支路静音=0"作为缝的判据（该判据对旧缺陷是充分必要的）。

### 9.15 过渡 HUD 文案回改（用户反馈三条：药丸时间节点 / 引擎名只显示档位 / 预告卡对不上介入点）

用户复看后指出三处与预期不符，逐条改回：

**① 药丸改回「时间节点」，节奏为「播放满 5 秒提示一次 → 显示 8 秒 → 渐隐」**
- 文案：`即将在 N 秒后开始智能混音` → **`即将在 m:ss 开始智能混音`**（`formatAutomixHudTime(startAt)`，
  即 §9.13 之前的形态；`automixHudCountdownSeconds` 一并删除）。
- 提示节奏（用户二次修正，既不常显也不做倒计时）：本曲播放位置 ≥ **5 秒**才提示，
  显示 **8 秒**（`AUTOMIX_HUD_NODE_DELAY_SECONDS` / `AUTOMIX_HUD_NODE_HOLD_SECONDS`）后渐隐卸载，
  每曲一遍（跨播放页卸载重挂也认，靠模块级 `automixNotificationMemory.notified`）。
- **计划晚到的兜底不需要额外分支**：入场条件是「播放位置 ≥5s ∧ 计划已就绪」，
  冷启动 / 新歌新列表没预载时计划晚于 5 秒才就绪，那一刻前一条早已成立 → 就绪即提示。
- 无缝衔接（gapless）不出药丸：它没有「开始智能混音」的时间节点，只由进度条上方的金色引擎名承担。

**② 进度条上方只显示引擎名，且只能是这四个**
- 新增单一真源 `transitionEngineDisplayName(strategy, autoMixEnabled, tier)`（`AutomixHudBadge.tsx`）：
  `AutoMix`（standard）/ `AutoMix Pro`（v2）/ `AutoMix Enhanced`（QQ 云档）/ `Gapless`；
  没有归属引擎（纯交叉淡化 fixed-crossfade / none）→ 返回 `null`，**什么都不显示**
  （不再出现「过渡」这种通用词，也不再出现「即将介入 / 正在介入 / 过渡效果」）。
- 两处消费方统一接上：`PlayerControls` 药丸上方的金色标签（`transitionEngineLabel`）与
  `AutomixHudProgressHint`（`AutomixHudInfo.engineLabel`）。
- `automixHud` 的构造同时放开 gapless：`transitionStrategy === 'gapless'` 时也给一份
  `kind: 'gapless'` 的 HUD（`startAt/endAt = duration`），因此**无缝衔接也会在进度条上方显示 `Gapless`**；
  药丸侧用 `kind` 拦住（见 ①）。
- 可见时机：standard 档 = 过渡窗口内；Pro / Enhanced = `running-transition` 全程（从介入瞬间起就显示，
  不再等动画窗口）；gapless = 边界前 8 秒窗口内 + 拼接瞬间。

**③ 右上角预告卡倒计时对齐「进入 AutoMix 的一瞬间」**
- `LiveUpNextNotification` 的 `eventTime` 由 `transitionStartTime`（= 动画窗口起点）改为优先取
  `automixHud.startAt`（= 过渡计划里的介入点，与药丸时间节点同一个值）；取不到时回退旧逻辑。
- 原因：AI 长混音的介入点比动画起点早几十秒，旧实现下卡片会在混音已经开跑后才数到 0
  （用户实测「和 automix 介入的时间不同」）。

**回归锁**：`test/automixHudBadge.test.tsx` 重写为 9 例：5 秒前不渲染 / 5 秒后显示 m:ss 时间节点、
显示满 8 秒渐隐卸载且同曲换切点不重弹、**计划晚到（播放位置已 42s）就绪即刻提示**、
`phase=running` 淡出卸载、`transitionEngineDisplayName` 四档映射 + 无归属时返回 null、
gapless 不出药丸但进度条提示显示 `Gapless`、底色 color-mix、基线对齐、淡入淡出预算。

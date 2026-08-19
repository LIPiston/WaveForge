/**
 * fusion —— 空间音频融合层（公共 API，供 attachV3Engine 与调音室 UI 使用）
 *
 * 职责：
 *  - 参数快照（独立于 V3EngineParams，localStorage 'waveforge:spatial-params' 惰性恢复）、
 *    订阅通知、patch 深合并；
 *  - 实时链同步（镜像 syncPitchChain 范式）：v3Node → SpatialNode → analyser，
 *    seq 竞态防护、上下文变化重置、v3 节点身份检测（host.attach 重建节点时自动重接）、
 *    失败静默保持 v3Node→analyser 直连（音频不中断）；
 *  - 离线导出后端工厂（createExportBackend：wasm 优先 / TS 兜底 + 网格装载）；
 *  - 处理器统计回传缓存（getSpatialStats）+ CPU% 估算（estimateCpuPercent）；
 *  - HRTF 数据集（用户导入 SOFA → 运行时换网格）：采样率不匹配自动重采样
 *    （resampleGrid，多相 Kaiser-sinc，导入时一次性）、活动数据集跨重启自动恢复
 *    （setHrtfDataset 写 localStorage 锚点，restoreHrtfDataset 在 attach 流程恢复）；
 *  - 内置 HRTF 数据集切换（规划书 §4.1：KEMAR / CIPIC 两套内置）：
 *    setBuiltinDataset 解码内嵌网格 → postGrid 热更新 + localStorage 锚点
 *    （getBuiltinDataset 读取；attach 恢复顺序见 setBuiltinDataset 头注释）。
 *
 * 拓扑：masterGain → [soundtouch?] → v3Node → [spatial?] → analyser。
 * 本模块仅被主线程（渲染进程）使用；worklet 处理器绝不 import 本模块。
 */

import { SpatialNode } from './SpatialNode'
import type { SpatialStats } from './SpatialNode'
import { createSpatialStore, deepMerge } from './persistence'
import { saveHrtfDataset, getLatestDataset } from './hrtfStore'
import { createWorkletBackend } from './backendIndex.generated'
import { loadSpatialGrid, loadBuiltinGrid } from './gridSource'
import { Resampler } from '../dsp/Resampler'
import type { SpatialBackend } from './SpatialBackend'
import type {
  DeepPartial,
  HrtfGrid,
  InstantSpatialSettings,
  SpatialParams,
  SpatialRenderConfig,
  SpeakerRoute,
  VirtualSpeaker,
  VirtualSpeakerCfg,
  WorldSettings,
} from './types'
import { createDefaultSpatialParams, instantSpeakers } from './types'
import { headLockedSpeakers } from './layouts'
import { stageRoom, stageSpeakers } from './scenes'
import { computeRelativeDirection, computeTrajectoryPosition } from './controller'
import { AMBIENCE_SPEAKERS } from './ambisonics'

const store = createSpatialStore()

// —— 模块状态 ——
let currentParams: SpatialParams | null = null // 惰性 restore
const subscribers = new Set<(p: SpatialParams) => void>()
let spatialNode: SpatialNode | null = null
let wired = false
let spatialCtx: AudioContext | null = null
let spatialSeq = 0
let registerPromise: Promise<boolean> | null = null
let lastWiredV3Node: AudioNode | null = null
let lastHandle: { audioContext: AudioContext; analyser: AnalyserNode } | null = null
let lastSyncGetNode: (() => AudioNode | null) | null = null
let lastStats: SpatialStats | null = null
/** 当前接线节点的输出声道数（output==='multichannel' 重建判定用；默认 2 双耳） */
let spatialOutputChannels = 2

function ensureParams(): SpatialParams {
  if (!currentParams) currentParams = store.restore()
  return currentParams
}

// ==================== 参数读写 / 订阅 ====================

/** 当前空间参数快照（惰性恢复持久化值；未设置过时返回默认） */
export function getSpatialParams(): SpatialParams {
  return ensureParams()
}

/** 整包替换（快照语义）：持久化 → 通知订阅 → 同步实时链并下发配置 */
export function setSpatialParams(p: SpatialParams): void {
  currentParams = p
  store.save(p)
  for (const cb of [...subscribers]) cb(p)
  // 已接线 → 仅重发 config；未接线但激活 → 尝试接线（未挂过链时 getter/handle 为 null，直接返回）
  void syncSpatialChain(lastSyncGetNode ?? (() => null), lastHandle)
}

/** 局部修改：深合并当前快照后提交（数组/Float32Array 整段替换） */
export function patchSpatialParams(partial: DeepPartial<SpatialParams>): void {
  setSpatialParams(deepMerge(ensureParams(), partial))
}

/** 订阅参数变化（返回退订函数） */
export function subscribeSpatialParams(cb: (p: SpatialParams) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/** 空间化是否激活（mode !== 'off'） */
export function isSpatialActive(): boolean {
  return getSpatialParams().mode !== 'off'
}

/** 最近一次处理器统计回传（worklet 每 ~80ms 回传一次；未接线/未回传过为 null） */
export function getSpatialStats(): SpatialStats | null {
  return lastStats
}

// ==================== 处理器统计换算（CPU% 估算，规划书 §5.6 状态栏） ====================

/**
 * CPU% 换算块长（样本）：按 256 样本 @48kHz 约定（墙钟 ≈5.33ms）——
 * Web Audio 渲染量子（128）的 2 倍窗口，作为 worklet 处理耗时占比的展示尺度。
 * avgProcessMs 由处理器按每 stats 窗口（30 块）求均值回传（SpatialProcessor）。
 */
const STATS_BLOCK_SAMPLES = 256
const STATS_BLOCK_SECONDS = STATS_BLOCK_SAMPLES / 48000

/**
 * worklet 处理耗时均值 → CPU 占用估算（%）：avgProcessMs / 块墙钟时长。
 *  - 无 stats 或未回传 avgProcessMs（旧 worklet / 未接线）→ null（UI 显示「—」）；
 *  - 结果钳制 0..100（avgProcessMs 为墙钟均值，可能含调度抖动）。
 */
export function estimateCpuPercent(stats: SpatialStats | null): number | null {
  if (!stats || typeof stats.avgProcessMs !== 'number' || !Number.isFinite(stats.avgProcessMs)) {
    return null
  }
  const ratio = stats.avgProcessMs / 1000 / STATS_BLOCK_SECONDS
  return Math.max(0, Math.min(100, ratio * 100))
}

// ==================== 配置推导 ====================

/**
 * 缺省通道路由（声源路由完整版的默认回退；同时被 stage/world 分支复用）：
 * 立体声输入只有 L/R 两路源（channel 0=L、1=R），每个虚拟扬声器取最近的源——
 * 按方位角符号：az<0（左半场）→ 0、az>0（右半场）→ 1；正前方 C（az=0）取 0。
 * 于是 5.1/7.1.4 布局下 C/SL/SR 等扬声器都有声（多只共享同一路源，靠各自
 * 方位的 HRTF 方向感分离，层次由布局/距离/增益决定）；stereo 布局即 L→左、R→右直通。
 * 模式 B 自定义布局可用 HeadLockedSettings.routes 逐扬声器覆盖（见 routeSpeaker）。
 */
function headLockedChannel(azimuthDeg: number): number {
  return azimuthDeg <= 0 ? 0 : 1
}

/**
 * 模式 B 单只扬声器按路由展开（声源路由完整版：规划书模式 B「每个声源可指定
 * 路由到哪个/哪几个虚拟扬声器」——模式 B 的声源即输入 L/R 两路，路由粒度到
 * 扬声器，由 routes[i] 指定第 i 只扬声器由哪个输入声道驱动）：
 *  - 'l' → 1 只，channel 0（仅左源）；
 *  - 'r' → 1 只，channel 1（仅右源）；
 *  - 'both' → 2 只（channel 0 与 channel 1，gain 各 ×0.5，其余参数一致）——
 *    后端 channel 是单一索引，双路源混合由两只半增益扬声器近似（方向一致、
 *    等功率分配，叠加后与全增益双路混合等效）；完整多源混合（AudioObject.routes
 *    指向任意多个扬声器）后续 wave；
 *  - undefined（routes 空或长度不足）→ 按方位角就近（headLockedChannel，回归）。
 */
function routeSpeaker(cfg: VirtualSpeakerCfg, route: SpeakerRoute | undefined): VirtualSpeaker[] {
  const base = {
    azimuthDeg: cfg.azimuthDeg,
    elevationDeg: cfg.elevationDeg,
    distance: cfg.distance,
    gain: cfg.gain,
    size: cfg.size,
  }
  if (route === 'both') {
    return [
      { ...base, channel: 0, gain: cfg.gain * 0.5 },
      { ...base, channel: 1, gain: cfg.gain * 0.5 },
    ]
  }
  // 'l' → 0（显式覆盖方位角就近）；'r' → 1；undefined → 就近路由（回归）
  const channel = route === 'r' ? 1 : route === 'l' ? 0 : headLockedChannel(cfg.azimuthDeg)
  return [{ ...base, channel }]
}

/**
 * 多声道输入自动映射（② 模式 A 补全，规划书「自动分析输入立体声/多声道 →
 * 自动映射到虚拟扬声器」）：输入声道数 → 虚拟扬声器布局。
 * 标准声道序（输入/输出共用，SpatialProcessor 物理映射同表）：
 *   0=FL、1=FR、2=FC、3=LFE、4=SL、5=SR、6=RL、7=RR
 *  - ≤2 声道 → instantSpeakers(settings)（±spreadDeg/2 立体声对，行为与现状一致）；
 *  - 6 声道（5.1）→ FL/FR/C/SL/SR 五只主扬声器（channel 0/1/2/4/5，方位角与
 *    layouts.ts 51 预设一致：C=0°、FL/FR=±30°、SL/SR=±110°）+ LFE 静音占位
 *    （channel 3、gain 0——LFE 无方向性，信号忽略不渲染），共 6 只；
 *  - 8 声道（7.1）→ 上述 + RL/RR（channel 6/7，±140°，与 714 预设地面层一致），共 8 只；
 *  - 其余路数（3..5 / 7 / >8）→ 按 5.1（≤6）/ 7.1（≥7）就近映射；扬声器 channel
 *    超出实际输入路数时由后端「越界取 0 号输入」兜底。
 * 渲染路由：双耳输出走后端 processMulti（按 channel 逐声道取源、HRTF 求和）；
 * 物理输出（output==='multichannel'）由处理器按方位角映射到物理声道（干声直通）。
 */
export function multichannelLayout(
  channels: number,
  settings: InstantSpatialSettings = createDefaultSpatialParams().instant,
): VirtualSpeaker[] {
  if (channels <= 2) return instantSpeakers(settings)
  const base: VirtualSpeaker[] = [
    { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FL
    { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // FR
    { channel: 2, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // C
    { channel: 3, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 0, size: 0 }, // LFE 静音占位
    { channel: 4, azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SL
    { channel: 5, azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // SR
  ]
  if (channels <= 6) return base
  return [
    ...base,
    { channel: 6, azimuthDeg: -140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // RL
    { channel: 7, azimuthDeg: 140, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }, // RR
  ]
}

/**
 * 模式 C 声源轨迹查询（轨迹优先）：查 world.trajectories 中 sourceId 匹配的轨迹，
 * 按 world.playhead（秒）经 computeTrajectoryPosition 线性插值得当前位置；
 * 无匹配轨迹 → null（调用方回退 src.position，行为不回归）。
 * 播放时钟由 UI playhead 驱动（自动随曲目播放后续 wave）。
 */
function trajectoryPosition(world: WorldSettings, sourceId: string): { x: number; y: number; z: number } | null {
  const traj = world.trajectories.find((t) => t.sourceId === sourceId)
  if (!traj) return null
  return computeTrajectoryPosition(traj.keyframes, world.playhead)
}

/**
 * 参数快照 → 虚拟扬声器列表（off 无扬声器；instant/headLocked/world/stage 有；
 * output==='stereo' 时整体直通、speakers=[]，见 spatialConfigFromParams 输出模式分支）。
 */
function speakersFromParams(p: SpatialParams): VirtualSpeaker[] {
  if (p.mode === 'instant') {
    if (p.instant.multichannelAuto) {
      // ② 多声道输入自动映射（multichannelAuto）：输入声道数由处理器 stats 回传
      // （getSpatialStats.inputChannels；未回传过按 2 处理——立体声布局，行为与
      // 现状一致）。>2 声道 → multichannelLayout（5.1/7.1 布局，speaker.channel 按
      // 标准声道序路由，后端 processMulti 逐声道双耳渲染）；≤2 → instantSpeakers。
      const inCh = lastStats?.inputChannels ?? 2
      return multichannelLayout(inCh, p.instant)
    }
    return instantSpeakers(p.instant)
  }
  if (p.mode === 'headLocked') {
    // 声源路由完整版：routes[i] 显式指定第 i 只扬声器由哪个输入声道驱动
    // （'l'/'r'/'both'）；缺省（routes 空或长度不足）→ headLockedChannel 按方位角
    // 就近（回归）。routes 超长部分截断（只取前 speakers.length 项）——
    // 长度防御在融合层做，不强制参数快照对齐。
    // 静音/Solo（右键菜单）：muted 扬声器在后端渲染层以增益 0 表达（改 cfg 增益
    // 后照常走路由展开——'both' 展开的两只半增益扬声器同样置 0，其余字段透传
    // 不受影响）。Solo 语义在 UI 层已归一化为其它扬声器 muted=true、本只 false，
    // 融合层无需感知 Solo，只按 muted 标志置零增益。
    const routes = p.headLocked.routes
    return headLockedSpeakers(p.headLocked).flatMap((cfg, i) =>
      routeSpeaker(cfg.muted ? { ...cfg, gain: 0 } : cfg, i < routes.length ? routes[i] : undefined),
    )
  }
  // 模式 D：场景预设扬声器（座位/房间缩放后）按方位角符号路由 channel，规则同模式 B
  if (p.mode === 'stage') {
    // 自定义附加声源（规划书「可替换/添加个别声源」；UI 本地参数承载，不落 scenes
    // 预设表）：stageSpeakers 结果后按方位路由附加为虚拟扬声器。每个声源相对默认
    // 座位位置（原点听者 (0,1.6,0)、yaw=0 朝 +Z）经 computeRelativeDirection 计算方向
    // ——自定义声源与预设扬声器同一坐标系（scenes.ts 距离/方位语义，同模式 C 听者
    // 约定），channel 按方位角符号就近路由（同 headLocked：az<=0 → 0、az>0 → 1）。
    // 规划书「替换」语义 = 用户删除预设扬声器（完整布局编辑器后续 wave），本波实现
    // 「添加」：附加声源叠加在预设布局之上，不修改预设表。
    const custom = p.stage.customSources.map((src) => {
      const rel = computeRelativeDirection({ position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 }, src.position)
      return {
        channel: headLockedChannel(rel.azimuthDeg),
        azimuthDeg: rel.azimuthDeg,
        elevationDeg: rel.elevationDeg,
        distance: rel.distance,
        gain: src.gain,
        size: src.size,
      }
    })
    return [
      ...stageSpeakers(p.stage).map((cfg) => ({
        channel: headLockedChannel(cfg.azimuthDeg),
        azimuthDeg: cfg.azimuthDeg,
        elevationDeg: cfg.elevationDeg,
        distance: cfg.distance,
        gain: cfg.gain,
        size: cfg.size,
      })),
      ...custom,
    ]
  }
  // 模式 C：世界漫游 —— 每个声源对象按听者相对方位（computeRelativeDirection，
  // 已扣除听者 yaw）映射为一只虚拟扬声器，channel 按方位角符号就近路由（与模式 B
  // 同语义：az<=0 左半场 → L 源、az>0 右半场 → R 源）。听者移动/转头 → 方位角/
  // 距离变化 → 融合层随参数快照重发 config 即完成空间更新。sources 为空 → 无扬声器。
  // 注：完整声源路由/多声道输入（每源独立声道而非按方位角就近路由）留后续 wave；
  // 简化遮挡/衍射模型（规划书 §4.7）同样后续 wave。
  if (p.mode === 'world') {
    return p.world.sources.map((src) => {
      // 轨迹优先：有 sourceId 匹配的轨迹 → 按 playhead 插值位置（声源沿时间轨迹运动）；
      // 无轨迹 → 静态 src.position（现状）。听者移动/转头/playhead 推进 → 方位角/距离
      // 变化 → 融合层随参数快照重发 config 即完成空间更新。
      const pos = trajectoryPosition(p.world, src.id) ?? src.position
      const rel = computeRelativeDirection(p.world.listener, pos)
      return {
        channel: headLockedChannel(rel.azimuthDeg),
        azimuthDeg: rel.azimuthDeg,
        elevationDeg: rel.elevationDeg,
        distance: rel.distance,
        gain: src.gain,
        size: src.size,
      }
    })
  }
  return []
}

/**
 * 参数快照 → 渲染配置（全量替换语义；instant/headLocked/stage 模式有虚拟扬声器）。
 * stage 模式的 room/roomAmount 语义覆盖：room 取场景预设（scenes.ts 单事实源），
 * roomAmount 取 StageSettings.reverbAmount（氛围混响由舞台面板控制，与模式 A 全局
 * 房间混响互不影响）——与 instant 的 room/roomAmount 字段解耦。
 */
export function spatialConfigFromParams(p: SpatialParams): SpatialRenderConfig {
  // 输出模式：stereo = 立体声下混（干声直通）——speakers=[] 使处理器走直通复制路径
  // （SpatialProcessor：speakers 为空 → 直通），不经过 HRTF/房间渲染。环境声附加
  // （ambience）在 speakers 推导之后、按「enabled && mode!=='off'」独立附加，此处早退
  // 一并旁路——stereo 下环境上混与主渲染同为干声，无附加意义。
  // multichannel 的渲染配置与 binaural 相同（speakers 同推导，无输出模式分支）：
  // 真实物理多声道输出由处理器承接——输出 >2 声道（SpatialNode 按 outputChannels
  // 重建，见 syncSpatialChain）时按方位角映射到物理声道（干声直通）；2 声道设备
  // 退化为 binaural 渲染。输入 >2 声道时后端 processMulti 按 speaker.channel 路由
  // （speakers 的 channel 由 UI 或 multichannelAuto 的 multichannelLayout 给出）。
  if (p.output === 'stereo') {
    return {
      speakers: [],
      room: p.mode === 'stage' ? stageRoom(p.stage) : p.instant.room,
      roomAmount: p.mode === 'stage' ? p.stage.reverbAmount : p.instant.roomAmount,
      amount: p.instant.amount,
      distanceModel: 'inverse',
      // 性能模式映射：quality 用球谐插值（方位过渡更平滑），balanced/lowLatency
      // 用最近邻（更快）——直通早退分支同样透传该语义（与常规分支形状一致）
      hrtfInterp: p.perfMode === 'quality' ? 'spherical' : 'nearest',
      convolution: p.convolution,
      masterGain: p.masterGain,
      // 与常规分支同形状：world 模式填默认听者速度（直通下无实际效果，仅保持一致）
      dopplerVelocity: p.mode === 'world' ? { x: 0, y: 0, z: 0 } : undefined,
      // 与常规分支同形状：instant 模式透传多声道自动映射开关（直通下无实际效果）
      multichannelAuto: p.mode === 'instant' ? p.instant.multichannelAuto : undefined,
    }
  }
  const stageActive = p.mode === 'stage'
  const speakers = speakersFromParams(p)
  // 环境声 Ambisonics 上混（规划书 Phase 4 完整版：FOA 编解码渲染路径）：
  // ambience 开启且模式非 off 时，在任意模式（instant/headLocked/world/stage）主渲染
  // 扬声器之后附加 4 只环境扬声器（AMBIENCE_SPEAKERS：45/135/225/315 水平等角布局，
  // channel 0 取 L 源作环境输入、distance 6 背景层、size 0.8 扩散）。完整信号流由
  // 处理器环境混合器承接（SpatialProcessor.renderAmbience）：
  //   立体声/多声道输入 → stereoToFoa 能量提取（M/S：同相 → W、反相 → Y）→
  //   decodeFoaToSpeakers 解码到 4 方向 → 每块 FOA 动态增益调制（clamp [-1,1]、
  //   一阶平滑防抽吸、去相关延迟扩散）→ 4 路动态增益 × amount·0.5 叠加到输出。
  // 与简化版（固定增益 amount·0.5 馈 4 扬声器）的差异：本层只做附加标记与占位——
  // gain 0 占位使环境扬声器在后端无输出（且处理器下发后端前按 ambience 标记拆出，
  // 不进后端卷积），真实增益由处理器每块按 FOA 解码动态调制（相位抵消语义，可负）。
  // ambienceAmount 透传 p.ambience.amount（处理器环境混合量的缩放系数）。
  if (p.ambience.enabled && p.mode !== 'off') {
    speakers.push(
      ...AMBIENCE_SPEAKERS.map((s) => ({
        channel: 0,
        azimuthDeg: s.azimuthDeg,
        elevationDeg: s.elevationDeg,
        distance: 6,
        gain: 0, // 占位：真实增益由处理器每块按 FOA 解码调制（ambience 标记路径）
        size: 0.8,
        ambience: true, // 环境声扬声器标记：处理器走 FOA 动态增益调制路径
      })),
    )
  }
  return {
    speakers,
    room: stageActive ? stageRoom(p.stage) : p.instant.room,
    roomAmount: stageActive ? p.stage.reverbAmount : p.instant.roomAmount,
    amount: p.instant.amount,
    distanceModel: 'inverse',
    // 性能模式映射：quality 用球谐插值（方位过渡更平滑），balanced/lowLatency
    // 用最近邻（更快）；旧快照缺 perfMode（undefined）按 balanced 处理（最近邻）
    hrtfInterp: p.perfMode === 'quality' ? 'spherical' : 'nearest',
    convolution: p.convolution,
    masterGain: p.masterGain,
    // 环境混合量（ambience 附加时透传；未附加 → undefined = 处理器环境混合器关闭）
    ambienceAmount: p.ambience.enabled && p.mode !== 'off' ? p.ambience.amount : undefined,
    // 模式 C 专属：遮挡/衍射量（§4.7 简化模型）→ 后端增益衰减 + 高频低通；
    // 其余模式缺省（undefined）→ 后端全旁路（与无遮挡逐位一致）。
    occlusionAmount: p.mode === 'world' ? p.world.occlusion : undefined,
    // 模式 C 专属：听者速度（世界坐标 m/s）→ 后端多普勒（§4.6）。本波引擎侧只留
    // 接口：默认静止 {0,0,0}（无多普勒效果），UI 层移动听者时随 config 更新。
    // 其余模式缺省（undefined）→ 后端不启用多普勒。
    dopplerVelocity: p.mode === 'world' ? { x: 0, y: 0, z: 0 } : undefined,
    // ② 多声道输入自动映射开关（instant 模式透传；处理器按输入/输出声道数自检路由）
    multichannelAuto: p.mode === 'instant' ? p.instant.multichannelAuto : undefined,
  }
}

// ==================== 实时链同步 ====================

/**
 * 目标输出声道数（SpatialNode 构造用）：output==='multichannel' 时按布局类型
 * 重建节点为 6/8 声道（处理器输出 >2 声道走物理声道映射，见 SpatialProcessor）：
 *  - SpatialParams.multichannelChannels 显式设置（6|8）时优先；
 *  - 否则按 headLocked/stage 布局类型推导：7.1.4 → 8、5.1/其它 → 6；
 *  - output 非 multichannel → 2（双耳）。
 * 真实设备声道能力检测（按输出设备实际声道数退避）与 setSinkId 设备选择后续 wave。
 */
function desiredOutputChannels(p: SpatialParams): number {
  if (p.output !== 'multichannel') return 2
  if (p.multichannelChannels !== undefined) return p.multichannelChannels
  if (p.mode === 'headLocked' && p.headLocked.layout === '714') return 8 // 7.1.4 → 8
  return 6 // 5.1 / stage / instant / world → 6
}

/** 摘除空间链：断开 spatialNode，恢复 lastWiredV3Node → analyser 直连 */
function teardownSpatial(restoreDirect: boolean): void {
  if (spatialNode) {
    try {
      spatialNode.node.disconnect()
    } catch {
      /* noop */
    }
    spatialNode = null
  }
  if (wired && restoreDirect && lastHandle && lastWiredV3Node) {
    try {
      lastWiredV3Node.disconnect()
      lastWiredV3Node.connect(lastHandle.analyser)
    } catch {
      /* noop */
    }
  }
  wired = false
  // 节点已摘除：输出声道数回默认（重建路径会在接线时按当前参数重新设置）
  spatialOutputChannels = 2
}

/** 公开摘除入口（detachV3Engine 用）：恢复 v3 → analyser 直连 */
export function unwireSpatial(): void {
  teardownSpatial(true)
}

/**
 * 按当前参数同步空间链（镜像 syncPitchChain 范式）：
 *  - seq 竞态防护：await 注册期间参数/接线变化 → 过期请求放弃；
 *  - 未激活或 AudioWorkletNode 不可用 → unwire（恢复直连）；
 *  - 上下文变化（重建音频图）→ 旧注册/接线作废；
 *  - 已接线且 v3 节点未变 → 仅重发 config；v3 节点被 host.attach 重建 → 摘旧重接；
 *  - 目标输出声道数变化（output 切到 multichannel / multichannelChannels 变更，
 *    或 714 布局切换）→ 重建节点（unwire 恢复直连 → 走下方接线路径，seq 防护覆盖）；
 *  - 接线：register → new SpatialNode(outputChannels) → v3Node.disconnect() →
 *    v3Node.connect(spatial) → spatial.connect(analyser) → postConfig；
 *  - 任一环节失败静默：保持 v3Node→analyser 直连，音频不中断。
 */
export async function syncSpatialChain(
  getV3Node: () => AudioNode | null,
  handle: { audioContext: AudioContext; analyser: AnalyserNode } | null,
): Promise<void> {
  lastSyncGetNode = getV3Node
  lastHandle = handle
  if (!handle) return // 音频图未接入：仅存参数，下次 attach 生效
  const seq = ++spatialSeq
  const active = isSpatialActive()

  if (!active || typeof AudioWorkletNode === 'undefined') {
    if (wired) teardownSpatial(true)
    return
  }

  const ctx = handle.audioContext
  // 上下文变化（重建音频图）：旧注册/接线作废
  if (spatialCtx !== ctx) {
    if (spatialNode) {
      try {
        spatialNode.node.disconnect()
      } catch {
        /* noop */
      }
      spatialNode = null
    }
    wired = false
    registerPromise = null
    spatialCtx = ctx
    spatialOutputChannels = 2
  }

  const v3Node = getV3Node()
  if (!v3Node) return // 引擎未接入音频图（冷启动仅存参数，下次 attach 生效）

  // ① 多声道物理输出：目标输出声道数变化 → 重建节点（unwire 恢复直连后走下方
  // 接线路径；seq 防护与既有 v3 重建路径共用，音频不中断）
  const outCh = desiredOutputChannels(ensureParams())
  if (wired && spatialNode && spatialOutputChannels !== outCh) {
    teardownSpatial(true)
  }

  if (wired && spatialNode) {
    if (lastWiredV3Node === v3Node) {
      // 已接线且节点未变：仅重发配置（参数变化 → 处理器 setConfig）
      spatialNode.postConfig(spatialConfigFromParams(ensureParams()))
      return
    }
    // v3 处理节点被 host.attach 重建：摘旧接线（不恢复直连——host.attach 已连新节点→analyser）
    teardownSpatial(false)
  }

  // 注册处理器（每上下文一次，失败静默——空间化不可用不影响其余效果）
  if (!registerPromise) {
    registerPromise = SpatialNode.register(ctx)
  }
  const ok = await registerPromise
  // 竞态防护：await 期间可能被切走/重接线/上下文重建，过期请求放弃
  if (!ok || seq !== spatialSeq || !handle || spatialCtx !== ctx) return
  const nodeNow = getV3Node()
  if (!nodeNow) return

  try {
    const node = new SpatialNode(ctx, outCh)
    spatialOutputChannels = outCh
    node.onStats = (s: SpatialStats) => {
      lastStats = s
      // 处理器初始化降级检测：SpatialProcessor 构造失败（WASM 实例化 / 网格解码 /
      // loadHrtf 抛错）时经 spatial-stats(backend='fallback') 通知主线程。passthrough
      // 空间节点无渲染意义（仅复制输入到输出），恢复 v3→analyser 直连消除无谓节点
      // 与延迟——处理器此时仍保活直通（音频不中断），摘除后直连路径同样有声。
      // 关键：这是 file:// 打包版「register 成功 + 节点构造成功但处理器内部失败」
      // 静音场景的兜底——即便处理直通已防静音，摘除空间链让音频走原始 v3→analyser，
      // 行为与「空间化不可用」完全一致（用户感知：空间模式无效但不影响播放）。
      if (s.backend === 'fallback') {
        teardownSpatial(true)
      }
    }
    node.postConfig(spatialConfigFromParams(ensureParams()))
    nodeNow.disconnect()
    nodeNow.connect(node.node)
    node.node.connect(handle.analyser)
    spatialNode = node
    lastWiredV3Node = nodeNow
    wired = true
  } catch {
    // 接线失败：恢复 v3 → analyser 直连。上方 try 中 nodeNow.disconnect() 已执行，
    // 若 new SpatialNode/connect 抛错则 v3 节点处于断开未重连状态 → 音频死寂；
    // 此处兜底重连 analyser（disconnect 无参清掉所有输出，含半成功的 spatial 输入）。
    try {
      nodeNow?.disconnect()
      nodeNow?.connect(handle.analyser)
    } catch {
      /* noop：重连失败也无法改善，保持断开（不影响其余效果链） */
    }
    spatialNode = null
    wired = false
  }
}

// ==================== HRTF 数据集（用户导入 SOFA → 运行时换网格） ====================

/** 当前生效的自定义 HRTF 数据集 id（null = 内置网格；仅模块状态，重启经 localStorage 恢复） */
let currentHrtfDatasetId: string | null = null

/** 活动 HRTF 数据集 id 的 localStorage 键（跨重启自动恢复：setHrtfDataset 写入，restoreHrtfDataset 读取） */
export const HRTF_ACTIVE_DATASET_KEY = 'waveforge:hrtf-active-dataset'

/**
 * 惰性读取 localStorage（Node/无 window 环境返回 null）。惰性取值使测试可经
 * vi.stubGlobal('window', { localStorage: 内存 mock }) 注入，无需测试专用导出。
 */
function activeDatasetStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return window.localStorage
}

/** 写活动数据集 id（null = 清除记录）；存储不可用静默（不影响实时换网格） */
function persistActiveDatasetId(id: string | null): void {
  const s = activeDatasetStorage()
  if (!s) return
  try {
    if (id === null) s.removeItem(HRTF_ACTIVE_DATASET_KEY)
    else s.setItem(HRTF_ACTIVE_DATASET_KEY, id)
  } catch {
    /* noop：存储失败不影响本次热更新 */
  }
}

/** HRTF 数据集合法性校验（setHrtfDataset / restoreHrtfDataset 共用；抛中文错误） */
function validateHrtfGrid(grid: HrtfGrid): void {
  if (grid.azimuths.length < 1 || grid.elevations.length < 1 || grid.hrirLength < 1) {
    throw new Error('HRTF 数据集网格为空（无方位/仰角/样本），导入失败')
  }
  const expectLen = grid.elevations.length * grid.azimuths.length * grid.hrirLength
  if (grid.left.length !== expectLen || grid.right.length !== expectLen) {
    throw new Error('HRTF 数据集网格尺寸不一致（left/right 长度与方位·仰角·样本数不匹配）')
  }
}

/**
 * 网格整体重采样到目标采样率（多相 Kaiser-sinc，dsp/Resampler 只读复用）。
 *  - 采样率已一致 → 原样返回（零成本）；
 *  - 逐单元格对 left/right 各 HRIR 做一次性重采样（channels=1，复用同一实例）；
 *  - HRIR 长度同步换算 round(len·targetFs/sampleRate)，与 Resampler.process 输出
 *    长度一致；方位/仰角列表不变；
 *  - 确定性：同输入同输出（Resampler 无随机源）。
 */
export function resampleGrid(grid: HrtfGrid, targetFs: number): HrtfGrid {
  if (!Number.isFinite(targetFs) || targetFs <= 0) {
    throw new Error(`非法目标采样率：${targetFs}`)
  }
  if (grid.sampleRate === targetFs) return grid
  if (!Number.isFinite(grid.sampleRate) || grid.sampleRate <= 0) {
    throw new Error(`HRTF 数据集采样率非法：${grid.sampleRate}`)
  }
  const newLen = Math.round((grid.hrirLength * targetFs) / grid.sampleRate)
  if (newLen < 1) {
    throw new Error('HRTF 数据集重采样后长度非法（目标采样率过低）')
  }
  const cells = grid.elevations.length * grid.azimuths.length
  const resampler = new Resampler(grid.sampleRate, targetFs, 1, 8)
  const left = new Float32Array(cells * newLen)
  const right = new Float32Array(cells * newLen)
  for (let c = 0; c < cells; c++) {
    const base = c * grid.hrirLength
    left.set(resampler.process(grid.left.subarray(base, base + grid.hrirLength)), c * newLen)
    right.set(resampler.process(grid.right.subarray(base, base + grid.hrirLength)), c * newLen)
  }
  return {
    sampleRate: targetFs,
    azimuths: grid.azimuths,
    elevations: grid.elevations,
    hrirLength: newLen,
    left,
    right,
  }
}

/**
 * 设置 HRTF 数据集（用户导入的 SOFA 网格；null = 恢复内置网格）。
 *  - 非 null：合法性校验 → 采样率适配（与当前音频上下文不一致时**重采样**——
 *    多相 Kaiser-sinc 整网格一次性重采样，导入时一次性成本可接受；重采样失败回退
 *    抛原不一致提示）→ IndexedDB 持久化（fire-and-forget，失败静默）→ 写活动
 *    数据集 id（localStorage，跨重启自动恢复）→ 已接线则 postGrid 热更新
 *    （结构化克隆 ~2MB 网格可接受）→ 记录数据集 id；
 *  - null：恢复内置网格（processor 收到 null → loadHrtf(builtinGrid)），并清除
 *    活动数据集 id（下次启动不再自动恢复自定义网格）；
 *  - 未接线（无 SpatialNode）：仅存状态/持久化；接线时不下发历史数据集（简化：
 *    由 restoreHrtfDataset 在 attach 流程恢复，见函数头注释）。
 */
export function setHrtfDataset(gridIn: HrtfGrid | null): void {
  if (gridIn === null) {
    currentHrtfDatasetId = null
    persistActiveDatasetId(null) // 恢复内置网格 → 清除活动记录（重启不再自动恢复）
    spatialNode?.postGrid(null)
    return
  }
  // 网格合法性防御（后端 loadHrtf 同样校验，此处提前拦截避免入库/下发坏数据）
  validateHrtfGrid(gridIn)
  // 采样率适配：与音频上下文不一致时一次性重采样（网格整体重采样一次，导入时
  // 一次性成本可接受）；重采样失败（Resampler 抛错）→ 回退抛原不一致提示
  let grid = gridIn
  if (spatialCtx && grid.sampleRate !== spatialCtx.sampleRate) {
    const mismatchMsg = `HRTF 数据集采样率（${grid.sampleRate} Hz）与当前音频上下文（${spatialCtx.sampleRate} Hz）不一致`
    try {
      grid = resampleGrid(grid, spatialCtx.sampleRate)
    } catch (e) {
      throw new Error(`${mismatchMsg}，且重采样失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const id = new Date().toISOString() // 日期戳 id（IndexedDB key，字典序 = 时间序）
  currentHrtfDatasetId = id
  // 持久化 fire-and-forget：IndexedDB 不可用/写入失败静默（不影响实时换网格）
  void saveHrtfDataset(id, grid).catch(() => {
    /* noop：存储失败不影响本次热更新 */
  })
  persistActiveDatasetId(id) // 写活动记录（跨重启自动恢复的锚点）
  // 已接线 → 结构化克隆热更新；未接线仅存状态（接线时由 restoreHrtfDataset 恢复）
  spatialNode?.postGrid(grid)
}

/**
 * 跨重启自动恢复最近一次生效的自定义 HRTF 数据集（attach 流程调用）。
 * 流程：读活动数据集 id（localStorage）→ getLatestDataset（hrtfStore 取最新导入）
 * → 校验（与 setHrtfDataset 同规则）→ 采样率适配（与当前上下文不一致时重采样）
 * → postGrid 热更新。
 * 返回：成功 true；无记录 / 数据集缺失或损坏 / 校验失败 / 存储异常 → false（不抛）。
 *
 * 调用点（由收口接线）：attachV3Engine 的 attach 流程应在空间链接线完成后调用
 * （postGrid 热更新需要 SpatialNode；未接线时仅恢复模块状态，接线后不会自动补发，
 * 与 setHrtfDataset 的简化语义一致）。重采样在恢复时按需进行，不改写 IDB 原记录。
 */
export async function restoreHrtfDataset(): Promise<boolean> {
  const storage = activeDatasetStorage()
  let activeId: string | null = null
  try {
    activeId = storage ? storage.getItem(HRTF_ACTIVE_DATASET_KEY) : null
  } catch {
    return false // 存储异常：视为无记录
  }
  if (!activeId) return false
  try {
    const latest = await getLatestDataset()
    if (!latest || latest.id !== activeId) return false // 活动记录对应的数据集已不存在
    validateHrtfGrid(latest.grid)
    // 采样率适配：上下文已接线且不一致 → 一次性重采样（成本可接受）
    let grid = latest.grid
    if (spatialCtx && grid.sampleRate !== spatialCtx.sampleRate) {
      grid = resampleGrid(grid, spatialCtx.sampleRate)
    }
    currentHrtfDatasetId = latest.id
    spatialNode?.postGrid(grid)
    return true
  } catch {
    return false // 数据集缺失/损坏/校验失败 → 恢复失败不抛
  }
}

// ==================== 内置 HRTF 数据集（规划书 §4.1：KEMAR / CIPIC 切换） ====================

/** 内置数据集选择的 localStorage 键（跨重启自动恢复：setBuiltinDataset 写入，attach 流程读取） */
export const BUILTIN_HRTF_DATASET_KEY = 'waveforge:hrtf-builtin'

/**
 * 当前生效的内置数据集 id（'kemar' | 'cipic'；null = 未选择/默认 kemar）。
 * 读取 localStorage（惰性；存储不可用/无记录 → null，不抛）。
 */
export function getBuiltinDataset(): 'kemar' | 'cipic' | null {
  const s = activeDatasetStorage()
  if (!s) return null
  try {
    const v = s.getItem(BUILTIN_HRTF_DATASET_KEY)
    return v === 'kemar' || v === 'cipic' ? v : null
  } catch {
    return null
  }
}

/**
 * 切换内置 HRTF 数据集（'kemar' MIT KEMAR / 'cipic' CIPIC subject_003，规划书 §4.1）。
 *  - 从 data/datasets.ts 查表解码（gridSource.loadBuiltinGrid，与 grid.bin 同布局）；
 *  - 数据未打包（base64 null）或解码失败 → **静默返回 false**（不抛、不写记录——
 *    UI 对未打包项保持禁用标注「数据未打包」，重复点击无副作用）；
 *  - 已接线 → postGrid 热更新（结构化克隆 ~2.4MB 网格可接受，与 SOFA 导入同路径）；
 *    未接线 → 仅写 localStorage 锚点（下次 attach 生效）；
 *  - 写 localStorage（BUILTIN_HRTF_DATASET_KEY = id）跨重启自动恢复；存储不可用
 *    静默（不影响本次热更新）；
 *  - 内置网格为 48kHz 固定（转换/内嵌时已定标）：与 worklet 构造路径（KEMAR 同）
 *    一致，不做上下文重采样（44.1kHz 等罕见上下文下与 KEMAR 同限，非本函数职责）；
 *  - 不触碰 SOFA 导入锚点（HRTF_ACTIVE_DATASET_KEY）：用户显式导入的 SOFA 数据集
 *    优先级更高（attach 恢复顺序：先应用本函数记录的内置选择，再 restoreHrtfDataset
 *    恢复 SOFA——两者并存时 SOFA 覆盖，符合「显式导入 > 内置选择」语义）；
 *  - 「恢复内置」语义：SOFA 区 setHrtfDataset(null) 恢复的是 worklet 构造时的
 *    内置网格（KEMAR），与本选择互不影响——本函数是内置两套之间的显式切换入口。
 * 返回：true = 已应用（或已记录待下次 attach）；false = 未打包/解码失败（静默）。
 *
 * 【attach 接线注释（由收口完成，勿在此实现）】attachV3Engine 的 attach 流程应在
 * 空间链接线完成后、restoreHrtfDataset **之前**应用内置选择：
 *   const builtin = getBuiltinDataset()
 *   if (builtin) setBuiltinDataset(builtin)
 * 顺序理由：postGrid 需要已接线的 SpatialNode；先内置后 SOFA，保证「显式导入
 * 的 SOFA 数据集优先于内置选择」的跨重启语义（见上）。未接线时本函数仅写
 * localStorage，与 setHrtfDataset 的简化语义一致（接线后不自动补发）。
 */
export function setBuiltinDataset(id: 'kemar' | 'cipic'): boolean {
  const grid = loadBuiltinGrid(id)
  if (!grid) return false // 数据未打包或损坏：静默忽略（调用方不弹错误）
  // 已接线 → postGrid 热更新（与 SOFA 导入同路径：loadHrtf 后处理器重发 lastConfig）；
  // 未接线 → 仅写锚点，attach 时由收口按上方注释顺序恢复
  spatialNode?.postGrid(grid)
  const s = activeDatasetStorage()
  if (s) {
    try {
      s.setItem(BUILTIN_HRTF_DATASET_KEY, id)
    } catch {
      /* noop：存储失败不影响本次热更新 */
    }
  }
  return true
}

// ==================== 离线导出后端 ====================

/**
 * 主线程离线导出用后端工厂：wasm 优先（生成模块内构造失败已降级 TS），
 * 随后装载 HRTF 网格（内嵌数据或合成兜底）。解析失败返回 null（调用方跳过空间化）。
 */
export function createExportBackend(sampleRate: number): SpatialBackend | null {
  try {
    const backend = createWorkletBackend()
    const grid = loadSpatialGrid(sampleRate)
    backend.loadHrtf(grid)
    return backend
  } catch {
    return null
  }
}

// ==================== 输出设备选择（§5.6：enumerateDevices 枚举 + setSinkId 切换） ====================

/**
 * AudioContext.setSinkId 运行时存在性类型：TS lib.dom 仅收录 HTMLMediaElement.setSinkId，
 * AudioContext.setSinkId 是 Chromium/Electron 较新 API（Chrome 110+），运行时以
 * typeof 守卫探测，缺失/不支持时静默降级（播放不受影响）。
 */
interface SinkCapableContext {
  setSinkId?(sinkId: string): Promise<void>
}

/**
 * 应用 setSinkId 的目标 AudioContext：优先空间链上下文（spatialCtx，syncSpatialChain
 * 接线时记录）；未接线时回退最近一次链同步句柄的上下文（lastHandle.audioContext——
 * attach 流程即使空间模式关闭也会记录该句柄，保证空间未开启时设备切换/恢复同样生效）。
 * setSinkId 是上下文级设置，作用于整条音频图（含 analyser 输出），与空间链是否接线无关。
 */
function sinkTargetCtx(): AudioContext | null {
  if (spatialCtx) return spatialCtx
  return lastHandle?.audioContext ?? null
}

/**
 * 对目标上下文应用 setSinkId（内部守卫 + try/catch，返回是否应用成功）：
 *  - 无上下文（引擎未 attach）→ false（调用方按语义降级：仅持久化，下次 attach 恢复）；
 *  - 上下文不支持 setSinkId（旧 Chromium/Electron）→ false（静默，播放不受影响）；
 *  - setSinkId 失败（设备被拔出 / 无效 id / 权限拒绝）→ false（保持当前输出不变）。
 *  - sinkId 空串 = 恢复系统默认输出（规范语义：setSinkId('') 复位默认设备）。
 */
async function applySinkIdToCtx(sinkId: string): Promise<boolean> {
  const ctx = sinkTargetCtx()
  if (!ctx) return false
  const sink = ctx as AudioContext & SinkCapableContext
  if (typeof sink.setSinkId !== 'function') return false
  try {
    await sink.setSinkId(sinkId)
    return true
  } catch {
    return false
  }
}

/**
 * 枚举输出设备（§5.6）：navigator.mediaDevices.enumerateDevices 过滤 audiooutput。
 *  - API 缺失 / 权限拒绝 / 枚举失败 → 返回 []（不抛；UI 显示「系统默认（不可枚举）」）；
 *  - enumerateDevices 无权限时 label 为空串（Electron 桌面环境通常有权限），
 *    空 label 回退占位名「输出设备 ${idx+1}」保证下拉可读。
 */
export async function listOutputDevices(): Promise<{ deviceId: string; label: string }[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d, idx) => ({ deviceId: d.deviceId, label: d.label || `输出设备 ${idx + 1}` }))
  } catch {
    return []
  }
}

/**
 * 切换输出设备（§5.6 顶部工具栏「输出设备选择」）：
 *  - sinkId = 具体设备 id → AudioContext.setSinkId(deviceId) 热切换；
 *  - sinkId = null → 恢复系统默认（清除快照 sinkId + setSinkId('')）；
 *  - 持久化：patchSpatialParams 深合并——sinkId 随 waveforge:spatial-params 快照
 *    整体保存（undefined 键 JSON 序列化自然丢弃），下一次 attach 由 applySinkId
 *    自动恢复；
 *  - 返回：应用成功 true；未接线（无上下文可应用）→ 仅持久化并返回 true
 *    （attach 恢复流程兜底）；上下文不支持 setSinkId / 应用失败 → false
 *    （持久化仍生效，下次 attach 重试；UI 调用方弹中文提示）。
 */
export async function setOutputDevice(sinkId: string | null): Promise<boolean> {
  patchSpatialParams({ sinkId: sinkId ?? undefined })
  if (!sinkTargetCtx()) return true // 未接线：仅持久化，下次 attach 由 applySinkId 恢复
  return applySinkIdToCtx(sinkId ?? '')
}

/**
 * attach 流程恢复已保存的输出设备（attachV3Engine 在 restoreHrtfDataset 之后调用）：
 * 读快照 sinkId → 有则对当前上下文 setSinkId（同守卫），无则 true（系统默认无需应用）。
 * 返回：应用成功 true；无上下文 / 上下文不支持 / 应用失败 → false（不抛，播放不受影响）。
 */
export async function applySinkId(): Promise<boolean> {
  const sinkId = getSpatialParams().sinkId
  if (!sinkId) return true
  return applySinkIdToCtx(sinkId)
}

// ==================== 播放/暂停（规划书「空格 | 播放/暂停」+ §5.6 工具栏播放控制） ====================

/**
 * 播放/暂停切换：语义 = 暂停/恢复**整个音频上下文**（AudioContext.suspend/resume，
 * 上下文级操作——音乐播放与调音室/空间链同步暂停，规划书「空格播放/暂停」）：
 *  - ctx.state === 'running' → suspend（暂停）；否则（suspended 等）→ resume（恢复）；
 *  - 目标上下文：模块态 spatialCtx（syncSpatialChain 接线时记录，优先）或
 *    lastHandle.audioContext（最近一次链同步句柄——空间模式未开启时同样生效）；
 *  - 无上下文（引擎未 attach / 冷启动）→ 返回 false（调用方静默忽略，不抛）；
 *  - suspend/resume 抛错（上下文已关闭等）→ 返回 false（不抛）。
 * 返回：切换是否成功（UI 调用方可按返回值提示；本波工具栏按钮简化不显示状态）。
 */
export async function togglePlayback(): Promise<boolean> {
  const ctx = spatialCtx ?? lastHandle?.audioContext ?? null
  if (!ctx) return false
  try {
    if (ctx.state === 'running') await ctx.suspend()
    else await ctx.resume()
    return true
  } catch {
    return false
  }
}

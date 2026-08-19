/**
 * SpatialProcessor —— 空间音频 AudioWorklet 处理器（waveforge-spatial）
 *
 * 拓扑：masterGain → [soundtouch?] → v3Node → [spatial?] → analyser。
 * 本处理器是 v3 处理节点之后的兄弟节点，只做双耳渲染，不碰引擎参数。
 *
 * 多声道输入/输出（②）：
 *  - 输入声道数检测：process 开头检测 inputs[0].length，经 stats 消息回传
 *    inputChannels（融合层据此推导 instant.multichannelAuto 的多声道布局）；
 *  - 输入 >2 声道且后端有 processMulti → 多声道渲染路径（后端按 speaker.channel
 *    逐声道取源，HRTF 双耳求和）；后端无 processMulti → 回退 2 路下混；
 *  - 输出 >2 声道 → 物理声道映射（不走后端 HRTF）：按扬声器方位角分类到标准
 *    声道序（0=FL 1=FR 2=FC 3=LFE 4=SL 5=SR 6=RL 7=RR），每物理声道输出 =
 *    对应扬声器 gain × 源（干声直通，无卷积/无房间）；输出 2 声道保持双耳路径。
 *
 * 房间模拟（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响）**已由后端实现**
 * （Wasm 内核 / TsConvolverBackend 的 roomSim.ts）；room.ts 轻量 Freeverb 版不再使用。
 * config.room / config.roomAmount 经 setConfig 透传给后端处理（room=off 或
 * roomAmount≤0 时后端全旁路，与旧行为逐位一致），本处理器不做任何房间叠加。
 *
 * 环境声混合器（Phase 4 完整版：FOA 编解码渲染路径，ambience:true 扬声器）：
 *  - fusion 侧附加 4 只环境扬声器（AMBIENCE_SPEAKERS 45/135/225/315，gain 0 占位 +
 *    ambience:true 标记，见 fusion.spatialConfigFromParams）；本处理器在 config 下发时
 *    把 ambience 扬声器从主渲染列表拆出（**不进后端卷积**——gain 0 占位为防御：
 *    即使漏拆，后端对该扬声器输出也为 0），由环境混合器旁路渲染；
 *  - 每块：stereoToFoa(inL, inR, block) 提取 FOA 环境场能量级 → decodeFoaToSpeakers
 *    解码到 4 方向 → 4 路目标增益（clamp [-1,1]，可负——Ambisonics 相位抵消语义）→
 *    一阶平滑（g += 0.2·(target−g)，~5 块时间常数防跳变抽吸）→ 每通道去相关延迟线
 *    （20/28/36/44ms 环形缓冲，扩散感——环境场不追求逐样本 HRTF 方向，去相关延迟
 *    近似扩散；完整逐扬声器 HRTF 渲染后续 wave）→ 叠加到最终 outL/outR 之后；
 *  - 激活条件：config.ambienceAmount 有效（>0，fusion 填 p.ambience.amount）且存在
 *    环境扬声器；平滑状态跨配置保留（开关切换无跳变，增益从旧值滑向新目标）。
 *
 * 范式照抄 worklet/AudioEffectsProcessor.ts：class extends AudioWorkletProcessor、
 * 本地声明 worklet 全局符号、文件末尾 registerProcessor 守卫（Node/测试环境跳过）。
 * 融合打包注意：AudioWorklet 全局作用域不支持裸 import/export——全部依赖
 * （TsConvolverBackend → dsp/Convolver → dsp/fft、roomSim、analyticHrtf）
 * 由构建脚本 build-spatial-worklet.mjs（esbuild 单文件）内联进 public/spatial-worklet.js。
 * 本文件禁止 import 浏览器 API 依赖模块（fusion/persistence 等主线程模块）。
 *
 * 线程模型：
 *   - 构造：同步完成（不 await）——createWorkletBackend() 选后端（wasm 优先/TS 兜底），
 *     loadSpatialGrid(sampleRate) 装载网格（内嵌数据解码或合成）→ backend.loadHrtf，
 *     且把该网格保留为 builtinGrid（用户导入数据集后可用 null 消息恢复）；
 *   - port.onmessage：{type:'spatial', config: SpatialRenderConfig} → backend.setConfig
 *     （含房间参数透传，后端内部初始化房间），同时保存 lastConfig 与 speakers；
 *     {type:'spatial-grid', grid: HrtfGrid | null} → backend.loadHrtf（null = 恢复
 *     builtinGrid）→ 重发 lastConfig（loadHrtf 后分区谱需重建，speaker 状态随之重建）；
 *   - process：输入缺失 → 静音输出；speakers 为空 → 直通复制；
 *     否则 backend.processStereo（后端内部完成房间渲染）；
 *   - 每 30 次 process 回调回传一次 {type:'spatial-stats', latencySamples, backend,
 *     inputChannels, avgProcessMs}——avgProcessMs 为窗口内每块 process 耗时均值
 *     （performance.now() 墙钟，物理映射/双耳/环境混合同路径测量），主线程
 *     fusion.estimateCpuPercent 按 256 样本块 @48kHz 换算 CPU%。
 */

import { createWorkletBackend, WASM_BYTES } from './backendIndex.generated'
import { loadSpatialGrid } from './gridSource'
import { ambienceDelaySamples, AMBIENCE_CHANNELS, foaAmbienceGains } from './ambienceMixer'
import type { HrtfGrid, SpatialRenderConfig, VirtualSpeaker } from './types'

export const SPATIAL_WORKLET_PROCESSOR_NAME = 'waveforge-spatial'

/** AudioWorklet 全局作用域环境声明（lib.dom 未内置，本地声明同 AudioEffectsProcessor） */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  readonly currentTime: number
  readonly currentFrame: number
  readonly sampleRate: number
  constructor(options?: AudioWorkletProcessorOptions)
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

interface AudioWorkletProcessorOptions {
  numberOfInputs: number
  numberOfOutputs: number
  outputChannelCount: number[]
  parameterData: Record<string, number>
  processorOptions: unknown
}

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor): void

/** stats 回传周期（process 回调次数，约 30×128 帧 ≈ 80ms @48kHz） */
const STATS_INTERVAL_CALLBACKS = 30

/**
 * 标准声道顺序（多声道输入/输出共用；物理声道映射的索引语义）：
 * 0=FL、1=FR、2=FC、3=LFE、4=SL、5=SR、6=RL、7=RR
 */
export const PHYSICAL_CHANNEL_ORDER = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'RL', 'RR'] as const

/**
 * 方位角 → 物理声道索引（标准声道序，见 PHYSICAL_CHANNEL_ORDER）：
 *  - az≈0（|az| < 30°）→ FC（2）；
 *  - az<0：|az| < 60° → FL（0）、60..140° → SL（4）、≥140° → RL（6）；
 *  - az>0：对称 → FR（1）/ SR（5）/ RR（7）。
 */
export function physicalChannelIndex(azimuthDeg: number): number {
  const az = Math.abs(azimuthDeg)
  if (az < 30) return 2 // az≈0 → FC
  if (azimuthDeg < 0) return az < 60 ? 0 : az < 140 ? 4 : 6 // FL / SL / RL
  return az < 60 ? 1 : az < 140 ? 5 : 7 // FR / SR / RR
}

/**
 * 多声道物理输出映射纯函数（①，测试与处理器共用）：speakers → 每物理声道增益列表。
 *  - 按方位角分类（physicalChannelIndex）累加扬声器 gain；索引越界（≥ outChannels）丢弃；
 *  - LFE 输入（channel 3）静音占位：不映射到任何物理声道（LFE 无方向性，信号忽略，
 *    物理 LFE 声道恒 0）；
 *  - 无扬声器映射的声道保持 0。
 */
export function mapSpeakersToPhysical(speakers: VirtualSpeaker[], outChannels: number): number[] {
  const gains = new Array<number>(outChannels).fill(0)
  for (const sp of speakers) {
    if (sp.channel === 3) continue // LFE 输入 → 静音占位
    const pidx = physicalChannelIndex(sp.azimuthDeg)
    if (pidx < outChannels) gains[pidx] += sp.gain
  }
  return gains
}

/** 环境去相关延迟线容量余量（样本）：须 ≥ 单块最大长度（Web Audio 渲染量子 ≤ 128 样本，
 *  2048 余量覆盖任何实现；容量 = 延迟 + 余量，写指针不与读指针碰撞） */
const AMBIENCE_DELAY_HEADROOM = 2048

/**
 * 环形延迟线（环境去相关扩散用）：读延迟 delay 样本处的旧值 + 写入当前样本。
 * 每环境通道一条、延迟独立（20/28/36/44ms 按 fs 换算）；缓冲未填满段输出 0
 * （启动静音——环境基底层由平滑增益渐入，无爆音）。
 */
class AmbienceDelayLine {
  private readonly buf: Float32Array
  private readonly delay: number
  private idx = 0

  constructor(delay: number, headroom: number) {
    this.delay = Math.max(1, delay)
    this.buf = new Float32Array(this.delay + headroom)
  }

  /** 读延迟输出并写入当前样本（返回延迟后的信号） */
  process(x: number): number {
    const y = this.buf[(this.idx - this.delay + this.buf.length) % this.buf.length]
    this.buf[this.idx] = x
    this.idx = (this.idx + 1) % this.buf.length
    return y
  }
}

export class SpatialProcessor extends AudioWorkletProcessor {
  /**
   * 后端（初始化失败时为 null，process 走直通降级）。
   * 构造器内 createWorkletBackend / loadSpatialGrid / backend.loadHrtf / 延迟线构造
   * 任一失败 → backend=null + fallback=true，process 直通复制输入到输出（不静音、
   * 保活），并经 spatial-stats(backend='fallback') 通知主线程摘除空间链恢复
   * v3→analyser 直连。关键：AudioWorklet 处理器构造器抛错会导致节点静音死寂
   * （主线程 new AudioWorkletNode 不抛、但 worklet 线程处理器不运行）——故构造器
   * 绝不抛错，所有失败吞掉转降级（file:// 打包版 WASM/grid 初始化失败的兜底）。
   */
  private readonly backend: ReturnType<typeof createWorkletBackend> | null
  /** 后端类型（信息性：wasm/ts；fallback=构造失败降级直通） */
  private readonly backendKind: string
  /** 初始化降级标志：true 时 process 直通复制输入→输出（不静音），主线程据此摘除空间链 */
  private readonly fallback: boolean
  private callbackCount = 0

  /** 最后下发的渲染配置（grid 热更新后需重发以重建分区谱与 speaker 状态） */
  private lastConfig: SpatialRenderConfig | null = null
  /** 内置网格（构造时装载的内嵌/合成网格引用；降级态为 null）：spatial-grid null 消息时恢复 */
  private readonly builtinGrid: HrtfGrid | null

  private hasSpeakers = false
  /** 当前扬声器列表（config 下发时保存；物理声道映射按方位角/输入声道渲染用） */
  private speakers: VirtualSpeaker[] = []
  /** 最近一次 process 的输入声道数（变化时经 stats 回传 inputChannels） */
  private lastInputChannels = 0
  /** 块处理耗时累积（ms，performance.now() 墙钟）：stats 窗口内求均值 avgProcessMs */
  private processMsAcc = 0
  /** 已计时的 process 块数（stats 窗口内；avgProcessMs = processMsAcc / 块数） */
  private processBlockCount = 0

  private silence: Float32Array = new Float32Array(0)
  private inL: Float32Array = new Float32Array(0)
  private inR: Float32Array = new Float32Array(0)
  private monoScratch: Float32Array = new Float32Array(0)

  // —— 环境混合器状态（ambience:true 扬声器，FOA 动态增益调制路径） ——
  /** 主渲染扬声器（无 ambience 标记）：下发后端 HRTF 卷积（config 下发时拆分） */
  private renderSpeakers: VirtualSpeaker[] = []
  /** 环境声扬声器（ambience:true）：不进后端卷积，由环境混合器旁路渲染 */
  private ambienceSpeakers: VirtualSpeaker[] = []
  /** 环境混合量（config.ambienceAmount 透传，0..1；undefined/0 = 环境混合器关闭） */
  private ambienceAmount = 0
  /** 环境混合器激活（ambienceAmount>0 且存在环境扬声器） */
  private ambienceActive = false
  /** FOA 调制增益平滑状态（每环境通道，一阶低通 g += 0.2·(target−g)，见 renderAmbience） */
  private readonly ambienceGains: number[] = new Array<number>(AMBIENCE_CHANNELS).fill(0)
  /** 去相关延迟线（每环境通道独立环形缓冲，延迟 20/28/36/44ms 按 fs 换算） */
  private readonly ambienceDelays: AmbienceDelayLine[] = []

  constructor() {
    super()
    // 同步初始化后端 + 网格 + 去相关延迟线。任一环节失败（WASM 实例化 / 网格解码 /
    // loadHrtf / 延迟线构造）→ 降级直通：backend=null + fallback=true，process 直通
    // 复制输入到输出（不静音、保活），并通知主线程摘除空间链恢复 v3→analyser 直连。
    // createWorkletBackend 已在工厂内做 WASM→TS 降级，但 TS 后端的 loadHrtf 仍可能因
    // 网格非法抛错；此处兜底所有路径（file:// 打包版初始化失败的静音根因）。
    let backend: ReturnType<typeof createWorkletBackend> | null = null
    let backendKind = 'ts'
    let grid: HrtfGrid | null = null
    let failed = false
    try {
      backend = createWorkletBackend()
      backendKind = WASM_BYTES ? 'wasm' : 'ts'
      // 同步装载网格（不 await）：内嵌数据解码或合成兜底；同时保留为内置网格引用
      grid = loadSpatialGrid(sampleRate)
      backend.loadHrtf(grid)
      // 去相关延迟线按采样率换算（20/28/36/44ms；每环境通道独立，扩散感）
      for (let k = 0; k < AMBIENCE_CHANNELS; k++) {
        this.ambienceDelays.push(new AmbienceDelayLine(ambienceDelaySamples(sampleRate, k), AMBIENCE_DELAY_HEADROOM))
      }
    } catch {
      // 初始化失败：降级直通（音频不中断）。backend=null 使 process 走直通复制；
      // 主线程收到 backend='fallback' 后摘除空间链恢复直连，此降级为瞬态兜底。
      failed = true
      backend = null
      backendKind = 'fallback'
      grid = null
    }
    this.backend = backend
    this.backendKind = backendKind
    this.fallback = failed
    this.builtinGrid = grid

    this.port.onmessage = (event: MessageEvent) => {
      if (this.fallback) return // 降级态：无后端可下发，忽略所有配置/网格消息
      const msg = event.data as { type?: string; config?: SpatialRenderConfig; grid?: HrtfGrid | null } | null
      if (msg === null || typeof msg !== 'object') return
      if (msg.type === 'spatial' && msg.config) {
        // 房间模拟已由后端实现（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响）；
        // room.ts 轻量版不再使用——config.room/roomAmount 透传给后端内部处理
        this.lastConfig = msg.config
        // 环境声扬声器不进后端卷积：拆分后仅主渲染扬声器下发后端（gain 0 占位为
        // 防御——即使漏拆后端也无输出），环境扬声器由环境混合器旁路渲染
        this.applyConfig(msg.config)
      } else if (msg.type === 'spatial-grid') {
        // 运行时换 HRTF 网格（用户导入 SOFA → 主线程解析 → postMessage 热更新）：
        // loadHrtf 后分区谱需重建（后端内部预计算），故重发 lastConfig 重建 speaker
        // 状态；grid=null 表示恢复内置网格（构造时保留的 builtinGrid 引用）。
        if (!this.backend || !this.builtinGrid) return // 降级态防御（不应到达，fallback 已早退）
        this.backend.loadHrtf(msg.grid ?? this.builtinGrid)
        if (this.lastConfig) this.applyConfig(this.lastConfig)
      }
    }

    // 降级通知主线程：fusion.onStats 收到 backend='fallback' 后摘除空间链恢复 v3→analyser
    // 直连（passthrough 空间节点无渲染意义，恢复直连消除无谓延迟）。消息在 onStats 接线
    // 后经事件循环投递（构造器在 worklet 线程异步运行，主线程 new SpatialNode 后同步挂 onStats）。
    if (this.fallback) {
      this.port.postMessage({
        type: 'spatial-stats',
        latencySamples: 0,
        backend: 'fallback',
        inputChannels: 0,
        avgProcessMs: 0,
      })
    }
  }

  /**
   * 下发配置（全量替换）：拆分主渲染/环境扬声器 + 更新环境混合器状态。
   *  - 主渲染扬声器（无 ambience 标记）→ 后端 setConfig（HRTF 卷积路径）；
   *  - 环境扬声器（ambience:true）→ 不进后端卷积，由 renderAmbience 旁路渲染；
   *  - ambienceAmount（fusion 填 p.ambience.amount）>0 且存在环境扬声器 → 激活
   *    环境混合器；平滑状态跨配置保留（开关切换无跳变，增益从旧值滑向新目标）。
   */
  private applyConfig(config: SpatialRenderConfig): void {
    if (!this.backend) return // 降级态：无后端可下发（onmessage 已早退，此处防御）
    this.renderSpeakers = []
    this.ambienceSpeakers = []
    for (const sp of config.speakers ?? []) {
      if (sp.ambience) this.ambienceSpeakers.push(sp)
      else this.renderSpeakers.push(sp)
    }
    this.backend.setConfig({ ...config, speakers: this.renderSpeakers })
    this.hasSpeakers = this.renderSpeakers.length > 0
    this.speakers = this.renderSpeakers // 物理声道映射（输出 >2 声道）按方位角/输入声道渲染
    this.ambienceAmount = config.ambienceAmount ?? 0
    this.ambienceActive = this.ambienceAmount > 0 && this.ambienceSpeakers.length > 0
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    // 块处理耗时起点（worklet 全局作用域有 performance；CPU% 由主线程
    // fusion.estimateCpuPercent 按 avgProcessMs 换算——物理映射/双耳/环境混合同路径）
    const t0 = performance.now()
    const outChannels = outputs.length > 0 ? outputs[0] : []
    if (outChannels.length === 0) return true // 无输出通道，保持处理器存活（空转路径不计入耗时均值）
    const frameCount = outChannels[0].length

    // 初始化降级直通：后端不可用 → 输入直通复制到输出（不静音），保持处理器存活。
    // 主线程收到 backend='fallback' 后会摘除空间链恢复 v3→analyser 直连，此直通路径
    // 在摘除前兜底（音频不中断）。多声道输出按输入声道 1:1 映射（缺失声道补 0）。
    if (this.fallback) {
      const inChannels = inputs.length > 0 ? inputs[0] : []
      if (inChannels.length > 0) {
        const src0 = inChannels[0]
        for (let c = 0; c < outChannels.length; c++) {
          const src = c < inChannels.length ? inChannels[c] : src0
          const dst = outChannels[c]
          const n = Math.min(frameCount, src.length)
          for (let i = 0; i < n; i++) dst[i] = src[i]
          for (let i = n; i < frameCount; i++) dst[i] = 0
        }
      } else {
        for (let c = 0; c < outChannels.length; c++) outChannels[c].fill(0)
      }
      return true
    }

    const backend = this.backend
    if (!backend) return true // 防御：无后端（不应到达，fallback 已早退）——静音保活
    // 缓冲按渲染量子预分配/按需扩容（仅尺寸变化时分配一次）
    if (this.silence.length < frameCount) this.silence = new Float32Array(frameCount)
    if (this.inL.length < frameCount) {
      this.inL = new Float32Array(frameCount)
      this.inR = new Float32Array(frameCount)
      this.monoScratch = new Float32Array(frameCount)
    }

    const inChannels = inputs.length > 0 ? inputs[0] : []
    // 输入声道数检测（②）：经 stats 消息回传 inputChannels——融合层据此推导
    // instant.multichannelAuto 的多声道布局（multichannelLayout）
    this.lastInputChannels = inChannels.length

    if (outChannels.length > 2) {
      // ① 多声道物理输出映射（不走后端 HRTF，见 renderPhysical 注释）
      this.renderPhysical(inChannels, outChannels, frameCount)
    } else {
      const l = inChannels[0] ?? this.silence // 无输入时静音
      const r = inChannels[1] ?? l // 单声道输入复制到双声道
      // 输入拷入 scratch（后端可能就地质化输入缓冲，避免污染）
      this.inL.set(l.subarray(0, frameCount))
      this.inR.set(r.subarray(0, frameCount))

      if (outChannels.length >= 2) {
        if (this.hasSpeakers && inChannels.length > 2 && backend.processMulti) {
          // ② 多声道输入 → 双耳：后端 processMulti 按 speaker.channel 逐声道取源
          // （HRTF 双耳求和；N 路输入原样传入，块长由后端按最短缓冲收敛——零分配）
          backend.processMulti(inChannels, outChannels[0], outChannels[1])
        } else if (this.hasSpeakers) {
          // 立体声/单声道输入，或后端无 processMulti（回退 2 路下混）：
          // 房间模拟已由后端实现（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响）；
          // room.ts 轻量版不再使用——config.room/roomAmount 已在 setConfig 透传后端
          backend.processStereo(this.inL, this.inR, outChannels[0], outChannels[1])
        } else {
          // 直通复制（未配置/关闭空间化：零额外延迟）
          outChannels[0].set(this.inL)
          outChannels[1].set(this.inR)
        }
      } else {
        // 单声道输出（SpatialNode 强制 2 声道，此处防御）：双耳处理后各取半混合
        backend.processStereo(this.inL, this.inR, outChannels[0], this.monoScratch)
        for (let i = 0; i < frameCount; i++) {
          outChannels[0][i] = (outChannels[0][i] + this.monoScratch[i]) * 0.5
        }
      }
      // 环境混合器（FOA 动态增益调制 + 去相关扩散）：环境输出叠加在最终 outL/outR
      // 之后（混合后、主渲染之后）；多声道物理输出路径（>2 声道）无 outL/outR，
      // 不叠加环境（环境扬声器 gain 0 对物理声道映射无贡献）
      this.renderAmbience(outChannels, frameCount)
    }

    // 块处理耗时累积（stats 窗口内求均值 avgProcessMs；空转早退路径不计数，防拉低读数）
    this.processMsAcc += performance.now() - t0
    this.processBlockCount++

    this.callbackCount++
    if (this.callbackCount >= STATS_INTERVAL_CALLBACKS) {
      this.callbackCount = 0
      const avgProcessMs = this.processBlockCount > 0 ? this.processMsAcc / this.processBlockCount : 0
      this.processMsAcc = 0
      this.processBlockCount = 0
      this.port.postMessage({
        type: 'spatial-stats',
        // 后端延迟是后端的固有配置属性（512 样本干湿对齐延迟），与输出声道数无关
        // （O1 审计 8.4 采纳）。代码核查：applyConfig 始终调 backend.setConfig（即使
        // 物理模式 outChannels>2 不走 backend.processStereo——renderPhysical 为干声
        // 直通无卷积），故 backend 恒被配置 → getLatencySamples 恒返回 512（WASM 无条件
        // 返回 PARTITION=512；TS 在 speakers.length>0 时返回 512）。物理模式 backend 有
        // latency（非 0），不满足"backend 无 latency 则报 0"条件——故统一报 backend 值，
        // 反映后端不变属性而非当前块音频路径延迟（物理模式实际路径延迟为 0）。
        latencySamples: backend.getLatencySamples(),
        backend: this.backendKind,
        inputChannels: this.lastInputChannels,
        // 窗口内每块 process 耗时均值（ms，墙钟）：主线程 fusion.estimateCpuPercent
        // 按 256 样本块 @48kHz 换算 CPU%（物理/双耳路径同一测量，同字段回传）
        avgProcessMs,
        // 环境混合器激活时的 FOA 调制增益（每环境通道平滑后值；可选调试信息——
        // 主线程转发器 SpatialNode.onStats 只挑 latencySamples/backend/inputChannels/
        // avgProcessMs，本字段为处理器侧信息性回传，融合层当前不消费）
        ambienceGains: this.ambienceActive ? this.ambienceGains : undefined,
      })
    }
    return true // 保持处理器存活
  }

  /**
   * 环境混合器（ambience:true 扬声器旁路渲染；FOA 动态增益调制 + 去相关扩散）。
   *
   * 信号流（每块）：
   *   1. 目标增益：stereoToFoa(inL, inR, block) 提取 FOA 环境场能量级（M/S：
   *      同相 → W 全向、反相 → Y 左右差分）→ decodeFoaToSpeakers 解码到
   *      AMBIENCE_SPEAKERS 方位角（45/135/225/315）→ 4 路增益 g_k（可负，
   *      Ambisonics 相位抵消语义，foaAmbienceGains 已 clamp 到 [-1,1]）；
   *   2. 慢变平滑：g_k += 0.2·(target_k − g_k)（一阶低通，~5 块时间常数——
   *      防 FOA 增益跳变抽吸；状态每通道，跨配置保留）；
   *   3. 去相关扩散：每环境通道信号 = L 源（channel 0，inL——输入缺失时已回退
   *      静音）经独立环形延迟线（20/28/36/44ms 按 fs 换算）——环境场不追求逐样本
   *      HRTF 方向，去相关延迟近似扩散感（完整逐扬声器 HRTF 渲染后续 wave）；
   *   4. 输出：outL[i] += g_k·env_k[i]·amount·0.5（outR 同），amount 为
   *      config.ambienceAmount（fusion 填 p.ambience.amount）——环境输出叠加在
   *      最终 outL/outR 之后（混合后、主渲染之后），0.5 防环境淹没主渲染。
   * 输入缺失/声道不足：环境混合器用 channel 0（inL 已按静音回退）。
   * ambience 扬声器不进后端卷积（applyConfig 下发前已拆出，gain 0 占位为防御）。
   */
  private renderAmbience(outChannels: Float32Array[], frameCount: number): void {
    if (!this.ambienceActive) return
    const nAmb = Math.min(this.ambienceSpeakers.length, AMBIENCE_CHANNELS)
    // 1. 目标增益（stereoToFoa + decode 一步；可负已 clamp）
    const targets = foaAmbienceGains(this.inL, this.inR, frameCount)
    // 2. 慢变平滑：一阶低通（~5 块时间常数），状态每通道
    for (let k = 0; k < nAmb; k++) {
      this.ambienceGains[k] += 0.2 * (targets[k] - this.ambienceGains[k])
    }
    // 3+4. 去相关延迟 + 叠加（L 源 = this.inL，channel 0 回退静音）
    const outL = outChannels[0]
    const outR = outChannels.length > 1 ? outChannels[1] : null
    const amount = this.ambienceAmount * 0.5 // 环境基底层防淹没（同 fusion 简化版 0.5 语义）
    for (let k = 0; k < nAmb; k++) {
      const g = this.ambienceGains[k] * amount
      const dl = this.ambienceDelays[k]
      for (let i = 0; i < frameCount; i++) {
        const env = dl.process(this.inL[i])
        outL[i] += g * env
        if (outR) outR[i] += g * env
      }
    }
  }

  /**
   * 多声道物理输出映射（①，输出 >2 声道路径）：
   * 按扬声器方位角分类到标准声道序（0=FL 1=FR 2=FC 3=LFE 4=SL 5=SR 6=RL 7=RR，
   * 见 PHYSICAL_CHANNEL_ORDER / physicalChannelIndex），每物理声道输出 =
   * 对应扬声器 gain × 源（干声直通，无卷积/无房间）；无扬声器映射的声道输出 0。
   *  - 源 = 输入声道（speaker.channel 索引；越界取 0 号输入）；
   *  - LFE 输入（channel 3）静音占位（无方向性，信号忽略）；
   *  - 多只扬声器映射同一声道 → 各自 gain × 源累加。
   */
  private renderPhysical(inChannels: Float32Array[], outChannels: Float32Array[], frameCount: number): void {
    for (const ch of outChannels) ch.fill(0)
    if (!this.hasSpeakers || inChannels.length === 0) return
    const in0 = inChannels[0]
    for (const sp of this.speakers) {
      if (sp.channel === 3) continue // LFE 输入 → 静音占位
      const pidx = physicalChannelIndex(sp.azimuthDeg)
      if (pidx >= outChannels.length) continue
      const src = sp.channel < inChannels.length ? inChannels[sp.channel] : in0 // 越界取 0 号
      const g = sp.gain
      for (let i = 0; i < frameCount; i++) {
        outChannels[pidx][i] += g * src[i]
      }
    }
  }
}

// AudioWorklet 全局作用域下才存在 registerProcessor；Node/测试环境跳过注册。
typeof registerProcessor !== 'undefined' &&
  registerProcessor(SPATIAL_WORKLET_PROCESSOR_NAME, SpatialProcessor)

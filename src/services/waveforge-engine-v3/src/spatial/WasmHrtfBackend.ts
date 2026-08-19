/**
 * WasmHrtfBackend —— 空间渲染的 Rust/WASM 性能后端（HSE v3 空间音频）
 *
 * 性能内核：`rust/hrtf-core`（Rust 编译为 WASM，纯 C ABI、无 wasm-bindgen，
 * 同步实例化）。与 TS 参考后端 `TsConvolverBackend`（复用 dsp/Convolver.ts
 * 分区 FFT 卷积）数值对拍，公式完全一致：
 *   - 分区卷积：L=512、FFT 1024，wet[t] = (x*h)[t-L]（x=扬声器源信号，h=最近邻 HRIR）；
 *   - 干路径：输入经 512 样本延迟线（与湿路对齐，系统总延迟 = 512）；
 *   - 空气吸收一阶低通：y[n]=(1-α)·x[n]+α·y[n-1]，α=exp(-2π·fc/fs)，fc=4000/(1+d) Hz；
 *   - 距离增益：inverse=min(1, 1/max(d,1))；linear=max(0, 1-(d-1)/(50-1))；
 *     exponential=pow(max(d,1)/1, -1)；
 *   - 混合：out = ((1-amount)·dry + amount·wetSum) · master_gain；
 *   - 多普勒（§4.6，模式 C）：config.dopplerVelocity → spatial_set_doppler（f32 ABI），
 *     Rust 侧按每 speaker 方位算 playback_rate = clamp(c/(c − v·dir), 0.5, 2.0)
 *     （c=343 m/s），吸收/距离增益后、卷积前做小数延迟线重采样——与 TS 参考侧
 *     resampleSpeaker 逐位对齐（对拍容差 1e-5 有最大余量）；rate==1 直通；
 *   - 房间模拟（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响）**在 Rust 内核内实现**：
 *     setConfig 时 config.room !== 'off' → spatial_set_room_preset(预设枚举)
 *     （自定义尺寸本轮不暴露，ABI spatial_set_room 已就绪）；'off' →
 *     spatial_set_room_preset(0) 旁路。与 TS 参考侧 roomSim.ts 逐位对拍（同预设表）。
 *   - 声源大小 size（§4.7 扩散声源）：VirtualSpeakerRaw.size（ABI 已传，TS 侧
 *     setConfig 已写）→ Rust 侧方向模糊（az ± size·30° 两方向 HRIR 50/50 混合）+
 *     右耳去相关（size·6 样本一阶线性插值延迟线）；size=0 直通（回归逐位）。
 *   - 卷积模式（契约 spatial_set_convolution_mode）：config.convolution
 *     'partitioned'→0（默认，FFT 分区卷积）/ 'time'→1（时域直接卷积）。两模式
 *     同块调度同放行（wet[t]=(x*h)[t−512]）——干湿对齐一致、脉冲位置一致，
 *     输出仅差 FFT 圆整（≤1e-4）；getLatencySamples 均返回 512。
 *   - 遮挡（契约 spatial_set_occlusion，§4.7）：config.occlusionAmount 存在时 →
 *     spatial_set_occlusion（Rust 侧钳位 0..1：增益衰减 gain·(1−0.8·occ) + 空气式
 *     低通 fc=12000·(1−occ) Hz）；occlusion=0 全旁路（回归逐位）。
 *   - 多声道输入（②，spatial_render_multi）：N 路单声道输入 → 双耳——与
 *     processStereo 同算法仅输入侧扩展（按 speaker.channel 索引取源，越界取
 *     0 号）；2 路输入 + 相同 speaker 配置下与 processStereo 输出逐位一致。
 *   - 契约两函数（规划书 §3.2）：getHrir（调 spatial_get_hrir，按当前插值模式
 *     查询指定方向 HRIR 对——与渲染同源同路径）与 setDistanceModel（调
 *     spatial_set_distance_model，与 set_config 的 distanceModel 参数写同一内部
 *     字段、后调者生效——setConfig 在 set_config 之后同值补调一次，双入口等价
 *     且幂等，行为不变）。
 *
 * 内存管理要点：
 *   - wasm 线性内存在 spatial_alloc / loadHrtf 拷贝后可能增长，`memory.buffer`
 *     会更换身份——所有 Float32Array 视图在每次 alloc 之后重建，不跨 alloc 存活；
 *   - JS 侧保留一块固定 scratch（regions×4096 f32 区域 + 多声道指针数组 u32，
 *     loadHrtf/setConfig 后重建；processMulti 按输入路数扩容重建），
 *     所有输入/输出复制走 scratch 指针；
 *   - 热路径（processStereo/processMulti）零分配（subarray 仅为视图）。
 */
import type { DistanceModel, HrtfGrid, ListenerState, SpatialRenderConfig } from './types'
import type { SpatialBackend } from './SpatialBackend'

/** rust/hrtf-core 的 WASM 导出（#[no_mangle] extern "C"，见 rust/hrtf-core/src/lib.rs） */
interface HrtfCoreExports {
  readonly memory: WebAssembly.Memory
  spatial_load_hrtf(
    sampleRate: number,
    azCount: number,
    elCount: number,
    hrirLen: number,
    azPtr: number,
    elPtr: number,
    leftPtr: number,
    rightPtr: number,
  ): number
  spatial_set_config(
    speakersPtr: number,
    speakerCount: number,
    room: number,
    roomAmount: number,
    amount: number,
    distanceModel: number,
    masterGain: number,
  ): number
  /** 设置 HRTF 插值模式：0=nearest（最近邻）/ 1=spherical（球谐插值）；非法返回 -1 */
  spatial_set_hrtf_interp_mode(mode: number): number
  /**
   * 设置卷积模式（契约 spatial_set_convolution_mode）：0=partitioned（FFT 分区卷积，
   * 默认）/ 1=time（时域直接卷积）。两模式干湿对齐一致、脉冲位置一致（±0 样本）、
   * 输出仅差 FFT 圆整（≤1e-4）；getLatencySamples 均返回 512。非法返回 -1。
   */
  spatial_set_convolution_mode(mode: number): number
  /**
   * 设置遮挡/衍射简化（契约 spatial_set_occlusion，§4.7）：0..1 全局遮挡量（Rust
   * 侧钳位）→ 每 speaker 增益衰减 gain·(1−0.8·occ) + 空气式低通
   * fc = 12000·(1−occ) Hz；0=全旁路（回归逐位）。返回 0=成功、-1 未 load_hrtf。
   */
  spatial_set_occlusion(amount: number): number
  /**
   * 设置多普勒（§4.6，模式 C）：听者速度（世界坐标 m/s，f32 ABI）与开关
   * （0=关闭 / 非 0=开启）；返回 0=成功、-1 未 load_hrtf。
   */
  spatial_set_doppler(velocityX: number, velocityY: number, velocityZ: number, enabled: number): number
  /**
   * 设置房间（预设，§3.2 契约）：0=off 1=studio 2=hall 3=stage 4=church
   * 5=outdoor 6=bathroom 7=corridor（与 RoomPreset 顺序一致；参数表与 TS 侧
   * roomSim.ts 一致）；返回 0=成功、-1 预设非法、-2 未 load_hrtf。
   */
  spatial_set_room_preset(preset: number): number
  /**
   * 设置房间（自定义尺寸，§3.2 契约；本轮 JS 侧不调用，保留 ABI 就绪）：
   * width/height/depth（米）、reflectivity（0..1）、earlyOrders（0..3）、
   * rt60Sec（秒）；返回 0=成功、-1 参数非法、-2 未 load_hrtf。
   */
  spatial_set_room(
    width: number,
    height: number,
    depth: number,
    reflectivity: number,
    earlyOrders: number,
    rt60Sec: number,
  ): number
  /**
   * 设置距离衰减模型（§3.2 契约）：0=inverse 1=linear 2=exponential。
   * 与 spatial_set_config 的 distanceModel 参数写同一内部字段、后调者生效——
   * 双入口等价（set_config 在 build_speaker 预计算 dist_gain，本函数就地对每
   * speaker 重算，同一 dist_gain_for 公式）。返回 0=成功、-1 非法、-2 未 load_hrtf。
   */
  spatial_set_distance_model(model: number): number
  /**
   * 查询指定方向的 HRIR 对（§3.2 契约）：按当前插值模式取 HRIR——0=nearest（最近邻
   * 网格查表）/ 1=spherical（球谐拟合），与 set_config 的 build_speaker 装载分支
   * 同源同路径。outL/outR 各写入 hrirLen 个 f32（长度 = 网格 hrirLength）。
   * 返回 0=成功、-1 未 load_hrtf、-2 len < hrirLen 或空指针。
   */
  spatial_get_hrir(
    azimuthDeg: number,
    elevationDeg: number,
    outL: number,
    outR: number,
    len: number,
  ): number
  spatial_render_objects(inL: number, inR: number, outL: number, outR: number, frameSize: number): number
  /**
   * 多声道输入渲染（②）：N 路单声道输入指针数组 → 双耳输出。与
   * spatial_render_objects 同算法仅输入侧扩展——speaker.channel 索引取输入
   * （channel ≥ 输入路数取 0 号；Rust 侧输入路数 = max(2, 最大 channel+1)，
   * 本侧指针数组容量与此一致并对缺失输入别名到 0 号区域）。
   */
  spatial_render_multi(inputPtrs: number, frameSize: number, outL: number, outR: number): number
  spatial_get_latency_samples(): number
  spatial_reset(): void
  spatial_alloc(size: number): number
  spatial_free(ptr: number, size: number): void
}

/**
 * JS 侧固定 scratch 帧上限（processStereo 按此分块）。
 * 分区长度 L=512（与 TS Convolver 默认 partitionSize=512 一致；
 * Rust getLatencySamples 恒返回 512，此处不重复定义）。
 */
const MAX_FRAME = 4096
/** speaker 数量上限（与 Rust 侧 MAX_SPEAKERS=256 对齐） */
const MAX_SPEAKERS = 256
/** 多声道指针数组容量下限（无扬声器/立体声配置下 Rust 侧输入路数恒 ≥2） */
const MIN_MULTI_PTR_CAP = 2

/** RoomPreset → 枚举序号（顺序与 types.ts 声明一致；Rust 侧 spatial_set_room_preset 同序） */
const ROOM_INDEX: Readonly<Record<string, number>> = {
  off: 0,
  studio: 1,
  hall: 2,
  stage: 3,
  church: 4,
  outdoor: 5,
  bathroom: 6,
  corridor: 7,
}

/** DistanceModel → 枚举值（Rust 侧：0=inverse 1=linear 2=exponential） */
const DISTANCE_MODEL_INDEX: Readonly<Record<string, number>> = {
  inverse: 0,
  linear: 1,
  exponential: 2,
}

export class WasmHrtfBackend implements SpatialBackend {
  /** wasm 实例导出 */
  private readonly exports: HrtfCoreExports
  /** wasm 线性内存（.buffer 在内存增长后变化，视图必须重建） */
  private readonly memory: WebAssembly.Memory

  /**
   * JS 侧固定 scratch（一块连续分配：regions×MAX_FRAME f32 区域 + 多声道指针数组
   * u32；loadHrtf 后重建，processMulti 按输入路数扩容重建）。
   * 区域布局：in0..inN-1 → outL → outR → 指针数组（紧跟 f32 区域末尾）。
   */
  private scratch: Float32Array | null = null
  private scratchPtr = 0
  private scratchBytes = 0
  /** scratch 内 f32 区域数（默认 4：inL/inR/outL/outR；processMulti 按输入路数重建） */
  private scratchRegions = 4
  /** 多声道指针数组视图（wasm 线性内存内，容量 = multiPtrCap u32） */
  private multiPtrs: Uint32Array | null = null
  private multiPtrsPtr = 0
  /** 多声道输入路数 = max(2, 最大 speaker.channel+1)（setConfig 按配置计算；与 Rust 侧 input_channel_count 一致） */
  private multiPtrCap = MIN_MULTI_PTR_CAP

  private loaded = false
  /** 网格 HRIR 长度（loadHrtf 时记录；getHrir 输出缓冲分配用，与 Rust 侧 hrir_len 一致） */
  private hrirLen = 0

  constructor(bytes: Uint8Array) {
    let module: WebAssembly.Module
    try {
      module = new WebAssembly.Module(bytes)
    } catch (err) {
      throw new Error(`WasmHrtfBackend: hrtf_core.wasm 模块解析失败（${String(err)}）`)
    }
    let instance: WebAssembly.Instance
    try {
      instance = new WebAssembly.Instance(module)
    } catch (err) {
      throw new Error(`WasmHrtfBackend: hrtf_core.wasm 实例化失败（${String(err)}）`)
    }
    this.exports = instance.exports as unknown as HrtfCoreExports
    this.memory = this.exports.memory
  }

  /** 设置 HRTF 网格（可重复调用换数据集）；实现内部预计算分区谱（Rust 侧） */
  loadHrtf(grid: HrtfGrid): void {
    const azCount = grid.azimuths.length
    const elCount = grid.elevations.length
    const hrirLen = grid.hrirLength
    if (!Number.isFinite(grid.sampleRate) || grid.sampleRate <= 0) {
      throw new Error('WasmHrtfBackend: HRTF 网格采样率非法')
    }
    if (azCount <= 0 || elCount <= 0 || hrirLen <= 0) {
      throw new Error('WasmHrtfBackend: HRTF 网格维度非法（azimuths/elevations/hrirLength 必须非空）')
    }
    const expect = azCount * elCount * hrirLen
    if (grid.left.length !== expect || grid.right.length !== expect) {
      throw new Error(
        `WasmHrtfBackend: HRTF 数据长度非法（期望 ${expect}，left=${grid.left.length} right=${grid.right.length}）`,
      )
    }
    // 拷贝到 wasm 内存（loadHrtf 可能触发内存增长——每次 alloc 后重建视图）。
    // copyF32 失败防御（O1 审计 2.3）：4 次连续 alloc，中途失败须 free 已分配的
    // ptr（否则前置 ptr 泄漏）。用数组追踪已分配 [ptr, bytes] 对，catch 块逐一 free。
    const allocated: Array<{ ptr: number; bytes: number }> = []
    let azPtr: number
    let elPtr: number
    let leftPtr: number
    let rightPtr: number
    try {
      azPtr = this.copyF32(grid.azimuths, azCount)
      allocated.push({ ptr: azPtr, bytes: azCount * 4 })
      elPtr = this.copyF32(grid.elevations, elCount)
      allocated.push({ ptr: elPtr, bytes: elCount * 4 })
      leftPtr = this.copyF32(grid.left, expect)
      allocated.push({ ptr: leftPtr, bytes: expect * 4 })
      rightPtr = this.copyF32(grid.right, expect)
      allocated.push({ ptr: rightPtr, bytes: expect * 4 })
    } catch (err) {
      // 中途失败：free 已分配的 ptr（LIFO 逆序释放，防 dlmalloc 碎片）
      for (let i = allocated.length - 1; i >= 0; i--) {
        this.exports.spatial_free(allocated[i].ptr, allocated[i].bytes)
      }
      throw err
    }
    const ret = this.exports.spatial_load_hrtf(
      grid.sampleRate | 0,
      azCount,
      elCount,
      hrirLen,
      azPtr,
      elPtr,
      leftPtr,
      rightPtr,
    )
    // 释放 JS 侧临时（wasm 内存保留网格副本）
    this.exports.spatial_free(azPtr, azCount * 4)
    this.exports.spatial_free(elPtr, elCount * 4)
    this.exports.spatial_free(leftPtr, expect * 4)
    this.exports.spatial_free(rightPtr, expect * 4)
    if (ret !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_load_hrtf 失败（错误码 ${ret}）`)
    }
    this.loaded = true
    this.hrirLen = hrirLen
    // 内存可能已增长：重建 JS 侧 scratch（默认 4 区域 + 最小指针数组容量；
    // setConfig 会按扬声器配置重建多声道容量）
    this.freeScratch()
    this.allocScratch(4, MIN_MULTI_PTR_CAP)
  }

  /** 更新渲染配置（全量替换语义）；房间由 spatial_set_room_preset 下发（Rust 内核内置 §4.5） */
  setConfig(config: SpatialRenderConfig): void {
    if (!this.loaded) {
      throw new Error('WasmHrtfBackend: 请先 loadHrtf 再 setConfig')
    }
    const n = config.speakers.length
    if (n > MAX_SPEAKERS) {
      throw new Error(`WasmHrtfBackend: speaker 数量超限（${n} > ${MAX_SPEAKERS}）`)
    }
    // VirtualSpeakerRaw 布局：24 字节 = channel(u32) + azimuth/elevation/distance/gain/size(f32×5)
    const words = n * 6
    const raw = new ArrayBuffer(words * 4)
    const u32 = new Uint32Array(raw)
    const f32 = new Float32Array(raw)
    // 最大 speaker.channel（多声道输入路数推导；立体声配置恒 0/1）
    let maxChannel = 0
    for (let i = 0; i < n; i++) {
      const s = config.speakers[i]
      const w = i * 6
      u32[w] = s.channel >>> 0
      f32[w + 1] = s.azimuthDeg
      f32[w + 2] = s.elevationDeg
      f32[w + 3] = s.distance
      f32[w + 4] = s.gain
      f32[w + 5] = s.size
      if (s.channel > maxChannel) maxChannel = s.channel
    }
    const ptr = this.exports.spatial_alloc(raw.byteLength)
    if (!ptr) {
      throw new Error('WasmHrtfBackend: spatial_alloc 失败（speakers）')
    }
    // alloc 后重建视图（内存可能已增长）——speakers 拷贝视图 + scratch 一并重建：
    // scratch 视图创建于 loadHrtf 末尾，若本次 alloc 触发 wasm 内存增长则已 detach，
    // 不重建会导致 processStereo 抛 detached ArrayBuffer 错误（64 对象必现）
    new Float32Array(this.memory.buffer, ptr, words).set(f32)
    this.freeScratch()
    // 多声道指针数组容量 = max(2, 最大 channel+1)（与 Rust 侧 input_channel_count 一致）
    this.allocScratch(4, Math.max(MIN_MULTI_PTR_CAP, maxChannel + 1))
    const room = ROOM_INDEX[config.room] ?? 0
    const distanceModel = DISTANCE_MODEL_INDEX[config.distanceModel] ?? 0
    // 插值模式透传（须先于 spatial_set_config：Rust 侧 build_speaker 读取该状态）：
    // 'nearest'→0（默认）/ 'spherical'→1（球谐插值，rust/hrtf-core 的 SH 拟合）
    const interpMode = config.hrtfInterp === 'spherical' ? 1 : 0
    const interpRet = this.exports.spatial_set_hrtf_interp_mode(interpMode)
    if (interpRet !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_set_hrtf_interp_mode 失败（错误码 ${interpRet}）`)
    }
    // 卷积模式透传（契约 spatial_set_convolution_mode）：'partitioned'→0（默认，
    // FFT 分区卷积）/ 'time'→1（时域直接卷积）。配置语义同插值模式（spatial_reset
    // 不重置）；置于 set_config 之前（Rust 侧 build_speaker 可按模式预计算）。
    const convMode = config.convolution === 'time' ? 1 : 0
    const convRet = this.exports.spatial_set_convolution_mode(convMode)
    if (convRet !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_set_convolution_mode 失败（错误码 ${convRet}）`)
    }
    const ret = this.exports.spatial_set_config(
      ptr,
      n,
      room,
      config.roomAmount,
      config.amount,
      distanceModel,
      config.masterGain,
    )
    this.exports.spatial_free(ptr, raw.byteLength)
    if (ret !== 0) {
      // -3 = 球谐拟合退化网格（AᵀA 秩亏：网格方向数 < 16）——附加中文说明便于排查
      const hint = ret === -3 ? '，球谐拟合退化网格（AᵀA 秩亏：网格方向数不足）' : ''
      throw new Error(`WasmHrtfBackend: spatial_set_config 失败（错误码 ${ret}${hint}）`)
    }
    // 距离模型双入口（§3.2 契约）：set_config 的 distanceModel 参数照传（Rust 侧
    // 仍接受），随后额外调 spatial_set_distance_model（同值）——两入口写同一内部
    // 字段、后调者生效；此处两次设置同值（幂等，保持现有行为），测试断言两入口
    // 设置同一模型输出逐位一致（Rust 侧 dist_gain 共用同一公式）。
    this.setDistanceModel(config.distanceModel ?? 'inverse')
    // 房间（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响，Rust 内核内置）：
    // config.room !== 'off' → spatial_set_room_preset(预设枚举)（参数表与 TS 参考侧
    // roomSim.ts 一致；自定义尺寸本轮不暴露，ABI spatial_set_room 已就绪）；
    // 'off' → spatial_set_room_preset(0) 全旁路（与现有一致，输出逐位不变）。
    // 置于 set_config 之后：room_amount 已存储，Rust 侧 build_room 重建房间状态。
    const roomPreset = ROOM_INDEX[config.room] ?? 0
    const roomRet = this.exports.spatial_set_room_preset(roomPreset)
    if (roomRet !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_set_room_preset 失败（错误码 ${roomRet}）`)
    }
    // 多普勒（§4.6，模式 C）：config.dopplerVelocity 存在时开启（速度经 f32 ABI
    // 边界量化，与 TS 参考侧 Math.fround 语义一致）；缺省 → enabled=0（无多普勒）。
    // 置于 spatial_set_config 之后：Rust 侧 set_config 会重置流式状态（重采样器
    // 随新速度从初始延迟起播），与 TS 参考侧 setConfig 语义对齐。
    const vel = config.dopplerVelocity
    const dopplerRet = this.exports.spatial_set_doppler(
      vel ? vel.x : 0,
      vel ? vel.y : 0,
      vel ? vel.z : 0,
      vel ? 1 : 0,
    )
    if (dopplerRet !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_set_doppler 失败（错误码 ${dopplerRet}）`)
    }
    // 遮挡（契约 spatial_set_occlusion，§4.7）：config.occlusionAmount **存在时**下发
    // （0..1 钳位由 Rust 侧执行；缺省不调用——保留上次值，与契约语义一致）。
    // 置于 set_config 之后：Rust 侧配置重建/流式重置后生效（与多普勒同风格）。
    if (config.occlusionAmount !== undefined) {
      const occRet = this.exports.spatial_set_occlusion(config.occlusionAmount)
      if (occRet !== 0) {
        throw new Error(`WasmHrtfBackend: spatial_set_occlusion 失败（错误码 ${occRet}）`)
      }
    }
    // 尾部重建 scratch：spatial_set_config / spatial_set_room_preset 等 Rust 侧调用
    // 内部会分配扬声器/房间缓冲（dlmalloc 可能触发 wasm 内存增长 → memory.buffer
    // 更换身份，之前创建的视图已 detach）。旧实现同样存在该隐患，仅在网格较小、
    // 堆余量不足时才暴露（网格内嵌越大越不容易触发）。此处统一重建保证
    // processStereo / processMulti 的 scratch 视图恒有效（非热路径，允许分配）。
    this.freeScratch()
    this.allocScratch(4, this.multiPtrCap)
  }

  /** 更新听者状态（波 1 各模式均固定原点朝前，忽略） */
  setListener(_listener: ListenerState): void {
    // 波 1 占位：头锁定/世界漫游尚未实现，与 TS 参考一致忽略
  }

  /**
   * 查询指定方向的 HRIR 对（§3.2 契约）：按当前插值模式取 HRIR——nearest=最近邻
   * 网格查表 / spherical=球谐拟合，与渲染同源同路径（Rust 侧 spatial_get_hrir 与
   * build_speaker 装载分支同源）。返回 { left, right }（各为长度 = 网格
   * hrirLength 的新 Float32Array）。
   * 实现：alloc 输出缓冲 → spatial_get_hrir → 拷贝回（视图在全部 alloc 之后重建，
   * 防 memory.buffer 换身份）；非零返回抛中文 Error。
   */
  getHrir(azimuthDeg: number, elevationDeg: number): { left: Float32Array; right: Float32Array } {
    if (!this.loaded) {
      throw new Error('WasmHrtfBackend: 请先 loadHrtf 再 getHrir')
    }
    const hl = this.hrirLen
    const lPtr = this.exports.spatial_alloc(hl * 4)
    if (!lPtr) {
      throw new Error('WasmHrtfBackend: spatial_alloc 失败（getHrir 左耳输出）')
    }
    const rPtr = this.exports.spatial_alloc(hl * 4)
    if (!rPtr) {
      this.exports.spatial_free(lPtr, hl * 4)
      throw new Error('WasmHrtfBackend: spatial_alloc 失败（getHrir 右耳输出）')
    }
    const ret = this.exports.spatial_get_hrir(azimuthDeg, elevationDeg, lPtr, rPtr, hl)
    // 失败前置（O1 审计 6.5）：失败时 wasm 未写入输出缓冲（或写入未定义内容），
    // 先抛错再 slice/free，避免读到陈旧/未初始化数据 + 释放后无效访问。
    if (ret !== 0) {
      this.exports.spatial_free(lPtr, hl * 4)
      this.exports.spatial_free(rPtr, hl * 4)
      // -3 = 球谐拟合退化网格（AᵀA 秩亏：网格方向数 < 16）——附加中文说明便于排查
      const hint = ret === -3 ? '，球谐拟合退化网格（AᵀA 秩亏：网格方向数不足）' : ''
      throw new Error(`WasmHrtfBackend: spatial_get_hrir 失败（错误码 ${ret}${hint}）`)
    }
    // 视图在全部 alloc 之后重建（内存可能已增长）；slice 拷贝回 JS 侧新数组
    // （随后释放 wasm 临时，返回数组不依赖 wasm 内存）
    const left = new Float32Array(this.memory.buffer, lPtr, hl).slice()
    const right = new Float32Array(this.memory.buffer, rPtr, hl).slice()
    this.exports.spatial_free(lPtr, hl * 4)
    this.exports.spatial_free(rPtr, hl * 4)
    return { left, right }
  }

  /**
   * 设置距离衰减模型（§3.2 契约）：inverse / linear / exponential。Rust 侧与
   * set_config 的 distanceModel 参数写同一内部字段、后调者生效——双入口等价
   * （就地对每 speaker 重算 dist_gain，不重建流式状态）。非法模型抛中文 Error。
   */
  setDistanceModel(model: DistanceModel): void {
    const idx = DISTANCE_MODEL_INDEX[model]
    if (idx === undefined) {
      throw new Error(`WasmHrtfBackend: 非法距离模型 ${String(model)}`)
    }
    const ret = this.exports.spatial_set_distance_model(idx)
    if (ret !== 0) {
      throw new Error(`WasmHrtfBackend: spatial_set_distance_model 失败（错误码 ${ret}）`)
    }
  }

  /** 渲染一个 block（任意帧长 ≤ 4096，超出自动分块） */
  processStereo(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const scratch = this.scratch
    if (!scratch) {
      throw new Error('WasmHrtfBackend: 尚未 loadHrtf')
    }
    const B = Math.min(inL.length, inR.length, outL.length, outR.length)
    let done = 0
    while (done < B) {
      const n = Math.min(MAX_FRAME, B - done)
      // 视图（零分配）：inL / inR / outL / outR 各占 MAX_FRAME f32
      const inLv = scratch.subarray(0, n)
      const inRv = scratch.subarray(MAX_FRAME, MAX_FRAME + n)
      const outLv = scratch.subarray(2 * MAX_FRAME, 2 * MAX_FRAME + n)
      const outRv = scratch.subarray(3 * MAX_FRAME, 3 * MAX_FRAME + n)
      inLv.set(inL.subarray(done, done + n))
      inRv.set(inR.subarray(done, done + n))
      const ret = this.exports.spatial_render_objects(
        this.scratchPtr,
        this.scratchPtr + MAX_FRAME * 4,
        this.scratchPtr + 2 * MAX_FRAME * 4,
        this.scratchPtr + 3 * MAX_FRAME * 4,
        n,
      )
      if (ret !== 0) {
        throw new Error(`WasmHrtfBackend: spatial_render_objects 失败（错误码 ${ret}）`)
      }
      outL.set(outLv, done)
      outR.set(outRv, done)
      done += n
    }
    // 防御：out 长于输入时补零，保证"完整写入"
    if (outL.length > B) outL.fill(0, B)
    if (outR.length > B) outR.fill(0, B)
  }

  /**
   * 渲染一个 block（多声道输入 → 双耳，SpatialBackend.processMulti 可选方法）：
   * 各输入拷贝进 wasm scratch（N×4096 上限；输入路数变化时 alloc 重建）→ 构造
   * 指针数组（容量 = 输入路数，缺失输入别名到 0 号区域——「越界取 0 号」）→
   * spatial_render_multi → 拷贝回。与 processStereo 同算法仅输入侧扩展：
   * 2 路输入 + 相同 speaker 配置下输出与 processStereo 逐位一致（回归测试）。
   */
  processMulti(inputs: Float32Array[], outL: Float32Array, outR: Float32Array): void {
    if (!this.scratch) {
      throw new Error('WasmHrtfBackend: 尚未 loadHrtf')
    }
    if (inputs.length === 0) {
      // 防御：无输入（处理器多声道路径恒 ≥3 路，不会走到）→ 静音输出
      outL.fill(0)
      outR.fill(0)
      return
    }
    // 实际拷贝路数 = min(输入路数, 指针数组容量)——扬声器 channel 只引用 0..cap-1，
    // 超出部分无引用不拷贝。输入路数变化（need 超出现有区域数）→ scratch 重建
    // （仅变化时分配一次，稳态零分配）
    const used = Math.min(inputs.length, this.multiPtrCap)
    const need = used + 2
    if (need > this.scratchRegions) {
      this.freeScratch()
      this.allocScratch(need, this.multiPtrCap)
    }
    const scratch = this.scratch as Float32Array
    // 手写 for 求 min（O1 审计 3.2）：避免 inputs.map 临时数组分配（每块一次）。
    let B = outL.length < outR.length ? outL.length : outR.length
    for (let i = 0; i < inputs.length; i++) {
      const len = inputs[i].length
      if (len < B) B = len
    }
    let done = 0
    while (done < B) {
      const n = Math.min(MAX_FRAME, B - done)
      // 视图（零分配）：各输入区域 + outL/outR 区域（紧跟输入之后）
      for (let i = 0; i < used; i++) {
        scratch.subarray(i * MAX_FRAME, i * MAX_FRAME + n).set(inputs[i].subarray(done, done + n))
      }
      const outLv = scratch.subarray(used * MAX_FRAME, used * MAX_FRAME + n)
      const outRv = scratch.subarray((used + 1) * MAX_FRAME, (used + 1) * MAX_FRAME + n)
      // 指针数组：i < 实际输入路数 → 对应输入区域；≥（缺失输入，扬声器 channel
      // 越界）→ 别名 0 号区域（与 TS 参考 processMulti「越界取 0 号」一致）
      for (let i = 0; i < this.multiPtrCap; i++) {
        this.multiPtrs![i] = this.scratchPtr + (i < inputs.length ? i : 0) * MAX_FRAME * 4
      }
      const ret = this.exports.spatial_render_multi(
        this.multiPtrsPtr,
        n,
        this.scratchPtr + used * MAX_FRAME * 4,
        this.scratchPtr + (used + 1) * MAX_FRAME * 4,
      )
      if (ret !== 0) {
        throw new Error(`WasmHrtfBackend: spatial_render_multi 失败（错误码 ${ret}）`)
      }
      outL.set(outLv, done)
      outR.set(outRv, done)
      done += n
    }
    // 防御：out 长于输入时补零，保证"完整写入"
    if (outL.length > B) outL.fill(0, B)
    if (outR.length > B) outR.fill(0, B)
  }

  /** 后端引入的延迟样本数 = 分区长度 512（与 TS 侧对齐） */
  getLatencySamples(): number {
    return this.exports.spatial_get_latency_samples() >>> 0
  }

  /** 清零流式状态（累加器/延迟线/滤波状态；网格与预计算谱保留） */
  reset(): void {
    this.exports.spatial_reset()
  }

  // ---------------------------------------------------------------- 内部

  /** 拷贝 f32 数组到 wasm 并返回指针（调用方负责 spatial_free） */
  private copyF32(src: ArrayLike<number>, size: number): number {
    const ptr = this.exports.spatial_alloc(size * 4)
    if (!ptr) {
      throw new Error('WasmHrtfBackend: spatial_alloc 失败（拷贝临时）')
    }
    // alloc 后重建视图（内存可能已增长）
    new Float32Array(this.memory.buffer, ptr, size).set(src)
    return ptr
  }

  /**
   * 分配 JS 侧固定 scratch（一块连续内存：regions×MAX_FRAME f32 区域 +
   * ptrCap u32 多声道指针数组，紧跟 f32 区域末尾——wasm32 指针 = u32，4 字节对齐）。
   */
  private allocScratch(regions: number, ptrCap: number): void {
    const bytes = regions * MAX_FRAME * 4 + ptrCap * 4
    const ptr = this.exports.spatial_alloc(bytes)
    if (!ptr) {
      throw new Error('WasmHrtfBackend: spatial_alloc 失败（scratch）')
    }
    this.scratchPtr = ptr
    this.scratchBytes = bytes
    this.scratchRegions = regions
    this.multiPtrCap = ptrCap
    // alloc 后重建视图（内存可能已增长）
    this.scratch = new Float32Array(this.memory.buffer, ptr, regions * MAX_FRAME)
    this.multiPtrs = new Uint32Array(this.memory.buffer, ptr + regions * MAX_FRAME * 4, ptrCap)
    this.multiPtrsPtr = ptr + regions * MAX_FRAME * 4
  }

  private freeScratch(): void {
    if (this.scratchPtr !== 0 && this.scratchBytes > 0) {
      this.exports.spatial_free(this.scratchPtr, this.scratchBytes)
      this.scratchPtr = 0
      this.scratchBytes = 0
      this.scratch = null
      this.multiPtrs = null
      this.multiPtrsPtr = 0
    }
  }
}

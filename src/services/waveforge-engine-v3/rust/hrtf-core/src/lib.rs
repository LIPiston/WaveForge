//! hrtf_core —— HSE v3 空间音频的 Rust HRTF 渲染核心（WASM，纯 C ABI）
//!
//! 与 TS 侧参考后端 `TsConvolverBackend`（复用 `src/dsp/Convolver.ts` 分区 FFT 卷积）
//! 做数值对拍，算法结构完全对齐：
//!   - 分区长度 L = 512，FFT 长度 N = 1024（nextPow2(2L)，与 Convolver 默认一致）；
//!   - 湿路 = 均匀分区卷积（overlap-add，Gardner 1995 语义），输出相对输入延迟 L；
//!   - 干路 = 输入经 512 样本延迟线（与湿路对齐，系统总延迟 = L）；
//!   - 混合：out = ((1-amount)·dry + amount·wetSum) · master_gain。
//!
//! 本波三件套（§4.7 与契约，TS/Rust 双后端逐位对拍）：
//!   - 声源大小 size（扩散声源，0..1）：方向模糊——set_config 时 size>0 的 speaker
//!     用 az ± size·30° 两个方向的 HRIR 对每耳各 50% 混合（(h1+h2)·0.5，f64 中间量、
//!     f32 写回）作该 speaker 的 HRIR（size=0 → 原方向单 HRIR，与现状逐位一致）；
//!     双耳去相关——右耳源额外小数延迟 size·6 样本（一阶线性插值延迟线，每 speaker
//!     状态，公式见 decorr_next；size=0 直通）。"更宽的方向感"。
//!   - 时域卷积（spatial_set_convolution_mode，0=partitioned 1=time）：time 模式
//!     每 speaker 每耳直接时域卷积（HRIR 逐样本乘加，环形输入历史跨块携带上一块
//!     尾部 = "卷积尾 + 当前块"）。干湿对齐设计：时域卷积与分区模式**同块调度同
//!     放行**（输入块装配 + 512 样本湿块缓冲延迟，wet[t] = (x*h)[t−512]），因此两
//!     模式干湿对齐一致、脉冲位置一致（±0 样本），输出仅差 FFT 圆整（≤1e-4）；
//!     getLatencySamples 两种模式均返回 512。分区模式（默认）行为不变（回归逐位）。
//!   - 遮挡/衍射简化（spatial_set_occlusion，0..1 钳位）：全局遮挡量 → 每 speaker
//!     增益衰减 gain·(1 − 0.8·occlusion) + 空气式低通 fc = 12000·(1−occlusion) Hz
//!     （系数公式与空气吸收同族 α = exp(−2π·fc/fs)，状态每 speaker 独立；
//!     fc 钳位 ≥1Hz——防 α=1 退化为纯保持/全静音，"遮挡=1 增益≈0.2"语义：
//!     低频以 0.2 增益通过、高频被强烈低通）。occlusion=0 全旁路（回归逐位）。
//!   - 多声道输入（②，spatial_render_multi）：N 路单声道输入 → 双耳输出——与
//!     spatial_render_objects 同算法仅输入侧扩展（SpeakerState.channel 保留原始值：
//!     立体声渲染仍按「0=L 其余=R」路由，与旧 clamp 逐位一致；多声道渲染按
//!     channel 索引取输入，channel ≥ 输入路数取 0 号）。输入路数 = max(2,
//!     最大 channel+1)；JS 侧指针数组长度与此一致并对缺失输入别名到 0 号。
//!   - 契约两函数（规划书 §3.2）：spatial_get_hrir（按当前插值模式查询指定方向
//!     HRIR 对，与 build_speaker 装载分支同源同路径）与 spatial_set_distance_model
//!     （与 set_config 的 distance_model 参数写同一内部字段、后调者生效——
//!     双入口等价，dist_gain 共用 dist_gain_for 公式）。
//!
//! FFT 内核为自研基-2 蝶形（镜像 `src/dsp/fft.ts`：f64 twiddle / f64 累加 / f32 写回），
//! 与 TS 参考实现逐位对齐，保证 1e-5 对拍容差有最大余量。
//! 无任何外部依赖（未使用 rustfft——纯 std 可构建，离线安全，见 Cargo.toml 注释）。
//!
//! 约定：
//!   - 热路径（spatial_render_objects）零分配：所有缓冲在 load/set_config 时预分配；
//!   - 全程 f32（房间 DSP 用 f64 中间量 + f32 存储，与 TS 侧 JS number/Float32Array 语义一致）；
//!   - 房间模拟（规划书 §4.5）**在 Rust 侧实现**：spatial_set_room（自定义参数）/
//!     spatial_set_room_preset（预设枚举）设置；镜像声源法早期反射（1-3 阶）+
//!     FDN 晚期混响（8 条质数延迟线 + Hadamard 8×8/√8 反馈矩阵 + 每线阻尼低通）。
//!     算法与 TS 侧 src/spatial/roomSim.ts 逐位对拍：同预设参数表、同镜像枚举顺序、
//!     同延迟取整/增益/低通公式、同 FDN 结构与运算顺序（详见下方"房间模拟"一节）；
//!     room=off（preset 0）或 room_amount≤0 时全旁路（输出与无房间逐位一致）。
//!     spatial_set_config 的 room 索引参数保留 ABI 兼容但忽略（房间由
//!     spatial_set_room_preset / spatial_set_room 设置），room_amount 在此存储；
//!   - HRTF 插值模式（规划书 §4.1）：interp_mode 0=nearest（最近邻网格查表，波 1
//!     默认）/ 1=spherical（球谐插值，SH 拟合算法与 TS 侧 src/spatial/hrtfInterp.ts
//!     逐位对齐——同阶 L=3、同基函数公式、同伪逆求法、同运算顺序，见下方 SH 一节）；
//!     spatial_set_hrtf_interp_mode 设置，spatial_reset 不重置（配置语义）。
//!   - 多普勒（规划书 §4.6，模式 C）：spatial_set_doppler 设置听者速度（世界坐标 m/s）
//!     与开关；每 speaker 按自身方位（声源静止）算
//!       doppler_factor = c / (c + dot(−v, dir_normalized))，c=343 m/s
//!       playback_rate = clamp(doppler_factor, 0.5, 2.0)
//!     速率语义：rate>1 听者接近声源 → 音调升高/时间压缩（重采样读指针前移）；
//!     rate<1 远离 → 音调降低；rate==1 直通（与无多普勒输出逐位相等）。
//!     重采样（时变小数延迟线 + 线性插值）位于距离增益/空气吸收之后、分区卷积之前，
//!     与 TS 侧 resampleSpeaker 逐位对齐：速度 f32 量化（ABI）、f64 运算、
//!     同运算顺序、同钳位（f32 写回）。

#![allow(clippy::missing_safety_doc)]

use std::sync::Mutex;

/// 分区长度 L（与 TS Convolver 默认 partitionSize=512 一致；getLatencySamples 恒返回此值）
const PARTITION: usize = 512;
/// FFT 长度 N = nextPow2(2·L) = 1024
const FFT_SIZE: usize = 1024;
/// 单次 processStereo 帧上限（JS 侧 scratch 缓冲大小 4096，Rust 侧留余量）
const MAX_FRAME: usize = 8192;
/// speaker 数量上限（内存护栏；实际配置为 2 只虚拟扬声器）
const MAX_SPEAKERS: usize = 256;
/// 多普勒空气声速（m/s，§4.6；与 TS 侧 SPEED_OF_SOUND 一致）
const DOPPLER_C: f64 = 343.0;
/// 多普勒 playback_rate 钳位范围（与 TS 侧一致）
const DOPPLER_RATE_MIN: f64 = 0.5;
const DOPPLER_RATE_MAX: f64 = 2.0;
/// 度 → 弧度（f64；与 TS 侧 DEG2RAD 一致）
const DEG2RAD: f64 = std::f64::consts::PI / 180.0;
/// 多普勒重采样环形延迟线长度（每 speaker 一条；与 TS 侧 RESAMP_LINE 一致）
const RESAMP_LINE: usize = 1024;
/// 重采样初始小数延迟（样本）：rate≠1 起播的固定延迟（与 TS 侧一致）
const RESAMP_START_DELAY: f64 = 512.0;
/// 延迟钳位下界（≥1：读指针不越过最新样本）
const RESAMP_MIN_DELAY: f64 = 1.0;
/// 延迟钳位上界（DLINE−2：线性插值双抽头始终落在环内）
const RESAMP_MAX_DELAY: f64 = (RESAMP_LINE - 2) as f64;
/// 声源大小方向模糊角度系数（度）：HRIR 对取 az ± size·30° 两方向 50/50 混合（§4.7）
const SIZE_BLUR_DEG: f64 = 30.0;
/// 双耳去相关延迟线长度（每 speaker 一条；最大延迟 size·6=6 样本 + 双抽头余量，
/// 与 TS 侧 DECORR_LINE 一致）
const DECORR_LINE: usize = 16;
/// 遮挡增益衰减系数（§4.7）：gain·(1 − 0.8·occlusion)
const OCC_GAIN_FACTOR: f64 = 0.8;
/// 遮挡空气式低通截止基准（Hz）：fc = 12000·(1 − occlusion)
const OCC_FC_BASE: f64 = 12000.0;
/// 遮挡低通截止钳位下界（Hz）：防 α=1 退化为纯保持/全静音（"遮挡=1 增益≈0.2"语义：
/// 低频仍以 0.2 增益通过、高频被强烈低通）
const OCC_FC_MIN: f64 = 1.0;

// ---------------------------------------------------------------------------
// 房间模拟（规划书 §4.5）常量与结构
// 与 TS 侧 src/spatial/roomSim.ts 逐位对拍：同预设参数表（ROOM_PRESETS）、
// 同镜像枚举顺序、同延迟取整（round(dist·fs/c)）、同增益（reflectivity^o/d²）、
// 同低通（fc=8000/(1+o) 早期 / 4000Hz FDN 阻尼）、同 FDN（质数延迟 + H8/√8）。
// 房间 DSP 一律 f64 中间量 + f32 存储（与 TS 侧 JS number + Float32Array 语义一致）。
// ---------------------------------------------------------------------------

/// 房间预设参数表（(width, height, depth, reflectivity, rt60)，单位：米/秒；
/// 与 TS 侧 roomSim.ts 的 ROOM_PRESETS 完全一致——改一处必须同步另一处）：
///   1=studio 录音棚（小空间短尾）/ 2=hall 音乐厅（大空间长尾）/
///   3=stage 舞台 / 4=church 教堂（超长尾）/
///   5=outdoor 户外（弱反射）/ 6=bathroom 浴室（瓷砖高反射）/
///   7=corridor 走廊（窄长通道）
const ROOM_PRESETS: [(f64, f64, f64, f64, f64); 7] = [
    (5.0, 3.0, 4.0, 0.25, 0.45),
    (25.0, 12.0, 18.0, 0.6, 2.2),
    (18.0, 8.0, 14.0, 0.5, 1.4),
    (30.0, 18.0, 40.0, 0.75, 4.5),
    (80.0, 30.0, 60.0, 0.15, 1.2),
    (2.5, 2.6, 2.2, 0.9, 1.8),
    (2.2, 2.8, 18.0, 0.5, 1.6),
];

/// 早期反射一阶低通截止基准（Hz）：fc = 8000/(1+阶)，高频吸收随反射次数
const EARLY_LP_FC_BASE: f64 = 8000.0;
/// FDN 阻尼低通截止（Hz，每线相同）
const FDN_LP_FC: f64 = 4000.0;
/// FDN 质数延迟（样本 @48kHz；按 fs 缩放后四舍五入，与 TS 侧 FDN_PRIMES 一致）
const FDN_PRIMES: [usize; 8] = [179, 211, 251, 307, 359, 419, 467, 521];

/// 房间几何/混响参数（spatial_set_room / spatial_set_room_preset 设置；
/// f64 与 TS 侧预设表逐位一致；ABI f32 参数经转换存入）
#[derive(Clone, Copy)]
struct RoomParams {
    width: f64,
    height: f64,
    depth: f64,
    /// 反射系数（0..1，逐次反射乘一次）
    reflectivity: f64,
    /// 早期反射阶数（0..3，0=关闭早期反射，只保留 FDN）
    early_orders: u32,
    /// 混响时间（秒，FDN 反馈增益基准）
    rt60: f64,
}

/// 镜像声源早期反射抽头（双耳共用延迟/增益；低通状态每耳独立，f32 存储）
struct EarlyTap {
    /// 延迟（采样，≥1；round(dist·fs/c)）
    delay: usize,
    /// 增益 = 反射系数^阶 / 距离²（1/d² 衰减 × 逐次反射损耗）
    gain: f32,
    /// 一阶低通系数 a = exp(-2π·fc/fs)，fc = 8000/(1+阶)
    lp_coef: f32,
    lp_state_l: f32,
    lp_state_r: f32,
}

/// 每 speaker 的早期反射状态（build_room 时重建，fresh 零状态；
/// 双耳**各用独立写指针**——若共享指针，两耳 pass 在块边界交错会导致
/// 各自历史环出现永久空洞（某些位置从未被本耳写过），输出与块长相关；
/// 独立指针下每耳环随时间连续覆盖，延迟读与块长无关）
struct SpeakerRoomState {
    hist_l: Vec<f32>,
    hist_r: Vec<f32>,
    hist_pos_l: usize,
    hist_pos_r: usize,
    taps: Vec<EarlyTap>,
}

/// FDN 晚期混响（每耳 8 条质数延迟线 + Hadamard 8×8/√8 反馈矩阵 + 每线阻尼低通；
/// build_room 时重建，fresh 零状态）
struct FdnState {
    delays: [usize; 8],
    /// 每线反馈增益 g = 10^(-3·delay_sec/rt60)（Schroeder 公式）
    gains: [f32; 8],
    /// 每线阻尼低通系数（fc = 4000Hz）
    lp_coefs: [f32; 8],
    lines_l: [Vec<f32>; 8],
    lines_r: [Vec<f32>; 8],
    pos_l: [usize; 8],
    pos_r: [usize; 8],
    lp_state_l: [f32; 8],
    lp_state_r: [f32; 8],
    /// 正交反馈矩阵 H8/√8（Sylvester Hadamard，f64）
    matrix: [[f64; 8]; 8],
    /// 每样本矩阵乘 scratch（阻尼后线输出，f64）
    v: [f64; 8],
}

impl FdnState {
    fn new(fs: u32, rt60: f64) -> FdnState {
        let scale = fs as f64 / 48000.0;
        let mut delays = [0usize; 8];
        let mut gains = [0.0f32; 8];
        let mut lp_coefs = [0.0f32; 8];
        for (i, &p) in FDN_PRIMES.iter().enumerate() {
            // 质数延迟按 fs 缩放后四舍五入（≥1）
            let d = ((p as f64 * scale) + 0.5).floor() as usize;
            delays[i] = d.max(1);
            // 反馈增益（Schroeder 公式）：g = 10^(-3·delay_sec/rt60)，注释公式
            let g = 10.0f64.powf(-3.0 * (d as f64 / fs as f64) / rt60);
            gains[i] = g as f32;
            // 阻尼一阶低通：fc = 4000Hz（每线相同）
            let a = (-2.0 * std::f64::consts::PI * FDN_LP_FC / fs as f64).exp();
            lp_coefs[i] = a as f32;
        }
        // 正交反馈矩阵：Hadamard 8×8 / √8（Sylvester 构造 H[i][k] = (-1)^popcount(i&k)，
        // 与 TS 侧 FdnState 同构造，正交归一保证能量不爆炸）
        let inv = 1.0 / 8.0f64.sqrt();
        let mut matrix = [[0.0f64; 8]; 8];
        for i in 0..8 {
            for k in 0..8 {
                matrix[i][k] = if (i & k).count_ones() % 2 == 0 { inv } else { -inv };
            }
        }
        FdnState {
            delays,
            gains,
            lp_coefs,
            lines_l: std::array::from_fn(|i| vec![0.0f32; delays[i]]),
            lines_r: std::array::from_fn(|i| vec![0.0f32; delays[i]]),
            pos_l: [0; 8],
            pos_r: [0; 8],
            lp_state_l: [0.0; 8],
            lp_state_r: [0.0; 8],
            matrix,
            v: [0.0; 8],
        }
    }

    /// 处理单样本（ear=0 左 / 1 右；input 为已除扬声器数的湿总线样本）。
    /// 每样本：①读各线输出 + 阻尼低通 ②矩阵混合 + 反馈写回（input 馈入全部 8 线）
    /// ③输出 = Σ 阻尼后线输出。全部 f64 中间量 + f32 存储（与 TS 侧逐位一致）。
    fn process_sample(&mut self, ear: usize, input: f64) -> f64 {
        let (lines, pos, lp_states) = if ear == 0 {
            (&mut self.lines_l, &mut self.pos_l, &mut self.lp_state_l)
        } else {
            (&mut self.lines_r, &mut self.pos_r, &mut self.lp_state_r)
        };
        // ① 读 + 阻尼
        for i in 0..8 {
            let p = pos[i];
            let read = lines[i][p] as f64;
            let a = self.lp_coefs[i] as f64;
            let lp = (1.0 - a) * read + a * lp_states[i] as f64;
            lp_states[i] = lp as f32;
            self.v[i] = lp;
        }
        // ② 矩阵 + 反馈写回
        for i in 0..8 {
            let mut acc = 0.0f64;
            for k in 0..8 {
                acc += self.matrix[i][k] * self.v[k];
            }
            let p = pos[i];
            let g = self.gains[i] as f64;
            lines[i][p] = (input + g * acc) as f32;
            let np = p + 1;
            pos[i] = if np >= self.delays[i] { 0 } else { np };
        }
        // ③ 输出
        let mut out = 0.0f64;
        for i in 0..8 {
            out += self.v[i];
        }
        out
    }
}

/// 某轴的镜像声源坐标（含该轴反射阶数）：镜像声源法——轴上镜像坐标
/// = 2k·dim ± coord；按阶分组（顺序与 TS 侧 roomSim.ts 的 axisImages 完全一致）：
///   0 阶：[coord]（声源自身）；1 阶：[-coord, 2·dim−coord]（两壁各一次）；
///   2 阶：[2·dim+coord, coord−2·dim]；3 阶：[4·dim−coord, −2·dim−coord]
fn axis_images(coord: f64, dim: f64, order: u32) -> Vec<(f64, u32)> {
    match order {
        0 => vec![(coord, 0)],
        1 => vec![(-coord, 1), (2.0 * dim - coord, 1)],
        2 => vec![(2.0 * dim + coord, 2), (coord - 2.0 * dim, 2)],
        _ => vec![(4.0 * dim - coord, 3), (-2.0 * dim - coord, 3)],
    }
}

/// 全局引擎（单线程 WASM；Mutex 无实际竞争开销）
static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

/// twiddle 表缓存（按 N 惰性构建一次；f64，与 dsp/fft.ts 的 Float64Array 一致）
static TWIDDLES: std::sync::OnceLock<Vec<Vec<f64>>> = std::sync::OnceLock::new();

// ---------------------------------------------------------------------------
// WASM ABI（精确契约，全部 #[no_mangle] pub extern "C"，无导入导出依赖，同步实例化）
// ---------------------------------------------------------------------------

/// 虚拟扬声器原始布局（24 字节：u32 + 5×f32，与 JS 侧 VirtualSpeakerRaw 对齐）
#[repr(C)]
pub struct VirtualSpeakerRaw {
    pub channel: u32,
    pub azimuth_deg: f32,
    pub elevation_deg: f32,
    pub distance: f32,
    pub gain: f32,
    pub size: f32,
}

/// 载入 HRTF 网格（拷贝到内部静态存储；可重复调用换数据集）。
/// 返回 0=成功；负值为错误码（-1 维度非法 / -2 空指针 / -3 尺寸溢出）。
#[no_mangle]
pub extern "C" fn spatial_load_hrtf(
    sample_rate: u32,
    az_count: u32,
    el_count: u32,
    hrir_len: u32,
    az_ptr: *const f32,
    el_ptr: *const f32,
    left_ptr: *const f32,
    right_ptr: *const f32,
) -> i32 {
    if sample_rate == 0 || az_count == 0 || el_count == 0 || hrir_len == 0 {
        return -1;
    }
    if az_ptr.is_null() || el_ptr.is_null() || left_ptr.is_null() || right_ptr.is_null() {
        return -2;
    }
    let az_n = az_count as usize;
    let el_n = el_count as usize;
    let hl = hrir_len as usize;
    // 尺寸溢出护栏（wasm32 usize=u32）
    let total = match az_n
        .checked_mul(el_n)
        .and_then(|v| v.checked_mul(hl))
    {
        Some(t) if t > 0 => t,
        _ => return -3,
    };
    // load_hrtf 非热路径，允许分配（拷贝网格；wasm 内存保留网格，JS 侧临时可释放）
    let az: Vec<f32> = unsafe { std::slice::from_raw_parts(az_ptr, az_n) }.to_vec();
    let el: Vec<f32> = unsafe { std::slice::from_raw_parts(el_ptr, el_n) }.to_vec();
    let left: Vec<f32> = unsafe { std::slice::from_raw_parts(left_ptr, total) }.to_vec();
    let right: Vec<f32> = unsafe { std::slice::from_raw_parts(right_ptr, total) }.to_vec();
    let eng = Engine::new(sample_rate, az, el, left, right, az_n, hl);
    *ENGINE.lock().unwrap() = Some(eng);
    0
}

/// 设置渲染配置（全量替换语义）。room_amount 在此存储（房间混合量，§4.5）；
/// room 索引参数保留 ABI 兼容但忽略——房间几何由 spatial_set_room_preset /
/// spatial_set_room 设置（与 TS 参考侧"setConfig 仅透传预设"语义一致）。
/// distance_model 参数与 spatial_set_distance_model 写同一内部字段——两入口等价、
/// 后调者生效（本参数仍可用；见 spatial_set_distance_model 注释互标）。
/// 返回 0=成功；-1 未 load_hrtf / -2 speaker 数量超限 / -3 球谐拟合退化网格
/// （AᵀA 秩亏：网格方向数 < 16，由 build_speaker → sh_hrir → invert_matrix 透传）/
/// -4 距离模型非法。
#[no_mangle]
pub extern "C" fn spatial_set_config(
    speakers: *const VirtualSpeakerRaw,
    speaker_count: u32,
    _room: u32,
    room_amount: f32,
    amount: f32,
    distance_model: u32,
    master_gain: f32,
) -> i32 {
    if distance_model > 2 {
        return -4;
    }
    if speaker_count as usize > MAX_SPEAKERS {
        return -2;
    }
    let raws: &[VirtualSpeakerRaw] = if speaker_count == 0 || speakers.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(speakers, speaker_count as usize) }
    };
    let mut guard = ENGINE.lock().unwrap();
    let eng = match guard.as_mut() {
        Some(e) => e,
        None => return -1, // 未 load_hrtf
    };
    // 预计算每 speaker 的分区谱与增益（set_config 非热路径，允许分配）
    let mut spk: Vec<SpeakerState> = Vec::with_capacity(raws.len());
    for raw in raws {
        match eng.build_speaker(raw, distance_model) {
            Ok(st) => spk.push(st),
            Err(code) => return code,
        }
    }
    eng.amount = amount;
    eng.master_gain = master_gain;
    eng.distance_model = distance_model;
    eng.room_amount = room_amount;
    eng.speakers = spk;
    // 多声道输入块装配缓冲（spatial_render_multi 用）：按输入路数重建
    // （count = max(2, 最大 speaker.channel+1)，与 input_channel_count 一致）
    let l = PARTITION;
    let ic = eng.input_channel_count();
    eng.in_blocks = vec![vec![0.0f32; l]; ic];
    // 房间状态随扬声器布局重建（fresh 零状态；几何参数由 spatial_set_room* 提供，
    // 随后 JS 侧再调 spatial_set_room_preset 覆盖——幂等）
    eng.build_room();
    // 配置变更：流式状态清零（与 TS 参考"重建 Convolver 实例"语义一致）
    eng.reset_stream();
    0
}

/// 设置房间（自定义参数，规划书 §3.2 契约；§4.5 完整房间模拟）：
/// width/height/depth（米）、reflectivity（0..1 反射系数）、early_orders（1-3 阶，
/// 0=关闭早期反射，钳位 0..3）、rt60_sec（秒，FDN 反馈增益基准）。
/// 配置语义：立即重建房间状态（fresh 零状态），spatial_reset 不重置本参数。
/// 返回 0=成功；-1 参数非法（尺寸/rt60 ≤ 0 或反射系数越界）/ -2 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_room(
    width: f32,
    height: f32,
    depth: f32,
    reflectivity: f32,
    early_orders: u32,
    rt60_sec: f32,
) -> i32 {
    if width <= 0.0 || height <= 0.0 || depth <= 0.0 || rt60_sec <= 0.0 {
        return -1;
    }
    if !(0.0..=1.0).contains(&reflectivity) {
        return -1;
    }
    let orders = early_orders.min(3); // 钳位 0..3（0=关闭早期反射）
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            // ABI f32 参数经转换存入 f64（几何运算与 TS 侧 f64 语义一致）
            eng.room_params = Some(RoomParams {
                width: width as f64,
                height: height as f64,
                depth: depth as f64,
                reflectivity: reflectivity as f64,
                early_orders: orders,
                rt60: rt60_sec as f64,
            });
            eng.build_room();
            0
        }
        None => -2,
    }
}

/// 设置房间（预设，规划书 §3.2 契约）：0=off 1=studio 2=hall 3=stage 4=church
/// 5=outdoor 6=bathroom 7=corridor（与 TS 侧 RoomPreset 顺序一致；参数表 ROOM_PRESETS
/// 与 TS 侧 roomSim.ts 完全一致，改一处必须同步另一处）。预设早期反射阶数默认 2。
/// 0=off 时全旁路（不产生任何房间输出，与无房间逐位一致）。
/// 返回 0=成功；-1 预设非法 / -2 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_room_preset(preset: u32) -> i32 {
    let mut guard = ENGINE.lock().unwrap();
    let eng = match guard.as_mut() {
        Some(e) => e,
        None => return -2,
    };
    if preset == 0 {
        // off：旁路（与现有一致）
        eng.room_params = None;
        eng.build_room();
        return 0;
    }
    let idx = (preset - 1) as usize;
    if idx >= ROOM_PRESETS.len() {
        return -1;
    }
    let (w, h, d, r, rt) = ROOM_PRESETS[idx];
    eng.room_params = Some(RoomParams {
        width: w,
        height: h,
        depth: d,
        reflectivity: r,
        early_orders: 2, // 预设默认早期反射阶数（与 TS 侧默认一致）
        rt60: rt,
    });
    eng.build_room();
    0
}

/// 设置 HRTF 插值模式（规划书 §3.2 契约）：0=nearest（最近邻，默认）/ 1=spherical（球谐插值）。
/// 配置语义：spatial_reset 不重置本状态（仅 load_hrtf 换数据集时随新 Engine 回默认值，
/// JS 侧 setConfig 每次显式重设）。返回 0=成功；-1 模式非法 / -2 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_hrtf_interp_mode(mode: u32) -> i32 {
    if mode > 1 {
        return -1;
    }
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            eng.interp_mode = mode;
            0
        }
        None => -2,
    }
}

/// 设置多普勒效应（规划书 §4.6，模式 C）：听者速度（世界坐标 m/s）与开关。
/// 语义：听者速度 + 每个 speaker 的方位（声源静止）算
///   doppler_factor = c / (c + dot(−v, dir_normalized))，c=343 m/s
///   playback_rate = clamp(doppler_factor, 0.5, 2.0)
/// （公式与 TS 侧 dopplerRate 一致；dir 为 speaker 方位单位向量，方向从听者指向声源）。
/// 速度经 f32 ABI 量化后以 f64 参与运算（与 TS 侧 Math.fround 等价）；rate==1 直通。
/// 配置语义：由 WasmHrtfBackend.setConfig 每次显式调用；spatial_reset 不重置本状态。
/// 返回 0=成功；-1 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_doppler(velocity_x: f32, velocity_y: f32, velocity_z: f32, enabled: u32) -> i32 {
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            if enabled == 0 {
                eng.doppler_velocity = (0.0, 0.0, 0.0);
                eng.doppler_enabled = false;
            } else {
                eng.doppler_velocity = (velocity_x, velocity_y, velocity_z);
                eng.doppler_enabled = true;
            }
            0
        }
        None => -1,
    }
}

/// 设置卷积模式（契约 spatial_set_convolution_mode）：0=partitioned（FFT 分区卷积，
/// 默认）/ 1=time（时域直接卷积，HRIR 逐样本乘加）。干湿对齐设计：time 模式与
/// 分区模式**同块调度同放行**（输入块装配 + 512 样本湿块缓冲延迟，
/// wet[t] = (x*h)[t−512]）——两模式干湿对齐一致、脉冲响应位置一致（±0 样本），
/// 输出仅差 FFT 圆整（≤1e-4）；getLatencySamples 两种模式均返回 512。
/// 配置语义：spatial_reset 不重置本状态（与插值模式同风格；JS 侧 setConfig 每次
/// 显式重设）。返回 0=成功；-1 模式非法（>1）/ -2 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_convolution_mode(mode: u32) -> i32 {
    if mode > 1 {
        return -1;
    }
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            eng.conv_mode = mode;
            0
        }
        None => -2,
    }
}

/// 设置遮挡/衍射简化（契约 spatial_set_occlusion，§4.7）：全局遮挡量 0..1（钳位）。
/// 语义：每 speaker 增益衰减 gain·(1 − 0.8·occlusion)（乘在湿路贡献上）+
/// 空气式一阶低通 fc = 12000·(1−occlusion) Hz（系数公式与空气吸收同族
/// α = exp(−2π·fc/fs)，状态每 speaker 独立；fc 钳位 ≥1Hz 防 α=1 退化为纯保持/
/// 全静音——"遮挡=1 增益≈0.2"语义：低频以 0.2 增益通过、高频被强烈低通）。
/// occlusion=0 时全旁路（与现状逐位一致）。配置语义：spatial_reset 不重置本状态
/// （JS 侧 setConfig 有 occlusionAmount 字段时下发）；变更不清零滤波器状态
/// （平滑过渡，无咔哒声）。返回 0=成功；-1 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_occlusion(amount: f32) -> i32 {
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            let occ = amount.clamp(0.0, 1.0);
            eng.occlusion = occ;
            // 空气式低通系数（与空气吸收同族）：α = exp(−2π·fc/fs)，
            // fc = max(12000·(1−occ), 1) Hz（f32 存储，与 TS 侧 occCoef 对齐）
            let fc = (OCC_FC_BASE * (1.0 - occ as f64)).max(OCC_FC_MIN);
            eng.occ_alpha = (-2.0 * std::f64::consts::PI * fc / eng.sample_rate as f64).exp() as f32;
            eng.occ_gain = (1.0 - OCC_GAIN_FACTOR * occ as f64) as f32;
            0
        }
        None => -1,
    }
}

/// 设置距离衰减模型（规划书 §3.2 契约）：0=inverse 1=linear 2=exponential。
/// 与 set_config 的 distance_model 参数写**同一内部字段**、后调者生效——两入口等价
/// （set_config 参数仍可用，见其注释互标）。set_config 在 build_speaker 预计算每
/// speaker 距离增益（dist_gain_for）；本函数就地对每 speaker 重算 dist_gain
/// （同一 dist_gain_for 公式、同 f32 运算顺序——两入口设置同一模型输出逐位一致），
/// 不重建流式状态（渲染/湿路历史保留；配置语义：仅衰减模型变更）。
/// 返回 0=成功；-1 模型非法（>2）/ -2 未 load_hrtf。
#[no_mangle]
pub extern "C" fn spatial_set_distance_model(model: u32) -> i32 {
    if model > 2 {
        return -1;
    }
    let mut guard = ENGINE.lock().unwrap();
    match guard.as_mut() {
        Some(eng) => {
            eng.distance_model = model;
            for s in eng.speakers.iter_mut() {
                s.dist_gain = dist_gain_for(model, s.distance);
            }
            0
        }
        None => -2,
    }
}

/// 渲染一个 block：输入立体声 → 双耳输出（延迟 L=512 样本，见 render 注释）。
/// 返回 0=成功；-1 未 load_hrtf / -2 空指针 / -3 帧尺寸非法。
#[no_mangle]
pub extern "C" fn spatial_render_objects(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    frame_size: u32,
) -> i32 {
    let n = frame_size as usize;
    if n == 0 || n > MAX_FRAME {
        return -3;
    }
    if in_l.is_null() || in_r.is_null() || out_l.is_null() || out_r.is_null() {
        return -2;
    }
    let mut guard = ENGINE.lock().unwrap();
    let eng = match guard.as_mut() {
        Some(e) => e,
        None => return -1,
    };
    let in_l = unsafe { std::slice::from_raw_parts(in_l, n) };
    let in_r = unsafe { std::slice::from_raw_parts(in_r, n) };
    let out_l = unsafe { std::slice::from_raw_parts_mut(out_l, n) };
    let out_r = unsafe { std::slice::from_raw_parts_mut(out_r, n) };
    eng.render(in_l, in_r, out_l, out_r);
    0
}

/// 渲染一个 block（多声道输入，② 多声道输入/输出）：N 路单声道输入 → 双耳输出。
/// 与 spatial_render_objects 同算法仅输入侧扩展（复用 render_multi 内核，通道数
/// = max(2, 最大 speaker.channel+1)，见 input_channel_count）：
///   - input_ptrs：输入指针数组（长度 ≥ 通道数；JS 侧 WasmHrtfBackend 对缺失输入
///     别名到 0 号输入区域，实现「speaker.channel ≥ 实际输入路数 → 取 0 号输入」）；
///   - 干路 = 0/1 号输入（立体声下混）；扬声器按 channel 索引取输入、HRTF 双耳求和；
///   - 2 路输入 + 相同 speaker 配置下与 spatial_render_objects 输出逐位一致（回归）。
/// 返回 0=成功；-1 未 load_hrtf / -2 空指针 / -3 帧尺寸非法。
#[no_mangle]
pub extern "C" fn spatial_render_multi(
    input_ptrs: *const *const f32,
    frame_size: u32,
    out_l: *mut f32,
    out_r: *mut f32,
) -> i32 {
    let n = frame_size as usize;
    if n == 0 || n > MAX_FRAME {
        return -3;
    }
    if input_ptrs.is_null() || out_l.is_null() || out_r.is_null() {
        return -2;
    }
    let mut guard = ENGINE.lock().unwrap();
    let eng = match guard.as_mut() {
        Some(e) => e,
        None => return -1,
    };
    let count = eng.input_channel_count();
    let ptrs = unsafe { std::slice::from_raw_parts(input_ptrs, count) };
    let out_l = unsafe { std::slice::from_raw_parts_mut(out_l, n) };
    let out_r = unsafe { std::slice::from_raw_parts_mut(out_r, n) };
    eng.render_multi(ptrs, out_l, out_r);
    0
}

/// 后端引入的延迟样本数 = 分区长度 512（与 TS 侧对齐）
#[no_mangle]
pub extern "C" fn spatial_get_latency_samples() -> u32 {
    PARTITION as u32
}

/// 查询指定方向的 HRIR 对（规划书 §3.2 契约）：按当前插值模式取 HRIR——
/// 0=nearest（最近邻网格查表）/ 1=spherical（球谐拟合），与 set_config 的
/// build_speaker 装载分支**同源同路径**（注释互标：build_speaker = 本函数 +
/// 方向模糊（size）与分区谱预计算；本函数恒取原方向单 HRIR，不含 size 模糊）。
/// out_l/out_r 各写入 hrir_len 个 f32（长度取网格 hrir_len）。
/// 返回 0=成功；-1 未 load_hrtf / -2 len < hrir_len 或空指针 /
/// -3 球谐拟合退化网格（AᵀA 秩亏：网格方向数 < 16；由 sh_hrir → invert_matrix 透传）。
#[no_mangle]
pub extern "C" fn spatial_get_hrir(
    azimuth_deg: f32,
    elevation_deg: f32,
    out_l: *mut f32,
    out_r: *mut f32,
    len: u32,
) -> i32 {
    let mut guard = ENGINE.lock().unwrap();
    let eng = match guard.as_mut() {
        Some(e) => e,
        None => return -1, // 未 load_hrtf
    };
    let hl = eng.hrir_len;
    if (len as usize) < hl || out_l.is_null() || out_r.is_null() {
        return -2;
    }
    let out_l = unsafe { std::slice::from_raw_parts_mut(out_l, hl) };
    let out_r = unsafe { std::slice::from_raw_parts_mut(out_r, hl) };
    if eng.interp_mode == 1 {
        // spherical：球谐拟合（与 build_speaker 的 sh_hrir 分支同源）。
        // 退化网格（AᵀA 秩亏）时 sh_hrir 返回 Err(-3) → 透传给 JS 侧。
        let h = match eng.sh_hrir(azimuth_deg, elevation_deg) {
            Ok(h) => h,
            Err(code) => return code, // -3：退化网格
        };
        out_l.copy_from_slice(&h[0]);
        out_r.copy_from_slice(&h[1]);
    } else {
        // nearest：最近邻网格查表（与 build_speaker 的最近邻分支同源）
        let el_idx = eng.nearest_el(elevation_deg);
        let az_idx = eng.nearest_az(azimuth_deg);
        let base = (el_idx * eng.az_count + az_idx) * hl;
        out_l.copy_from_slice(&eng.left[base..base + hl]);
        out_r.copy_from_slice(&eng.right[base..base + hl]);
    }
    0
}

/// 清零流式状态（累加器 / 延迟线 / 滤波状态；保留网格与预计算谱）
#[no_mangle]
pub extern "C" fn spatial_reset() {
    if let Some(eng) = ENGINE.lock().unwrap().as_mut() {
        eng.reset_stream();
    }
}

/// JS 侧分配 wasm 线性内存（对齐 8；返回 0 表示失败）。幂等：可多次调用。
#[no_mangle]
pub extern "C" fn spatial_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let layout = match std::alloc::Layout::from_size_align(size, 8) {
        Ok(l) => l,
        Err(_) => return std::ptr::null_mut(),
    };
    unsafe { std::alloc::alloc(layout) }
}

/// 释放 spatial_alloc 分配的内存（ptr/size 必须与分配时一致）
#[no_mangle]
pub extern "C" fn spatial_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(size, 8) {
        unsafe { std::alloc::dealloc(ptr, layout) }
    }
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/// 单个虚拟扬声器的渲染状态（set_config 时全部预分配）
struct SpeakerState {
    /// 输入声道路由（原始 channel 值，见 VirtualSpeakerRaw.channel 语义）：
    /// 立体声渲染（spatial_render_objects）按「0=L、其余=R」路由（channel≥1 均取 R，
    /// 与旧「clamp 到 0/1」逐位一致）；多声道渲染（spatial_render_multi）按
    /// channel 索引取输入（channel ≥ 输入路数时取 0 号输入）。
    channel: usize,
    /// 扬声器增益（0..2，直接乘在湿路贡献上）
    gain: f32,
    /// 声源大小（0..1 钳位，§4.7 扩散声源）：>0 → 方向模糊 + 右耳去相关
    size: f32,
    /// 距离（米；房间镜像声源几何用，build_speaker 时存储）
    distance: f32,
    /// 距离增益（set_config 时按 distance_model 预计算）
    dist_gain: f32,
    /// 空气吸收一阶低通系数 α = exp(-2π·fc/fs)，fc = 4000/(1+d) Hz
    alpha: f32,
    /// 低通状态 y[n-1]
    absorb_state: f32,
    /// 遮挡空气式低通状态 y[n-1]（fc = 12000·(1−occ) Hz，系数在引擎级；§4.7）
    occ_state: f32,
    /// 多普勒方位单位向量（f64，方向从听者指向声源；set_config 时预计算，与 TS 侧一致）
    dir: (f64, f64, f64),
    /// 多普勒重采样环形延迟线（长度 RESAMP_LINE，set_config 时预分配）
    rsmp_line: Vec<f32>,
    /// 重采样写指针（环内索引 0..RESAMP_LINE）
    rsmp_pos: usize,
    /// 重采样小数延迟（样本，f64；初始 RESAMP_START_DELAY）
    rsmp_delay: f64,
    /// 双耳去相关延迟线（§4.7 声源大小：右耳源小数延迟 size·6 样本；长度 DECORR_LINE）
    decorr_line: Vec<f32>,
    /// 去相关写指针（环内索引 0..DECORR_LINE）
    decorr_pos: usize,
    /// 去相关延迟（样本，f64 = size·6；size=0 直通）
    decorr_delay: f64,
    /// 原始 HRIR 对（方向模糊后；分区模式用于预计算 spec，time 模式直接卷积用）
    hrir: [Vec<f32>; 2],
    /// time 模式环形输入历史（长度 = hrir_len，跨块携带上一块尾部；每耳一条）
    hist: [Vec<f32>; 2],
    /// time 模式历史写指针（每耳）
    hist_pos: [usize; 2],
    /// 右耳源缓冲（长度 L；仅 size>0 时填充——去相关延迟后的源）
    source_r: Vec<f32>,
    /// 左耳输入谱保存（长度 N；仅 size>0 分区模式用——右耳源另行 FFT 后的左耳谱副本）
    in_re: Vec<f32>,
    in_im: Vec<f32>,
    /// 分区数 P = ceil(hrir_len / L)
    partitions: usize,
    /// 每耳各分区预计算的频域谱（交错 re/im，长度 P·N·2）
    spec: [Vec<f32>; 2],
    /// 每耳 overlap-add 累加器（长度 (P+1)·L；time 模式作为本块卷积输出暂存）
    accum: [Vec<f32>; 2],
    /// 吸收+距离增益后的源块（长度 L）
    source: Vec<f32>,
    /// FFT 工作缓冲（长度 N）
    work_re: Vec<f32>,
    work_im: Vec<f32>,
    /// 复乘结果缓冲（长度 N）
    prod_re: Vec<f32>,
    prod_im: Vec<f32>,
}

/// 渲染引擎（全量流式状态，全部预分配）
struct Engine {
    sample_rate: u32,
    az: Vec<f32>,
    el: Vec<f32>,
    /// 左耳 HRIR 平面数组，行主序 [elIdx·azCount + azIdx]·hrirLen + n
    left: Vec<f32>,
    right: Vec<f32>,
    az_count: usize,
    hrir_len: usize,
    /// 干湿混合（空间化强度）0..1
    amount: f32,
    master_gain: f32,
    distance_model: u32,
    /// HRTF 插值模式：0=nearest（最近邻网格查表）/ 1=spherical（球谐插值）。
    /// 配置语义：spatial_reset 不重置；load_hrtf 换数据集时回默认 0（新 Engine）。
    interp_mode: u32,
    /// 卷积模式：0=partitioned（FFT 分区卷积，默认）/ 1=time（时域直接卷积）。
    /// 配置语义：spatial_reset 不重置（JS 侧 setConfig 每次显式重设）。
    conv_mode: u32,
    /// 听者速度（世界坐标 m/s，f32 ABI 语义；多普勒 §4.6）
    doppler_velocity: (f32, f32, f32),
    /// 多普勒开关（spatial_set_doppler enabled；false 时速度视为 0 → rate==1 直通）
    doppler_enabled: bool,
    /// 遮挡量（0..1 钳位，spatial_set_occlusion；0=全旁路与现状逐位一致）
    occlusion: f32,
    /// 遮挡空气式低通系数 α = exp(−2π·fc/fs)，fc = max(12000·(1−occ), 1) Hz
    occ_alpha: f32,
    /// 遮挡增益衰减 (1 − 0.8·occ)
    occ_gain: f32,
    /// 球谐插值拟合缓存（惰性：首次 spherical set_config 时算一次；换网格自动失效）
    sh_cache: Option<ShCache>,
    speakers: Vec<SpeakerState>,
    // ---- 房间模拟（§4.5：镜像声源早期反射 + FDN 晚期混响）----
    /// 房间几何/混响参数（spatial_set_room / spatial_set_room_preset 设置；None=off 旁路）
    room_params: Option<RoomParams>,
    /// 房间混合量（set_config 的 room_amount 存储；激活需 > 0）
    room_amount: f32,
    /// 房间是否激活（room_params 存在 && room_amount>0 && 有扬声器；build_room 时计算）
    room_active: bool,
    /// 每 speaker 的早期反射状态（与 speakers 平行；build_room 重建）
    speaker_room: Vec<SpeakerRoomState>,
    /// FDN 晚期混响（每耳 8 线；build_room 重建）
    fdn: Option<FdnState>,
    /// 早期反射累加总线 scratch（每块长度 L，双耳）
    early_block_l: Vec<f32>,
    early_block_r: Vec<f32>,
    // ---- 流式状态 ----
    /// 输入块装配（长度 L）
    in_block_l: Vec<f32>,
    in_block_r: Vec<f32>,
    /// 多声道输入块装配（spatial_render_multi 用，每输入声道一条，长度 L；
    /// set_config 时按输入路数 = max(2, 最大 speaker.channel+1) 重建——与
    /// in_block_l/r 同语义的逐声道版本：块满时 process_block_multi 读取）
    in_blocks: Vec<Vec<f32>>,
    input_pos: usize,
    /// 干路径延迟线（长度 L，环形）：写 x[t]，读 x[t-L]
    dry_line_l: Vec<f32>,
    dry_line_r: Vec<f32>,
    dry_pos: usize,
    /// 湿块环形队列（每耳，容量 2L）：内容为 y[0], y[1], …（y = 输入与 HRIR 的线性卷积）
    wet_l: Vec<f32>,
    wet_r: Vec<f32>,
    wet_pos: usize,
    wet_len: usize,
    /// 已喂入输入样本数（累计）
    fed: usize,
    /// 当前块的湿路累加（各 speaker 贡献求和，长度 L）
    wet_block_l: Vec<f32>,
    wet_block_r: Vec<f32>,
}

/// 距离衰减增益（与 TS 参考公式一致；set_config 的 build_speaker 与
/// spatial_set_distance_model 两入口共用——同公式同运算顺序，两入口设置同一模型
/// 输出逐位一致）：
///   inverse:     min(1, 1/max(d,1))
///   linear:      max(0, 1-(d-1)/(50-1))
///   exponential: pow(max(d,1)/1, -1)   —— 与 inverse 在数值上等价
fn dist_gain_for(model: u32, d: f32) -> f32 {
    match model {
        0 => (1.0 / d.max(1.0)).min(1.0),
        1 => (1.0 - (d - 1.0) / (50.0 - 1.0)).max(0.0),
        _ => (d.max(1.0) / 1.0).powf(-1.0),
    }
}

impl SpeakerState {
    /// 双耳去相关（§4.7 声源大小 size）：右耳源的一阶线性插值小数延迟线。
    /// 延迟 = size·6 样本（f64，build_speaker 预计算）。每样本——
    ///   1) 输入写入环形延迟线（写指针 +1）；
    ///   2) 读指针 pos = 最新样本索引 − delay（delay>0 时 pos < newest，
    ///      双抽头均为已写样本）；
    ///   3) floor/frac 线性插值（f64 计算、f32 写回，与 TS 侧 decorrRight 逐位对齐）。
    /// 仅右耳源调用（左耳不延迟——双耳去相关，"更宽的方向感"）；
    /// size=0 时调用方跳过（直通，不触碰延迟线状态）。
    fn decorr_next(&mut self, x: f32) -> f32 {
        self.decorr_line[self.decorr_pos] = x;
        self.decorr_pos = (self.decorr_pos + 1) % DECORR_LINE;
        let newest = (self.decorr_pos + DECORR_LINE - 1) % DECORR_LINE;
        let pos = newest as f64 - self.decorr_delay;
        let i0f = pos.floor();
        let frac = pos - i0f;
        let i0 = i0f as i64;
        let idx0 = i0.rem_euclid(DECORR_LINE as i64) as usize;
        let idx1 = if idx0 + 1 >= DECORR_LINE { 0 } else { idx0 + 1 };
        (self.decorr_line[idx0] as f64 * (1.0 - frac) + self.decorr_line[idx1] as f64 * frac) as f32
    }
}

impl Engine {
    fn new(
        sample_rate: u32,
        az: Vec<f32>,
        el: Vec<f32>,
        left: Vec<f32>,
        right: Vec<f32>,
        az_count: usize,
        hrir_len: usize,
    ) -> Engine {
        let l = PARTITION;
        Engine {
            sample_rate,
            az,
            el,
            left,
            right,
            az_count,
            hrir_len,
            amount: 0.7,
            master_gain: 0.9,
            distance_model: 0,
            interp_mode: 0,
            conv_mode: 0,
            doppler_velocity: (0.0, 0.0, 0.0),
            doppler_enabled: false,
            occlusion: 0.0,
            occ_alpha: 0.0,
            occ_gain: 1.0,
            sh_cache: None,
            speakers: Vec::new(),
            room_params: None,
            room_amount: 0.0,
            room_active: false,
            speaker_room: Vec::new(),
            fdn: None,
            early_block_l: vec![0.0; l],
            early_block_r: vec![0.0; l],
            in_block_l: vec![0.0; l],
            in_block_r: vec![0.0; l],
            in_blocks: Vec::new(),
            input_pos: 0,
            dry_line_l: vec![0.0; l],
            dry_line_r: vec![0.0; l],
            dry_pos: 0,
            wet_l: vec![0.0; 2 * l],
            wet_r: vec![0.0; 2 * l],
            wet_pos: 0,
            wet_len: 0,
            fed: 0,
            wet_block_l: vec![0.0; l],
            wet_block_r: vec![0.0; l],
        }
    }

    /// 方位角环形最近邻（±180° 相邻）：距离 Δ 归一化到 (-180, 180]
    fn nearest_az(&self, az: f32) -> usize {
        let mut best = 0usize;
        let mut best_d = f32::INFINITY;
        for (i, &a) in self.az.iter().enumerate() {
            let mut d = (a - az) % 360.0;
            if d > 180.0 {
                d -= 360.0;
            } else if d < -180.0 {
                d += 360.0;
            }
            let ad = d.abs();
            if ad < best_d {
                best_d = ad;
                best = i;
            }
        }
        best
    }

    /// 仰角最近邻（非环形）
    fn nearest_el(&self, el: f32) -> usize {
        let mut best = 0usize;
        let mut best_d = f32::INFINITY;
        for (i, &e) in self.el.iter().enumerate() {
            let ad = (e - el).abs();
            if ad < best_d {
                best_d = ad;
                best = i;
            }
        }
        best
    }

    /// 球谐插值拟合缓存（惰性：首次 spherical set_config 时算一次，换网格自动失效——
    /// load_hrtf 新建 Engine 即弃旧缓存）。纯 std、无外部依赖（延续手写 FFT 风格）。
    /// 返回 Ok(&ShCache) = 缓存命中或拟合成功 / Err(-3) = 退化网格（AᵀA 秩亏）。
    fn ensure_sh_cache(&mut self) -> Result<&ShCache, i32> {
        if self.sh_cache.is_none() {
            let c = ShCache::fit(&self.az, &self.el, &self.left, &self.right, self.hrir_len)?;
            self.sh_cache = Some(c);
        }
        Ok(self.sh_cache.as_ref().unwrap())
    }

    /// 按目标方向生成球谐插值 HRIR 对（左/右耳各 hrir_len 样本）。
    /// 算法与 TS 侧 src/spatial/hrtfInterp.ts 的 sphericalHrtf 逐位对齐：
    /// 同阶 L=3、同基函数公式（sh_basis）、同伪逆求法（invert_matrix）、
    /// 同求值顺序（out[t] = Σ_k c_k[t]·Y_k），对拍容差 1e-5 有最大余量。
    /// 返回 Ok([L,R]) / Err(-3) = 退化网格（由 ensure_sh_cache → ShCache::fit →
    /// invert_matrix 透传）。调用方（build_speaker / spatial_get_hrir）须透传 -3。
    fn sh_hrir(&mut self, az_deg: f32, el_deg: f32) -> Result<[Vec<f32>; 2], i32> {
        // 先取仰角范围再借缓存（避免缓存的可变借用与 self.el 读冲突）
        let el_min = self.el[0] as f64;
        let el_max = self.el[self.el.len() - 1] as f64;
        let cache = self.ensure_sh_cache()?;
        let nb = cache.basis_count;
        let hl = cache.hrir_len;
        // 边缘行为（与 TS 侧一致）：az wrap 到 [-180, 180)；el clamp 到网格仰角范围
        let az = wrap_az(az_deg as f64);
        let el = (el_deg as f64).clamp(el_min, el_max);
        let mut y = [0.0f64; SH_BASIS_COUNT];
        sh_basis(az, el, &mut y);
        let mut out = [vec![0.0f32; hl], vec![0.0f32; hl]];
        for ear in 0..2usize {
            for t in 0..hl {
                let mut s = 0.0f64;
                for k in 0..nb {
                    s += cache.coeffs[ear][k * hl + t] * y[k];
                }
                out[ear][t] = s as f32;
            }
        }
        Ok(out)
    }

    /// 为单个 speaker 预计算：HRIR 对（按插值模式取最近邻网格查表或球谐插值）
    /// → 补零 → 分区 FFT 谱 + 增益/滤波系数
    fn build_speaker(&mut self, raw: &VirtualSpeakerRaw, distance_model: u32) -> Result<SpeakerState, i32> {
        // 距离增益（公式见 dist_gain_for——set_config 与 spatial_set_distance_model
        // 两入口共用同一公式，保证等价；注释互标：spatial_set_distance_model 就地
        // 重算 dist_gain 时用同一函数）
        let d = raw.distance;
        let dist_gain = dist_gain_for(distance_model, d);

        // 空气吸收一阶低通：fc = 4000/(1+d) Hz，系数 α = exp(-2π·fc/fs)
        //   y[n] = (1-α)·x[n] + α·y[n-1]（与 TS 公式一致，收口阶段核对）
        let fc = 4000.0 / (1.0 + d.max(0.0));
        let alpha = (-2.0 * std::f32::consts::PI * fc / self.sample_rate as f32).exp();

        // 多普勒方位单位向量（f64，与 TS 侧一致）：az/el 为 f32（VirtualSpeakerRaw 语义），
        // dir = (cos(el)·sin(az), sin(el), cos(el)·cos(az))，显式归一化（f32 方位角
        // 舍入下长度≈1——归一化保证两实现逐位一致）
        let az_rad = raw.azimuth_deg as f64 * DEG2RAD;
        let el_rad = raw.elevation_deg as f64 * DEG2RAD;
        let d0 = el_rad.cos() * az_rad.sin();
        let d1 = el_rad.sin();
        let d2 = el_rad.cos() * az_rad.cos();
        let dlen = (d0 * d0 + d1 * d1 + d2 * d2).sqrt();
        let dir = (d0 / dlen, d1 / dlen, d2 / dlen);

        // 声源大小（§4.7 扩散声源）：0..1 钳位（f32，与 TS 侧 clamp 一致）。
        // size>0 → 方向模糊（az ± size·30° 两方向 HRIR 对每耳各 50% 混合）+
        // 右耳去相关（size·6 样本小数延迟，process_block 施加）；size=0 → 直通。
        let size = raw.size.clamp(0.0, 1.0);

        // HRIR 对装载：按插值模式分两支——方向模糊对两支均生效：
        // ① spherical（球谐插值，见下方 SH 一节，算法与 TS 侧 hrtfInterp.ts 逐位对齐）：
        //    按目标方向（连续角度，不限于网格点）生成 HRIR 对；
        // ② nearest（最近邻网格查表，波 1 原逻辑）：az/el → 网格索引 → 拷贝 HRIR 段。
        // 方向模糊（size>0）：az ± size·30° 两方向各取 HRIR 对后 50/50 混合，
        //   混合公式 (h1+h2)·0.5（f64 中间量、f32 写回，与 TS 侧 mixHalf 逐位一致）。
        let hrir: [Vec<f32>; 2] = if self.interp_mode == 1 {
            if size > 0.0 {
                let az1 = raw.azimuth_deg as f64 - size as f64 * SIZE_BLUR_DEG;
                let az2 = raw.azimuth_deg as f64 + size as f64 * SIZE_BLUR_DEG;
                // sh_hrir 返回 Err(-3) 时（退化网格）由 ? 透传给 build_speaker 调用方
                // （spatial_set_config → Err(code) => return code）
                let h1 = self.sh_hrir(az1 as f32, raw.elevation_deg)?;
                let h2 = self.sh_hrir(az2 as f32, raw.elevation_deg)?;
                let m = self.hrir_len;
                let mut mix = [vec![0.0f32; m], vec![0.0f32; m]];
                for ear in 0..2usize {
                    for j in 0..m {
                        mix[ear][j] = ((h1[ear][j] as f64 + h2[ear][j] as f64) * 0.5) as f32;
                    }
                }
                mix
            } else {
                self.sh_hrir(raw.azimuth_deg, raw.elevation_deg)?
            }
        } else {
            let el_idx = self.nearest_el(raw.elevation_deg);
            if size > 0.0 {
                // 方向模糊：az ± size·30° 最近邻两方向（仰角共用 el_idx）
                let az1 = raw.azimuth_deg as f64 - size as f64 * SIZE_BLUR_DEG;
                let az2 = raw.azimuth_deg as f64 + size as f64 * SIZE_BLUR_DEG;
                let a1 = self.nearest_az(az1 as f32);
                let a2 = self.nearest_az(az2 as f32);
                let b1 = (el_idx * self.az_count + a1) * self.hrir_len;
                let b2 = (el_idx * self.az_count + a2) * self.hrir_len;
                let m = self.hrir_len;
                let mut mix = [Vec::with_capacity(m), Vec::with_capacity(m)];
                for ear in 0..2usize {
                    let plane: &[f32] = if ear == 0 { &self.left } else { &self.right };
                    for j in 0..m {
                        mix[ear].push(((plane[b1 + j] as f64 + plane[b2 + j] as f64) * 0.5) as f32);
                    }
                }
                mix
            } else {
                let az_idx = self.nearest_az(raw.azimuth_deg);
                let base = (el_idx * self.az_count + az_idx) * self.hrir_len;
                [
                    self.left[base..base + self.hrir_len].to_vec(),
                    self.right[base..base + self.hrir_len].to_vec(),
                ]
            }
        };

        // 分区数 P = ceil(M/L)；hrirLen ≤ 512 时 P=1（补零到 L）
        let l = PARTITION;
        let n = FFT_SIZE;
        let p = (self.hrir_len + l - 1) / l;
        let mut spec = [Vec::with_capacity(p * n * 2), Vec::with_capacity(p * n * 2)];
        for ear in 0..2usize {
            let plane = &hrir[ear];
            let mut work_re = vec![0.0f32; n];
            let mut work_im = vec![0.0f32; n];
            for pidx in 0..p {
                // 分区填充（超出 HRIR 长度补零）
                work_re.fill(0.0);
                work_im.fill(0.0);
                let off = pidx * l;
                let hi = (off + l).min(self.hrir_len);
                for j in off..hi {
                    work_re[j - off] = plane[j];
                }
                fft(&mut work_re, &mut work_im, false);
                for k in 0..n {
                    spec[ear].push(work_re[k]);
                    spec[ear].push(work_im[k]);
                }
            }
        }
        Ok(SpeakerState {
            // 保留原始 channel（多声道渲染按索引取输入；立体声渲染仍按「0=L 其余=R」路由，
            // channel≥1 取 R 与旧「clamp 到 0/1」行为逐位一致）
            channel: raw.channel as usize,
            gain: raw.gain,
            size,
            distance: raw.distance,
            dist_gain,
            alpha,
            absorb_state: 0.0,
            occ_state: 0.0,
            dir,
            rsmp_line: vec![0.0; RESAMP_LINE],
            rsmp_pos: 0,
            rsmp_delay: RESAMP_START_DELAY,
            decorr_line: vec![0.0; DECORR_LINE],
            decorr_pos: 0,
            // 右耳去相关延迟 = size·6 样本（f64；size=0 → 0 → 直通）
            decorr_delay: size as f64 * 6.0,
            hrir,
            hist: [vec![0.0; self.hrir_len], vec![0.0; self.hrir_len]],
            hist_pos: [0, 0],
            source_r: vec![0.0; l],
            in_re: vec![0.0; n],
            in_im: vec![0.0; n],
            partitions: p,
            spec,
            accum: [vec![0.0; (p + 1) * l], vec![0.0; (p + 1) * l]],
            source: vec![0.0; l],
            work_re: vec![0.0; n],
            work_im: vec![0.0; n],
            prod_re: vec![0.0; n],
            prod_im: vec![0.0; n],
        })
    }

    /// 按当前房间参数 + 扬声器布局重建房间状态（fresh 零状态；配置语义：
    /// 与 TS 侧"setConfig 重建 RoomSim 实例"等价）。房间关闭（无参数 /
    /// room_amount≤0 / 无扬声器）时清空并全旁路（输出与无房间逐位一致）。
    fn build_room(&mut self) {
        let params = match self.room_params {
            Some(p) => p,
            None => {
                self.room_active = false;
                self.speaker_room.clear();
                self.fdn = None;
                return;
            }
        };
        self.room_active = self.room_amount > 0.0 && !self.speakers.is_empty();
        self.speaker_room.clear();
        if self.room_active && params.early_orders > 0 {
            for s in &self.speakers {
                self.speaker_room
                    .push(self.build_speaker_room(s.distance, s.dir, &params));
            }
        }
        self.fdn = if self.room_active {
            Some(FdnState::new(self.sample_rate, params.rt60))
        } else {
            None
        };
    }

    /// 为单个 speaker 生成镜像声源早期反射抽头（build_room 时调用，非热路径）。
    /// 听者位于房间中心；声源位置 = 中心 + 距离·方位单位向量（dir 与多普勒同构）。
    /// 镜像坐标按逐轴逐阶嵌套枚举（顺序与 TS 侧 roomSim.ts 完全一致）；
    /// 抽头参数：延迟 = round(dist·fs/c)、增益 = reflectivity^阶/距离²、
    /// 低通 fc = 8000/(1+阶)。历史环长度 = 最大抽头延迟（预分配）。
    fn build_speaker_room(&self, distance: f32, dir: (f64, f64, f64), p: &RoomParams) -> SpeakerRoomState {
        let fs = self.sample_rate as f64;
        let cx = p.width * 0.5;
        let cy = p.height * 0.5;
        let cz = p.depth * 0.5;
        let d = distance as f64;
        let sx = cx + d * dir.0;
        let sy = cy + d * dir.1;
        let sz = cz + d * dir.2;
        let orders = p.early_orders;
        let mut taps: Vec<EarlyTap> = Vec::new();
        let mut max_delay = 1usize;
        for ox in 0..=orders {
            for (qx, ox2) in axis_images(sx, p.width, ox) {
                for oy in 0..=orders {
                    for (qy, oy2) in axis_images(sy, p.height, oy) {
                        for oz in 0..=orders {
                            for (qz, oz2) in axis_images(sz, p.depth, oz) {
                                let o = ox2 + oy2 + oz2;
                                if o < 1 || o > orders {
                                    continue;
                                }
                                let dx = qx - cx;
                                let dy = qy - cy;
                                let dz = qz - cz;
                                let dist = (dx * dx + dy * dy + dz * dz).sqrt();
                                // 延迟（采样）= round(dist·fs/c)（c=343 m/s；≥1 钳位，
                                // 与 TS 侧一致）
                                let delay = ((dist * fs / DOPPLER_C) + 0.5).floor();
                                let delay = (delay.max(1.0)) as usize;
                                if delay > max_delay {
                                    max_delay = delay;
                                }
                                // 增益 = 反射系数^阶 / 距离²（1/d² 衰减 × 逐次反射损耗；
                                // 显式累乘 f64，与 TS 侧逐位一致）
                                let mut rp = 1.0f64;
                                for _ in 0..o {
                                    rp *= p.reflectivity;
                                }
                                let gain = rp / (dist * dist);
                                // 高频吸收随反射次数：fc = 8000/(1+阶) Hz
                                let fc = EARLY_LP_FC_BASE / (1.0 + o as f64);
                                let lp_coef = (-2.0 * std::f64::consts::PI * fc / fs).exp();
                                taps.push(EarlyTap {
                                    delay,
                                    gain: gain as f32,
                                    lp_coef: lp_coef as f32,
                                    lp_state_l: 0.0,
                                    lp_state_r: 0.0,
                                });
                            }
                        }
                    }
                }
            }
        }
        SpeakerRoomState {
            hist_l: vec![0.0; max_delay],
            hist_r: vec![0.0; max_delay],
            hist_pos_l: 0,
            hist_pos_r: 0,
            taps,
        }
    }

    /// 多声道输入路数 = max(2, 最大 speaker.channel + 1)（与 JS 侧 WasmHrtfBackend
    /// 的指针数组容量 multiPtrCap 一致——JS 保证指针数组长度 ≥ 本值，且对
    /// 缺失输入（channel ≥ 实际输入路数）别名到 0 号输入，实现「越界取 0 号」）。
    fn input_channel_count(&self) -> usize {
        self.speakers
            .iter()
            .map(|s| s.channel + 1)
            .max()
            .unwrap_or(2)
            .max(2)
    }

    /// 处理一个完整输入块：逐 speaker 吸收→距离增益→[遮挡低通]→[去相关/多普勒]→
    /// 卷积（分区 FFT 或时域直接，按 conv_mode），累加进湿块并入队。
    /// 房间激活时（§4.5）：每 speaker 湿路输出后串早期反射（镜像声源抽头），
    /// 湿总线再进 FDN 晚期混响，按 roomAmount 混回。
    /// multi=false：读 in_block_l/r（立体声装配）；multi=true：读 in_blocks（多声道
    /// 装配，spatial_render_multi 路径）。其余逻辑两路径完全一致（同算法仅输入侧扩展）。
    fn process_block(&mut self, multi: bool) {
        let l = PARTITION;
        let n = FFT_SIZE;
        self.wet_block_l.fill(0.0);
        self.wet_block_r.fill(0.0);
        if self.room_active {
            self.early_block_l.fill(0.0);
            self.early_block_r.fill(0.0);
        }
        let n_speakers = self.speakers.len();
        // 遮挡（§4.7）：occlusion>0 时激活——每 speaker 增益 ×(1−0.8·occ)（乘在湿段
        // 提取处）+ 空气式低通（fc = 12000·(1−occ) Hz，钳位 ≥1Hz；系数在引擎级、
        // 状态每 speaker 独立）。occlusion=0 → 全旁路（与现状逐位一致）。
        let occ_active = self.occlusion > 0.0;
        let occ_gain = self.occ_gain;
        for (si, s) in self.speakers.iter_mut().enumerate() {
            // 源声道选择（立体声：channel==0 → L 否则 R，与旧「clamp 到 0/1」逐位一致；
            // 多声道：按 channel 索引取 in_blocks[ch]，channel ≥ 输入路数取 0 号）
            let src: &[f32] = if multi {
                let idx = if s.channel >= self.in_blocks.len() { 0 } else { s.channel };
                &self.in_blocks[idx]
            } else {
                if s.channel == 0 { &self.in_block_l } else { &self.in_block_r }
            };
            // 空气吸收低通（每 speaker 独立状态）→ 距离增益 × 扬声器增益 × 遮挡增益 → 遮挡低通 → 源块
            // 增益施加点（O1 审计 1.5）：speakerGain × occ_gain × dist_gain 全乘源信号卷积前，
            // 与 TS 侧 `distGain = distanceGain × speakerGain × occGain`（在 src[i]*g 处一并乘）
            // 对齐——原实现把 speakerGain × occ_gain 留到卷积后乘 accum，f32 乘法顺序差异
            // 在高扬声器数/窄带相干输入下产生 ~1e-7 偏差；全乘源信号前使两实现逐位一致。
            let src_gain = s.dist_gain * s.gain * if occ_active { occ_gain } else { 1.0 };
            for j in 0..l {
                let x = src[j];
                let y = (1.0 - s.alpha) * x + s.alpha * s.absorb_state;
                s.absorb_state = y;
                let mut v = y * src_gain;
                if occ_active {
                    // 遮挡空气式低通：fc = 12000·(1−occ) Hz，系数公式与空气吸收同族
                    // （α = exp(−2π·fc/fs)，引擎级全局系数），独立状态
                    // （与 TS 侧 y += a(x−y) 同族）
                    let o = (1.0 - self.occ_alpha) * v + self.occ_alpha * s.occ_state;
                    s.occ_state = o;
                    v = o;
                }
                s.source[j] = v;
            }
            // 多普勒重采样（§4.6，模式 C）：吸收/距离增益之后、卷积之前，
            // 每块按当前 playback_rate 处理（与 TS 侧 resampleSpeaker 逐位对齐）：
            //   doppler_factor = c / (c + dot(−v, dir)) = c / (c − v·dir)，c=343 m/s
            //   playback_rate = clamp(factor, 0.5, 2.0)
            // 速度 f32 ABI → f64（与 TS 侧 Math.fround 等价）；rate==1 直通
            // （不触碰延迟线状态，与无多普勒输出逐位相等）。
            // 每输出样本：①输入写入环形延迟线 ②delay += 1−rate ③钳位 [1, DLINE−2]
            // ④读指针 pos = 最新样本 − (delay−1)，floor/frac 线性插值（f64 计算、f32 写回）。
            // 恒定速率下延迟线饱和后速率回落 1（效果持续约 (MAX−START)/|rate−1| 样本，
            // 规划书 §4.6 简化模型）。
            if self.doppler_enabled {
                let vx = self.doppler_velocity.0 as f64;
                let vy = self.doppler_velocity.1 as f64;
                let vz = self.doppler_velocity.2 as f64;
                let m = -vx * s.dir.0 - vy * s.dir.1 - vz * s.dir.2;
                let rate = (DOPPLER_C / (DOPPLER_C + m)).clamp(DOPPLER_RATE_MIN, DOPPLER_RATE_MAX);
                if rate != 1.0 {
                    let mut wp = s.rsmp_pos;
                    let mut delay = s.rsmp_delay;
                    for j in 0..l {
                        s.rsmp_line[wp] = s.source[j];
                        wp = (wp + 1) % RESAMP_LINE;
                        delay += 1.0 - rate;
                        if delay < RESAMP_MIN_DELAY {
                            delay = RESAMP_MIN_DELAY;
                        } else if delay > RESAMP_MAX_DELAY {
                            delay = RESAMP_MAX_DELAY;
                        }
                        let newest = (wp + RESAMP_LINE - 1) % RESAMP_LINE;
                        let pos = newest as f64 - (delay - 1.0);
                        let i0f = pos.floor();
                        let frac = pos - i0f;
                        let i0 = i0f as i64;
                        let idx0 = i0.rem_euclid(RESAMP_LINE as i64) as usize;
                        let idx1 = if idx0 + 1 >= RESAMP_LINE { 0 } else { idx0 + 1 };
                        s.source[j] = (s.rsmp_line[idx0] as f64 * (1.0 - frac) + s.rsmp_line[idx1] as f64 * frac) as f32;
                    }
                    s.rsmp_pos = wp;
                    s.rsmp_delay = delay;
                }
            }
            // 双耳去相关（§4.7 声源大小 size>0）：右耳源 = 左耳源经小数延迟
            // size·6 样本（一阶线性插值延迟线，decorr_next；size=0 跳过——
            // 回归逐位）
            let dec = s.size > 0.0;
            if dec {
                for j in 0..l {
                    s.source_r[j] = s.decorr_next(s.source[j]);
                }
            }
            if self.conv_mode == 1 {
                // 时域直接卷积（契约 spatial_set_convolution_mode=time）：
                // 每 speaker 每耳环形输入历史（长度 M=hrir_len，跨块携带上一块
                // 尾部 = "卷积尾 + 当前块"），HRIR 逐样本乘加（f64 累加、f32 写回，
                // 与 TS 侧 TimeConvolver 逐位对齐）；结果写入 accum[ear][0..L)，
                // 与分区模式共用下方湿段提取/早期反射/左移。干湿对齐设计：与
                // 分区模式**同块调度同放行**（512 样本湿块缓冲延迟，wet[t]=(x*h)[t−512]），
                // 故两模式干湿对齐一致、脉冲位置一致（±0 样本），仅差 FFT 圆整。
                let m = self.hrir_len;
                for ear in 0..2usize {
                    let src_ear: &[f32] = if ear == 1 && dec { &s.source_r } else { &s.source };
                    let (hist, hp) = (&mut s.hist[ear], &mut s.hist_pos[ear]);
                    for j in 0..l {
                        hist[*hp] = src_ear[j];
                        *hp = (*hp + 1) % m;
                        let newest = (*hp + m - 1) % m;
                        let mut acc = 0.0f64;
                        for t in 0..m {
                            acc += s.hrir[ear][t] as f64 * hist[(newest + m - t) % m] as f64;
                        }
                        s.accum[ear][j] = acc as f32;
                    }
                }
            } else {
                // 输入块 FFT（分区模式，默认）：左耳源；去相关时右耳源另行 FFT
                s.work_re[..l].copy_from_slice(&s.source);
                s.work_re[l..].fill(0.0);
                s.work_im.fill(0.0);
                fft(&mut s.work_re, &mut s.work_im, false);
                if dec {
                    // 保存左耳输入谱，右耳谱 = 去相关源的 FFT
                    s.in_re.copy_from_slice(&s.work_re);
                    s.in_im.copy_from_slice(&s.work_im);
                    s.work_re[..l].copy_from_slice(&s.source_r);
                    s.work_re[l..].fill(0.0);
                    s.work_im.fill(0.0);
                    fft(&mut s.work_re, &mut s.work_im, false);
                }
                for ear in 0..2usize {
                    let (ire, iim) = if dec && ear == 0 {
                        (&s.in_re, &s.in_im)
                    } else {
                        (&s.work_re, &s.work_im)
                    };
                    // 各分区复乘 + IFFT + overlap-add（与 Convolver.processWetBlock 同构）
                    // 复乘 f64 中间量（O1 审计 1.3）：r1/i1/r2/i2 先 as f64 → 乘加在
                    // f64 域完成 → 写回 f32。与 TS 侧 dsp/Convolver.ts:406-411 逐位对齐
                    // （JS Float32Array 取值自动提升为 f64 number，乘加在 f64 完成后
                    // 写回 f32——Rust 侧需显式 as f64 提升复刻此语义，否则 f32×f32
                    // 在 Rust 中为纯 f32 运算，与 TS 侧产生 ~1e-7 量级差异）。
                    for pidx in 0..s.partitions {
                        let base = pidx * n * 2;
                        for k in 0..n {
                            let r1 = ire[k] as f64;
                            let i1 = iim[k] as f64;
                            let r2 = s.spec[ear][base + 2 * k] as f64;
                            let i2 = s.spec[ear][base + 2 * k + 1] as f64;
                            s.prod_re[k] = (r1 * r2 - i1 * i2) as f32;
                            s.prod_im[k] = (r1 * i2 + i1 * r2) as f32;
                        }
                        fft(&mut s.prod_re, &mut s.prod_im, true);
                        let b1 = pidx * l;
                        let b2 = b1 + l;
                        for j in 0..l {
                            s.accum[ear][b1 + j] += s.prod_re[j];
                            s.accum[ear][b2 + j] += s.prod_re[l + j];
                        }
                    }
                }
            }
            // 提取本块湿段（累加进 wet_block），左移累加器（两模式共用）。
            // 增益施加点（O1 审计 1.5）：原 g = gain·(1−0.8·occ) 已前移到源信号
            // （见上方 src_gain = dist_gain × s.gain × occ_gain），此处 g=1.0 维持结构。
            // 卷积后乘法 1.0·x = x 在 IEEE 754 下逐位恒等，无 f32 损耗。
            let g: f32 = 1.0;
            for ear in 0..2usize {
                let wet_blk = if ear == 0 {
                    &mut self.wet_block_l
                } else {
                    &mut self.wet_block_r
                };
                let has_early = self.room_active && si < self.speaker_room.len();
                if has_early {
                    let sr = &mut self.speaker_room[si];
                    let early_blk = if ear == 0 {
                        &mut self.early_block_l
                    } else {
                        &mut self.early_block_r
                    };
                    // 每耳独立写指针（见 SpeakerRoomState 注释：共享指针会产生空洞）
                    let (hist, hist_pos) = if ear == 0 {
                        (&mut sr.hist_l, &mut sr.hist_pos_l)
                    } else {
                        (&mut sr.hist_r, &mut sr.hist_pos_r)
                    };
                    let max_d = hist.len();
                    let mut wp = *hist_pos;
                    for j in 0..l {
                        let w = g * s.accum[ear][j];
                        // 湿总线累加（O1 审计 1.2）：TS 侧 Float32Array[i] += x 在 JS 中
                        // 为 f64 中间量→f32 写回；原 Rust `wet_blk[j] += w` 为纯 f32 +=，
                        // 与 TS 产生 ~1e-7 差异。改为 (wet_blk[j] as f64 + w as f64) as f32
                        // 与 TS 逐位对齐。
                        wet_blk[j] = (wet_blk[j] as f64 + w as f64) as f32;
                        hist[wp] = w;
                        for t in sr.taps.iter_mut() {
                            // 延迟读（历史环：写当前样本后回读 delay 前的样本）
                            let read = hist[(wp + max_d - t.delay) % max_d] as f64;
                            // 一阶低通（高频吸收随反射次数）：y = (1-a)·x + a·y[n-1]
                            let a = t.lp_coef as f64;
                            let lp = (1.0 - a) * read
                                + a * if ear == 0 { t.lp_state_l as f64 } else { t.lp_state_r as f64 };
                            if ear == 0 {
                                t.lp_state_l = lp as f32;
                            } else {
                                t.lp_state_r = lp as f32;
                            }
                            // 累加进早期总线（f64 中间量 + f32 存储，与 TS 侧一致）
                            early_blk[j] = (early_blk[j] as f64 + t.gain as f64 * lp) as f32;
                        }
                        wp += 1;
                        if wp == max_d {
                            wp = 0;
                        }
                    }
                    *hist_pos = wp;
                } else {
                    for j in 0..l {
                        // 湿总线累加（O1 审计 1.2，同上分支）：f64 中间量 + f32 写回与 TS 对齐
                        wet_blk[j] = (wet_blk[j] as f64 + (g * s.accum[ear][j]) as f64) as f32;
                    }
                }
                s.accum[ear].copy_within(l..(s.partitions + 1) * l, 0);
                s.accum[ear][s.partitions * l..(s.partitions + 1) * l].fill(0.0);
            }
        }
        // 房间晚期混响（§4.5）：FDN 输入 = 湿总线/N（N = 扬声器数，归一化各 speaker
        // 湿路和），输出混回湿总线 wet += roomAmount·(early + fdnOut)，随后干湿混合。
        if self.room_active {
            let room_amount = self.room_amount as f64;
            let ns = n_speakers as f64;
            let fdn = self.fdn.as_mut().unwrap();
            for j in 0..l {
                let x = self.wet_block_l[j];
                let fdn_out = fdn.process_sample(0, x as f64 / ns);
                self.wet_block_l[j] =
                    (x as f64 + room_amount * (self.early_block_l[j] as f64 + fdn_out)) as f32;
            }
            for j in 0..l {
                let x = self.wet_block_r[j];
                let fdn_out = fdn.process_sample(1, x as f64 / ns);
                self.wet_block_r[j] =
                    (x as f64 + room_amount * (self.early_block_r[j] as f64 + fdn_out)) as f32;
            }
        }
        // 湿块入队（环形，容量 2L）
        let cap = self.wet_l.len();
        let mask = cap - 1;
        let wi = (self.wet_pos + self.wet_len) & mask;
        for j in 0..l {
            self.wet_l[(wi + j) & mask] = self.wet_block_l[j];
            self.wet_r[(wi + j) & mask] = self.wet_block_r[j];
        }
        self.wet_len += l;
    }

    /// 渲染一个 block（任意帧长，逐样本流式）：
    ///   - 干路径：环形延迟线读 x[t-512]；
    ///   - 湿路径：块满时分区卷积，输出 y[t-512]（y = 输入与 HRIR 的线性卷积）；
    ///   - 混合：out[t] = ((1-amount)·dry + amount·wet) · master_gain。
    /// 系统总延迟 = L = 512（输出位置 t 只依赖输入 ≤ t-512）。
    fn render(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let l = PARTITION;
        let dry_gain = 1.0 - self.amount;
        let amount = self.amount;
        let master = self.master_gain;
        for i in 0..in_l.len() {
            let xl = in_l[i];
            let xr = in_r[i];
            // 干路径延迟线：读 x[t-L]，写 x[t]
            let dry_l = self.dry_line_l[self.dry_pos];
            let dry_r = self.dry_line_r[self.dry_pos];
            self.dry_line_l[self.dry_pos] = xl;
            self.dry_line_r[self.dry_pos] = xr;
            self.dry_pos += 1;
            if self.dry_pos == l {
                self.dry_pos = 0;
            }
            // 输入块装配；块满 → 分区卷积产出湿块入队
            self.in_block_l[self.input_pos] = xl;
            self.in_block_r[self.input_pos] = xr;
            self.input_pos += 1;
            if self.input_pos == l {
                self.process_block(false);
                self.input_pos = 0;
            }
            // 放行输出（每输入样本输出 1 样本；湿队空时输出 0——对应 y[t-L]<0 的零段）。
            // 湿路延迟对齐：y[k] 在输出位置 k+512 放行（与 TS Convolver 的
            // wetIdx = totalOut - L 规则一致），故 fed > PARTITION 后才消费湿队。
            // 注意：左右耳队列并行、共享 wet_len，消费前先统一判定（避免左耳消费后右耳误判为空）。
            self.fed += 1;
            let has_wet = self.wet_len > 0 && self.fed > PARTITION;
            let wet_l = if has_wet {
                self.wet_l[self.wet_pos]
            } else {
                0.0
            };
            let wet_r = if has_wet {
                self.wet_r[self.wet_pos]
            } else {
                0.0
            };
            if has_wet {
                self.wet_pos += 1;
                if self.wet_pos == self.wet_l.len() {
                    self.wet_pos = 0;
                }
                self.wet_len -= 1;
            }
            out_l[i] = (dry_gain * dry_l + amount * wet_l) * master;
            out_r[i] = (dry_gain * dry_r + amount * wet_r) * master;
        }
    }

    /// 渲染一个 block（多声道输入，spatial_render_multi 契约）：与 render 同构，
    /// 仅输入侧扩展——0/1 号输入作干路/装配 L/R（立体声下混），其余声道逐声道
    /// 装配进 in_blocks（块满时 process_block(true) 按 channel 索引取源）；
    /// 湿路/房间/混合与 render 完全一致。
    fn render_multi(&mut self, inputs: &[*const f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let l = PARTITION;
        let count = self.in_blocks.len(); // 输入路数（set_config 按最大 channel 预分配）
        let in_l = unsafe { std::slice::from_raw_parts(inputs[0], out_l.len()) };
        let in_r = unsafe { std::slice::from_raw_parts(inputs[1], out_l.len()) };
        let dry_gain = 1.0 - self.amount;
        let amount = self.amount;
        let master = self.master_gain;
        for i in 0..in_l.len() {
            let xl = in_l[i];
            let xr = in_r[i];
            // 干路径延迟线：读 x[t-L]，写 x[t]（与 render 一致）
            let dry_l = self.dry_line_l[self.dry_pos];
            let dry_r = self.dry_line_r[self.dry_pos];
            self.dry_line_l[self.dry_pos] = xl;
            self.dry_line_r[self.dry_pos] = xr;
            self.dry_pos += 1;
            if self.dry_pos == l {
                self.dry_pos = 0;
            }
            // 逐声道输入块装配（raw 指针逐样本读，零分配）；块满 → process_block(true)
            for ch in 0..count {
                self.in_blocks[ch][self.input_pos] = unsafe { *inputs[ch].add(i) };
            }
            self.input_pos += 1;
            if self.input_pos == l {
                self.process_block(true);
                self.input_pos = 0;
            }
            // 放行输出（与 render 相同：干路延迟对齐 + 湿队消费）
            self.fed += 1;
            let has_wet = self.wet_len > 0 && self.fed > PARTITION;
            let wet_l = if has_wet { self.wet_l[self.wet_pos] } else { 0.0 };
            let wet_r = if has_wet { self.wet_r[self.wet_pos] } else { 0.0 };
            if has_wet {
                self.wet_pos += 1;
                if self.wet_pos == self.wet_l.len() {
                    self.wet_pos = 0;
                }
                self.wet_len -= 1;
            }
            out_l[i] = (dry_gain * dry_l + amount * wet_l) * master;
            out_r[i] = (dry_gain * dry_r + amount * wet_r) * master;
        }
    }

    /// 清零流式状态（网格与预计算谱保留）
    fn reset_stream(&mut self) {
        self.input_pos = 0;
        self.dry_pos = 0;
        self.wet_pos = 0;
        self.wet_len = 0;
        self.fed = 0;
        self.dry_line_l.fill(0.0);
        self.dry_line_r.fill(0.0);
        self.wet_l.fill(0.0);
        self.wet_r.fill(0.0);
        self.wet_block_l.fill(0.0);
        self.wet_block_r.fill(0.0);
        // 多声道输入装配缓冲清零（与 in_block_l/r 同语义）
        for b in self.in_blocks.iter_mut() {
            b.fill(0.0);
        }
        // 房间状态清零（§4.5）：历史环/低通状态/FDN 延迟线与指针（参数保留）
        for sr in self.speaker_room.iter_mut() {
            sr.hist_l.fill(0.0);
            sr.hist_r.fill(0.0);
            sr.hist_pos_l = 0;
            sr.hist_pos_r = 0;
            for t in sr.taps.iter_mut() {
                t.lp_state_l = 0.0;
                t.lp_state_r = 0.0;
            }
        }
        if let Some(fdn) = self.fdn.as_mut() {
            for i in 0..8 {
                fdn.lines_l[i].fill(0.0);
                fdn.lines_r[i].fill(0.0);
            }
            fdn.pos_l = [0; 8];
            fdn.pos_r = [0; 8];
            fdn.lp_state_l = [0.0; 8];
            fdn.lp_state_r = [0.0; 8];
        }
        self.early_block_l.fill(0.0);
        self.early_block_r.fill(0.0);
        for s in self.speakers.iter_mut() {
            s.absorb_state = 0.0;
            s.occ_state = 0.0;
            s.accum[0].fill(0.0);
            s.accum[1].fill(0.0);
            // 多普勒重采样状态清零（延迟线/写指针/小数延迟回初始；与 TS reset 一致）
            s.rsmp_line.fill(0.0);
            s.rsmp_pos = 0;
            s.rsmp_delay = RESAMP_START_DELAY;
            // 双耳去相关状态清零（延迟线/写指针；与 TS reset 一致）
            s.decorr_line.fill(0.0);
            s.decorr_pos = 0;
            // 时域卷积状态清零（环形历史/写指针；与 TS TimeConvolver reset 一致）
            s.hist[0].fill(0.0);
            s.hist[1].fill(0.0);
            s.hist_pos = [0, 0];
        }
    }
}

// ---------------------------------------------------------------------------
// 球谐（Spherical Harmonics）HRTF 插值
// 与 TS 侧 src/spatial/hrtfInterp.ts 逐位对齐：同阶 L=3（16 基）、同基函数公式、
// 同伪逆求法（正规方程 + 高斯-若尔当）、同运算顺序。拟合残差实测见 TS 侧文件头。
// ---------------------------------------------------------------------------

/// 球谐阶数 L=3（规划书 §4.1 默认；与 TS 侧 SH_ORDER 一致）
const SH_ORDER: usize = 3;
/// 基函数数 = (L+1)² = 16
const SH_BASIS_COUNT: usize = (SH_ORDER + 1) * (SH_ORDER + 1);

/// π（f64，与 TS 侧 Math.PI 一致）
const PI: f64 = std::f64::consts::PI;
/// √2（f64，与 TS 侧 Math.SQRT2 一致）
const SQRT2: f64 = std::f64::consts::SQRT_2;

/// 基函数常量（惰性初始化一次；表达式与 TS 侧 hrtfInterp.ts 常量逐位一致）
struct ShBasisConsts {
    k0: f64,
    k1: f64,
    k2: f64,
    k3: f64,
    c21: f64,
    c22: f64,
    c31: f64,
    c32: f64,
    c33: f64,
}

fn sh_consts() -> &'static ShBasisConsts {
    static C: std::sync::OnceLock<ShBasisConsts> = std::sync::OnceLock::new();
    C.get_or_init(|| ShBasisConsts {
        k0: 0.5 / PI.sqrt(), // Y00 归一化 √(1/4π)
        k1: (3.0 / (4.0 * PI)).sqrt(), // Y1m 归一化（含 √2 因子合并，见 sh_basis）
        k2: (5.0 / (16.0 * PI)).sqrt(), // Y2,0 归一化
        k3: (7.0 / (16.0 * PI)).sqrt(), // Y3,0 归一化
        c21: 3.0 * SQRT2 * (15.0 / (8.0 * PI)).sqrt(), // Y2,±1 中 3·√2·K21
        c22: 3.0 * SQRT2 * (15.0 / (32.0 * PI)).sqrt(), // Y2,±2 中 3·√2·K22
        c31: 1.5 * SQRT2 * (21.0 / (32.0 * PI)).sqrt(), // Y3,±1 中 (3/2)·√2·K31
        c32: 15.0 * SQRT2 * (105.0 / (32.0 * PI)).sqrt(), // Y3,±2 中 15·√2·K32
        c33: 15.0 * SQRT2 * (35.0 / (64.0 * PI)).sqrt(), // Y3,±3 中 15·√2·K33
    })
}

/// 方位角归一化到 [-180, 180)（与 TS 侧边缘行为一致；基函数对 az 周期 360°）
fn wrap_az(az: f64) -> f64 {
    (((az + 180.0) % 360.0) + 360.0) % 360.0 - 180.0
}

/// 计算 (az_deg, el_deg) 处 16 个实球谐基函数值（写入 out[0..16]）。
/// 约定与公式：u = cos(el)、v = sin(el)、ca/sa = cos/sin(az)，标准实球谐
/// （Condon-Shortley 相因子在内），逐项表达式与 TS 侧 hrtfInterp.ts 的
/// shBasis 同结构（同运算顺序，注释见 TS 侧）。
fn sh_basis(az_deg: f64, el_deg: f64, out: &mut [f64; SH_BASIS_COUNT]) {
    let c = sh_consts();
    let phi = az_deg * PI / 180.0;
    let th = el_deg * PI / 180.0;
    let u = th.cos();
    let v = th.sin();
    let ca = phi.cos();
    let sa = phi.sin();
    let c2 = ca * ca - sa * sa; // cos(2φ)
    let s2 = 2.0 * sa * ca; // sin(2φ)
    let c3 = c2 * ca - s2 * sa; // cos(3φ)
    let s3 = s2 * ca + c2 * sa; // sin(3φ)
    let u2 = u * u;
    let u3 = u2 * u;
    let v2 = v * v;
    let v3 = v2 * v;

    out[0] = c.k0;
    out[1] = -c.k1 * sa * u;
    out[2] = c.k1 * v;
    out[3] = -c.k1 * ca * u;
    out[4] = c.c22 * s2 * u2;
    out[5] = -c.c21 * sa * v * u;
    out[6] = c.k2 * (3.0 * v2 - 1.0) * 0.5;
    out[7] = -c.c21 * ca * v * u;
    out[8] = c.c22 * c2 * u2;
    out[9] = -c.c33 * s3 * u3;
    out[10] = c.c32 * s2 * v * u2;
    out[11] = -c.c31 * sa * (5.0 * v2 - 1.0) * u;
    out[12] = c.k3 * (5.0 * v3 - 3.0 * v) * 0.5;
    out[13] = -c.c31 * ca * (5.0 * v2 - 1.0) * u;
    out[14] = c.c32 * c2 * v * u2;
    out[15] = -c.c33 * c3 * u3;
}

/// 原地高斯-若尔当求逆（部分主元，n 阶方阵，行主序 f64）。
/// 步骤与 TS 侧 hrtfInterp.ts 的 invertGaussJordan 逐位一致：
/// 扩增 [M|I] → 逐列选主元换行 → 归一化主元行 → 消去其余行 → 提取右半。
///
/// 返回 0=成功 / -3=退化网格（AᵀA 秩亏：部分主元后主元 |d|<1e-12）。
/// 奇异矩阵防御（O1 审计 P1）：退化场景（网格方向数 N < 基函数数 16，如
/// 1×1 网格 N=1）时 AᵀA 必然秩亏（rank ≤ N < 16）→ 返回 -3 而非静默产出
/// NaN（原实现 d=0 时 0/0=NaN 污染全矩阵 → 后续 SH 系数全 NaN → 卷积输出
/// 全 NaN 静音）。阈值 1e-12 与 TS 侧一致（f64 数值量级）。
fn invert_matrix(n: usize, m: &mut [f64]) -> i32 {
    let w = 2 * n;
    let mut aug = vec![0.0f64; n * w];
    for r in 0..n {
        for c in 0..n {
            aug[r * w + c] = m[r * n + c];
        }
        aug[r * w + n + r] = 1.0;
    }
    for col in 0..n {
        // 部分主元：列 col 及以下绝对值最大行
        let mut piv = col;
        let mut best = aug[col * w + col].abs();
        for r in (col + 1)..n {
            let a = aug[r * w + col].abs();
            if a > best {
                best = a;
                piv = r;
            }
        }
        if piv != col {
            for c in 0..w {
                aug.swap(col * w + c, piv * w + c);
            }
        }
        // 归一化主元行——除零前防御（O1 审计 P1）：部分主元后主元仍近 0
        // ⇒ 矩阵奇异（AᵀA 秩亏），返回 -3 而非 0/0=NaN 污染全矩阵。
        let d = aug[col * w + col];
        if d.abs() < 1e-12 {
            return -3;
        }
        for c in 0..w {
            aug[col * w + c] /= d;
        }
        // 消去其余行
        for r in 0..n {
            if r == col {
                continue;
            }
            let f = aug[r * w + col];
            if f == 0.0 {
                continue;
            }
            for c in 0..w {
                aug[r * w + c] -= f * aug[col * w + c];
            }
        }
    }
    for r in 0..n {
        for c in 0..n {
            m[r * n + c] = aug[r * w + n + c];
        }
    }
    0
}

/// 球谐拟合缓存内容（一次拟合，多次求值；load_hrtf 换数据集后随 Engine 重建）
struct ShCache {
    /// 基函数数（=16）
    basis_count: usize,
    /// HRIR 长度（样本）
    hrir_len: usize,
    /// 每耳每样本 SH 系数 c_k[t]（2 × basis_count×hrir_len，行主序 [ear][k·hl+t]）
    coeffs: [Vec<f64>; 2],
}

impl ShCache {
    /// 拟合一次网格：伪逆 + 每耳每样本 SH 系数（纯函数，确定性）。
    /// 算法与 TS 侧 fitShCoefficients 逐位一致（同基函数求值、同正规方程、
    /// 同伪逆求法、同累加顺序）：c_k[t] = Σ_d P[k][d]·f(d,t)。
    ///
    /// 返回 Ok(ShCache) = 拟合成功 / Err(-3) = 退化网格（AᵀA 秩亏，invert_matrix
    /// 返回 -3）。调用方（ensure_sh_cache → sh_hrir → build_speaker/spatial_get_hrir）
    /// 须将 -3 透传给 spatial_set_config / spatial_get_hrir，JS 侧 WasmHrtfBackend
    /// 检查返回码抛中文 Error。
    fn fit(az: &[f32], el: &[f32], left: &[f32], right: &[f32], hrir_len: usize) -> Result<ShCache, i32> {
        let nb = SH_BASIS_COUNT;
        let nd = az.len() * el.len();

        // A：nd×nb（行主序 f64），每行 = 网格某方向上的 16 个基函数值
        let mut a = vec![0.0f64; nd * nb];
        let mut d = 0usize;
        for e in 0..el.len() {
            for i in 0..az.len() {
                let mut b = [0.0f64; SH_BASIS_COUNT];
                sh_basis(az[i] as f64, el[e] as f64, &mut b);
                for k in 0..nb {
                    a[d * nb + k] = b[k];
                }
                d += 1;
            }
        }

        // G = AᵀA（nb×nb）
        let mut g = vec![0.0f64; nb * nb];
        for k in 0..nb {
            for m in 0..nb {
                let mut s = 0.0f64;
                for d2 in 0..nd {
                    s += a[d2 * nb + k] * a[d2 * nb + m];
                }
                g[k * nb + m] = s;
            }
        }
        // invert_matrix 返回 -3 时 AᵀA 秩亏（退化网格）→ 透传给调用方
        let inv_ret = invert_matrix(nb, &mut g);
        if inv_ret != 0 {
            return Err(inv_ret);
        }

        // P = G⁻¹·Aᵀ（nb×nd）
        let mut pinv = vec![0.0f64; nb * nd];
        for k in 0..nb {
            for d2 in 0..nd {
                let mut s = 0.0f64;
                for m in 0..nb {
                    s += g[k * nb + m] * a[d2 * nb + m];
                }
                pinv[k * nd + d2] = s;
            }
        }

        // 每耳每样本系数 c_k[t] = Σ_d P[k][d]·f(d,t)（f = 网格 HRIR 平面数组）。
        // 伪逆 P 只作为拟合中间量（与 TS 侧缓存结构不同——TS 缓存保留 P 供文档化，
        // 本侧系数即求值所需全部状态）；先算完两耳再组装结构体
        // （避免字段求值顺序导致 pinv 先于闭包最后使用被移动）
        let fit_ear = |plane: &[f32]| -> Vec<f64> {
            let mut coeffs = vec![0.0f64; nb * hrir_len];
            for k in 0..nb {
                for t in 0..hrir_len {
                    let mut s = 0.0f64;
                    for d2 in 0..nd {
                        s += pinv[k * nd + d2] * plane[d2 * hrir_len + t] as f64;
                    }
                    coeffs[k * hrir_len + t] = s;
                }
            }
            coeffs
        };
        let coeffs = [fit_ear(left), fit_ear(right)];
        Ok(ShCache {
            basis_count: nb,
            hrir_len,
            coeffs,
        })
    }
}

// ---------------------------------------------------------------------------
// FFT（自研基-2，镜像 dsp/fft.ts：f64 twiddle + f64 累加 + f32 写回，逐位对齐）
// ---------------------------------------------------------------------------

/// 构建 N 点 FFT 全 stage twiddle 表（θ_k = 2πk/len，仅存正向 cos/sin，逆变换取共轭）
fn build_twiddles(n: usize) -> Vec<Vec<f64>> {
    let mut stages = Vec::new();
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let mut t = Vec::with_capacity(half * 2);
        let step = 2.0 * std::f64::consts::PI / len as f64;
        for k in 0..half {
            t.push((step * k as f64).cos());
            t.push((step * k as f64).sin());
        }
        stages.push(t);
        len <<= 1;
    }
    stages
}

/// 原位基-2 复 FFT（Cooley–Tukey DIT，自研；算法与 dsp/fft.ts 完全一致）：
/// 位反转排列 → 逐 stage 蝶形（f64 累加、f32 写回）→ 逆变换 ×1/N。
fn fft(real: &mut [f32], imag: &mut [f32], inverse: bool) {
    let n = real.len();
    debug_assert!(n == imag.len() && n.is_power_of_two());

    // 位反转排列
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            real.swap(i, j);
            imag.swap(i, j);
        }
    }

    // twiddle 表（惰性构建一次；渲染热路径为无锁原子读）
    // 单键断言（O1 审计 1.7）：当前 N 恒 FFT_SIZE=1024，OnceLock<Vec<Vec<f64>>>
    // 单键足够——若未来支持变长 FFT（如多 N 输入），改 HashMap<usize, Vec<Vec<f64>>>
    // 按 N 多键缓存。当前断言防 N!=1024 误用（twiddle 表错误会污染整段卷积输出，
    // 症状隐蔽难定位）。debug_assert 在 release 不生效，故用 assert! 强校验。
    assert!(n == FFT_SIZE, "fft: 仅支持 N=FFT_SIZE=1024，实际 n={}", n);
    let stages = TWIDDLES.get_or_init(|| build_twiddles(n));

    let sign = if inverse { 1.0 } else { -1.0 }; // 逆变换 twiddle 取共轭（+j sin θ）
    let mut stage = 0usize;
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let t = &stages[stage];
        let mut i = 0usize;
        while i < n {
            for k in 0..half {
                let wr = t[2 * k];
                let wi = sign * t[2 * k + 1];
                let ur = real[i + k] as f64;
                let ui = imag[i + k] as f64;
                let vr = real[i + k + half] as f64;
                let vi = imag[i + k + half] as f64;
                // 蝶形：u + w·v 与 u − w·v（f64 累加，写回 f32）
                let vrw = wr * vr - wi * vi;
                let viw = wr * vi + wi * vr;
                real[i + k] = (ur + vrw) as f32;
                imag[i + k] = (ui + viw) as f32;
                real[i + k + half] = (ur - vrw) as f32;
                imag[i + k + half] = (ui - viw) as f32;
            }
            i += len;
        }
        len <<= 1;
        stage += 1;
    }

    if inverse {
        let inv = 1.0 / n as f64;
        for i in 0..n {
            real[i] = (real[i] as f64 * inv) as f32;
            imag[i] = (imag[i] as f64 * inv) as f32;
        }
    }
}

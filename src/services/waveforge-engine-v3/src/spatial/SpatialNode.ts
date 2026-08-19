/**
 * SpatialNode —— 空间音频 AudioWorklet 节点主线程包装（waveforge-spatial）
 *
 * 用法同 SoundTouchNode（attachV3Engine syncPitchChain 先例）：
 *   register 每上下文缓存一次（addModule 失败 catch 返回 false）；
 *   构造抛错表示处理器不可用（调用方应静默降级直连）。
 * 主线程 → 处理器消息：{type:'spatial', config}（全量替换语义）、
 * {type:'spatial-grid', grid}（HRTF 网格热更新，null = 恢复内置）；
 * 处理器 → 主线程：{type:'spatial-stats', latencySamples, backend, inputChannels,
 * avgProcessMs}（经 onStats 转发）。
 */

import type { HrtfGrid, SpatialRenderConfig } from './types'

/** 空间处理器统计回传 */
export interface SpatialStats {
  latencySamples: number
  backend: string
  /** 输入声道数（处理器 process 开头检测；多声道输入自动映射用，未回传过缺省） */
  inputChannels?: number
  /** 窗口内每块 process 耗时均值 ms（处理器按 30 回调窗口求均值；CPU% 换算见 fusion.estimateCpuPercent） */
  avgProcessMs?: number
}

/**
 * 解析 worklet 模块绝对 URL（file:// 打包版路径加固）。
 *
 * 背景：AudioWorklet.addModule(moduleUrl) 按「文档基础 URL」解析相对路径
 * （等价 window.location / document.baseURI）。dev（http://localhost:3000）下
 * './spatial-worklet.js' 正常；但打包版用 Electron loadFile(file://) 加载
 * dist/index.html，部分 Chromium/Electron 版本对 file:// 下 AudioWorklet 相对
 * 模块解析有差异（相对路径可能解析失败 → register 拒绝 → 处理器不注册）。
 *
 * 修复：用 new URL(name, base) 显式生成绝对 URL，消除相对解析歧义。
 * base 优先 document.baseURI（含 <base> 标签语义，与资源加载一致），回退
 * location.href；两者均无（Node/无 window，不应到达 register）→ 原样返回 name，
 * 交由 addModule 自行解析（register 在运行时调用，主线程恒有 document）。
 *
 * v3 worklet（EngineV3Host.workletUrl='./v3-worklet.js'）同款相对路径——本函数
 * 仅对空间链应用绝对解析加固（v3 链路未报问题，保持现状不改动）。
 */
function resolveWorkletUrl(name: string): string {
  let base: string | undefined
  try {
    base = typeof document !== 'undefined' ? document.baseURI : undefined
  } catch {
    /* noop：document 访问异常（沙箱隔离）→ 回退 location */
  }
  if (!base) {
    try {
      base = typeof location !== 'undefined' ? location.href : undefined
    } catch {
      /* noop */
    }
  }
  if (!base) return name // 无 window：原样相对路径（addModule 自行解析）
  try {
    return new URL(name, base).href
  } catch {
    return name // base 非法 URL：回退相对路径
  }
}

export class SpatialNode {
  /** 每上下文一次注册缓存（失败也缓存，避免反复 addModule） */
  private static readonly registerCache = new WeakMap<AudioContext, Promise<boolean>>()

  /** 底层 AudioWorkletNode（暴露供 connect/disconnect） */
  readonly node: AudioWorkletNode

  /** 处理器统计回传回调（融合层挂接，转发 spatial-stats） */
  onStats: ((stats: SpatialStats) => void) | null = null

  /** 注册处理器（每 AudioContext 一次，失败返回 false 不抛出） */
  static register(ctx: AudioContext): Promise<boolean> {
    let p = SpatialNode.registerCache.get(ctx)
    if (!p) {
      // file:// 打包版路径加固：显式绝对 URL 消除相对解析歧义（见 resolveWorkletUrl）。
      // addModule 失败（404/解析错误/模块语法错误）→ catch 返回 false（调用方静默降级直连）。
      p = ctx.audioWorklet
        .addModule(resolveWorkletUrl('spatial-worklet.js'))
        .then(() => true)
        .catch(() => false)
      SpatialNode.registerCache.set(ctx, p)
    }
    return p
  }

  /**
   * 构造节点。
   * @param outputChannels 输出声道数（默认 2 = 双耳；output==='multichannel' 时
   *   融合层重建为 6（5.1）或 8（7.1.4）——处理器输出 >2 声道走物理声道映射）。
   *   真实设备声道能力检测 / setSinkId 设备选择后续 wave。
   */
  constructor(ctx: AudioContext, outputChannels = 2) {
    this.node = new AudioWorkletNode(ctx, 'waveforge-spatial', { outputChannelCount: [outputChannels] })
    this.node.port.onmessage = (event: MessageEvent) => {
      const d = event.data as { type?: string; latencySamples?: number; backend?: string; inputChannels?: number; avgProcessMs?: number } | null
      if (d && d.type === 'spatial-stats' && this.onStats) {
        this.onStats({
          latencySamples: d.latencySamples ?? 0,
          backend: d.backend ?? 'ts',
          inputChannels: d.inputChannels,
          avgProcessMs: d.avgProcessMs,
        })
      }
    }
  }

  /** 下发渲染配置（全量替换语义，处理器内 setConfig + 房间状态更新） */
  postConfig(config: SpatialRenderConfig): void {
    this.node.port.postMessage({ type: 'spatial', config })
  }

  /** 下发 HRTF 网格热更新（null = 恢复内置网格；处理器 loadHrtf 后自动重发最后 config） */
  postGrid(grid: HrtfGrid | null): void {
    this.node.port.postMessage({ type: 'spatial-grid', grid })
  }
}

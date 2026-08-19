/**
 * room —— 轻量 Freeverb 兜底（历史实现，当前后端已内置完整房间模拟；保留以备回退/测试）
 *
 * 说明：房间模拟（规划书 §4.5 完整版：镜像声源法早期反射 + FDN 晚期混响）已由
 * 后端实现（Wasm 内核 lib.rs / TsConvolverBackend 的 roomSim.ts），本文件不再被
 * SpatialProcessor / 离线导出引用，仅保留作回退/对比测试用途。
 *
 * 基于 dsp/ReverbSimple.ts（Freeverb 类 8 梳状 + 4 全通）。每个房间预设映射为
 * ReverbSimpleParams（type 提供基准特性 + roomSize/damping 微调，本模块固定取值）。
 *
 * 混音语义：房间为"叠加在双耳湿信号上"的附加层（types.ts InstantSpatialSettings.roomAmount）：
 *   out = in + amount·(混响湿路)；ReverbSimple dry=0 使其输出纯湿路。
 *
 * 预设 → ReverbSimpleParams 映射表（参数值注释）：
 *   off        旁路（process 直接返回）
 *   studio     录音棚：type=room（小房间短尾），roomSize 0.35 / damping 0.55 / wet 0.5 /
 *              preDelayMs 4 / width 0.6（中小空间，偏干）
 *   hall       音乐厅：type=hall（大空间长尾），roomSize 0.75 / damping 0.4 / wet 0.55 /
 *              preDelayMs 18 / width 0.8（长尾宽阔）
 *   stage      舞台：type=stage（delayScale 1.2 延迟拉长），roomSize 0.55 / damping 0.5 /
 *              wet 0.5 / preDelayMs 22 / width 0.9（纵深宽声场）
 *   church     教堂：type=hall，roomSize 0.95 / damping 0.3 / wet 0.6 /
 *              preDelayMs 35 / width 0.85（超长尾、反馈强、明亮）
 *   outdoor    户外：type=hall，roomSize 0.98 / damping 0.15 / wet 0.3 /
 *              preDelayMs 28 / width 0.5（稀疏漫反射，低密度）
 *   bathroom   浴室：type=plate（金属板明亮密实），roomSize 0.85 / damping 0.08 /
 *              wet 0.5 / preDelayMs 6 / width 0.25（极亮、近单声道化瓷砖反射）
 *   corridor   走廊：type=hall，roomSize 0.8 / damping 0.45 / wet 0.55 /
 *              preDelayMs 10 / width 0.15（窄长通道，强单声道化回声）
 *
 * 确定性：同输入同预设必同输出；process 就地处理、稳态零分配（scratch 按需扩容）。
 */

import { ReverbSimple } from '../dsp/ReverbSimple'
import type { ReverbSimpleParams } from '../dsp/ReverbSimple'
import type { RoomPreset } from './types'

/** 房间处理器接口（worklet 处理器与离线导出共用） */
export interface RoomProcessor {
  setPreset(preset: RoomPreset): void
  /** 就地叠加混响：out = in + amount·(混响湿路)；amount<=0 或 off 时直通 */
  process(l: Float32Array, r: Float32Array, amount: number): void
}

/** 预设 → ReverbSimple 参数（dry 恒 0：本模块只取湿路，混音在 process 中按 amount 叠加） */
const PRESET_TABLE: Record<Exclude<RoomPreset, 'off'>, ReverbSimpleParams> = {
  studio: { roomSize: 0.35, damping: 0.55, wet: 0.5, dry: 0, preDelayMs: 4, width: 0.6, type: 'room' },
  hall: { roomSize: 0.75, damping: 0.4, wet: 0.55, dry: 0, preDelayMs: 18, width: 0.8, type: 'hall' },
  stage: { roomSize: 0.55, damping: 0.5, wet: 0.5, dry: 0, preDelayMs: 22, width: 0.9, type: 'stage' },
  church: { roomSize: 0.95, damping: 0.3, wet: 0.6, dry: 0, preDelayMs: 35, width: 0.85, type: 'hall' },
  outdoor: { roomSize: 0.98, damping: 0.15, wet: 0.3, dry: 0, preDelayMs: 28, width: 0.5, type: 'hall' },
  bathroom: { roomSize: 0.85, damping: 0.08, wet: 0.5, dry: 0, preDelayMs: 6, width: 0.25, type: 'plate' },
  corridor: { roomSize: 0.8, damping: 0.45, wet: 0.55, dry: 0, preDelayMs: 10, width: 0.15, type: 'hall' },
}

export function createRoomProcessor(sampleRate: number): RoomProcessor {
  const reverb = new ReverbSimple(sampleRate)
  let enabled = false
  let wetL: Float32Array = new Float32Array(0)
  let wetR: Float32Array = new Float32Array(0)

  return {
    setPreset(preset: RoomPreset): void {
      if (preset === 'off') {
        enabled = false // 旁路
        return
      }
      enabled = true
      reverb.setParams(PRESET_TABLE[preset])
    },
    process(l: Float32Array, r: Float32Array, amount: number): void {
      if (!enabled || amount <= 0) return
      const B = Math.min(l.length, r.length)
      if (B <= 0) return
      if (wetL.length < B) {
        wetL = new Float32Array(B)
        wetR = new Float32Array(B)
      }
      wetL.set(l.subarray(0, B))
      wetR.set(r.subarray(0, B))
      // ReverbSimple 就地处理：dry=0 → 输出纯湿路
      reverb.processStereo(wetL, wetR)
      for (let i = 0; i < B; i++) {
        l[i] += amount * wetL[i]
        r[i] += amount * wetR[i]
      }
    },
  }
}

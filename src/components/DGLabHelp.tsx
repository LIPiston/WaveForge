/**
 * DG-LAB 设置项「详情」帮助文案：让用户了解每个功能负责什么、怎么调、默认值，
 * 而不是自己逐个试。
 */
import { useState } from 'react'
import { Info } from 'lucide-react'

export const HELP: Record<string, string> = {
  feelStyle:
    '体感风格：决定身体感受到的「音乐质感」。立体声=左右声道跟随歌曲声像（贴大腿左右区分最明显）；心跳=每拍一次咚-哒；呼吸=缓慢起伏交替；潮汐=波浪横滚；敲击=鼓点短促点击；流动=连绵平缓；重拳=低音重击（最有力，建议从小强度开始）。',
  sensitivity: '灵敏度：体感对音量的响应强度。越高越敏感（同样的歌体感越强）。建议先低后高，找到舒适档。默认 1。',
  smoothing: '平滑：强度变化的顺滑程度。越高起伏越柔和、越低越跟手（快歌建议高一点更舒适）。默认 0.5。',
  stepPreset:
    '强度差（体质档）：单次更新最多变化的强度幅度。强=耐电、响应最跟手（30）；中=平衡（12）；弱=新手/不耐电、最柔和（5，默认）；自定义=自己填 1-60。防「1 直接跳到 200」的刺痛。',
  rampPreset:
    '恢复适应时间：暂停后继续播放 / 重新启用波形时，从 0 缓慢升到目标所需的时间。快=1s、中=2.5s、慢=5s（默认，最温和，给身体适应时间）。',
  dynamicRange:
    '自动适配轻响：根据歌曲轻重自动分配强度——轻歌放大、重歌收敛，避免轻歌一直微弱、重歌一直顶满。默认开启。',
  capsA: 'A 通道强度上限（0-200）：A 通道最大输出。若高于 App 内设置的硬上限会被自动下调。',
  capsB: 'B 通道强度上限（0-200）：B 通道最大输出。若高于 App 内设置的硬上限会被自动下调。',
  pulseEnabled: '节拍脉冲：重音/鼓点时叠加一段短促脉冲波形，增加敲击感。关闭后仅连续强度。',
  waveId: '脉冲波形：节拍脉冲使用的波形形状（内置连续/呼吸/潮汐/节拍，或你导入的自定义波形）。',
  outputToggle: '波形输出启禁：仅暂停「波形输出」，不关闭插件、不断开连接；重新启用后会按「恢复适应时间」缓慢恢复。',
  widget: '实时波形常驻：在左上角显示悬浮小组件（可拖拽、记住位置、任何模式置顶），实时展示 A/B 强度与波形。',
  port: '中继端口：手机扫码连接的端口（默认 30082）。修改后自动重启生效。',
  address: '网卡：扫码地址使用的本机 IP。多宽带/多网卡环境可手动选择手机能连到的那个。',
}

/** 设置项旁的 ⓘ 详情：点击内联展开一句话说明。 */
export function HelpInfo({ id, text }: { id?: string; text?: string }) {
  const [open, setOpen] = useState(false)
  const content = text ?? (id ? HELP[id] : '')
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-amber-200/40 text-amber-200/70 hover:bg-amber-200/15 hover:text-amber-100 transition-colors shrink-0"
        aria-label="详情"
      >
        <Info className="w-2.5 h-2.5" />
      </button>
      {open && (
        <span className="text-[10px] leading-relaxed text-amber-100/70 bg-amber-200/10 border border-amber-200/20 rounded-lg px-2 py-1 max-w-[260px] block">
          {content}
        </span>
      )}
    </span>
  )
}
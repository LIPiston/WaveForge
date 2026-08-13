/**
 * 详细日志开关。
 *
 * 播放热路径上的 console.log 会连同参数对象（过渡计划、整份节拍数组、歌曲对象等）
 * 一起被 Chromium 控制台长期持有，开发者工具打开时更是无限累积，是长时间播放
 * 内存缓慢增长的重要来源之一。这些日志默认静默；在开发者工具控制台执行
 * localStorage.setItem('waveforge:verbose-log', '1') 并重启应用后可恢复输出。
 */
let cachedFlag: boolean | null = null

function verboseEnabled(): boolean {
  if (cachedFlag !== null) return cachedFlag
  try {
    cachedFlag = localStorage.getItem('waveforge:verbose-log') === '1'
  } catch {
    cachedFlag = false
  }
  return cachedFlag
}

export function debugLog(...args: unknown[]): void {
  if (verboseEnabled()) console.log(...args)
}

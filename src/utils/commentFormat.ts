/**
 * 评论时间格式化：评论弹窗（列表 + 弹幕）与评论相关的展示共用。
 * 平台接口的时间字段既有毫秒时间戳，也有「3天前」这类现成文本（汽水评论两者皆有可能）。
 */

/** 毫秒时间戳 → 相对时间文案（刚刚/N分钟前/N小时前/...） */
export function formatRelativeCommentTime(timestamp: number): string {
  if (!timestamp || isNaN(timestamp)) return '未知时间'

  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 0) return '刚刚'

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const months = Math.floor(days / 30)
  const years = Math.floor(days / 365)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 30) return `${days}天前`
  if (months < 12) return `${months}个月前`
  return `${years}年前`
}

/** 兼容毫秒时间戳与现成文本：纯数字字符串按时间戳，其余原样展示 */
export function formatCommentTime(time: number | string): string {
  if (typeof time === 'string') {
    const text = time.trim()
    if (!text) return '未知时间'
    return /^\d+$/.test(text) ? formatRelativeCommentTime(Number(text)) : text
  }
  return formatRelativeCommentTime(time)
}

/** 排序用毫秒值：非数字文本（如「3天前」）按 0 处理，维持服务端顺序 */
export function commentTimeValue(time: number | string): number {
  return typeof time === 'number' ? time : Number(time) || 0
}

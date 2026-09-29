/**
 * QQ 音乐「我喜欢」id/mid 映射的形状归一。
 *
 * 上游 `fcg_musiclist_getmyfav.fcg?dirinfo=1` 返回的是**对象**而不是数组：
 *   { code: 0, totalNum: 861, map: { "501231481": 1, "351268824": 1, ... },
 *     mapmid: { "004a6uCg1jmsgO": 1, "0018EZ1S325Joo": 1, ... } }
 * （2026-09-27 实测 861 首用户：两个 map 各 861 项。）
 *
 * 事故：调用方原先用 `Array.isArray(data.map)` 判断 → 恒为 false → 拿到空数组 →
 * 客户端红心缓存变成空集合 → 「我喜欢」歌单里右键仍显示「我喜欢」、各处红心全是空心。
 *
 * 注意：**不能**假设 map 与 mapmid 按下标一一对应 —— map 的键是纯数字，
 * JS 对象对整数样式的键按数值升序枚举，与 mapmid（非数字键，插入序）顺序不同，
 * 且上游两次请求的顺序本身也不稳定（实测 dirinfo 有/无两次首项不同）。
 * 需要 mid → 数字 id 的精确对应时，请用歌曲详情接口，不要按下标配对。
 */

/** 把 map / mapmid 这类 {key: 1} 形状统一成去空白后的字符串数组；数组输入原样保留。 */
export function likedMapValues(input) {
  const normalize = (value) => String(value ?? '').trim()
  if (Array.isArray(input)) {
    return input.map(normalize).filter(Boolean)
  }
  if (input && typeof input === 'object') {
    return Object.keys(input).map(normalize).filter(Boolean)
  }
  return []
}

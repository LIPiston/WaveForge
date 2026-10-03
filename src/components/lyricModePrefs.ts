/**
 * WaveForge 歌词模式（现代/沉浸式/…）与 Folia 歌词风格（流光/绘光/…）共用的
 * 「顺序 + 可见性」偏好。
 *
 * 两份列表规则相同、数据各自独立（不同 localStorage key），所以逻辑放这里而不是抄两遍。
 * 这里全部是纯函数：读脏值、顺序表过时、条目被删/新增这些情况都要能被测出来。
 */

/**
 * 安全解析一个 id 列表。脏值（非 JSON、不是数组、元素不是字符串）一律当没存过，
 * 由调用方回落到默认顺序——缓存类偏好坏了不该让界面打不开。
 */
export function parseStoredIdList(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const ids = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

/**
 * 把保存的顺序合并到当前的全量清单上：
 * - 只保留仍然存在的 id（删掉的模式不会留残影）
 * - 存过的 id 按保存顺序排在前面，重复项去重
 * - 全量清单里没出现过的 id（新增模式）按默认顺序追加到末尾
 *
 * 关键点：顺序表是「过时快照」，新增模式必须仍然可见，否则升级后会凭空消失。
 */
export function mergeOrder(allIds: readonly string[], savedOrder: readonly string[] | null): string[] {
  const known = new Set(allIds)
  const merged: string[] = []
  const seen = new Set<string>()
  for (const id of savedOrder ?? []) {
    if (!known.has(id) || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  for (const id of allIds) {
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  return merged
}

/** 从 localStorage 读顺序；坏值/没存过时返回 null（调用方用默认顺序）。 */
export function readStoredOrder(key: string, allIds: readonly string[]): string[] | null {
  try {
    const parsed = parseStoredIdList(localStorage.getItem(key))
    return parsed ? mergeOrder(allIds, parsed) : null
  } catch {
    return null
  }
}

export function writeStoredOrder(key: string, order: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(order))
  } catch (error) {
    console.warn(`保存顺序失败 [${key}]:`, error)
  }
}

/**
 * 把某个 id 移到目标下标（拖拽与「上移/下移」共用）。
 * 目标下标按「移除该 id 之后」的列表计算，并做边界收敛。
 */
export function moveIdToIndex(order: readonly string[], id: string, targetIndex: number): string[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  const without = order.filter(item => item !== id)
  const clamped = Math.max(0, Math.min(without.length, Math.trunc(targetIndex)))
  without.splice(clamped, 0, id)
  return without
}

/** 相对移动：delta = -1 前移一位，+1 后移一位。已在端点时原样返回。 */
export function moveIdByOffset(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  return moveIdToIndex(order, id, from + Math.trunc(delta))
}

export interface EffectiveVisibleInput {
  /** 全量清单（默认顺序），用于补齐 */
  allIds: readonly string[]
  /** 用户保存的可见集合（可能过时：含已删除 id、缺新增 id） */
  visible: readonly string[]
  /** 当前正在使用的 id：始终可见，否则用户会「所在模式没出现在选择条里」 */
  currentId: string
  /** 无条件保留的 id（WaveForge 侧是「现代」，Folia 侧没有） */
  alwaysVisibleIds?: readonly string[]
  /** 至少保留几个可见，避免列表被关空 */
  minVisible?: number
}

/**
 * 求出真正生效的可见集合：清理失效 id、按默认顺序排列、补上必留项与当前项，
 * 并在可见数不足时按默认顺序补齐到 minVisible。
 */
export function resolveEffectiveVisible(input: EffectiveVisibleInput): string[] {
  const { allIds, visible, currentId, alwaysVisibleIds = [], minVisible = 1 } = input
  const known = new Set(allIds)
  const include = new Set<string>()
  for (const id of visible) {
    if (known.has(id)) include.add(id)
  }
  for (const id of alwaysVisibleIds) {
    if (known.has(id)) include.add(id)
  }
  if (known.has(currentId)) include.add(currentId)
  for (const id of allIds) {
    if (include.size >= minVisible) break
    include.add(id)
  }
  // 按默认顺序输出：可见性只管「在不在」，顺序由 mergeOrder 的结果决定，
  // 两者正交，调用方（选择条 / 菜单）才能各自独立地消费。
  return allIds.filter(id => include.has(id))
}

export interface ToggleVisibleInput extends EffectiveVisibleInput {
  id: string
  /** 即使可见也不允许关闭的 id（WaveForge 侧的「现代」） */
  lockedIds?: readonly string[]
}

export type ToggleVisibleResult =
  | { ok: true; visible: string[] }
  | { ok: false; reason: 'locked' | 'current' | 'last-visible' }

/**
 * 切换某个 id 的可见性。拒绝的三种情况与现有模式菜单一致：
 * 锁定的（现代）、当前正在用的、以及关掉后就不足最小可见数的。
 */
export function toggleVisible(input: ToggleVisibleInput): ToggleVisibleResult {
  const { id, lockedIds = [], minVisible = 1 } = input
  const effective = resolveEffectiveVisible(input)
  const isVisible = effective.includes(id)

  if (isVisible) {
    if (lockedIds.includes(id)) return { ok: false, reason: 'locked' }
    if (id === input.currentId) return { ok: false, reason: 'current' }
    if (effective.length <= minVisible) return { ok: false, reason: 'last-visible' }
    return { ok: true, visible: effective.filter(item => item !== id) }
  }
  return { ok: true, visible: [...effective, id] }
}

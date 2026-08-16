/**
 * 版本代号（A 方案：水声主题，贴合"澜音=波澜的声音"）。
 * 内部版本号仍是 0.x.y（更新系统/versionCode 依赖），这里只美化对外展示：
 *   `0.1.3「涟漪 さざなみ」`
 * patch 版本沿用所属 minor 的代号（0.1.x → 涟漪）。
 */

export interface VersionCodename {
  zh: string
  ja: string
  romaji: string
}

const CODENAMES: Record<number, VersionCodename> = {
  1: { zh: '涟漪', ja: 'さざなみ', romaji: 'sazanami' },
  2: { zh: '潮汐', ja: 'ちょうせき', romaji: 'chōseki' },
  3: { zh: '涌浪', ja: 'うねり', romaji: 'uneri' },
  4: { zh: '海风', ja: 'うみかぜ', romaji: 'umikaze' },
  5: { zh: '潮鸣', ja: 'しおなり', romaji: 'shionari' },
  6: { zh: '深蓝', ja: 'こんぺき', romaji: 'konpeki' },
  7: { zh: '极光', ja: 'オーロラ', romaji: 'ōrora' },
  10: { zh: '澜', ja: 'おおなみ', romaji: 'ōnami' },
}

export function getVersionCodename(version: string): VersionCodename | null {
  const minor = parseInt(String(version).replace(/^v/i, '').split('.')[1] || '', 10)
  return CODENAMES[minor] || null
}

/** 对外展示：0.1.3「涟漪 さざなみ」 */
export function getVersionDisplay(version: string): string {
  const v = String(version).replace(/^v/i, '')
  const c = getVersionCodename(version)
  return c ? `${v}「${c.zh} ${c.ja}」` : v
}

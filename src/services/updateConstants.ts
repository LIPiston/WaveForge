/**
 * 更新清单多源地址（TV / PC / 网页共用同一协议）。
 *
 * 网络现实：国内用户大多无法裸连 GitHub，也没有自建服务器。
 * 因此按"Gitee 主源（国内直连快）→ ghproxy 加速的 GitHub → GitHub 直连"顺序尝试。
 *
 * 注意：Gitee 仓库需与 GitHub 保持同步（发布脚本 publish-release.mjs 会推 update.json 到双源；
 * 首次需手动 `git push gitee master` 同步一次）。Kotlin 侧 UpdateChecker.kt 有同序副本，改动需同步。
 */

/** 更新清单（update.json，版本无关的固定地址）的多源候选 */
export const UPDATE_MANIFEST_URLS = [
  'https://gitee.com/kirito666233/wave-forge/raw/master/update.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/YoshinoRinn/WaveForge/master/update.json',
  'https://raw.githubusercontent.com/YoshinoRinn/WaveForge/master/update.json',
]

/** GitHub 下载加速前缀（ghproxy 系列，按顺序尝试） */
export const GITHUB_DOWNLOAD_PROXIES = ['https://ghproxy.net/', 'https://mirror.ghproxy.com/']

/**
 * 把产物下载地址展开为多源候选：Gitee 直连；GitHub 先加 ghproxy 加速、最后直连。
 */
export function withDownloadProxies(url: string): string[] {
  if (url.includes('gitee.com')) return [url]
  const proxied = GITHUB_DOWNLOAD_PROXIES.map((p) => p + url)
  return [...proxied, url]
}

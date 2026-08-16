/**
 * Apple Music 账号认证与用户信息
 *
 * 登录凭据：
 * - Developer Token（JWT，Authorization: Bearer）——需开发者密钥签发，网上有公开生成器
 * - Media-User-Token（需登录 Apple Music 账号的会话令牌）
 *
 * 校验 / 用户信息端点（逆向文档确认）：
 * - GET /v1/me/storefront        → 校验凭据 + 返回用户 storefront
 * - GET /v1/me/social-profile    → data.attributes.name / artwork（账户名与头像）
 */

export interface AppleUserInfo {
  name: string
  avatarUrl?: string
  storefront: string
}

export const AMP_API = 'https://amp-api.music.apple.com/v1'

export interface AppleCredentials {
  developerToken: string
  mediaUserToken: string
  storefront: string
}

export function getAppleCredentials(): AppleCredentials {
  return {
    developerToken: localStorage.getItem('appleDeveloperToken') || '',
    mediaUserToken: localStorage.getItem('appleMediaUserToken') || '',
    storefront: localStorage.getItem('appleStorefront') || 'cn',
  }
}

export function getAppleAuthState(): { loggedIn: boolean; name: string; avatarUrl?: string; storefront: string } {
  const name = localStorage.getItem('appleAccountName') || ''
  const avatarUrl = localStorage.getItem('appleAvatarUrl') || undefined
  const storefront = localStorage.getItem('appleStorefront') || 'cn'
  const credentials = getAppleCredentials()
  return {
    loggedIn: Boolean(credentials.developerToken && credentials.mediaUserToken && name),
    name,
    avatarUrl,
    storefront,
  }
}

export function clearAppleLogin(): void {
  localStorage.removeItem('appleAccountName')
  localStorage.removeItem('appleAvatarUrl')
}

export function saveAppleLogin(user: AppleUserInfo): void {
  if (user.name) localStorage.setItem('appleAccountName', user.name)
  if (user.avatarUrl) localStorage.setItem('appleAvatarUrl', user.avatarUrl)
  if (user.storefront) localStorage.setItem('appleStorefront', user.storefront)
}

const appleFetch = async (path: string, credentials: AppleCredentials, timeoutMs = 8000): Promise<any | null> => {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${AMP_API}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${credentials.developerToken}`,
        'Media-User-Token': credentials.mediaUserToken,
        Origin: 'https://music.apple.com',
        Referer: 'https://music.apple.com/',
        Accept: 'application/json',
      },
    })
    if (!response.ok) return null
    return await response.json()
  } catch (error) {
    console.warn('[AppleAuth] 请求失败:', path, error)
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

const toAvatarUrl = (artwork?: { url?: string }): string | undefined => {
  if (!artwork?.url) return undefined
  // artwork.url 形如 {w}x{h}bb.jpg —— 替换为 200×200
  return artwork.url.replace(/\{w\}x\{h\}bb/g, '200x200bb')
}

/**
 * 校验 Apple 凭据并拉取用户信息。
 * - storefront 失败 → 凭据无效
 * - social-profile 失败 → 仅返回 storefront（已登录但无资料）
 */
export async function validateAppleLogin(
  developerToken: string,
  mediaUserToken: string,
  storefront = 'cn',
): Promise<{ ok: boolean; user?: AppleUserInfo; error?: string }> {
  const credentials: AppleCredentials = { developerToken, mediaUserToken, storefront }

  const storefrontData = await appleFetch('/me/storefront', credentials)
  if (!storefrontData) {
    return { ok: false, error: '凭据无效或已过期（Developer Token / Media-User-Token）' }
  }
  const resolvedStorefront = storefrontData?.data?.[0]?.id || storefront

  const profile = await appleFetch('/me/social-profile', credentials)
  if (profile?.data) {
    const attributes = profile.data.attributes || profile.data
    return {
      ok: true,
      user: {
        name: attributes.name || 'Apple Music 用户',
        avatarUrl: toAvatarUrl(attributes.artwork),
        storefront: resolvedStorefront,
      },
    }
  }

  // social-profile 不可用时降级：仅凭 storefront 视为已登录
  return {
    ok: true,
    user: {
      name: 'Apple Music 用户',
      storefront: resolvedStorefront,
    },
  }
}

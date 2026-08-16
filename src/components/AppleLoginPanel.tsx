import { useEffect, useRef, useState } from 'react'
import { Apple, CheckCircle2, KeyRound, Loader2, LogOut, ShieldCheck, X } from 'lucide-react'
import { validateAppleLogin, clearAppleLogin, getAppleAuthState, type AppleUserInfo } from '../services/appleAuth'

interface AppleLoginPanelProps {
  accentColor?: string
  onClose: () => void
  onLoginSuccess: (user: AppleUserInfo | null) => void
}

/**
 * Apple Music 登录：Developer Token + Media-User-Token。
 * 校验通过后拉取 storefront 与用户资料（头像/昵称）。
 */
export default function AppleLoginPanel({ accentColor = '#fa2d48', onClose, onLoginSuccess }: AppleLoginPanelProps) {
  const [devToken, setDevToken] = useState(() => localStorage.getItem('appleDeveloperToken') || '')
  const [mediaToken, setMediaToken] = useState(() => localStorage.getItem('appleMediaUserToken') || '')
  const [storefront, setStorefront] = useState(() => localStorage.getItem('appleStorefront') || 'cn')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [currentUser, setCurrentUser] = useState(() => getAppleAuthState())
  const [showGuide, setShowGuide] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const handleLogin = async () => {
    const dev = devToken.trim()
    const media = mediaToken.trim()
    if (!dev || !media) {
      setStatus({ ok: false, message: '请先填写 Developer Token 与 Media-User-Token' })
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const result = await validateAppleLogin(dev, media, storefront)
      if (!mountedRef.current) return
      if (result.ok && result.user) {
        localStorage.setItem('appleDeveloperToken', dev)
        localStorage.setItem('appleMediaUserToken', media)
        setCurrentUser({ loggedIn: true, name: result.user.name, avatarUrl: result.user.avatarUrl, storefront: result.user.storefront })
        setStatus({ ok: true, message: `登录成功：${result.user.name}` })
        onLoginSuccess(result.user)
      } else {
        setStatus({ ok: false, message: result.error || '登录失败' })
      }
    } catch (error) {
      if (mountedRef.current) setStatus({ ok: false, message: error instanceof Error ? error.message : '登录失败' })
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const handleLogout = () => {
    clearAppleLogin()
    localStorage.removeItem('appleDeveloperToken')
    localStorage.removeItem('appleMediaUserToken')
    setCurrentUser({ loggedIn: false, name: '', storefront })
    setStatus({ ok: true, message: '已退出登录' })
    onLoginSuccess(null)
  }

  const inputClass = 'w-full rounded-xl border border-white/12 bg-white/[0.05] px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/30'

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#12141c] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${accentColor}22` }}>
              <Apple className="h-5 w-5" style={{ color: accentColor }} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-white">Apple Music 登录</h2>
              <p className="text-xs text-white/45">使用 Apple 账号接入 WaveForge</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-6">
          {currentUser.loggedIn && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-3.5">
              {currentUser.avatarUrl ? (
                <img src={currentUser.avatarUrl} alt={currentUser.name} className="h-10 w-10 rounded-full object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
                  <ShieldCheck className="h-5 w-5 text-emerald-300" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{currentUser.name}</div>
                <div className="text-xs text-white/45">Apple Music · {currentUser.storefront.toUpperCase()} 商店</div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/65 transition hover:bg-white/10"
              >
                <LogOut className="h-3.5 w-3.5" /> 退出
              </button>
            </div>
          )}

          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-white/60">
              <KeyRound className="h-3.5 w-3.5" /> Developer Token（Authorization: Bearer …）
            </label>
            <input
              type="password"
              value={devToken}
              onChange={event => setDevToken(event.target.value)}
              placeholder="eyJhbGciOiJFUzI1NiIsImtpZCI6…"
              className={inputClass}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-white/60">
              <ShieldCheck className="h-3.5 w-3.5" /> Media-User-Token（Apple Music 账号会话令牌）
            </label>
            <input
              type="password"
              value={mediaToken}
              onChange={event => setMediaToken(event.target.value)}
              placeholder="AwAAAB…"
              className={inputClass}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-white/60">商店（Storefront）</label>
            <select
              value={storefront}
              onChange={event => setStorefront(event.target.value)}
              className={`${inputClass} appearance-none`}
            >
              <option value="cn">中国大陆 (cn)</option>
              <option value="hk">香港 (hk)</option>
              <option value="tw">台湾 (tw)</option>
              <option value="us">美国 (us)</option>
              <option value="jp">日本 (jp)</option>
              <option value="kr">韩国 (kr)</option>
              <option value="gb">英国 (gb)</option>
            </select>
          </div>

          <button
            type="button"
            onClick={() => void handleLogin()}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
            style={{ background: accentColor }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Apple className="h-4 w-4" />}
            {loading ? '验证中…' : (currentUser.loggedIn ? '重新登录' : '登录 Apple Music')}
          </button>

          {status && (
            <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs ${status.ok ? 'bg-emerald-400/10 text-emerald-200' : 'bg-amber-400/10 text-amber-200'}`}>
              {status.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>{status.message}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowGuide(value => !value)}
            className="text-xs text-white/45 underline-offset-2 transition hover:text-white/70 hover:underline"
          >
            {showGuide ? '收起 Token 获取指引' : '如何获取 Token？'}
          </button>
          {showGuide && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-xs leading-relaxed text-white/55">
              <p className="mb-2 font-medium text-white/75">Token 获取方式：</p>
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>
                  <b className="text-white/80">Developer Token</b>：Apple 媒体服务 JWT，需开发者密钥签发。可使用网上公开的
                  「Apple Music API JWT 生成器」站点生成（key id / team id / 私钥需自行准备）。
                </li>
                <li>
                  <b className="text-white/80">Media-User-Token</b>：登录 <span className="text-white/70">music.apple.com</span> 后，
                  在浏览器开发者工具 → 网络 → 任意 amp-api 请求的请求头中复制
                  <code className="mx-1 rounded bg-white/10 px-1 py-0.5">media-user-token</code> 的值。
                </li>
              </ol>
              <p className="mt-2 text-white/40">令牌仅保存在本机 localStorage，用于直接调用 Apple Music API。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

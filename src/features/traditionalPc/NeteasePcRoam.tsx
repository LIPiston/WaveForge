// 网易云 PC 客户端「漫游」页（私人漫游）复刻。
//
// 官方这一页是电台式版式：顶部漫游模式胶囊 → 当前曲目大卡（封面 + 曲目信息 + 播放全部/换一批）
// → 漫游出来的队列列表。数据走探索网关 /api/netease/native/roam（需登录），
// 队列与当前曲目全部由接口实时生成，页面不做任何本地造数据。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LogIn, Radio, RefreshCw } from 'lucide-react'
import { fetchNeteaseRoam } from '../neteaseExplore/api'
import type { Song } from '../../services/musicApi'
import {
  PcChips, PcCover, PcEmpty, PcGhostButton, PcListFooter, PcPageTitle, PcPrimaryButton, PcSongTable,
  pcSongArtwork, pcSongKey, pcTheme, pcTint,
} from './pcKit'
import type { PcAccount, PcActions, PcChrome } from './types'

/**
 * 漫游模式 → fetchNeteaseRoam 的 mode/subMode。
 * 取值来源说明：服务端把 mode 原样透传给安卓协议 /api/v1/radio/get（server/netease-native-explore.mjs），
 * 仓库里唯一能确认的取值是它自己的默认值 'DEFAULT'（官方「熟悉」档）；其余四档用客户端漫游模式的语义标识，
 * 服务端不识别时会返回空列表 —— 那时页面显示空态并提示切回「熟悉」，不造假数据。
 */
const ROAM_MODES: Array<{ key: string; label: string; mode: string; subMode?: string }> = [
  { key: 'familiar', label: '熟悉', mode: 'DEFAULT' },
  { key: 'like', label: '喜欢', mode: 'FAMILIAR' },
  { key: 'explore', label: '探索', mode: 'EXPLORE' },
  { key: 'niche', label: '小众', mode: 'NICHE' },
  { key: 'atmosphere', label: '氛围', mode: 'ATMOSPHERE' },
]

/** 单次漫游拉取的歌曲数（接口回传上限附近的常规值）。 */
const ROAM_LIMIT = 30
/** 换一批时回传给服务端的已漫游 id 上限，与探索页保持一致（服务端也只吃 100 个）。 */
const ROAM_MEMORY_LIMIT = 100

export interface NeteasePcRoamProps {
  chrome: PcChrome
  account: PcAccount
  actions: PcActions
  authRevision?: number
  /** 隐藏保活页为 false：非 active 时不拉数据 */
  active?: boolean
}

function NeteasePcRoam({ chrome, account, actions, authRevision, active = true }: NeteasePcRoamProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)

  const [modeKey, setModeKey] = useState(ROAM_MODES[0].key)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 换一批：自增触发重拉（避免把「已漫游 id」放进依赖导致每次拿到结果又重拉一次）
  const [batch, setBatch] = useState(0)
  const memoryRef = useRef<string[]>([])

  const mode = useMemo(() => ROAM_MODES.find(item => item.key === modeKey) || ROAM_MODES[0], [modeKey])
  const modeItems = useMemo(() => ROAM_MODES.map(item => ({ key: item.key, label: item.label })), [])

  useEffect(() => {
    if (!active || !loggedIn) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetchNeteaseRoam(controller.signal, {
      mode: mode.mode,
      subMode: mode.subMode,
      limit: ROAM_LIMIT,
      // 换一批时把已漫游出来的歌交给服务端去重，与官方「换一批」语义一致
      unplaySongIds: memoryRef.current,
    })
      .then(list => {
        if (controller.signal.aborted) return
        setSongs(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setSongs([])
        setError(err instanceof Error ? err.message : '漫游加载失败')
        setLoading(false)
      })
    return () => controller.abort()
  }, [active, loggedIn, mode, authRevision, batch])

  // 当前曲目大卡：优先正在播放的那首（若它在本批漫游里），否则用第一首
  const currentSong = useMemo(() => {
    const playingKey = actions.currentSongKey
    return (playingKey ? songs.find(song => pcSongKey(song) === playingKey) : undefined) || songs[0] || null
  }, [songs, actions.currentSongKey])

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  const nextBatch = useCallback(() => {
    memoryRef.current = [...new Set([...memoryRef.current, ...songs.map(song => String(song.id))])].slice(-ROAM_MEMORY_LIMIT)
    setBatch(value => value + 1)
  }, [songs])

  return (
    <div className="pb-8">
      <PcPageTitle
        theme={theme}
        title="私人漫游"
        subtitle={loggedIn ? `按你的口味实时生成播放队列 · 当前模式「${mode.label}」` : '漫游需要登录网易云音乐账号'}
        extra={<Radio className={`h-5 w-5 ${theme.faint}`} />}
      />

      <PcChips items={modeItems} value={modeKey} onChange={setModeKey} accent={accent} theme={theme} className="mb-5" />

      {!loggedIn ? (
        <PcEmpty
          theme={theme}
          title="登录后开启私人漫游"
          description="漫游会按你的听歌口味实时生成队列，未登录时不可用"
          action={<PcPrimaryButton label="立即登录" icon={<LogIn className="h-3.5 w-3.5" />} accent={accent} onClick={() => actions.onLogin?.()} />}
        />
      ) : (
        <>
          {currentSong ? (
            <div className="mb-6 flex flex-col gap-4 rounded-xl p-4 sm:flex-row" style={pcTint(accent, 0.07)}>
              <PcCover
                src={pcSongArtwork(currentSong)}
                alt={currentSong.name}
                eager
                className="h-[200px] w-[200px] shrink-0 shadow-sm"
                overlay={
                  <span className="absolute left-2 top-2 rounded-full bg-black/45 px-2 py-[3px] text-[11px] leading-none text-white backdrop-blur-sm">
                    {mode.label}
                  </span>
                }
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={`text-[12px] ${theme.subtle}`}>私人漫游 · {mode.label}</span>
                <h2 className={`mt-1 line-clamp-2 text-[22px] font-semibold leading-tight ${theme.text}`}>{currentSong.name}</h2>
                <p className={`mt-2 text-[13px] ${theme.subtle}`}>
                  {(currentSong.artists || []).map(artist => artist.name).filter(Boolean).join(' / ') || '未知歌手'}
                </p>
                <p className={`mt-0.5 truncate text-[12px] ${theme.faint}`}>{currentSong.album?.name || '未知专辑'}</p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />
                  <PcGhostButton
                    label="换一批"
                    icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
                    theme={theme}
                    onClick={nextBatch}
                    disabled={loading}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className={`mb-6 rounded-xl p-4 ${theme.surface}`}>
              <div className="flex items-center gap-3">
                <span className={`flex h-16 w-16 items-center justify-center rounded-lg ${theme.hover}`}>
                  <Radio className={`h-6 w-6 ${theme.faint}`} />
                </span>
                <div className="min-w-0">
                  <p className={`text-[14px] ${theme.subtle}`}>{loading ? '正在为你生成漫游队列…' : '本次漫游没有拿到歌曲'}</p>
                  <p className={`mt-1 text-[12px] ${theme.faint}`}>
                    {error || '可以先切回「熟悉」模式，或点「换一批」重新生成'}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <PcGhostButton
                    label="换一批"
                    icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />}
                    theme={theme}
                    onClick={nextBatch}
                    disabled={loading}
                  />
                </div>
              </div>
            </div>
          )}

          <PcSongTable
            songs={songs}
            skin={chrome.skin}
            theme={theme}
            accent={accent}
            loading={loading && !songs.length}
            columns={{ index: true, like: true, album: true, duration: true }}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
            onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
            likedKeys={actions.likedKeys}
            onToggleLike={actions.onToggleLike}
            empty={(
              <PcEmpty
                theme={theme}
                title={error ? '漫游加载失败' : '该漫游模式暂无歌曲'}
                description={error || `服务端未返回「${mode.label}」模式的歌曲，可切换其它模式再试`}
                action={(
                  <PcGhostButton
                    label="重试"
                    icon={<RefreshCw className="h-3.5 w-3.5" />}
                    theme={theme}
                    onClick={nextBatch}
                    disabled={loading}
                  />
                )}
              />
            )}
          />

          {songs.length > 0 && <PcListFooter theme={theme} label={`本次漫游 ${songs.length} 首 · 双击或点行首播放，点「换一批」重新生成`} />}
        </>
      )}
    </div>
  )
}

export default memo(NeteasePcRoam)

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
 * 取值证据（2026-10-04 抓包核对）：
 * 1) NeteaseCloudMusicApi 公开逆向文档：/api/v1/radio/get 的 mode ∈ { aidj, DEFAULT, FAMILIAR, EXPLORE, SCENE_RCMD }（可选 subMode）；
 * 2) 官方 Link Platform 下发的曲风漫游资源实测携带 mode=SCENE_RCMD + subMode（见 neteaseExplore/model.ts 的 fm 入口）；
 * 3) 本机网易云 PC 客户端 3.1.41 实测：点「漫游」直接开播且逐首下发，客户端本身无档位选择器。
 * 早期这里猜的 'NICHE'/'ATMOSPHERE' 上游并不存在（任意非法值都会被容忍成默认流），已按真实枚举修正；
 * 官方没有「喜欢/小众」档位，不再伪造。
 */
const ROAM_MODES: Array<{ key: string; label: string; mode: string; subMode?: string }> = [
  { key: 'familiar', label: '熟悉', mode: 'FAMILIAR' },
  { key: 'explore', label: '探索', mode: 'EXPLORE' },
  { key: 'scene', label: '氛围', mode: 'SCENE_RCMD' },
  { key: 'default', label: '默认', mode: 'DEFAULT' },
]

/** 漫游队列目标长度（官方客户端是逐首播放的电台，这里拼成队列便于整批试听）。 */
const ROAM_QUEUE_TARGET = 30
/** 每轮并发请求数：上游单曲下发，队列靠多轮连发拼出来（打满 8 轮仍不够就按实得展示）。 */
const ROAM_BATCH_SIZE = 6
const ROAM_MAX_ROUNDS = 8
/** 换一批时回传给服务端的已漫游 id 上限，与探索页保持一致（服务端也只吃 100 个）。 */
const ROAM_MEMORY_LIMIT = 100

/**
 * 拼一支漫游队列：/api/v1/radio/get 每次只回 1 首（实测），连发多轮并用 unplaySongIds 去重。
 * 整轮没有任何新增时提前止损——继续连发只会拿到重复曲目。
 */
async function fetchRoamQueue(signal: AbortSignal | undefined, options: { mode: string; subMode?: string; memory: string[] }): Promise<Song[]> {
  const collected: Song[] = []
  const seen = new Set<string>()
  const played = [...options.memory]
  for (let round = 0; round < ROAM_MAX_ROUNDS && collected.length < ROAM_QUEUE_TARGET; round++) {
    const batch = await Promise.all(Array.from({ length: ROAM_BATCH_SIZE }, () =>
      fetchNeteaseRoam(signal, { mode: options.mode, subMode: options.subMode, limit: 1, unplaySongIds: played })
        .then(list => list[0])
        .catch(() => undefined)))
    let added = 0
    for (const song of batch) {
      if (!song?.id || seen.has(String(song.id))) continue
      seen.add(String(song.id))
      collected.push(song)
      played.push(String(song.id))
      added++
    }
    if (!added) break
  }
  return collected.slice(0, ROAM_QUEUE_TARGET)
}

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
    void fetchRoamQueue(controller.signal, {
      mode: mode.mode,
      subMode: mode.subMode,
      // 换一批时把已漫游出来的歌交给服务端去重，与官方「换一批」语义一致
      memory: memoryRef.current,
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
                title={error ? '漫游加载失败' : '本次漫游没有拿到歌曲'}
                description={error || '官方漫游是逐首下发的电台，偶发空回合；点「换一批」重试或切换其它模式'}
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

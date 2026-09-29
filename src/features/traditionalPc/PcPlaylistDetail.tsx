// 官方 PC 客户端风格歌单详情（两个平台共用外壳，skin 决定页签与细节）。
//
// 与旧版 TraditionalPlaylistDetail 的差别：这里完全按客户端排版（大封面头部 + 页签 +
// 提示条 + 表格），并复用 pcKit 的表格，保证与列表页一致的行高/列宽/角标。
// 列表很长时用「滚动到底自动追加」分批渲染 —— 客户端本身是虚拟列表，这里用更轻的做法
// 避免为了一个二级页引入虚拟化依赖。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListPlus, Share2 } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { isSameSong } from '../../services/musicApi'
import { getPlatformCapabilities, platformLabel, type MusicPlatform } from '../../services/platforms'
import { subscribePlaylist } from '../../services/playlistService'
import {
  PcDetailHeader, PcGhostButton, PcNoticeBar, PcPrimaryButton, PcSongTable, PcTabs, PcTableSearch,
  PcEmpty, pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import type { PcActions, PcAccount } from './types'

const PAGE_SIZE = 200

type PlaylistLike = {
  id: number | string
  dirId?: number | string
  name: string
  coverImgUrl?: string
  coverUrl?: string
  trackCount?: number
  description?: string
  desc?: string
  creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
  tags?: string[]
  platform?: MusicPlatform
  isCollected?: boolean
  isLike?: boolean
  playCount?: number
  createTime?: number
} | null

export interface PcPlaylistDetailProps {
  playlist: PlaylistLike
  songs: Song[]
  loading: boolean
  error?: string
  onRetry?: () => void
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  actions: PcActions
  account: PcAccount
  /** 本人创建的歌单：隐藏「收藏」入口，显示编辑/投稿 */
  isOwner?: boolean
  /** 从父层带入的收藏态（订阅后回写由父层负责） */
  onSubscribeToggle?: () => void
}

function PcPlaylistDetail({
  playlist, songs, loading, error = '', onRetry, chrome, actions, account, isOwner = false, onSubscribeToggle,
}: PcPlaylistDetailProps) {
  const theme = pcTheme(chrome.tone)
  const skin = chrome.skin
  const accent = chrome.accent
  const [tab, setTab] = useState('songs')
  const [keyword, setKeyword] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [noticeHidden, setNoticeHidden] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setTab('songs'); setVisibleCount(PAGE_SIZE) }, [playlist?.id, skin])

  // 长歌单分批渲染：滚到底部哨兵进入视口就追加下一批
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => (count < songs.length ? Math.min(songs.length, count + PAGE_SIZE) : count))
      }
    }, { rootMargin: '320px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [songs.length])

  const platform = (playlist?.platform || songs[0]?.platform || (skin === 'qq' ? 'qq' : 'netease')) as MusicPlatform
  const capabilities = getPlatformCapabilities(platform)
  const coverUrl = playlist?.coverImgUrl || playlist?.coverUrl || songs[0]?.album?.picUrl
  const description = playlist?.description || playlist?.desc || ''
  const filtered = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase()
    if (!trimmed) return songs
    return songs.filter(song =>
      song.name.toLowerCase().includes(trimmed)
      || (song.artists || []).some(artist => (artist.name || '').toLowerCase().includes(trimmed))
      || (song.album?.name || '').toLowerCase().includes(trimmed))
  }, [songs, keyword])
  const visibleSongs = filtered.slice(0, visibleCount)
  const trackCount = songs.length || playlist?.trackCount || 0

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  const handleSubscribe = useCallback(() => {
    if (!playlist) return
    const targetId = String(playlist.id || (playlist as { dirId?: string | number }).dirId || '')
    if (!targetId) return
    void subscribePlaylist(targetId, true, platform).then(() => onSubscribeToggle?.()).catch(() => undefined)
  }, [playlist, platform, onSubscribeToggle])

  const creatorName = playlist?.creator?.nickname || (playlist?.isLike && account.username) || (isOwner ? account.username : '')
  const creatorAvatar = playlist?.creator?.avatarUrl || (isOwner || playlist?.isLike ? account.avatar : undefined)
  const meta = [
    platformLabel(platform),
    playlist?.createTime ? `创建于 ${new Date(playlist.createTime).toLocaleDateString('zh-CN')}` : '',
    (playlist?.tags || []).length ? (playlist?.tags || []).map(tag => `#${tag}`).join(' ') : '',
  ].filter(Boolean).join(' · ')

  // 官方还有「评论 / 收藏者」页签，但仓库里没有歌单级评论/收藏者接口（只有单曲评论，走行内入口/右键菜单），
  // 所以这里只保留有数据的「歌曲」，而不是留一个点进去是空态的页签。
  const tabItems = [{ key: 'songs', label: '歌曲', count: trackCount }]

  return (
    <div className="pb-8">
      <PcDetailHeader
        theme={theme}
        skin={skin}
        coverUrl={coverUrl}
        title={playlist?.name || '歌单'}
        playCount={playlist?.playCount}
        description={description}
        meta={meta}
        creator={creatorName ? { name: creatorName, avatar: creatorAvatar } : undefined}
        titleExtra={undefined}
        actions={(
          <>
            <PcPrimaryButton label="播放" accent={accent} onClick={playAll} disabled={!songs.length} />
            {/* 「我喜欢的音乐」是系统歌单：官方没有收藏入口，也不该出现收藏按钮 */}
            {!isOwner && !playlist?.isLike && (
              <PcGhostButton
                label={playlist?.isCollected ? '已收藏' : '收藏'}
                icon={<ListPlus className="h-3.5 w-3.5" />}
                theme={theme}
                onClick={handleSubscribe}
                disabled={!capabilities.subscribePlaylist}
              />
            )}
            {/* 下载/批量在本软件没有链路，更多菜单由行右键承担：都不渲染假入口 */}
            {actions.onSharePlaylist && playlist ? (
              <PcGhostButton label="分享" icon={<Share2 className="h-3.5 w-3.5" />} theme={theme} onClick={() => actions.onSharePlaylist?.(playlist)} />
            ) : null}
          </>
        )}
      />

      {/* 页签 + 右端搜索 */}
      <div className={`mb-3 flex items-end justify-between gap-4 border-b ${theme.divider}`}>
        <PcTabs items={tabItems} value={tab} onChange={setTab} accent={accent} theme={theme} />
        <div className="pb-1.5">
          <PcTableSearch value={keyword} onChange={setKeyword} theme={theme} accent={accent} placeholder="搜索" />
        </div>
      </div>

      {skin === 'netease' && !noticeHidden && !isOwner && (
        <PcNoticeBar theme={theme} onClose={() => setNoticeHidden(true)}>
          <span className="truncate">会员可畅听本歌单内的高音质与 VIP 歌曲</span>
        </PcNoticeBar>
      )}

      {error ? (
        <div className={`rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>
          {error}
          {onRetry ? <button type="button" onClick={onRetry} className="ml-2 underline">重试</button> : null}
        </div>
      ) : null}

      {tab === 'songs' && (
        <>
          <PcSongTable
            songs={visibleSongs}
            skin={skin}
            theme={theme}
            accent={accent}
            loading={loading && !songs.length}
            columns={{ index: true, like: true, album: true, duration: true }}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            onPlay={(song, index) => actions.onPlaySongs(song, filtered, index)}
            onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: filtered }) }}
            likedKeys={actions.likedKeys}
            onToggleLike={actions.onToggleLike}
            empty={<PcEmpty theme={theme} title="这个歌单还没有可播放的歌曲" />}
            rowActions={(song) => (
              <>
                <button type="button" className={`text-[11px] ${theme.faint} hover:opacity-80`} onClick={event => { event.stopPropagation(); actions.onOpenComments?.(song) }}>评论</button>
              </>
            )}
          />
          <div ref={sentinelRef} />
          {visibleCount < filtered.length && (
            <div className={`py-4 text-center text-[12px] ${theme.faint}`}>正在载入更多…（已显示 {visibleSongs.length}/{filtered.length}）</div>
          )}
        </>
      )}
    </div>
  )
}

export default memo(PcPlaylistDetail)
export { isSameSong }

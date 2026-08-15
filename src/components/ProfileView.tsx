import { getQQUserDisplayName } from '../utils/qqUser'
import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Heart, List, User, Crown, Calendar, MapPin, RefreshCw, LogOut, Plus, MoreHorizontal, Play, History, Disc3, Radio, Mic2, Users, TrendingUp, ArrowLeft, Film } from 'lucide-react'
import { Song, resolveSongAlbumIdentifier, getUserFollows, getUserFolloweds, getUserRecordRank, getQQFollows, getQQFans, getQQUserProfile, getQQUserFavs, subscribeQQUser, subscribeNeteaseUser, getSubscribedAlbums, getSubscribedArtists, getQQSubscribedAlbums, getQQSubscribedArtists, getNeteaseMvSublist, neteaseDailySignin } from '../services/musicApi'
import PlaylistDetailPanel from './PlaylistDetailPanel'
import CachedImage from './CachedImage'
import PlaylistContextMenu from './PlaylistContextMenu'
import SongContextMenu from './SongContextMenu'
import CreatePlaylistModal from './CreatePlaylistModal'
import EditPlaylistModal from './EditPlaylistModal'
import DeletePlaylistModal from './DeletePlaylistModal'
import {
  createPlaylist,
  deletePlaylist,
  getUserPlaylists,
  removeSongFromPlaylist,
  subscribePlaylist,
  updatePlaylist,
  updatePlaylistCover
} from '../services/playlistService'
import { detectQQMusicVip } from '../utils/musicEntitlements'

interface Playlist {
  id: string | number
  dirId?: string | number
  name: string
  coverImgUrl: string
  trackCount: number
  playCount?: number
  creator?: {
    nickname: string
    userId?: string | number
    avatarUrl?: string
  }
  userId?: string | number
  description?: string
  specialType?: number
  isLike?: boolean
  isCollected?: boolean
  subscribed?: boolean
  platform?: 'netease' | 'qq'
  tags?: string[]
  createTime?: number
  commentCount?: number
}

interface UserDetail {
  nickname: string
  avatarUrl: string
  userId: string
  signature?: string
  vipType?: number
  city?: string
  birthday?: number
  followeds?: number  // 粉丝数（网易云）
  follows?: number    // 关注数（网易云）
  playlistCount?: number
  level?: number
  // 网易云特有字段
  eventCount?: number      // 动态数
  newFollows?: number      // 新关注数
  listenSongs?: number     // 累计听歌
  createTime?: number      // 注册时间
  gender?: number          // 性别：0-保密, 1-男, 2-女
  province?: number        // 省份代码
  backgroundUrl?: string   // 背景图
  // QQ音乐特有字段
  visitornum?: number     // 访客数
  fansnum?: number        // 粉丝数
  follownum?: number      // 关注总数
  followusernum?: number  // 关注用户数
  followsingernum?: number // 关注歌手数
  listenLevel?: string    // 听歌等级图标
}

type ProfileTab = 'created' | 'subscribed' | 'detail' | 'recent' | 'social' | 'rank' | 'favs' | 'collections'
type RecentPlaybackType = 'song' | 'playlist' | 'album' | 'dj' | 'voice'

const formatCount = (value?: number) => {
  const count = Number(value || 0)
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return count ? String(count) : '0'
}

interface RecentPlaybackItem {
  id: string
  type: RecentPlaybackType
  name: string
  subtitle: string
  coverUrl: string
  playTime?: number
  song?: Song
  playlist?: Playlist
  albumId?: string
}

interface ProfileViewProps {
  initialPlatform: 'netease' | 'qq'  // 初始显示的平台
  initialTab?: ProfileTab
  canSwitchPlatform: boolean  // 是否可以切换平台
  userId: string  // 当前平台的用户ID
  cookie: string  // 当前平台的Cookie
  accentColor?: string  // 主题色
  onClose: () => void
  onSongSelect: (song: Song, playlist?: Song[]) => void
  handleSwitchPlatform: () => void  // 切换平台的回调
  onLogout: (platform: 'netease' | 'qq') => void  // 退出登录回调
  currentSong?: Song | null
  playerTheme?: 'light' | 'dark'
  onOpenArtist?: (artistId: string, platform: 'netease' | 'qq') => void
  onOpenAlbum?: (albumId: string, platform: 'netease' | 'qq') => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => boolean | Promise<boolean>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
}

export default function ProfileView({ 
  initialPlatform,
  initialTab = 'created',
  canSwitchPlatform,
  userId,
  cookie,
  accentColor = '#3B82F6',
  onClose, 
  onSongSelect,
  handleSwitchPlatform,
  onLogout,
  currentSong = null,
  playerTheme = 'dark',
  onOpenArtist,
  onOpenAlbum,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onCopyInfo
}: ProfileViewProps) {
  const [currentPlatform, setCurrentPlatform] = useState<'netease' | 'qq'>(initialPlatform)
  const [activeTab, setActiveTab] = useState<ProfileTab>(initialTab)
  const [recentType, setRecentType] = useState<RecentPlaybackType>('song')
  const [recentItems, setRecentItems] = useState<RecentPlaybackItem[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState('')
  const recentRequestRef = useRef<{ revision: number; controller: AbortController | null }>({
    revision: 0,
    controller: null,
  })
  // 社交（关注/粉丝）状态 —— 仅网易云
  const [socialType, setSocialType] = useState<'follows' | 'followeds'>('follows')
  const [socialItems, setSocialItems] = useState<{ userId: string; nickname: string; avatarUrl: string; signature: string; isFollow: boolean }[]>([])
  const [socialLoading, setSocialLoading] = useState(false)
  const [socialError, setSocialError] = useState('')
  // QQ 社交状态（关注用户/粉丝列表）
  const [qqSocialType, setQqSocialType] = useState<'follows' | 'fans'>('follows')
  const [qqSocialItems, setQqSocialItems] = useState<{ encUin: string; mid: string; name: string; desc: string; avatarUrl: string; isFollow: boolean; isSelf: boolean }[]>([])
  // QQ 他人“我喜欢”列表
  const [qqFavItems, setQqFavItems] = useState<any[]>([])
  const [qqFavLoading, setQqFavLoading] = useState(false)
  // 网易云收藏的专辑 / 关注的歌手 / 收藏的 MV
  const [collectedAlbums, setCollectedAlbums] = useState<any[]>([])
  const [collectedArtists, setCollectedArtists] = useState<any[]>([])
  const [collectedMvs, setCollectedMvs] = useState<any[]>([])
  const [collectionsLoading, setCollectionsLoading] = useState(false)
  const [qqSocialLoading, setQqSocialLoading] = useState(false)
  const [qqSocialError, setQqSocialError] = useState('')
  // 听歌排行状态 —— 仅网易云
  const [rankType, setRankType] = useState<0 | 1>(0)
  const [rankItems, setRankItems] = useState<Song[]>([])
  const [rankLoading, setRankLoading] = useState(false)
  const [rankError, setRankError] = useState('')
  const [createdPlaylists, setCreatedPlaylists] = useState<Playlist[]>([])
  const [subscribedPlaylists, setSubscribedPlaylists] = useState<Playlist[]>([])
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false)
  const [showEditPlaylist, setShowEditPlaylist] = useState(false)
  const [showDeletePlaylist, setShowDeletePlaylist] = useState(false)
  const [operationLoading, setOperationLoading] = useState(false)
  const [playlistContextMenu, setPlaylistContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    playlist: Playlist | null
  }>({ show: false, x: 0, y: 0, playlist: null })
  const [recentSongContextMenu, setRecentSongContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    song: Song | null
    songs: Song[]
  }>({ show: false, x: 0, y: 0, song: null, songs: [] })
  const [managementPlaylist, setManagementPlaylist] = useState<Playlist | null>(null)

  // 查看他人模式导航栈：点关注/粉丝里的用户后 push 进入，返回箭头 pop 上一级
  interface ViewEntry {
    platform: 'netease' | 'qq'
    userId: string
    nickname?: string
    avatarUrl?: string
    signature?: string
    returnTab: ProfileTab // 返回时恢复的 tab（进入前的）
  }
  const [viewStack, setViewStack] = useState<ViewEntry[]>([])
  const viewTarget = viewStack.length > 0 ? viewStack[viewStack.length - 1] : null

  // 获取当前平台（查看他人时锁定为目标平台）
  const platform = viewTarget?.platform || currentPlatform
  // 活动用户 ID（查看他人时为目标用户，否则为自己）
  const activeUserId = viewTarget?.userId || userId
  // 查看他人时禁用歌单写操作与平台切换
  const isViewingOther = Boolean(viewTarget)
  
  // 根据主题色生成渐变色
  const generateGradientColors = (baseColor: string) => {
    // 将 hex 转换为 RGB
    const hexToRgb = (hex: string) => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
      return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      } : { r: 59, g: 130, b: 246 } // 默认蓝色
    }

    const rgb = hexToRgb(baseColor)
    
    // 生成三种渐变色：主色、暗色、更暗的色
    const color1 = `${rgb.r}, ${rgb.g}, ${rgb.b}`
    const color2 = `${Math.max(0, rgb.r - 40)}, ${Math.max(0, rgb.g - 40)}, ${Math.max(0, rgb.b - 40)}`
    const color3 = `${Math.max(0, rgb.r - 60)}, ${Math.max(0, rgb.g - 60)}, ${Math.max(0, rgb.b - 60)}`
    
    return { color1, color2, color3, rgb }
  }

  const { color1, color2, color3, rgb } = generateGradientColors(accentColor)
  
  // 性别显示
  const getGenderText = (gender?: number) => {
    if (gender === 1) return '男'
    if (gender === 2) return '女'
    return '保密'
  }
  
  // 格式化注册时间
  const formatCreateTime = (timestamp?: number) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    const years = new Date().getFullYear() - date.getFullYear()
    return `${date.getFullYear()}年${date.getMonth() + 1}月 (${years}年)`
  }

  const showPlaylistToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
  }

  const isPlaylistActionSuccessful = (result: any) => {
    return Boolean(result && !result.error && (
      result.code === undefined || result.code === 0 || result.code === 200 || result.result === 0 || result.result === 100
    ))
  }

  const refreshPlaylistLists = async (showFeedback = false) => {
    if (!userId) return
    setLoading(true)
    try {
      const playlists = await getUserPlaylists(platform, userId, undefined, { forceRefresh: true })
      const created = playlists.filter((playlist: Playlist) => (
        platform === 'qq'
          ? !playlist.isCollected
          : playlist.userId?.toString() === userId.toString()
      ))
      const subscribed = playlists.filter((playlist: Playlist) => (
        platform === 'qq'
          ? Boolean(playlist.isCollected)
          : playlist.userId?.toString() !== userId.toString()
      ))
      setCreatedPlaylists(created)
      setSubscribedPlaylists(subscribed)
      if (showFeedback) showPlaylistToast('歌单列表已刷新', 'success')
    } catch (error) {
      console.error('刷新个人歌单失败:', error)
      if (showFeedback) showPlaylistToast(error instanceof Error ? error.message : '刷新歌单失败，请重试', 'error')
    } finally {
      setLoading(false)
    }
  }

  const handlePlaylistContextMenu = (playlist: Playlist, event: React.MouseEvent) => {
    // 查看他人个人中心时禁用歌单管理（不操作对方歌单）
    if (viewTarget) return
    event.preventDefault()
    event.stopPropagation()
    setManagementPlaylist(playlist)
    setPlaylistContextMenu({ show: true, x: event.clientX, y: event.clientY, playlist })
  }

  const handleCreatePlaylist = async (name: string, privacy: 'public' | 'private', description?: string, coverDataUrl?: string) => {
    setOperationLoading(true)
    try {
      const result = await createPlaylist(name, platform, {
        privacy: privacy === 'private' ? '10' : '0',
        type: 'NORMAL',
        cookie
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '创建歌单失败')
      }
      const playlistId = result?.playlist?.id || result?.data?.playlist?.id || result?.id || result?.playlistId
      if (platform === 'netease' && description && playlistId) {
        const updateResult = await updatePlaylist(playlistId.toString(), 'netease', { name, desc: description, tags: '', cookie })
        if (!isPlaylistActionSuccessful(updateResult)) {
          throw new Error(updateResult?.error || updateResult?.message || '歌单描述保存失败')
        }
      }
      if (platform === 'netease' && coverDataUrl && playlistId) {
        const coverResult = await updatePlaylistCover(playlistId.toString(), coverDataUrl, 'netease', { cookie })
        if (!isPlaylistActionSuccessful(coverResult)) {
          throw new Error(coverResult?.error || coverResult?.message || '歌单封面上传失败')
        }
      }
      setShowCreatePlaylist(false)
      await refreshPlaylistLists()
      showPlaylistToast(
        platform === 'qq' && (description || coverDataUrl)
          ? 'QQ 歌单创建成功；描述和自定义封面不受当前接口支持'
          : '歌单创建成功',
        'success'
      )
    } catch (error) {
      console.error('创建歌单失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '创建歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  const handleEditPlaylist = async (data: { name: string; desc?: string; privacy?: string; coverDataUrl?: string }) => {
    if (!managementPlaylist || platform !== 'netease') return
    setOperationLoading(true)
    try {
      const tags = Array.isArray((managementPlaylist as any).tags)
        ? (managementPlaylist as any).tags.join(';')
        : ((managementPlaylist as any).tags || '')
      const result = await updatePlaylist(managementPlaylist.id.toString(), 'netease', {
        name: data.name,
        desc: data.desc,
        tags,
        cookie
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '编辑歌单失败')
      }
      if (data.coverDataUrl) {
        const coverResult = await updatePlaylistCover(managementPlaylist.id.toString(), data.coverDataUrl, 'netease', { cookie })
        if (!isPlaylistActionSuccessful(coverResult)) {
          throw new Error(coverResult?.error || coverResult?.message || '歌单封面上传失败')
        }
      }
      setShowEditPlaylist(false)
      await refreshPlaylistLists()
      showPlaylistToast('歌单信息已更新', 'success')
    } catch (error) {
      console.error('编辑歌单失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '编辑歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  const handleDeletePlaylist = async () => {
    if (!managementPlaylist) return
    setOperationLoading(true)
    try {
      const deleteId = platform === 'qq' ? managementPlaylist.dirId || managementPlaylist.id : managementPlaylist.id
      const result = await deletePlaylist(deleteId.toString(), platform, { cookie })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '删除歌单失败')
      }
      setShowDeletePlaylist(false)
      setManagementPlaylist(null)
      setShowPlaylistDetail(false)
      await refreshPlaylistLists()
      showPlaylistToast('歌单已删除', 'success')
    } catch (error) {
      console.error('删除歌单失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '删除歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  const handleSubscribePlaylist = async (playlist: Playlist, subscribe: boolean) => {
    setOperationLoading(true)
    try {
      const result = await subscribePlaylist(playlist.id.toString(), subscribe, platform, { cookie })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || (subscribe ? '收藏歌单失败' : '取消收藏失败'))
      }
      setPlaylistContextMenu({ show: false, x: 0, y: 0, playlist: null })
      await refreshPlaylistLists()
      showPlaylistToast(subscribe ? '已收藏歌单' : '已取消收藏', 'success')
    } catch (error) {
      console.error('收藏歌单失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '歌单收藏操作失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  const handleSharePlaylist = async (playlist: Playlist) => {
    const url = platform === 'qq'
      ? `https://y.qq.com/n/ryqq/playlist/${playlist.id}`
      : `https://music.163.com/#/playlist?id=${playlist.id}`
    try {
      if (navigator.share) {
        await navigator.share({ title: playlist.name, url })
      } else {
        await navigator.clipboard.writeText(url)
        showPlaylistToast('歌单链接已复制', 'success')
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') showPlaylistToast('分享失败，请重试', 'error')
    }
  }

  const handlePlayPlaylist = async (playlist: Playlist, event: React.MouseEvent) => {
    event.stopPropagation()
    try {
      const response = await fetch(
        platform === 'qq'
          ? `http://localhost:3001/api/qq/playlist/detail?id=${encodeURIComponent(playlist.id)}&cookie=${encodeURIComponent(cookie)}`
          : `http://localhost:3001/api/netease/playlist/detail?id=${encodeURIComponent(playlist.id)}&cookie=${encodeURIComponent(cookie)}`
      )
      const data = await response.json()
      if (!response.ok || data.error) throw new Error(data.error || '读取歌单失败')
      const tracks = platform === 'qq'
        ? data.songlist || data.data?.songlist || []
        : data.playlist?.tracks || []
      const songs: Song[] = tracks.map((track: any) => platform === 'qq' ? ({
        id: track.songid || track.id,
        mid: track.songmid || track.mid,
        name: track.songname || track.name,
        artists: track.singer || [],
        album: {
          name: track.albumname || track.album?.name || '',
          picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
        },
        duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
        platform: 'qq'
      }) : ({
        id: track.id,
        name: track.name,
        artists: track.ar || track.artists || [],
        album: track.al || track.album || {},
        duration: track.dt || track.duration || 0,
        platform: 'netease',
        vip: track.vip || false,
        fee: track.fee || 0
      }))
      if (songs.length > 0) handleSongSelection(songs[0], songs)
      else showPlaylistToast('歌单中暂无可播放歌曲', 'info')
    } catch (error) {
      console.error('播放歌单失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '播放歌单失败，请重试', 'error')
    }
  }

  const handleRemoveFromPlaylist = async (song: Song, playlistId: string) => {
    if (
      !managementPlaylist ||
      managementPlaylist.isLike ||
      managementPlaylist.isCollected ||
      managementPlaylist.userId?.toString() !== userId.toString()
    ) return
    setOperationLoading(true)
    try {
      const result = await removeSongFromPlaylist(playlistId, song.id.toString(), userId, platform, {
        songMid: song.mid,
        songType: song.songType,
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '从歌单移除歌曲失败')
      }
      setPlaylistSongs(previous => previous.filter(item => !(
        item.id === song.id && item.platform === song.platform
      )))
      const updateTrackCount = (playlist: Playlist | null) => playlist ? {
        ...playlist,
        trackCount: Math.max(0, Number(playlist.trackCount || 0) - 1)
      } : playlist
      setSelectedPlaylist((previous: Playlist | null) => updateTrackCount(previous))
      setManagementPlaylist(previous => updateTrackCount(previous))
      await refreshPlaylistLists()
      showPlaylistToast('已从歌单移除歌曲', 'success')
    } catch (error) {
      console.error('从歌单移除歌曲失败:', error)
      showPlaylistToast(error instanceof Error ? error.message : '从歌单移除歌曲失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  const handleRemoveFromLikedPlaylist = async (song: Song) => {
    if (!managementPlaylist?.isLike || !onRemoveFromFavorites) return
    const removed = await onRemoveFromFavorites(song)
    if (!removed) return

    setPlaylistSongs(previous => previous.filter(item => !(
      item.id === song.id && item.platform === song.platform
    )))
    const updateTrackCount = (playlist: Playlist | null) => playlist ? {
      ...playlist,
      trackCount: Math.max(0, Number(playlist.trackCount || 0) - 1)
    } : playlist
    setSelectedPlaylist((previous: Playlist | null) => updateTrackCount(previous))
    setManagementPlaylist(previous => updateTrackCount(previous))
    await refreshPlaylistLists()
  }
  // 歌单详情面板状态
  const [showPlaylistDetail, setShowPlaylistDetail] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] = useState<any>(null)
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([])
  const [loadingPlaylistSongs, setLoadingPlaylistSongs] = useState(false)

  const handleSongSelection = (song: Song, songs?: Song[]) => {
    setShowPlaylistDetail(false)
    setPlaylistContextMenu({ show: false, x: 0, y: 0, playlist: null })
    onClose()
    onSongSelect(song, songs)
  }

  // 点击歌单，获取歌单详情并显示面板
  const handlePlaylistClick = async (playlist: any) => {
    setManagementPlaylist(playlist)
    setSelectedPlaylist(playlist)
    setShowPlaylistDetail(true)
    setLoadingPlaylistSongs(true)
    setPlaylistSongs([])
    
    try {
      let response, data
      
      if (platform === 'netease') {
        response = await fetch(`http://localhost:3001/api/netease/playlist/detail?id=${encodeURIComponent(playlist.id)}&cookie=${encodeURIComponent(cookie)}`)
        data = await response.json()
        if (!response.ok || data.error) throw new Error(data.error || '读取网易云歌单失败')
        if (data.playlist) {
          const detailedPlaylist = { ...playlist, ...data.playlist, platform: 'netease' }
          setSelectedPlaylist(detailedPlaylist)
          setManagementPlaylist(detailedPlaylist)
        }
        
        if (data.playlist && data.playlist.tracks) {
          const songs: Song[] = data.playlist.tracks.map((track: any) => ({
            id: track.id,
            name: track.name,
            artists: track.ar || track.artists || [],
            album: track.al || track.album || {},
            duration: track.dt || track.duration || 0,
            platform: 'netease'
          }))
          
          setPlaylistSongs(songs)
        }
      } else if (platform === 'qq') {
        console.log('📤 正在获取QQ音乐歌单详情，ID:', playlist.id)
        response = await fetch(`http://localhost:3001/api/qq/playlist/detail?id=${playlist.id}&cookie=${encodeURIComponent(cookie)}`)
        data = await response.json()
        
        console.log('📥 QQ音乐歌单详情:', data)
        if (data.playlist) {
          const keepCustomLikeAppearance = Boolean(playlist.isLike)
          const detailedPlaylist = {
            ...playlist,
            ...data.playlist,
            name: keepCustomLikeAppearance ? playlist.name : (data.playlist.name || playlist.name),
            coverImgUrl: keepCustomLikeAppearance ? playlist.coverImgUrl : (data.playlist.coverImgUrl || playlist.coverImgUrl),
            dirId: playlist.dirId,
            userId: playlist.userId,
            isLike: playlist.isLike,
            isCollected: playlist.isCollected,
            platform: 'qq' as const
          }
          setSelectedPlaylist(detailedPlaylist)
          setManagementPlaylist(detailedPlaylist)
        }
        
        // QQ音乐歌单详情直接返回songlist字段
        if (data.songlist && Array.isArray(data.songlist)) {
          const songs: Song[] = data.songlist.map((track: any) => ({
            id: track.songid || track.id,
            mid: track.songmid || track.mid,
            name: track.songname || track.name,
            artists: track.singer || [],
            album: {
              name: track.albumname || track.album?.name || '',
              picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
            },
            duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
            platform: 'qq'
          }))
          
          console.log('✅ 解析到', songs.length, '首歌曲')
          setPlaylistSongs(songs)
        } else if (data.data && data.data.songlist) {
          // 备用：检查是否在data.songlist里
          const songs: Song[] = data.data.songlist.map((track: any) => ({
            id: track.songid || track.id,
            mid: track.songmid || track.mid,
            name: track.songname || track.name,
            artists: track.singer || [],
            album: {
              name: track.albumname || track.album?.name || '',
              picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
            },
            duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
            platform: 'qq'
          }))
          
          console.log('✅ 解析到', songs.length, '首歌曲')
          setPlaylistSongs(songs)
        } else {
          console.warn('⚠️ 未找到songlist字段')
        }
      }
    } catch (error) {
      console.error('❌ 获取歌单详情失败:', error)
    } finally {
      setLoadingPlaylistSongs(false)
    }
  }

  const toImageUrl = (value: unknown) => typeof value === 'string' ? value : ''

  const normalizeRecentSong = (raw: any): Song | null => {
    const source = raw?.resource || raw?.data || raw?.song || raw
    const id = Number(source?.id ?? source?.songId ?? source?.song?.id ?? raw?.song?.id ?? raw?.resourceId)
    if (!Number.isFinite(id)) return null
    const songSource = source?.song || source?.data || raw?.song || raw?.data || source
    const artists = songSource?.ar || songSource?.artists || songSource?.singer || []
    const album = songSource?.al || songSource?.album || {}
    return {
      id,
      name: songSource?.name || songSource?.songName || '未知歌曲',
      artists: Array.isArray(artists) ? artists.map((artist: any) => ({ id: artist.id, name: artist.name || artist.n || '未知歌手', mid: artist.mid })) : [],
      album: { id: album.id, name: album.name || '未知专辑', picUrl: toImageUrl(album.picUrl || album.picurl || album.blurPicUrl || album.coverUrl || songSource?.coverUrl), mid: album.mid, pmid: album.pmid },
      duration: Number(songSource?.dt || songSource?.duration || 0),
      platform: 'netease',
      vip: songSource?.privilege?.st === -200 || Boolean(songSource?.fee === 1),
      fee: songSource?.fee
    }
  }

  const getRecentRows = (payload: any): any[] => {
    const candidates = [
      payload?.data?.list,
      payload?.data?.records,
      payload?.data?.songs,
      payload?.data,
      payload?.list,
      payload?.records,
      payload?.songs,
      payload?.weekData,
      payload?.allData,
    ]
    return candidates.find(Array.isArray) || []
  }

  const normalizeRecentItems = (payload: any, type: RecentPlaybackType): RecentPlaybackItem[] => {
    const rows = getRecentRows(payload)
    return rows.map((row: any, index: number) => {
      const resource = row?.resource || row?.data || row
      const id = String(row?.resourceId ?? resource?.id ?? resource?.djId ?? resource?.programId ?? index)
      const artistsSource = resource?.ar || resource?.artists || resource?.singer || []
      const artistNames = Array.isArray(artistsSource) ? artistsSource.map((artist: any) => artist?.name || artist?.title || artist?.singerName).filter(Boolean).join(' / ') : ''
      const coverUrl = toImageUrl(resource?.coverImgUrl || resource?.picUrl || resource?.blurPicUrl || resource?.coverUrl || resource?.al?.picUrl || resource?.album?.picUrl || resource?.creator?.avatarUrl)
      const trackCount = Number(resource?.trackCount ?? resource?.trackNumber ?? resource?.trackNum ?? resource?.size ?? 0) || (Array.isArray(resource?.tracks) ? resource.tracks.length : 0) || (Array.isArray(resource?.trackIds) ? resource.trackIds.length : 0)
      if (type === 'song') {
        const song = normalizeRecentSong(row)
        return { id, type, name: song?.name || resource?.name || '未知歌曲', subtitle: song ? song.artists.map(artist => artist.name).join(' / ') : artistNames, coverUrl: song?.album.picUrl || coverUrl, playTime: Number(row?.playTime || row?.playTimeStamp || 0), song: song || undefined }
      }
      if (type === 'playlist') {
        const playlist: Playlist = { id, name: resource?.name || '未知歌单', coverImgUrl: coverUrl, trackCount, playCount: Number(resource?.playCount || 0), platform: 'netease', creator: resource?.creator ? { nickname: resource.creator.nickname || '未知用户', userId: resource.creator.userId, avatarUrl: resource.creator.avatarUrl } : undefined }
        return { id, type, name: playlist.name, subtitle: playlist.trackCount > 0 ? `${playlist.trackCount} 首歌曲` : '歌曲数暂未返回', coverUrl, playTime: Number(row?.playTime || 0), playlist }
      }
      if (type === 'album') {
        const albumId = String(resource?.id ?? row?.resourceId ?? '')
        return { id, type, name: resource?.name || '未知专辑', subtitle: artistNames || resource?.artist?.name || '网易云音乐专辑', coverUrl, playTime: Number(row?.playTime || 0), albumId }
      }
      return { id, type, name: resource?.name || (type === 'dj' ? '未知电台' : '未知声音'), subtitle: resource?.dj?.nickname || resource?.radio?.name || '网易云音乐', coverUrl, playTime: Number(row?.playTime || 0) }
    }).filter((item: RecentPlaybackItem) => item.name !== '未知歌曲' || item.type !== 'song')
  }

  const normalizeQQRecentItems = (payload: any): RecentPlaybackItem[] => {
    const rows = Array.isArray(payload?.records)
      ? payload.records
      : (Array.isArray(payload?.songlist) ? payload.songlist.map((song: Song) => ({ song })) : [])
    return rows.map((row: any, index: number) => {
      const song = row?.song || row
      const id = String(song?.mid || song?.id || index)
      const artists = Array.isArray(song?.artists) ? song.artists : (Array.isArray(song?.singer) ? song.singer : [])
      return {
        id,
        type: 'song' as const,
        name: song?.name || '未知歌曲',
        subtitle: artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ') || 'QQ 音乐',
        coverUrl: toImageUrl(song?.album?.picUrl || song?.albumpic || song?.picUrl),
        playTime: Number(row?.playTime || 0),
        song: { ...song, platform: 'qq' as const }
      }
    }).filter((item: RecentPlaybackItem) => item.name !== '未知歌曲')
  }

  const fetchRecentPlayback = async (type: RecentPlaybackType = recentType) => {
    recentRequestRef.current.controller?.abort()
    const controller = new AbortController()
    const revision = recentRequestRef.current.revision + 1
    recentRequestRef.current = { revision, controller }
    const requestPlatform = currentPlatform
    const requestCookie = cookie
    setRecentLoading(true)
    setRecentError('')
    setRecentItems([])
    try {
      const requestType = requestPlatform === 'qq' ? 'song' : type
      const endpoint = requestPlatform === 'qq'
        ? 'http://localhost:3001/api/qq/record/recent/song'
        : `http://localhost:3001/api/netease/record/recent/${requestType}`
      const query = new URLSearchParams({ limit: '100', cookie: requestCookie })
      const response = await fetch(`${endpoint}?${query.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const payload = await response.json()
      if (recentRequestRef.current.revision !== revision) return
      const successfulCode = requestPlatform === 'qq' ? (!payload?.code || payload.code === 0) : (!payload?.code || payload.code === 200)
      if (!response.ok || payload?.error || !successfulCode) throw new Error(payload?.error || payload?.msg || '最近播放加载失败')
      const normalizedItems = requestPlatform === 'qq'
        ? normalizeQQRecentItems(payload)
        : normalizeRecentItems(payload, requestType)
      setRecentItems(normalizedItems)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || recentRequestRef.current.revision !== revision) return
      setRecentItems([])
      setRecentError(error instanceof Error ? error.message : '最近播放加载失败，请重试')
    } finally {
      if (recentRequestRef.current.revision === revision) {
        recentRequestRef.current.controller = null
        setRecentLoading(false)
      }
    }
  }

  const formatRecentTime = (value?: number) => {
    if (!value) return ''
    const timestamp = value < 1e12 ? value * 1000 : value
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  useEffect(() => {
    if (activeTab === 'recent') void fetchRecentPlayback(platform === 'qq' ? 'song' : recentType)
    return () => recentRequestRef.current.controller?.abort()
  }, [activeTab, recentType, currentPlatform, cookie])
  useEffect(() => {
    fetchUserData()
    // 查看他人或切换用户时清空社交/排行数据
    if (viewTarget) {
      setSocialItems([])
      setQqSocialItems([])
      setRankItems([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, activeUserId, viewTarget])

  // 社交（关注/粉丝）数据获取 —— 网易云（查看他人时展示对方关注/粉丝）
  useEffect(() => {
    if (activeTab !== 'social' || platform !== 'netease') return
    let cancelled = false
    setSocialLoading(true)
    setSocialError('')
    const task = socialType === 'follows'
      ? getUserFollows(activeUserId, { cookie })
      : getUserFolloweds(activeUserId, { cookie })
    task.then((data) => {
      if (cancelled) return
      const raw = socialType === 'follows' ? data?.follow : data?.followeds
      setSocialItems(Array.isArray(raw) ? raw.map((u: any) => ({
        userId: String(u.userId || u.id || ''),
        nickname: u.nickname || '未知用户',
        avatarUrl: u.avatarUrl || '',
        signature: u.signature || '',
        // 关注列表都是已关注；粉丝列表看 mutual（是否互关）
        isFollow: socialType === 'follows' ? true : Boolean(u.mutual),
      })) : [])
      setSocialLoading(false)
    }).catch(() => {
      if (cancelled) return
      setSocialError('获取失败，请确认已登录网易云')
      setSocialLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, socialType, platform, activeUserId, cookie])

  // QQ 关注用户/粉丝列表数据获取（查看他人时用 RelationList HostUin=EncUin）
  useEffect(() => {
    if (activeTab !== 'social' || platform !== 'qq') return
    let cancelled = false
    setQqSocialLoading(true)
    setQqSocialError('')
    const task = viewTarget
      ? getQQUserProfile(activeUserId).then((data) => ({
          data: { list: qqSocialType === 'follows' ? data?.data?.follows : data?.data?.fans },
        }))
      : (qqSocialType === 'follows' ? getQQFollows({ cookie }) : getQQFans({ cookie }))
    task.then((data) => {
      if (cancelled) return
      const list = data?.data?.list || []
      setQqSocialItems(Array.isArray(list) ? list.map((u: any) => ({
        encUin: u.EncUin || u.encUin || '',
        mid: u.MID || u.mid || '',
        name: u.Name || u.name || '未知用户',
        desc: u.Desc || u.desc || '',
        avatarUrl: u.AvatarUrl || u.avatarUrl || '',
        isFollow: Boolean(u.IsFollow || u.isFollow),
        isSelf: Boolean(u.OtherInfo?.IsSelf || u.isSelf),
      })) : [])
      setQqSocialLoading(false)
    }).catch(() => {
      if (cancelled) return
      setQqSocialError('获取失败，请确认 QQ 登录态有效')
      setQqSocialLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, qqSocialType, platform, activeUserId, viewTarget, cookie])

  // 打开用户个人中心（push 进导航栈，进入后默认看歌单概览）
  const openUserProfile = (targetPlatform: 'netease' | 'qq', targetUserId: string, nickname?: string, avatarUrl?: string, signature?: string) => {
    setViewStack(prev => [...prev, { platform: targetPlatform, userId: targetUserId, nickname, avatarUrl, signature, returnTab: activeTab }])
    setActiveTab('created')
  }

  // QQ 他人“我喜欢”数据获取（music.favor_system_read/get_favor_list_byid）
  useEffect(() => {
    if (activeTab !== 'favs' || platform !== 'qq' || !viewTarget) return
    let cancelled = false
    setQqFavLoading(true)
    getQQUserFavs(activeUserId, 1).then((data) => {
      if (cancelled) return
      setQqFavItems(Array.isArray(data?.data?.list) ? data.data.list : [])
      setQqFavLoading(false)
    }).catch(() => {
      if (cancelled) return
      setQqFavItems([])
      setQqFavLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, platform, activeUserId, viewTarget, cookie])

  // 收藏的专辑 / 关注的歌手（仅自己的个人中心；QQ 用 RelationList/collect）
  useEffect(() => {
    if (activeTab !== 'collections' || viewTarget) return
    let cancelled = false
    setCollectionsLoading(true)
    const task = platform === 'netease'
      ? Promise.all([getSubscribedAlbums('netease', { cookie }), getSubscribedArtists('netease', { cookie }), getNeteaseMvSublist({ cookie })])
      : Promise.all([getQQSubscribedAlbums({ cookie }), getQQSubscribedArtists({ cookie })])
    void task.then(([albumsData, artistsData, mvsData]) => {
      if (cancelled) return
      setCollectedAlbums(Array.isArray(albumsData?.data?.list) ? albumsData.data.list : Array.isArray(albumsData?.data) ? albumsData.data : [])
      setCollectedArtists(Array.isArray(artistsData?.data?.list) ? artistsData.data.list : Array.isArray(artistsData?.data) ? artistsData.data : [])
      if (platform === 'netease') setCollectedMvs(Array.isArray(mvsData) ? mvsData : [])
      setCollectionsLoading(false)
    }).catch(() => {
      if (cancelled) return
      setCollectionsLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, platform, viewTarget, cookie])

  // 返回箭头：pop 上一级，恢复进入前的 tab
  const popView = () => {
    setViewStack(prev => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      const next = prev.slice(0, -1)
      setActiveTab(last.returnTab || 'created')
      return next
    })
  }

  // 小字/点外部：清空栈，回到自己的个人中心（粉丝界面）
  const clearView = () => {
    setViewStack([])
    setActiveTab('social')
  }

  // 听歌排行数据获取 —— 仅网易云（需要登录，只能查自己）
  useEffect(() => {
    if (activeTab !== 'rank' || currentPlatform !== 'netease') return
    if (viewTarget) {
      setRankItems([])
      return
    }
    let cancelled = false
    setRankLoading(true)
    setRankError('')
    getUserRecordRank(userId, rankType, { cookie }).then((data) => {
      if (cancelled) return
      const raw = rankType === 1 ? data?.weekData : data?.allData
      setRankItems(Array.isArray(raw) ? raw.map((item: any) => {
        // 兼容扁平结构 {id,name,ar,al} 与嵌套结构 {song:{...}}（部分网易云接口版本返回嵌套）
        const track = (item && typeof item === 'object' && item.song && typeof item.song === 'object')
          ? item.song
          : item
        const arList = Array.isArray(track.ar) ? track.ar
          : Array.isArray(track.artists) ? track.artists
          : Array.isArray(item.ar) ? item.ar
          : Array.isArray(item.artists) ? item.artists
          : []
        const albumInfo = track.al || item.al
        return {
          id: track.id ?? item.id,
          name: track.name || item.name || '',
          artists: arList.map((a: any) => ({ name: a.name || a.title || '' })),
          album: albumInfo ? { name: albumInfo.name, picUrl: albumInfo.picUrl || albumInfo.pic || '' } : undefined,
          duration: track.dt || item.dt || 0,
          playCount: track.playCount ?? item.playCount ?? 0,
          platform: 'netease'
        } as Song
      }) : [])
      setRankLoading(false)
    }).catch(() => {
      if (cancelled) return
      setRankError('获取听歌排行失败，请确认已登录网易云')
      setRankLoading(false)
    })
    return () => { cancelled = true }
  }, [activeTab, rankType, currentPlatform, userId, cookie])

  // 同步initialPlatform的变化
  useEffect(() => {
    setCurrentPlatform(initialPlatform)
    // 平台切换瞬间内部 state currentPlatform 还是旧值，而 userId/cookie 已是新平台——
    // 直接以 prop 平台拉取，避免用「旧平台 state + 新平台 userId」的错误组合导致歌单为空
    fetchUserData(initialPlatform)
  }, [initialPlatform])

  useEffect(() => {
    const handlePlaylistContentChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        platform?: 'netease' | 'qq'
        type?: string
        coverImgUrl?: string
        trackCountDelta?: number
      }>).detail
      if (!detail || detail.platform !== currentPlatform || detail.type !== 'like') return

      setCreatedPlaylists(previous => previous.map(playlist => playlist.isLike
        ? {
            ...playlist,
            coverImgUrl: detail.coverImgUrl || playlist.coverImgUrl,
            trackCount: Math.max(0, Number(playlist.trackCount || 0) + Number(detail.trackCountDelta || 0))
          }
        : playlist
      ))
    }

    window.addEventListener('playlist-content-changed', handlePlaylistContentChanged)
    return () => window.removeEventListener('playlist-content-changed', handlePlaylistContentChanged)
  }, [currentPlatform])

  // 切换平台（查看他人时锁定目标平台，禁止切换）
  const handlePlatformSwitch = () => {
    if (viewTarget) return
    recentRequestRef.current.controller?.abort()
    recentRequestRef.current.revision += 1
    setRecentItems([])
    setRecentError('')
    setRecentLoading(activeTab === 'recent')
    setRecentSongContextMenu({ show: false, x: 0, y: 0, song: null, songs: [] })
    handleSwitchPlatform()  // 调用父组件的回调
  }

  const fetchUserData = async (targetPlatform?: 'netease' | 'qq') => {
    setLoading(true)
    const platform = targetPlatform || (viewTarget?.platform || currentPlatform)
    const uid = activeUserId

    if (platform === 'netease') {
      try {
        // 获取用户歌单（查看他人时展示对方的歌单/我喜欢）
        const playlistRes = await fetch(`http://localhost:3001/api/netease/user/playlist?uid=${uid}&cookie=${encodeURIComponent(cookie)}`)
        const playlistData = await playlistRes.json()
        
        if (playlistData.playlist) {
          const playlists: Playlist[] = playlistData.playlist.map((playlist: any) => ({
            ...playlist,
            id: playlist.id?.toString(),
            name: playlist.name || '未命名歌单',
            trackCount: Number(playlist.trackCount ?? playlist.trackNumber ?? 0),
            platform: 'netease',
            isLike: playlist.specialType === 5 || playlist.name === '我喜欢的音乐',
            isCollected: playlist.userId?.toString() !== uid.toString()
          }))
          const created = playlists.filter((playlist) => playlist.userId?.toString() === uid.toString())
          const subscribed = playlists.filter((playlist) => playlist.userId?.toString() !== uid.toString())
          setCreatedPlaylists(created)
          setSubscribedPlaylists(subscribed)
        }

        // 获取用户详情
        const detailRes = await fetch(`http://localhost:3001/api/netease/user/detail?uid=${uid}`)
        const detailData = await detailRes.json()
        
        if (detailData.profile) {
          setUserDetail({
            nickname: detailData.profile.nickname,
            avatarUrl: detailData.profile.avatarUrl,
            userId: detailData.profile.userId?.toString(),
            signature: detailData.profile.signature,
            vipType: detailData.profile.vipType,
            city: detailData.profile.city,
            birthday: detailData.profile.birthday,
            followeds: detailData.profile.followeds,
            follows: detailData.profile.follows,
            playlistCount: detailData.profile.playlistCount,
            level: detailData.level,
            // 网易云特有数据
            eventCount: detailData.profile.eventCount,
            newFollows: detailData.profile.newFollows,
            listenSongs: detailData.listenSongs,
            createTime: detailData.profile.createTime,
            gender: detailData.profile.gender,
            province: detailData.profile.province,
            backgroundUrl: detailData.profile.backgroundUrl
          })
        }
      } catch (error) {
        console.error('获取网易云用户数据失败:', error)
      }
    } else if (platform === 'qq') {
      // 查看他人（QQ）：EncUin 打码无法查歌单/详情，使用列表传入的资料
      if (viewTarget) {
        setUserDetail({
          nickname: viewTarget.nickname || '未知用户',
          avatarUrl: viewTarget.avatarUrl || '',
          userId: viewTarget.userId,
          signature: viewTarget.signature || '',
        })
        setCreatedPlaylists([])
        setSubscribedPlaylists([])
        setLoading(false)
        return
      }
      try {
        console.log('📤 正在获取QQ音乐用户数据...')
        
        // 获取用户详情（包含歌单）
        const detailRes = await fetch(`http://localhost:3001/api/qq/user/detail?id=${userId}&cookie=${encodeURIComponent(cookie)}`)
        const detailData = await detailRes.json()
        
        console.log('📥 QQ音乐用户详情:', detailData)
        console.log('📥 detailData.creator:', detailData.creator)
        console.log('📥 detailData.mydiss:', detailData.mydiss)

        // 用户详情只包含 mydiss（自建歌单）。收藏歌单必须通过
        // user/collect/songlist 单独读取，再按 isCollected 分栏。
        const qqDisplayName = getQQUserDisplayName(detailData, userId)
        const playlists = await getUserPlaylists('qq', userId, qqDisplayName)
        setCreatedPlaylists(playlists.filter((playlist: Playlist) => !playlist.isCollected))
        setSubscribedPlaylists(playlists.filter((playlist: Playlist) => Boolean(playlist.isCollected)))
        
        if (detailData.creator) {
          // 设置用户详情
          const isVip = detectQQMusicVip(detailData)
          
          setUserDetail({
            nickname: qqDisplayName,
            avatarUrl: detailData.creator.headpic || detailData.creator.avatarUrl || '',
            userId: userId,
            vipType: isVip ? 1 : 0,
            signature: '',
            playlistCount: detailData.mydiss?.num || 0,
            // QQ音乐特有数据
            visitornum: detailData.creator.nums?.visitornum,
            fansnum: detailData.creator.nums?.fansnum,
            follownum: detailData.creator.nums?.follownum,
            followusernum: detailData.creator.nums?.followusernum,
            followsingernum: detailData.creator.nums?.followsingernum,
            listenLevel: detailData.creator.listeninfo?.iconurl
          })
        } else {
          console.warn('⚠️ detailData.creator 不存在')
        }
      } catch (error) {
        console.error('❌ 获取QQ音乐用户数据失败:', error)
        setUserDetail({
          nickname: 'QQ音乐用户',
          avatarUrl: '',
          userId: userId
        })
      }
    }
    
    setLoading(false)
  }

  return (
    <div className="profile-overlay-root fixed inset-0 w-full h-full overflow-hidden z-50">
      {/* ???????????????????????? */}
      <div
        className="profile-glass-mask absolute inset-0 cursor-pointer"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
        onClick={() => (viewStack.length > 0 ? clearView() : onClose())}
      />

      {/* 内容区 */}
      <div className="relative z-10 w-full h-full flex items-center justify-center p-6" onClick={() => (viewStack.length > 0 ? clearView() : onClose())}>
                             <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.18 }}
          className="profile-glass-panel relative w-full h-full max-w-7xl max-h-[90vh] flex flex-col overflow-hidden rounded-[32px]"
          style={{
            willChange: 'transform, opacity',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            aria-hidden="true"
            className="profile-glass-panel-surface absolute inset-0 pointer-events-none rounded-[32px]"
          />
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-white/10">
            <div className="flex items-center gap-3">
              {viewTarget ? (
                <>
                  <button type="button" onClick={popView} className="p-2 -ml-2 hover:bg-white/10 rounded-full transition-colors" title="返回上一级" aria-label="返回">
                    <ArrowLeft className="w-5 h-5 text-white/70" />
                  </button>
                  <User className="w-6 h-6 text-white" />
                  <div>
                    <h2 className="text-xl font-bold text-white leading-tight truncate max-w-60">{viewTarget.nickname || '用户'} 的个人中心</h2>
                    {viewStack.length >= 2 && (
                      <button
                        type="button"
                        onClick={clearView}
                        className="text-[11px] text-white/40 hover:text-red-400 transition-colors"
                        title="回到我的个人中心粉丝界面"
                      >
                        点击返回个人中心
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <User className="w-6 h-6 text-white" />
                  <h2 className="text-2xl font-bold text-white">个人中心</h2>
                </>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              {activeTab !== 'detail' && !viewTarget && (
                <motion.button
                  whileHover={{ scale: 1.08, rotate: 30 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => refreshPlaylistLists(true)}
                  disabled={loading || operationLoading}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="刷新歌单"
                  aria-label="刷新歌单"
                >
                  <RefreshCw className={`w-5 h-5 text-white/70 ${loading ? 'animate-spin' : ''}`} />
                </motion.button>
              )}
              {currentPlatform === 'netease' && !viewTarget && (
                <motion.button
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => {
                    void neteaseDailySignin(1).then((result) => {
                      if (result?.code === 200 || result?.message?.includes('签到')) {
                        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '每日签到成功', type: 'success' } }))
                      } else {
                        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: result?.message || '今日已签到或签到失败', type: 'info' } }))
                      }
                    })
                  }}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                  title="每日签到"
                  aria-label="每日签到"
                >
                  <Calendar className="w-5 h-5 text-white/70" />
                </motion.button>
              )}
              {activeTab === 'created' && !viewTarget && (
                <motion.button
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
                  onClick={() => setShowCreatePlaylist(true)}
                  disabled={operationLoading}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors disabled:opacity-40"
                  title="创建歌单"
                  aria-label="创建歌单"
                >
                  <Plus className="w-5 h-5 text-white/70" />
                </motion.button>
              )}
              {/* 平台切换按钮 - 仅在两个平台都登录时显示 */}
              {canSwitchPlatform && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handlePlatformSwitch}
                  className={`px-4 py-2 rounded-full font-medium text-sm transition-all flex items-center gap-2 ${
                    platform === 'netease'
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-red-600 hover:bg-red-700 text-white'
                  }`}
                >
                  <RefreshCw className="w-4 h-4" />
                  切换到{platform === 'netease' ? 'QQ音乐' : '网易云'}
                </motion.button>
              )}
              
              {/* 关闭按钮 */}
              <motion.button
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X className="w-6 h-6 text-white/60" />
              </motion.button>
            </div>
          </div>

          {/* 标签栏 */}
          <div className="flex border-b border-white/10">
            <button
              onClick={() => setActiveTab('created')}
              className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'created'
                  ? 'text-white bg-white/10'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
              style={activeTab === 'created' ? {
                borderBottom: `2px solid ${accentColor}`,
              } : {}}
            >
              <List className="w-5 h-5" />
              {viewTarget && platform === 'qq' ? '创建的歌单' : `我创建的歌单 (${createdPlaylists.length})`}
            </button>
            <button
              onClick={() => setActiveTab('subscribed')}
              className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'subscribed'
                  ? 'text-white bg-white/10'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
              style={activeTab === 'subscribed' ? {
                borderBottom: `2px solid ${accentColor}`,
              } : {}}
            >
              <Heart className="w-5 h-5" />
              {viewTarget && platform === 'qq' ? '收藏的歌单' : `收藏的歌单 (${subscribedPlaylists.length})`}
            </button>
            {!viewTarget && (
            <button
              onClick={() => setActiveTab('recent')}
              className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'recent' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
              style={activeTab === 'recent' ? { borderBottom: `2px solid ${accentColor}` } : {}}
            >
              <History className="w-5 h-5" />
              最近播放
            </button>
            )}
            {currentPlatform === 'netease' && (
              <button
                onClick={() => setActiveTab('social')}
                className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === 'social' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
                style={activeTab === 'social' ? { borderBottom: `2px solid ${accentColor}` } : {}}
              >
                <Users className="w-5 h-5" />
                关注/粉丝
              </button>
            )}
            {currentPlatform === 'qq' && (
              <button
                onClick={() => setActiveTab('social')}
                className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === 'social' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
                style={activeTab === 'social' ? { borderBottom: `2px solid ${accentColor}` } : {}}
              >
                <Users className="w-5 h-5" />
                关注/粉丝
              </button>
            )}
            {viewTarget && platform === 'qq' && (
              <button
                onClick={() => setActiveTab('favs')}
                className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === 'favs' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
                style={activeTab === 'favs' ? { borderBottom: `2px solid ${accentColor}` } : {}}
              >
                <Heart className="w-5 h-5" />
                我喜欢
              </button>
            )}
            {!viewTarget && (
              <button
                onClick={() => setActiveTab('collections')}
                className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === 'collections' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
                style={activeTab === 'collections' ? { borderBottom: `2px solid ${accentColor}` } : {}}
              >
                <Disc3 className="w-5 h-5" />
                收藏
              </button>
            )}
            {currentPlatform === 'netease' && !viewTarget && (
              <button
                onClick={() => setActiveTab('rank')}
                className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                  activeTab === 'rank' ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/5'
                }`}
                style={activeTab === 'rank' ? { borderBottom: `2px solid ${accentColor}` } : {}}
              >
                <TrendingUp className="w-5 h-5" />
                听歌排行
              </button>
            )}
            <button
              onClick={() => setActiveTab('detail')}
              className={`relative flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'detail'
                  ? 'text-white bg-white/10'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
              style={activeTab === 'detail' ? {
                borderBottom: `2px solid ${accentColor}`,
              } : {}}
            >
              <User className="w-5 h-5" />
              用户信息
            </button>
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-hidden rounded-b-[24px]">
            <div
              className="overflow-y-auto pr-2"
              style={{
                height: '100%',
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent'
              }}
            >
              <div className="p-6">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-white/60">加载中...</div>
              </div>
            ) : (
              <>
                {/* 我创建的歌单 */}
                {activeTab === 'created' && viewTarget && platform === 'qq' && (
                  <div className="py-14 text-center">
                    <p className="text-white/45 text-sm">QQ 音乐平台限制，无法获取他人的歌单数据</p>
                    <p className="text-white/30 text-xs mt-2">可在 QQ 音乐网页版查看对方的歌单</p>
                  </div>
                )}
                {activeTab === 'created' && !(viewTarget && platform === 'qq') && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {createdPlaylists.map((playlist, index) => (
                      <motion.div
                        key={`created-${playlist.id || index}`}
                        whileHover={{ scale: 1.05 }}
                        onClick={() => handlePlaylistClick(playlist)}
                        onContextMenu={(event) => handlePlaylistContextMenu(playlist, event)}
                        className="relative rounded-xl p-4 cursor-pointer transition-all overflow-hidden group"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          backdropFilter: 'blur(10px)',
                          WebkitBackdropFilter: 'blur(10px)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                          e.currentTarget.style.borderColor = accentColor
                          e.currentTarget.style.boxShadow = `0 8px 25px ${accentColor}30`
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        {(
                          <div className="absolute top-6 right-6 z-20 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(event) => handlePlayPlaylist(playlist, event)}
                              className="p-2 rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors"
                              title="播放歌单"
                              aria-label="播放歌单"
                            >
                              <Play className="w-4 h-4" fill="currentColor" />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => handlePlaylistContextMenu(playlist, event)}
                              className="p-2 rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors"
                              title="歌单操作"
                              aria-label="歌单操作"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </div>
                        )}                        <div className="relative w-full aspect-square rounded-lg overflow-hidden mb-3 bg-white/10">
                          {playlist.coverImgUrl ? (
                            <CachedImage 
                              src={playlist.coverImgUrl} 
                              alt={playlist.name} 
                              className="w-full h-full object-cover"
                              fallback={
                                <div className="w-full h-full flex items-center justify-center">
                                  <Music className="w-8 h-8 text-white/20" />
                                </div>
                              }
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-8 h-8 text-white/20" />
                            </div>
                          )}
                          {platform === 'qq' && playlist.isLike && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                              <Heart
                                className="h-[42%] w-[42%] fill-white/75 text-white/75"
                                strokeWidth={0}
                                style={{ filter: 'drop-shadow(0 4px 14px rgba(0, 0, 0, 0.28)) blur(0.7px)' }}
                              />
                            </div>
                          )}
                        </div>
                        <div className="text-white text-sm font-medium truncate mb-1">{playlist.name}</div>
                        <div className="text-white/50 text-xs">{playlist.trackCount} 首歌曲</div>
                      </motion.div>
                    ))}
                  </div>
                )}

                {/* 收藏的歌单 */}
                {activeTab === 'subscribed' && viewTarget && platform === 'qq' && (
                  <div className="py-14 text-center">
                    <p className="text-white/45 text-sm">QQ 音乐平台限制，无法获取他人的歌单数据</p>
                    <p className="text-white/30 text-xs mt-2">可在 QQ 音乐网页版查看对方的歌单</p>
                  </div>
                )}
                {activeTab === 'subscribed' && !(viewTarget && platform === 'qq') && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {subscribedPlaylists.map((playlist, index) => (
                      <motion.div
                        key={`subscribed-${playlist.id || index}`}
                        whileHover={{ scale: 1.05 }}
                        onClick={() => handlePlaylistClick(playlist)}
                        onContextMenu={(event) => handlePlaylistContextMenu(playlist, event)}
                        className="relative rounded-xl p-4 cursor-pointer transition-all overflow-hidden group"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          backdropFilter: 'blur(10px)',
                          WebkitBackdropFilter: 'blur(10px)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                          e.currentTarget.style.borderColor = accentColor
                          e.currentTarget.style.boxShadow = `0 8px 25px ${accentColor}30`
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        {(
                          <div className="absolute top-6 right-6 z-20 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(event) => handlePlayPlaylist(playlist, event)}
                              className="p-2 rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors"
                              title="播放歌单"
                              aria-label="播放歌单"
                            >
                              <Play className="w-4 h-4" fill="currentColor" />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => handlePlaylistContextMenu(playlist, event)}
                              className="p-2 rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors"
                              title="歌单操作"
                              aria-label="歌单操作"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          </div>
                        )}                        <div className="w-full aspect-square rounded-lg overflow-hidden mb-3 bg-white/10">
                          {playlist.coverImgUrl ? (
                            <CachedImage 
                              src={playlist.coverImgUrl} 
                              alt={playlist.name} 
                              className="w-full h-full object-cover"
                              fallback={
                                <div className="w-full h-full flex items-center justify-center">
                                  <Music className="w-8 h-8 text-white/20" />
                                </div>
                              }
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-8 h-8 text-white/20" />
                            </div>
                          )}
                        </div>
                        <div className="text-white text-sm font-medium truncate mb-1">{playlist.name}</div>
                        <div className="text-white/50 text-xs">{playlist.trackCount} 首歌曲</div>
                        {playlist.creator && (
                          <div className="text-white/40 text-xs mt-1">by {playlist.creator.nickname}</div>
                        )}
                      </motion.div>
                    ))}
                  </div>
                )}

                {/* 用户详情 */}
                {/* 平台最近播放 */}
                {activeTab === 'recent' && (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xl font-semibold text-white">平台最近播放</h3>
                      </div>
                      <button onClick={() => void fetchRecentPlayback(platform === 'qq' ? 'song' : recentType)} className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white/80 text-sm flex items-center gap-2">
                        <RefreshCw className={`w-4 h-4 ${recentLoading ? 'animate-spin' : ''}`} /> 刷新
                      </button>
                    </div>
                    {platform === 'netease' ? (
                      <div className="flex flex-wrap gap-2">
                        {([['song', '歌曲', Music], ['playlist', '歌单', List], ['album', '专辑', Disc3], ['dj', '电台', Radio], ['voice', '声音', Mic2]] as const).map(([type, label, Icon]) => (
                          <button key={type} onClick={() => setRecentType(type)} className={`px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${recentType === type ? 'text-white' : 'text-white/55 hover:text-white bg-white/5'}`} style={recentType === type ? { background: `${accentColor}55`, border: `1px solid ${accentColor}99` } : {}}>
                            <Icon className="w-4 h-4" /> {label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {recentError && <div className="text-sm text-red-300 bg-red-400/10 border border-red-300/20 rounded-lg p-3">{recentError}</div>}
                    {recentLoading ? <div className="py-16 text-center text-white/55">正在读取平台最近播放…</div> : recentItems.length === 0 ? <div className="py-16 text-center text-white/45">暂无平台最近播放记录</div> : (
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {recentItems.map((item, index) => {
                          const songItems = recentItems.filter(entry => entry.type === 'song' && entry.song)
                          const canOpen = item.type === 'song' || item.type === 'playlist' || item.type === 'album'
                          return (
                            <motion.div
                              key={`${item.type}-${item.id}-${index}`}
                              whileHover={{ scale: 1.04, y: -3 }}
                              className={`relative rounded-xl p-3 overflow-hidden group transition-all ${canOpen ? 'cursor-pointer' : 'cursor-default'}`}
                              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                               onClick={() => {
                                 if (item.type === 'song' && item.song) handleSongSelection(item.song, songItems.map(entry => entry.song!))
                                 else if (item.type === 'playlist' && item.playlist) void handlePlaylistClick(item.playlist)
                                 else if (item.type === 'album' && item.albumId) onOpenAlbum?.(item.albumId, platform)
                               }}
                               onContextMenu={(event) => {
                                 if (item.type !== 'song' || !item.song) return
                                 event.preventDefault()
                                 event.stopPropagation()
                                 setRecentSongContextMenu({
                                   show: true,
                                   x: event.clientX,
                                   y: event.clientY,
                                   song: item.song,
                                   songs: songItems.map(entry => entry.song!),
                                 })
                               }}
                              onMouseEnter={(event) => {
                                event.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                                event.currentTarget.style.borderColor = accentColor
                                event.currentTarget.style.boxShadow = `0 8px 25px ${accentColor}30`
                              }}
                              onMouseLeave={(event) => {
                                event.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                                event.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                                event.currentTarget.style.boxShadow = 'none'
                              }}
                            >
                              <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-white/10 mb-3">
                                {item.coverUrl ? <CachedImage src={item.coverUrl} alt={item.name} className="w-full h-full object-cover" fallback={<div className="w-full h-full flex items-center justify-center"><Music className="w-8 h-8 text-white/20" /></div>} /> : <div className="w-full h-full flex items-center justify-center"><Music className="w-8 h-8 text-white/20" /></div>}
                                {item.type === 'song' && item.song && <button type="button" onClick={(event) => { event.stopPropagation(); handleSongSelection(item.song!, songItems.map(entry => entry.song!)) }} className="absolute bottom-2 right-2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg" aria-label="播放"><Play className="w-5 h-5" fill="currentColor" /></button>}
                                {item.type === 'playlist' && item.playlist && <button type="button" onClick={(event) => void handlePlayPlaylist(item.playlist!, event)} className="absolute bottom-2 right-2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg" aria-label="播放歌单"><Play className="w-5 h-5" fill="currentColor" /></button>}
                              </div>
                              <div className="text-white text-sm font-medium truncate mb-1" title={item.name}>{item.name}</div>
                              <div className="text-white/50 text-xs truncate">{item.subtitle || (platform === 'qq' ? 'QQ 音乐' : '网易云音乐')}</div>
                              {item.playTime ? <div className="text-white/35 text-[11px] mt-2 truncate">{formatRecentTime(item.playTime)}</div> : null}
                            </motion.div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}                {activeTab === 'social' && platform === 'netease' && (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-xl font-semibold text-white">社交关系</h3>
                      <div className="flex rounded-lg bg-white/5 p-0.5">
                        <button onClick={() => setSocialType('follows')} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${socialType === 'follows' ? 'text-white' : 'text-white/55 hover:text-white'}`} style={socialType === 'follows' ? { background: `${accentColor}55` } : {}}>关注</button>
                        <button onClick={() => setSocialType('followeds')} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${socialType === 'followeds' ? 'text-white' : 'text-white/55 hover:text-white'}`} style={socialType === 'followeds' ? { background: `${accentColor}55` } : {}}>粉丝</button>
                      </div>
                    </div>
                    {socialError && <div className="text-sm text-red-300 bg-red-400/10 border border-red-300/20 rounded-lg p-3">{socialError}</div>}
                    {socialLoading ? <div className="py-16 text-center text-white/55">正在加载{socialType === 'follows' ? '关注' : '粉丝'}列表…</div>
                      : socialItems.length === 0 ? <div className="py-16 text-center text-white/45">暂无{socialType === 'follows' ? '关注' : '粉丝'}</div>
                      : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                          {socialItems.map((u, index) => (
                            <div
                              key={`${u.userId}-${index}`}
                              className="rounded-xl p-4 transition-all cursor-pointer"
                              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                              onClick={() => { if (u.userId) openUserProfile('netease', u.userId, u.nickname, u.avatarUrl, u.signature) }}
                              title="点击查看用户主页"
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-white/10">
                                  {u.avatarUrl ? <img src={u.avatarUrl} alt={u.nickname} className="w-full h-full object-cover" /> : <User className="w-6 h-6 m-auto mt-3 text-white/30" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-white text-sm font-medium truncate">{u.nickname}</p>
                                  <p className="text-white/40 text-xs truncate mt-0.5">{u.signature || '这个人很懒，什么都没写'}</p>
                                </div>
                                {/* 关注/回关/取关（网易云） */}
                                {u.userId && (
                                  <button
                                    type="button"
                                    className={`shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors ${u.isFollow ? 'text-white/50 hover:text-white/80' : 'text-white'}`}
                                    style={u.isFollow ? { background: 'rgba(255,255,255,0.1)' } : { background: `${accentColor}55`, border: `1px solid ${accentColor}88` }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      const next = !u.isFollow
                                      setSocialItems(prev => prev.map(item =>
                                        item.userId === u.userId ? { ...item, isFollow: next } : item
                                      ))
                                      void subscribeNeteaseUser(u.userId, next).then((result) => {
                                        if (!(result?.code === 200 || result?.result === 100)) {
                                          setSocialItems(prev => prev.map(item =>
                                            item.userId === u.userId ? { ...item, isFollow: u.isFollow } : item
                                          ))
                                        }
                                      })
                                    }}
                                  >
                                    {u.isFollow ? '已关注' : (socialType === 'followeds' ? '回关' : '关注')}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {activeTab === 'social' && platform === 'qq' && (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-xl font-semibold text-white">社交关系</h3>
                      <div className="flex rounded-lg bg-white/5 p-0.5">
                        <button onClick={() => setQqSocialType('follows')} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${qqSocialType === 'follows' ? 'text-white' : 'text-white/55 hover:text-white'}`} style={qqSocialType === 'follows' ? { background: `${accentColor}55` } : {}}>关注</button>
                        <button onClick={() => setQqSocialType('fans')} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${qqSocialType === 'fans' ? 'text-white' : 'text-white/55 hover:text-white'}`} style={qqSocialType === 'fans' ? { background: `${accentColor}55` } : {}}>粉丝</button>
                      </div>
                    </div>
                    {qqSocialError && <div className="text-sm text-red-300 bg-red-400/10 border border-red-300/20 rounded-lg p-3">{qqSocialError}</div>}
                    {qqSocialLoading ? <div className="py-16 text-center text-white/55">正在加载{qqSocialType === 'follows' ? '关注' : '粉丝'}列表…</div>
                      : qqSocialItems.length === 0 ? <div className="py-16 text-center text-white/45">暂无{qqSocialType === 'follows' ? '关注' : '粉丝'}</div>
                      : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                          {qqSocialItems.map((u, index) => (
                            <div
                              key={`${u.encUin || u.mid}-${index}`}
                              className="rounded-xl p-4 transition-all cursor-pointer"
                              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                              onClick={() => {
                                // 关注列表里有歌手的 mid → 应用内打开歌手详情
                                if (u.mid) {
                                  if (onOpenArtist) onOpenArtist(u.mid, 'qq')
                                  else if (u.encUin) openUserProfile('qq', u.encUin, u.name, u.avatarUrl)
                                } else if (u.encUin) {
                                  openUserProfile('qq', u.encUin, u.name, u.avatarUrl)
                                }
                              }}
                              title={u.mid ? '点击打开歌手详情' : '点击查看用户主页'}
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-white/10">
                                  {u.avatarUrl ? <img src={u.avatarUrl} alt={u.name} className="w-full h-full object-cover" /> : <Users className="w-6 h-6 m-auto mt-3 text-white/30" />}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-white text-sm font-medium truncate">{u.name}</p>
                                  <p className="text-white/40 text-xs truncate mt-0.5">{u.desc || (u.mid ? '歌手' : '这个人很懒，什么都没写')}</p>
                                </div>
                                {/* 关注/回关按钮（仅用户；自己不显示；歌手关注走歌手详情内） */}
                                {!u.mid && !u.isSelf && u.encUin && (
                                  <button
                                    type="button"
                                    className={`shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors ${u.isFollow ? 'text-white/50 hover:text-white/80' : 'text-white'}`}
                                    style={u.isFollow ? { background: 'rgba(255,255,255,0.1)' } : { background: `${accentColor}55`, border: `1px solid ${accentColor}88` }}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      const next = !u.isFollow
                                      // 乐观更新，失败时回滚
                                      setQqSocialItems(prev => prev.map(item =>
                                        item.encUin === u.encUin ? { ...item, isFollow: next } : item
                                      ))
                                      void subscribeQQUser(u.encUin, next).then((result) => {
                                        if (!(result?.result === 100 || result?.code === 200)) {
                                          setQqSocialItems(prev => prev.map(item =>
                                            item.encUin === u.encUin ? { ...item, isFollow: u.isFollow } : item
                                          ))
                                        }
                                      })
                                    }}
                                  >
                                    {/* 粉丝 tab 里未关注的是“回关”（对方已关注我）；关注 tab 里都是“已关注”；已关注再点取关 */}
                                    {u.isFollow ? '已关注' : (qqSocialType === 'fans' ? '回关' : '关注')}
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {activeTab === 'favs' && viewTarget && platform === 'qq' && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Heart className="w-4 h-4 text-white/60" />
                      <h3 className="text-sm font-medium text-white/80">我喜欢（{qqFavItems.length}）</h3>
                    </div>
                    {qqFavLoading ? <div className="py-12 text-center text-white/45 text-sm">加载中...</div>
                      : qqFavItems.length === 0 ? <div className="py-12 text-center text-white/45 text-sm">暂无我喜欢数据</div>
                      : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                          {qqFavItems.map((item, index) => (
                            <div key={`${item.id || index}-${index}`} className="rounded-xl p-2.5 transition-all" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
                              <div className="relative w-full aspect-square rounded-lg overflow-hidden mb-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                {item.logo ? <img src={item.logo} alt={item.title || ''} className="w-full h-full object-cover" /> : <Music className="w-8 h-8 m-auto text-white/20" />}
                              </div>
                              <p className="text-white/90 text-xs font-medium truncate">{item.title || item.name || '未知'}</p>
                              <p className="text-white/40 text-[11px] truncate mt-0.5">
                                {Array.isArray(item.vec_singer) ? item.vec_singer.map((s: any) => s.name).join(' / ') : ''}
                                {item.song_num ? ` · ${item.song_num} 首` : ''}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {activeTab === 'collections' && !viewTarget && (
                  <div className="space-y-6">
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Disc3 className="w-4 h-4 text-white/60" />
                        <h3 className="text-sm font-medium text-white/80">收藏的专辑（{collectedAlbums.length}）</h3>
                      </div>
                      {collectionsLoading ? <div className="py-10 text-center text-white/45 text-sm">加载中...</div>
                        : collectedAlbums.length === 0 ? <div className="py-10 text-center text-white/45 text-sm">暂无收藏专辑</div>
                        : (
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                            {collectedAlbums.map((album, index) => {
                              const albumId = album.id || album.albumid || album.albumId
                              const albumName = album.name || album.albumname || '未知专辑'
                              const cover = album.picUrl || album.pic || ''
                              const singerName = album.artist?.name || album.singername || ''
                              return (
                                <div key={`${albumId || index}-${index}`} className="rounded-xl p-2.5 transition-all cursor-pointer" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                                  onClick={() => { if (albumId && onOpenAlbum) onOpenAlbum(String(albumId), platform) }} title="点击打开专辑">
                                  <div className="relative w-full aspect-square rounded-lg overflow-hidden mb-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                    {cover ? <img src={cover} alt={albumName} className="w-full h-full object-cover" /> : <Music className="w-8 h-8 m-auto text-white/20" />}
                                  </div>
                                  <p className="text-white/90 text-xs font-medium truncate">{albumName}</p>
                                  <p className="text-white/40 text-[11px] truncate mt-0.5">{singerName}</p>
                                </div>
                              )
                            })}
                          </div>
                        )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <Music className="w-4 h-4 text-white/60" />
                        <h3 className="text-sm font-medium text-white/80">关注的歌手（{collectedArtists.length}）</h3>
                      </div>
                      {collectedArtists.length === 0 ? <div className="py-10 text-center text-white/45 text-sm">暂无关注歌手</div>
                        : (
                          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                            {collectedArtists.map((artist, index) => {
                              const artistId = artist.id || artist.singerid || artist.mid
                              const artistName = artist.name || artist.singername || '未知歌手'
                              const cover = artist.picUrl || artist.pic || artist.singerpic || ''
                              return (
                                <div key={`${artistId || index}-${index}`} className="rounded-xl p-4 transition-all cursor-pointer flex items-center gap-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                                  onClick={() => { if (artistId && onOpenArtist) onOpenArtist(String(artistId), platform) }} title="点击打开歌手">
                                  <div className="w-12 h-12 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }}>
                                    {cover ? <img src={cover} alt={artistName} className="w-full h-full object-cover" /> : <Music className="w-6 h-6 m-auto mt-3 text-white/30" />}
                                  </div>
                                  <p className="text-white/90 text-xs font-medium truncate">{artistName}</p>
                                </div>
                              )
                            })}
                          </div>
                        )}
                    </div>
                    {platform === 'netease' && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <Film className="w-4 h-4 text-white/60" />
                          <h3 className="text-sm font-medium text-white/80">收藏的 MV（{collectedMvs.length}）</h3>
                        </div>
                        {collectedMvs.length === 0 ? <div className="py-10 text-center text-white/45 text-sm">暂无收藏 MV</div>
                          : (
                            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                              {collectedMvs.map((mv, index) => {
                                const mvName = mv.name || mv.title || '未知 MV'
                                const cover = mv.cover || mv.picUrl || mv.imgurl16v9 || ''
                                return (
                                  <div key={`${mv.id || index}-${index}`} className="rounded-xl p-2.5 transition-all cursor-pointer" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                                    onClick={() => { if (mv.id) window.dispatchEvent(new CustomEvent('play-mv', { detail: { id: mv.id, name: mvName, platform: 'netease' } })) }} title="点击播放 MV">
                                    <div className="relative w-full aspect-video rounded-lg overflow-hidden mb-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                      {cover ? <img src={cover} alt={mvName} className="w-full h-full object-cover" /> : <Film className="w-8 h-8 m-auto text-white/20" />}
                                    </div>
                                    <p className="text-white/90 text-xs font-medium truncate">{mvName}</p>
                                    <p className="text-white/40 text-[11px] truncate mt-0.5">{mv.artistName || mv.artist?.name || ''}</p>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                )}
                {activeTab === 'rank' && currentPlatform === 'netease' && (
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="text-xl font-semibold text-white">听歌排行</h3>
                      <div className="flex rounded-lg bg-white/5 p-0.5">
                        <button onClick={() => setRankType(0)} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${rankType === 0 ? 'text-white' : 'text-white/55 hover:text-white'}`} style={rankType === 0 ? { background: `${accentColor}55` } : {}}>所有时间</button>
                        <button onClick={() => setRankType(1)} className={`px-3 py-1.5 rounded-md text-sm transition-colors ${rankType === 1 ? 'text-white' : 'text-white/55 hover:text-white'}`} style={rankType === 1 ? { background: `${accentColor}55` } : {}}>最近一周</button>
                      </div>
                    </div>
                    {rankError && <div className="text-sm text-red-300 bg-red-400/10 border border-red-300/20 rounded-lg p-3">{rankError}</div>}
                    {rankLoading ? <div className="py-16 text-center text-white/55">正在加载听歌排行…</div>
                      : rankItems.length === 0 ? <div className="py-16 text-center text-white/45">暂无听歌记录</div>
                      : (
                        <div className="space-y-1">
                          {rankItems.map((song, index) => (
                            <div
                              key={`${song.id}-${index}`}
                              className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/5 transition-colors group cursor-pointer"
                              onClick={() => handleSongSelection(song, rankItems)}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setRecentSongContextMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: rankItems })
                              }}
                            >
                              <span className={`w-8 text-center text-sm font-semibold shrink-0 ${index < 3 ? '' : 'text-white/40'}`} style={index < 3 ? { color: accentColor } : {}}>{index + 1}</span>
                              <div className="w-11 h-11 rounded-lg overflow-hidden shrink-0 bg-white/10">
                                {song.album?.picUrl ? <CachedImage src={song.album.picUrl} alt={song.name} className="w-full h-full object-cover" fallback={<div className="w-full h-full flex items-center justify-center"><Music className="w-5 h-5 text-white/20" /></div>} /> : <div className="w-full h-full flex items-center justify-center"><Music className="w-5 h-5 text-white/20" /></div>}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-white text-sm font-medium truncate">{song.name}</p>
                                <p className="text-white/45 text-xs truncate">{(song.artists || []).map(a => a.name).join(' / ') || '未知歌手'}</p>
                              </div>
                              {song.playCount ? (
                                <span className="text-white/40 text-[11px] shrink-0 mr-1">{formatCount(song.playCount)} 次</span>
                              ) : null}
                              <button type="button" onClick={(event) => { event.stopPropagation(); handleSongSelection(song, rankItems) }} className="p-2 rounded-full bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg" aria-label="播放">
                                <Play className="w-4 h-4" fill="currentColor" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                  </div>
                )}
                {activeTab === 'detail' && userDetail && (
                  <div className="max-w-2xl mx-auto">
                    <div className="flex flex-col items-center mb-8">
                      {/* 大头像 */}
                      <div className="w-32 h-32 rounded-full overflow-hidden mb-4 border-4 border-white/20">
                        {userDetail.avatarUrl ? (
                          <img src={userDetail.avatarUrl} alt={userDetail.nickname} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-white/10 flex items-center justify-center">
                            <User className="w-16 h-16 text-white/20" />
                          </div>
                        )}
                      </div>
                      
                      {/* 昵称和VIP */}
                      <div className="flex items-center gap-2 mb-2">
                        {userDetail.vipType !== undefined && userDetail.vipType > 0 && (
                          <Crown className="w-6 h-6 text-yellow-400" />
                        )}
                        <h3 className={`text-3xl font-bold ${userDetail.vipType && userDetail.vipType > 0 ? 'text-yellow-400' : 'text-white'}`}>
                          {userDetail.nickname}
                        </h3>
                      </div>

                      {/* 个性签名 */}
                      {userDetail.signature && (
                        <p className="text-white/60 text-center mb-4">{userDetail.signature}</p>
                      )}
                    </div>

                    {/* 详细信息卡片 */}
                    <div className="bg-white/5 rounded-xl p-6 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white/5 rounded-lg p-4">
                          <div className="text-white/50 text-sm mb-1">用户ID</div>
                          <div className="text-white font-medium">{userDetail.userId}</div>
                        </div>

                        {userDetail.level !== undefined && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">等级</div>
                            <div className="text-white font-medium">Lv.{userDetail.level}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：听歌等级 */}
                        {userDetail.listenLevel && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">听歌等级</div>
                            <img src={userDetail.listenLevel} alt="听歌等级" className="h-6" />
                          </div>
                        )}

                        {/* 网易云：粉丝数 */}
                        {userDetail.followeds !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">粉丝</div>
                            <div className="text-white font-medium">{userDetail.followeds.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：粉丝数 */}
                        {userDetail.fansnum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">粉丝</div>
                            <div className="text-white font-medium">{userDetail.fansnum.toLocaleString()}</div>
                          </div>
                        )}

                        {/* 网易云：关注数 */}
                        {userDetail.follows !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注</div>
                            <div className="text-white font-medium">{userDetail.follows.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：关注用户数 */}
                        {userDetail.followusernum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注用户</div>
                            <div className="text-white font-medium">{userDetail.followusernum.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：关注歌手数 */}
                        {userDetail.followsingernum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注歌手</div>
                            <div className="text-white font-medium">{userDetail.followsingernum.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：访客数 */}
                        {userDetail.visitornum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">访客</div>
                            <div className="text-white font-medium">{userDetail.visitornum.toLocaleString()}</div>
                          </div>
                        )}

                        {userDetail.playlistCount !== undefined && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">歌单数</div>
                            <div className="text-white font-medium">{userDetail.playlistCount}</div>
                          </div>
                        )}
                        
                        {/* 网易云：动态数 */}
                        {userDetail.eventCount !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">动态</div>
                            <div className="text-white font-medium">{userDetail.eventCount.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* 网易云：累计听歌 */}
                        {userDetail.listenSongs !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">累计听歌</div>
                            <div className="text-white font-medium">{userDetail.listenSongs.toLocaleString()} 首</div>
                          </div>
                        )}
                        
                        {/* 网易云：性别 */}
                        {userDetail.gender !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">性别</div>
                            <div className="text-white font-medium">{getGenderText(userDetail.gender)}</div>
                          </div>
                        )}
                        
                        {/* 网易云：注册时间 */}
                        {userDetail.createTime !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              注册时间
                            </div>
                            <div className="text-white font-medium">{formatCreateTime(userDetail.createTime)}</div>
                          </div>
                        )}

                        {userDetail.city && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              所在地
                            </div>
                            <div className="text-white font-medium">{userDetail.city}</div>
                          </div>
                        )}

                        {userDetail.birthday && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              生日
                            </div>
                            <div className="text-white font-medium">
                              {new Date(userDetail.birthday).toLocaleDateString('zh-CN')}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* 退出登录按钮 */}
                      <div className="mt-8">
                        <button
                          onClick={() => {
                            if (confirm(`确定要退出${platform === 'netease' ? '网易云音乐' : 'QQ音乐'}登录吗？`)) {
                              onLogout(platform)
                              onClose()
                            }
                          }}
                          className="relative w-full py-3 px-4 rounded-xl text-red-400 hover:text-red-300 font-medium transition-all flex items-center justify-center gap-2 overflow-hidden group"
                          style={{
                            background: 'rgba(239, 68, 68, 0.15)',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            boxShadow: '0 4px 15px rgba(239, 68, 68, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.25)'
                            e.currentTarget.style.boxShadow = '0 6px 25px rgba(239, 68, 68, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15)'
                            e.currentTarget.style.transform = 'translateY(-2px)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'
                            e.currentTarget.style.boxShadow = '0 4px 15px rgba(239, 68, 68, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)'
                            e.currentTarget.style.transform = 'translateY(0)'
                          }}
                        >
                          <LogOut className="w-5 h-5 relative z-10" />
                          <span className="relative z-10">退出登录</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* 歌单详情面板 */}
      <PlaylistDetailPanel
        show={showPlaylistDetail}
        playlist={selectedPlaylist}
        songs={playlistSongs}
        loading={loadingPlaylistSongs}
        onClose={() => setShowPlaylistDetail(false)}
        onSongSelect={handleSongSelection}
        neteaseVip={platform === 'netease' ? (userDetail?.vipType || 0) > 0 : false}
        qqVip={platform === 'qq' ? (userDetail?.vipType || 0) > 0 : false}
        currentPlatform={platform}
        currentSong={currentSong}
        playerTheme={playerTheme}
        accentColor={accentColor}
        userPlaylists={[...createdPlaylists, ...subscribedPlaylists]}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={
          managementPlaylist?.isLike && onRemoveFromFavorites
            ? handleRemoveFromLikedPlaylist
            : onRemoveFromFavorites
        }
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onCopyInfo={onCopyInfo}
        onRemoveFromPlaylist={
          managementPlaylist?.userId?.toString() === userId.toString() &&
          !managementPlaylist?.isLike &&
          !managementPlaylist?.isCollected
            ? handleRemoveFromPlaylist
            : undefined
        }
      />

      <PlaylistContextMenu
        show={playlistContextMenu.show}
        x={playlistContextMenu.x}
        y={playlistContextMenu.y}
        playlist={playlistContextMenu.playlist}
        onClose={() => setPlaylistContextMenu({ show: false, x: 0, y: 0, playlist: null })}
        onEdit={(playlist) => {
          setManagementPlaylist(playlist)
          setShowEditPlaylist(true)
        }}
        onDelete={(playlist) => {
          setManagementPlaylist(playlist)
          setShowDeletePlaylist(true)
        }}
        onSubscribe={handleSubscribePlaylist}
        onShare={handleSharePlaylist}
        isOwner={playlistContextMenu.playlist?.userId?.toString() === userId.toString()}
        isSubscribed={Boolean(playlistContextMenu.playlist?.isCollected || playlistContextMenu.playlist?.subscribed)}
        isSpecialPlaylist={Boolean(playlistContextMenu.playlist?.isLike)}
        canEdit={platform === 'netease'}
      />

      {recentSongContextMenu.song && (
        <SongContextMenu
          show={recentSongContextMenu.show}
          x={recentSongContextMenu.x}
          y={recentSongContextMenu.y}
          song={recentSongContextMenu.song}
          playerTheme={playerTheme}
          onClose={() => setRecentSongContextMenu(previous => ({ ...previous, show: false }))}
          onPlayNow={(song) => handleSongSelection(
            song,
            recentSongContextMenu.songs.length > 0 ? recentSongContextMenu.songs : [song],
          )}
          onPlayNext={onPlayNext}
          onAddToFavorites={onAddToFavorites}
          onRemoveFromFavorites={onRemoveFromFavorites ? (song) => { void onRemoveFromFavorites(song) } : undefined}
          onAddToPlaylist={onAddToPlaylist}
          onViewComments={onViewComments}
          onViewAlbum={onOpenAlbum ? (song) => {
            const songPlatform = (song.platform || platform) as 'netease' | 'qq'
            void resolveSongAlbumIdentifier(song, songPlatform).then(albumId => {
              if (albumId) onOpenAlbum(albumId, songPlatform)
            })
          } : undefined}
          onViewArtist={onOpenArtist ? (song) => {
            const songPlatform = (song.platform || platform) as 'netease' | 'qq'
            const artist = song.artists?.[0]
            const artistId = songPlatform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
            if (artistId) onOpenArtist(String(artistId), songPlatform)
          } : undefined}
          onCopyInfo={onCopyInfo}
          userPlaylists={[...createdPlaylists, ...subscribedPlaylists]}
          platform={(recentSongContextMenu.song.platform || platform) as 'netease' | 'qq'}
        />
      )}

      <CreatePlaylistModal
        show={showCreatePlaylist}
        onClose={() => setShowCreatePlaylist(false)}
        onSubmit={handleCreatePlaylist}
        loading={operationLoading}
      />

      <EditPlaylistModal
        show={showEditPlaylist}
        onClose={() => setShowEditPlaylist(false)}
        onSubmit={handleEditPlaylist}
        playlist={managementPlaylist}
        loading={operationLoading}
      />

      <DeletePlaylistModal
        show={showDeletePlaylist}
        onClose={() => setShowDeletePlaylist(false)}
        onConfirm={handleDeletePlaylist}
        playlistName={managementPlaylist?.name || ''}
        loading={operationLoading}
      />
    </div>
  )
}









// 网易云音乐 PC 客户端「播客」页复刻（传统模式中栏）。
//
// 官方 PC 播客页结构：上左「高分播客 | 最热播客」、上右「好书推荐 | 免费听书」两块编号封面卡面板，
// 中间一排分类 chips（排行榜 / 音乐播客 / 有声书 + 知识 / 二次元 / 明星专区 / 生活 / 更多∨），
// 下方「猜你喜欢」封面网格。
// 数据：面板与猜你喜欢来自播客主页 blockVOS 与播客无限流；chips 来自播客分类接口并按分类取电台。
// 播客电台在 WaveForge 内走歌单通道打开（电台详情由歌单页渲染），节目则直接播放。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { fetchNeteaseProgramSong } from '../neteaseExplore/api'
import {
  fetchNeteasePodcastCategories, fetchNeteasePodcastCategoryRadios, fetchNeteasePodcastHome,
  fetchNeteasePodcastInfinite, normalizeNeteasePodcastBlocks, normalizeNeteasePodcastHome,
  type NeteasePodcastCategory,
} from '../neteaseExplore/discover'
import {
  neteaseResourceArtwork, neteaseResourceKey, type NeteaseNativeBlock, type NeteaseNativeResource,
} from '../neteaseExplore/model'
import {
  PcCardGrid, PcCountBadge, PcCover, PcEmpty, PcNoticeBar, PcSectionTitle, PcTabs, pcTheme,
  type PcCardItem, type PcTabItem, type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  active?: boolean
  currentSongKey?: string
  currentSong?: Song | null
}

// 分类接口拿不到时的固定文案（与官方 PC 页一致）
const FALLBACK_CHIP_ROWS: Array<Array<{ id: string; label: string }>> = [
  [{ id: '', label: '排行榜' }, { id: '', label: '音乐播客' }, { id: '', label: '有声书' }],
  [{ id: '', label: '知识' }, { id: '', label: '二次元' }, { id: '', label: '明星专区' }, { id: '', label: '生活' }],
]

/** 面板封面卡：封面 + 序号 + 1~2 行标题（官方播客面板同款）。 */
function PodcastPanel({ theme, accent, tabs, value, onChange, resources, loading, expanded, onToggleExpand, onOpen }: {
  theme: PcTheme
  accent: string
  tabs: PcTabItem[]
  value: string
  onChange: (key: string) => void
  resources: NeteaseNativeResource[]
  loading: boolean
  expanded: boolean
  onToggleExpand: () => void
  onOpen: (resource: NeteaseNativeResource) => void
}) {
  const visible = expanded ? resources.slice(0, 14) : resources.slice(0, 7)
  return (
    <section className={`rounded-lg border p-4 ${theme.divider}`}>
      <div className="mb-4 flex items-end justify-between gap-3">
        <PcTabs items={tabs} value={value} onChange={onChange} accent={accent} theme={theme} />
        <button type="button" onClick={onToggleExpand} disabled={resources.length <= 7} className={`shrink-0 text-[12px] ${resources.length > 7 ? theme.subtle : 'opacity-0'}`}>
          {expanded ? '收起' : '查看全部'}
        </button>
      </div>
      {loading ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, index) => <span key={`panel-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
        </div>
      ) : visible.length > 0 ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-7">
          {visible.map((resource, index) => (
            <button
              key={`panel:${neteaseResourceKey(resource)}:${index}`}
              type="button"
              onClick={() => onOpen(resource)}
              onContextMenu={event => event.preventDefault()}
              className="group block text-left"
            >
              <PcCover
                src={neteaseResourceArtwork(resource)}
                alt={resource.title || '播客'}
                eager={index < 4}
                className="aspect-square w-full"
                rounded="rounded-lg"
                overlay={(
                  <>
                    <PcCountBadge value={resource.playCount} />
                    <span className="absolute bottom-2 right-2 flex h-7 w-7 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                      <Play className="h-3 w-3 fill-current" style={{ color: accent }} />
                    </span>
                  </>
                )}
              />
              <span className="mt-2 flex gap-1 text-[11px] leading-snug">
                <span className={`shrink-0 tabular-nums ${theme.faint}`}>{index + 1}</span>
                <span className={`line-clamp-2 ${theme.text}`}>{resource.title || '播客'}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className={`py-8 text-center text-[12px] ${theme.faint}`}>暂无内容</p>
      )}
    </section>
  )
}

function NeteasePcPodcast({ chrome, actions, active = true, authRevision = 0 }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent

  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [recommend, setRecommend] = useState<NeteaseNativeResource[]>([])
  const [recommendLoading, setRecommendLoading] = useState(true)
  const [categories, setCategories] = useState<NeteasePodcastCategory[]>([])
  const [categoryRadios, setCategoryRadios] = useState<NeteaseNativeResource[]>([])
  const [categoryLoading, setCategoryLoading] = useState(false)
  const [bookRadios, setBookRadios] = useState<NeteaseNativeResource[]>([])
  const [topTab, setTopTab] = useState('high')
  const [bookTab, setBookTab] = useState('book')
  const [topExpanded, setTopExpanded] = useState(false)
  const [bookExpanded, setBookExpanded] = useState(false)
  const [activeCategory, setActiveCategory] = useState<{ id: string; label: string } | null>(null)
  const [showAllChips, setShowAllChips] = useState(false)
  const [notice, setNotice] = useState('')

  // 播客主页（blockVOS：编辑精选 / 为你推荐 / 音乐播客榜 / 上新佳作 / 音乐大咖说 / 热门播客 / 分类 …）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setHomeLoading(true)
    fetchNeteasePodcastHome(controller.signal)
      .then(payload => { if (!controller.signal.aborted) setBlocks(normalizeNeteasePodcastHome(payload).blocks) })
      .catch(() => { if (!controller.signal.aborted) setBlocks([]) })
      .finally(() => { if (!controller.signal.aborted) setHomeLoading(false) })
    return () => controller.abort()
  }, [active, authRevision])

  // 播客无限流：既是「猜你喜欢」的数据源，也是两块面板的兜底
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setRecommendLoading(true)
    fetchNeteasePodcastInfinite('', true, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const list = normalizeNeteasePodcastBlocks(payload).flatMap(block => block.resources)
        const seen = new Set<string>()
        setRecommend(list.filter(resource => {
          const key = neteaseResourceKey(resource)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 24))
      })
      .catch(() => { if (!controller.signal.aborted) setRecommend([]) })
      .finally(() => { if (!controller.signal.aborted) setRecommendLoading(false) })
    return () => controller.abort()
  }, [active, authRevision])

  // 播客分类（chips 数据源）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchNeteasePodcastCategories(controller.signal)
      .then(list => { if (!controller.signal.aborted) setCategories(list) })
      .catch(() => { if (!controller.signal.aborted) setCategories([]) })
    return () => controller.abort()
  }, [active, authRevision])

  /** 按关键字选块：优先区块标题，其次区块 code。 */
  const blockResources = useCallback((pattern: RegExp): NeteaseNativeResource[] => {
    const block = blocks.find(item => pattern.test(`${item.title} ${item.blockCode} ${item.showType}`))
    return block?.resources || []
  }, [blocks])

  const highResources = useMemo(() => {
    const matched = blockResources(/编辑精选|精选|高分|口碑/)
    return matched.length > 0 ? matched : (recommend.length > 0 ? recommend : blocks[0]?.resources || [])
  }, [blockResources, blocks, recommend])

  const hotResources = useMemo(() => {
    const matched = blockResources(/热门播客|热门|最热|榜/)
    return matched.length > 0 ? matched : (recommend.length > 0 ? recommend : blocks[0]?.resources || [])
  }, [blockResources, blocks, recommend])

  // 好书推荐 / 免费听书：有声书类分类的电台（App 里听书就是 djradio），拿不到再退区块
  const bookCategories = useMemo(
    () => categories.filter(item => /有声书|听书|文学|儿童|亲子|故事|知识|人文/.test(item.name)),
    [categories],
  )

  useEffect(() => {
    if (!active || bookCategories.length === 0) return
    const controller = new AbortController()
    void (async () => {
      const picks = bookCategories.slice(0, 2)
      const results = await Promise.all(picks.map(item => fetchNeteasePodcastCategoryRadios(item.id, 0, 14, controller.signal).catch(() => [])))
      if (controller.signal.aborted) return
      setBookRadios(results.flat())
    })()
    return () => controller.abort()
  }, [active, bookCategories])

  const bookFallback = useMemo(() => blockResources(/有声书|佳作|上新|好书/), [blockResources])
  const bookList = bookRadios.length > 0 ? bookRadios : (bookFallback.length > 0 ? bookFallback : recommend)
  const freeList = bookRadios.length > 1 ? bookRadios.slice(Math.ceil(bookRadios.length / 2)) : (bookFallback.length > 0 ? bookFallback : recommend)

  // 选中的分类 chips：取该分类下的热门电台
  useEffect(() => {
    if (!active || !activeCategory?.id) { setCategoryRadios([]); return }
    const controller = new AbortController()
    setCategoryLoading(true)
    fetchNeteasePodcastCategoryRadios(activeCategory.id, 0, 24, controller.signal)
      .then(list => { if (!controller.signal.aborted) setCategoryRadios(list) })
      .catch(() => { if (!controller.signal.aborted) setCategoryRadios([]) })
      .finally(() => { if (!controller.signal.aborted) setCategoryLoading(false) })
    return () => controller.abort()
  }, [active, activeCategory])

  // 电台在 WaveForge 里走歌单通道打开；节目直接播放；两者都没有则提示，不静默失败
  const openResource = useCallback((resource: NeteaseNativeResource) => {
    setNotice('')
    if (resource.playlist?.id) {
      actions.onOpenPlaylist({ ...resource.playlist, coverUrl: resource.playlist.coverUrl || neteaseResourceArtwork(resource), source: 'netease-podcast' })
      return
    }
    if (resource.song?.id) { actions.onPlaySongs(resource.song, [resource.song], 0); return }
    const action = resource.action
    if (action.type === 'program') {
      void fetchNeteaseProgramSong(action.id)
        .then(song => { if (song) actions.onPlaySongs(song, [song], 0); else setNotice('该节目暂无法播放') })
        .catch(() => setNotice('该节目暂无法播放'))
      return
    }
    const radioId = action.type === 'radio' ? action.channel.id : resource.id
    if (radioId) {
      actions.onOpenPlaylist({
        id: String(radioId),
        name: resource.title || '播客',
        coverUrl: neteaseResourceArtwork(resource) || resource.coverUrl,
        description: resource.subtitle || undefined,
        playCount: resource.playCount,
        platform: 'netease',
        source: 'netease-podcast-radio',
      })
      return
    }
    setNotice(`${resource.title || '该内容'}暂不支持在 WaveForge 内打开`)
  }, [actions])

  const chipRows = useMemo(() => {
    if (categories.length === 0) return FALLBACK_CHIP_ROWS
    const all = categories.map(item => ({ id: item.id, label: item.name }))
    return [all.slice(0, 3), all.slice(3)]
  }, [categories])

  const secondRow = showAllChips ? chipRows[1] : chipRows[1].slice(0, 4)
  const hasMoreChips = chipRows[1].length > 4

  const gridResources = activeCategory ? categoryRadios : recommend
  const gridLoading = activeCategory ? categoryLoading : recommendLoading
  const cards: PcCardItem[] = useMemo(() => gridResources.map((resource, index) => ({
    key: `${neteaseResourceKey(resource)}:${index}`,
    coverUrl: neteaseResourceArtwork(resource),
    title: resource.title || '播客',
    subtitle: (resource.subtitle || '').trim().slice(0, 40) || undefined,
    playCount: resource.playCount,
    onClick: () => openResource(resource),
  })), [gridResources, openResource])

  const renderChips = (items: Array<{ id: string; label: string }>) => items.map(item => {
    const selected = Boolean(activeCategory) && activeCategory?.label === item.label
    return (
      <button
        key={`chip:${item.id || 'static'}:${item.label}`}
        type="button"
        onClick={() => {
          if (selected) { setActiveCategory(null); return }
          if (!item.id) { setNotice(`「${item.label}」分类暂不可用`); return }
          setActiveCategory({ id: item.id, label: item.label })
        }}
        className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${selected ? 'font-medium text-white' : theme.chipIdle}`}
        style={selected ? { background: accent } : undefined}
      >
        {item.label}
      </button>
    )
  })

  return (
    <div className="pb-6">
      {notice && <PcNoticeBar theme={theme} onClose={() => setNotice('')}>{notice}</PcNoticeBar>}

      {/* 上左：高分播客 / 最热播客　上右：好书推荐 / 免费听书 */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <PodcastPanel
          theme={theme}
          accent={accent}
          tabs={[{ key: 'high', label: '高分播客' }, { key: 'hot', label: '最热播客' }]}
          value={topTab}
          onChange={setTopTab}
          resources={topTab === 'high' ? highResources : hotResources}
          loading={homeLoading && recommendLoading}
          expanded={topExpanded}
          onToggleExpand={() => setTopExpanded(value => !value)}
          onOpen={openResource}
        />
        <PodcastPanel
          theme={theme}
          accent={accent}
          tabs={[{ key: 'book', label: '好书推荐' }, { key: 'free', label: '免费听书' }]}
          value={bookTab}
          onChange={setBookTab}
          resources={bookTab === 'book' ? bookList : freeList}
          loading={homeLoading && recommendLoading}
          expanded={bookExpanded}
          onToggleExpand={() => setBookExpanded(value => !value)}
          onOpen={openResource}
        />
      </div>

      {/* 分类 chips：两组 + 更多∨ */}
      <div className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center gap-2">{renderChips(chipRows[0])}</div>
        <div className="flex flex-wrap items-center gap-2">
          {renderChips(secondRow)}
          {(hasMoreChips || showAllChips) && (
            <button
              type="button"
              onClick={() => setShowAllChips(value => !value)}
              className={`flex items-center gap-0.5 rounded-full px-3 py-1.5 text-[13px] transition ${theme.chipIdle}`}
            >
              更多<ChevronDown className={`h-3.5 w-3.5 transition ${showAllChips ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* 猜你喜欢 / 选中分类的热门电台 */}
      <section>
        <PcSectionTitle title={activeCategory ? `「${activeCategory.label}」热门播客` : '猜你喜欢'} theme={theme} />
        {gridLoading ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={`grid-skeleton:${index}`}>
                <span className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />
                <span className={`mt-2 block h-3 w-3/4 animate-pulse rounded ${theme.surface}`} />
              </div>
            ))}
          </div>
        ) : cards.length > 0 ? (
          <PcCardGrid items={cards} theme={theme} accent={accent} columns={6} />
        ) : (
          <PcEmpty theme={theme} title={activeCategory ? '该分类暂无播客' : '暂无播客推荐'} description={activeCategory ? '换个分类试试' : undefined} />
        )}
      </section>
    </div>
  )
}

export default memo(NeteasePcPodcast)

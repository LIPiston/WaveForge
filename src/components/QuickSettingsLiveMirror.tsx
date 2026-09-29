import { useLayoutEffect, useRef } from 'react'

/**
 * 「播放设置」预览的**实时镜像**层 —— 预览不再另画一套抽象画面，而是把**真实播放面**
 * （`[data-waveforge-playback-page]`，即 App 里那个 `minimal-playback-surface`）克隆一份
 * 搬进预览框，并按帧同步内联样式、文本与 canvas 像素。预览因此**就是真机**：
 * 改设置、歌词滚动、频谱跳动、封面律动全部实时跟着变，永远不会和真机漂移。
 *
 * ## 为什么是「克隆 + 逐帧同步」而不是别的做法
 *
 * - **不能把真身搬进来**：真身是 React 管理的节点，reparent 会破坏 React 的 bookkeeping。
 * - **不能就地 transform 真身**：真身是 framer 的 `motion.div`，`style.transform` 归 framer 管，
 *   外部写会被下一次渲染覆盖；改 `#root` 的 transform 又会连带缩放整个 App。
 * - **不能留着真身在原地、只在预览处开个「洞」看过去**：那要给遮罩与面板都开 clip-path 洞，
 *   面板圆角会被顶掉，洞的位置还得随面板布局实时重算。
 *
 * 克隆 + 逐帧同步完全没有上述副作用：自包含、不碰全局布局、不碰 React 树。
 *
 * ## 同步机制（改这里之前务必读完）
 *
 * **绝对不能「每隔 N 毫秒整棵重建」**。重建会让克隆体里的 CSS 动画每次都从第 0 帧重来 ——
 * 封面律动、频谱条这类无限 keyframes 会看起来卡在起始帧，歌词的入场过渡也会被反复重播，
 * 比静态画面还难看。所以按**变更类型**分三档处理，只有真·结构变化才动 DOM：
 *
 * | 变更 | 来源 | 处理 |
 * |---|---|---|
 * | `attributes`（style / class） | 歌词 rAF 逐帧写 `el.style.color`、切 class | 只把内联 style / class 抄到配对节点 |
 * | `characterData` | **React 更新文本走的是 `node.nodeValue`**（时钟、歌名、倒计时） | 只抄 `nodeValue` |
 * | `childList` | 整块增删（歌词行切换、模式切换） | **只重建该元素的子节点**，其余子树原样保留 |
 *
 * 配对表 `pairs` 覆盖 `childNodes`（元素 + 文本节点），由 `pairTree()` 递归建立。
 * 逐帧代价是 O(变更节点数)，不是 O(整棵树)。
 *
 * ## 已知取舍
 *
 * - `<video>` / `<audio>` / `<iframe>` 会被**断源**：否则预览里会再拉一次流、甚至再出一路声音。
 *   代价是 MV / 视频模式在预览里是空白区（视频画面无法可靠地跨域复制）。
 * - 用 WebGL 且未开 `preserveDrawingBuffer` 的 canvas 复制不到像素（本项目
 *   `ModernAudioVisualizer` / `ModengPlayerPage` 都是 2d，正常可复制）。
 * - 克隆体打 `inert` + `aria-hidden`，宿主 `pointer-events: none`：预览是「看」的、不能点，
 *   也不能进可访问性树（否则会多出一个「播放设置」按钮，和无障碍/测试的角色查询打架）。
 * - 克隆体里会清掉几个**会「冒充真身」的标记与 id**（见 `STRIP_*`）：它们在别处是被
 *   `querySelector` / `getElementById` 当唯一实体用的，尤其 `data-waveforge-playback-page`
 *   留着的话镜像会认到自己的克隆体上。
 * - 缩放用 `min(盒宽/源宽, 盒高/源高)` **等比**，宁可有留边也不拉伸 —— 预览的比例必须与真机一致。
 *
 * 拿不到真实播放面时（jsdom 单测、home 页、Apple 电台/播客这类自带播放页的模式）
 * 上报 `onStatusChange('absent')`，由父级回退到内置的模拟场景。
 */
export type QuickSettingsMirrorStatus = 'live' | 'absent'

/** 真实播放面的根标记，写在 App.tsx 的 `minimal-playback-surface` 上。 */
const SOURCE_SELECTOR = '[data-waveforge-playback-page="true"]'

/** 克隆体里必须清掉的属性：别处按它们查「唯一实体」。 */
const STRIP_ATTRIBUTES = ['data-waveforge-playback-page', 'data-wf-upnext-card']

/** 克隆体里必须清掉的 id 前缀：`wf-` 是本项目锚点约定（墙纸/辉煌控件锚点）。 */
const STRIP_ID_PREFIX = 'wf-'

/** 每 N 帧做一次「源是否被换掉 / 尺寸是否变了」的低频巡检（约 4 次/秒）。 */
const SOURCE_POLL_FRAMES = 15

/** canvas 像素复制的分频：频谱条不需要 60fps，隔帧抄一次足够跟手。 */
const CANVAS_COPY_EVERY = 2

interface QuickSettingsLiveMirrorProps {
  /** 源播放面是否存在；'absent' 时父级应回退到内置模拟场景。 */
  onStatusChange: (status: QuickSettingsMirrorStatus) => void
}

export default function QuickSettingsLiveMirror({ onStatusChange }: QuickSettingsLiveMirrorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    const stage = stageRef.current
    if (!host || !stage) return

    let source: HTMLElement | null = null
    let cloneRoot: HTMLElement | null = null
    let frame = 0
    let disposed = false
    let status: QuickSettingsMirrorStatus | null = null
    let sourceW = 0
    let sourceH = 0
    let hostW = 0
    let hostH = 0

    /** 源节点 → 克隆节点（元素 + 文本节点）；逐帧同步靠它定位。 */
    const pairs = new Map<Node, Node>()
    const canvasPairs: Array<[HTMLCanvasElement, HTMLCanvasElement]> = []
    /** 内联 style / class 被改过的元素 */
    const dirtyAttrs = new Set<Element>()
    /** `childList` 变化过的元素：只重建它们的子节点 */
    const dirtyChildren = new Set<Element>()
    /** `characterData` 变化过的文本节点 */
    const dirtyText = new Set<CharacterData>()

    const report = (next: QuickSettingsMirrorStatus) => {
      if (status === next) return
      status = next
      onStatusChange(next)
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof Element) dirtyAttrs.add(record.target)
          continue
        }
        if (record.type === 'characterData') {
          if (record.target instanceof CharacterData) dirtyText.add(record.target)
          continue
        }
        if (record.target instanceof Element) dirtyChildren.add(record.target)
      }
    })

    /**
     * 递归消毒：清掉会冒充真身的标记与 id、停掉媒体元素。可作用于任意子树根
     * （首次建树与后续局部重建共用）。
     */
    const sanitizeNode = <T extends Node>(node: T): T => {
      if (node instanceof Element) {
        for (const attr of STRIP_ATTRIBUTES) node.removeAttribute(attr)
        if (node.id && node.id.startsWith(STRIP_ID_PREFIX)) node.removeAttribute('id')

        const tag = node.tagName
        if (tag === 'VIDEO' || tag === 'AUDIO') {
          const media = node as unknown as HTMLMediaElement
          media.pause()
          media.removeAttribute('src')
          media.removeAttribute('autoplay')
          for (const child of Array.from(node.querySelectorAll('source'))) child.remove()
        } else if (tag === 'IFRAME') {
          // 断源即可：空 iframe 是透明的，比留一个正在加载的第二个播放器好得多
          node.removeAttribute('src')
        }
        for (const child of Array.from(node.children)) sanitizeNode(child)
      }
      return node
    }

    /** 递归建立「源 → 克隆」配对表，顺带收集需要逐帧抄像素的 canvas 对。 */
    const pairTree = (srcNode: Node, dstNode: Node) => {
      pairs.set(srcNode, dstNode)
      if (srcNode instanceof HTMLCanvasElement && dstNode instanceof HTMLCanvasElement) {
        canvasPairs.push([srcNode, dstNode])
      }
      const srcChildren = srcNode.childNodes
      const dstChildren = dstNode.childNodes
      const count = Math.min(srcChildren.length, dstChildren.length)
      for (let index = 0; index < count; index += 1) {
        pairTree(srcChildren[index], dstChildren[index])
      }
    }

    const rebuildPairs = () => {
      pairs.clear()
      canvasPairs.length = 0
      if (source && cloneRoot) pairTree(source, cloneRoot)
    }

    /** 按预览框尺寸给舞台定标：**等比**缩放 + 居中（宁可有留边，也不拉伸变形）。 */
    const layout = () => {
      const nextHostW = host.clientWidth
      const nextHostH = host.clientHeight
      if (!nextHostW || !nextHostH || !sourceW || !sourceH) return
      hostW = nextHostW
      hostH = nextHostH
      const scale = Math.min(hostW / sourceW, hostH / sourceH)
      stage.style.transform = `translate(${(hostW - sourceW * scale) / 2}px, ${(hostH - sourceH * scale) / 2}px) scale(${scale})`
    }

    /** 整棵重建：只用于首次挂载、源被换掉、源尺寸变了以外的结构崩坏。 */
    const build = () => {
      observer.disconnect()
      dirtyAttrs.clear()
      dirtyChildren.clear()
      dirtyText.clear()
      pairs.clear()
      canvasPairs.length = 0
      stage.replaceChildren()

      const next = document.querySelector<HTMLElement>(SOURCE_SELECTOR)
      if (!next) {
        source = null
        cloneRoot = null
        // 清掉上一次定标留下的尺寸/位移，避免空舞台留下残留样式
        stage.style.width = ''
        stage.style.height = ''
        stage.style.transform = ''
        report('absent')
        return
      }
      source = next
      cloneRoot = null

      const root = sanitizeNode(next.cloneNode(true) as HTMLElement)
      root.setAttribute('inert', '')
      root.setAttribute('aria-hidden', 'true')
      // 真身的入场动画（framer 写的内联 transform/opacity/filter）可能停在半路，
      // 克隆体要停在静止态；后续帧的同步会再把它抄成真身当时的真实值。
      root.style.transform = 'none'
      root.style.opacity = '1'
      root.style.filter = 'none'

      sourceW = next.offsetWidth || window.innerWidth
      sourceH = next.offsetHeight || window.innerHeight
      stage.style.width = `${sourceW}px`
      stage.style.height = `${sourceH}px`
      stage.replaceChildren(root)
      cloneRoot = root
      pairTree(next, root)
      layout()

      observer.observe(next, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
      report('live')
    }

    /**
     * 只重建某个元素的子节点（`childList` 变化）。
     * **不整棵重建**是刻意的：整棵重建会把无关子树的 CSS 动画全部从头播一遍。
     */
    const resyncChildren = (srcElement: Element) => {
      const dstElement = pairs.get(srcElement)
      if (!(dstElement instanceof Element)) return false
      const rebuilt: Node[] = []
      for (const child of Array.from(srcElement.childNodes)) {
        rebuilt.push(sanitizeNode(child.cloneNode(true)))
      }
      dstElement.replaceChildren(...rebuilt)
      return true
    }

    /** 剔除被更外层元素覆盖的项：先处理最外层，避免拿着已被替换掉的旧节点去同步。 */
    const outermostOnly = (candidates: Set<Element>) => Array.from(candidates).filter((element) => {
      let parent = element.parentElement
      while (parent) {
        if (candidates.has(parent)) return false
        parent = parent.parentElement
      }
      return true
    })

    const syncDirty = () => {
      // ① 结构（先做：它会改变配对表）
      if (dirtyChildren.size > 0) {
        const targets = outermostOnly(dirtyChildren)
        dirtyChildren.clear()
        let intact = true
        for (const element of targets) {
          if (!resyncChildren(element)) intact = false
        }
        if (!intact) {
          build()
          return
        }
        rebuildPairs()
      }
      // ② 文本
      if (dirtyText.size > 0) {
        for (const srcText of dirtyText) {
          const dstText = pairs.get(srcText)
          if (dstText instanceof CharacterData && dstText.nodeValue !== srcText.nodeValue) {
            dstText.nodeValue = srcText.nodeValue
          }
        }
        dirtyText.clear()
      }
      // ③ 内联 style / class
      if (dirtyAttrs.size > 0) {
        for (const srcElement of dirtyAttrs) {
          const dstElement = pairs.get(srcElement)
          if (!(dstElement instanceof Element)) continue
          const style = srcElement.getAttribute('style')
          if (style !== dstElement.getAttribute('style')) {
            if (style === null) dstElement.removeAttribute('style')
            else dstElement.setAttribute('style', style)
          }
          const className = srcElement.getAttribute('class')
          if (className !== dstElement.getAttribute('class')) {
            if (className === null) dstElement.removeAttribute('class')
            else dstElement.setAttribute('class', className)
          }
        }
        dirtyAttrs.clear()
      }
    }

    /** canvas 像素复制：频谱条这类画在 canvas 上，DOM 克隆只能拿到空画布。 */
    const copyCanvases = () => {
      for (const [srcCanvas, dstCanvas] of canvasPairs) {
        if (!srcCanvas.isConnected || !dstCanvas.isConnected) continue
        if (srcCanvas.width !== dstCanvas.width) dstCanvas.width = srcCanvas.width
        if (srcCanvas.height !== dstCanvas.height) dstCanvas.height = srcCanvas.height
        const context = dstCanvas.getContext('2d')
        if (!context) continue
        try {
          context.clearRect(0, 0, dstCanvas.width, dstCanvas.height)
          context.drawImage(srcCanvas, 0, 0, dstCanvas.width, dstCanvas.height)
        } catch {
          // 画布被跨域资源污染等情况：跳过这一帧，不影响其余同步
        }
      }
    }

    let rafId = 0
    const schedule = () => {
      if (disposed) return
      rafId = requestAnimationFrame(tick)
    }

    const tick = () => {
      if (disposed) return
      frame += 1

      if (frame % SOURCE_POLL_FRAMES === 0) {
        const current = document.querySelector<HTMLElement>(SOURCE_SELECTOR)
        if (!current || current !== source) {
          build()
          schedule()
          return
        }
        if (current.offsetWidth !== sourceW || current.offsetHeight !== sourceH) {
          sourceW = current.offsetWidth
          sourceH = current.offsetHeight
          stage.style.width = `${sourceW}px`
          stage.style.height = `${sourceH}px`
          layout()
        }
        if (host.clientWidth !== hostW || host.clientHeight !== hostH) layout()
      }

      syncDirty()
      if (frame % CANVAS_COPY_EVERY === 0) copyCanvases()
      schedule()
    }

    build()
    schedule()

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layout())
    resizeObserver?.observe(host)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      observer.disconnect()
      resizeObserver?.disconnect()
      stage.replaceChildren()
      pairs.clear()
      canvasPairs.length = 0
    }
  }, [onStatusChange])

  return (
    <div
      ref={hostRef}
      data-wf-qs-mirror=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        ref={stageRef}
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', contain: 'layout paint' }}
      />
    </div>
  )
}

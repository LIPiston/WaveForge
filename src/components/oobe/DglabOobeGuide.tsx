/**
 * DG-LAB 连接引导（OOBE）—— 讲清楚「手机 App 怎么连上当前插件」。
 *
 * 用户提供的 6 张手机截图（1-6，外加一张「设置网格」附加图）按步骤框选动画展示：
 *   0 版本选择    DG-LAB 3.0 / 4.0（本期先做 3.0 动画）
 *   1 首页        框出底部「SOCKET 控制」入口
 *   2 连接中      等待主机连上 App
 *   3 SOCKET 页   框右上角齿轮「设置」→ 再框「输出设置」
 *   4 输出设置    框 A/B 上限 + 增加速率（1 建议）+ 用异色框出「连接服务器」
 *   5 二维码      实时生成 3.0 二维码，扫码成功→下一步；可跳过进主界面
 *   6 已连接      框出「服务器连接成功」提示，引导结束
 *
 * 形态（contained）：默认嵌在 DG-LAB 控制台弹窗内，铺满弹窗面板（与控制台弹窗同尺寸），
 * 因此不会另开一层全屏页；独立使用时（调试台）退化成同尺寸的居中弹窗。
 * 布局：左「手机截图 + 框选动画」/ 右「步骤内容 + 提示」，面板内部不出现滚动条。
 *
 * 设计：金黑配色对齐 DG-LAB 控制台；截图用 SVG 1:1 高亮层 + 框选脉冲/扫描光动画；
 * 二维码走真实插件链路（client.getQR），扫码成功检测用 useDGLabStatus().state==='bound'。
 */
import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Ban, Check, CircleAlert, CircleCheck, Gauge, Info, Lightbulb, PlugZap,
  QrCode, ScanLine, ShieldAlert, ShieldCheck, Smartphone, TriangleAlert, Wifi, X, Zap,
} from 'lucide-react'
import { useTvBack } from '../../tv/tvCore'
import { useDGLabStatus, getDGLabClient, saveDGLabSettings, type DGLabSettings } from '@/plugins/clients/DGLabClient'
import homeImg from '@/assets/oobe-dglab/app-home.webp'
import connectingImg from '@/assets/oobe-dglab/app-connecting.webp'
import socketPageImg from '@/assets/oobe-dglab/app-socket-page.webp'
import settingsGridImg from '@/assets/oobe-dglab/app-settings-grid.webp'
import configImg from '@/assets/oobe-dglab/app-socket-config.webp'
import remoteImg from '@/assets/oobe-dglab/app-remote-scan.webp'
import connectedImg from '@/assets/oobe-dglab/app-connected.webp'
import './dglabOobe.css'

const GOLD = '#FFE89C'
const GOLD_DEEP = '#d9bd6e'
const SCAN = '#22d3ee'
const SLIDER = '#fb923c'

/** 截图内高亮矩形（像素，基于源图 1206×2622，已用脚本逐张核对）。 */
const IMG_W = 1206
const IMG_H = 2622
const RECTS = {
  socketEntry: { x: 912, y: 2256, w: 264, h: 264 },
  connectingDialog: { x: 120, y: 1037, w: 966, h: 527 },
  settingsEntry: { x: 1066, y: 181, w: 100, h: 100 },
  // 功能菜单宫格第一行三格（源图竖直虚线边框 x=57/374、444/761、831/1148，每格 318 宽）
  controlledSettings: { x: 57, y: 1011, w: 318, h: 315 },
  capSliders: { x: 182, y: 1138, w: 844, h: 810 },
  connectServerBtn: { x: 180, y: 949, w: 846, h: 90 },
  scanCamera: { x: 662, y: 1359, w: 164, h: 142 },
  successToast: { x: 420, y: 2212, w: 367, h: 143 },
  // 连接成功后顶部的「0-200」强度上限卡片（左右各一，点按可唤出上限弹窗）
  capQuickA: { x: 152, y: 324, w: 328, h: 136 },
  capQuickB: { x: 727, y: 324, w: 328, h: 136 },
} as const

type StepKind = 'intro' | 'version' | 'mark' | 'qr' | 'done'
interface StepDef {
  kind: StepKind
  title: string
  /** 标题下的一句话导语 */
  lead: string
  /** 正文说明（前言步骤用卡片排版，不需要这句） */
  copy?: string
  img?: string
  /** 高亮框（mark 步骤用，渲染不同颜色） */
  marks?: { key: keyof typeof RECTS; color?: string }[]
  /** 底部提示（icon 决定色调；detail 为补充说明的第二段，弱化显示） */
  tip?: { icon: 'wifi' | 'bulb' | 'info'; text: string; detail?: string }
  /** 截图外的指引箭头（画在手机右侧空白处，坐标系见 .dglab-oobe-callout） */
  callout?: { path: string; head: string; label: { text: string; x: number; y: number } }
  /** 该步骤真实可点「下一步」的前置条件：'none' | 'scanned' */
  advanceWhen?: 'none' | 'scanned'
}

const STEPS: StepDef[] = [
  {
    kind: 'intro',
    title: '前言',
    lead: '使用前请阅读以下安全须知',
    tip: { icon: 'bulb', text: '稍后可在插件主界面调整强度上限、恢复适应时间等参数，请根据自身情况设置。' },
  },
  {
    kind: 'version',
    title: '选择 APP 版本',
    lead: '请选择手机中安装的版本',
    copy: '选择后将按对应版本进行演示，当前截图以 3.0 为准。',
    tip: { icon: 'wifi', text: '手机与电脑须处于同一局域网（同一 WiFi 或同一热点），否则扫码地址无法访问。' },
  },
  {
    kind: 'mark',
    title: '打开 SOCKET 控制',
    lead: '入口位于 App 首页底部',
    copy: '在 App 首页底部的四个入口中，点击最右侧的「SOCKET 控制」。',
    img: homeImg,
    marks: [{ key: 'socketEntry', color: GOLD }],
  },
  {
    kind: 'mark',
    title: '等待主机连接',
    lead: '等待电脑端插件连接 App',
    copy: '进入后请保持该页面开启，等待连接完成，届时会弹出「蓝牙连接中 / 连接服务器」提示。',
    img: connectingImg,
    marks: [{ key: 'connectingDialog', color: GOLD }],
    tip: {
      icon: 'info',
      text: '若超过 10 秒无法连接设备，请查看 APP 后续弹窗：您可能需要重置一次设备。',
      detail: '重置方法：关闭主机，随后开机，并在 3 秒内将顶部的左右拨轮一侧向上、一侧向下，持续 1 秒；狼眼闪烁完毕后即可松开，静候 APP 连接至主机即可。',
    },
  },
  {
    kind: 'mark',
    title: '打开设置',
    lead: '点击右上角的宫格按钮',
    copy: '点击页面右上角的宫格按钮（四个小方块），打开功能菜单。',
    img: socketPageImg,
    marks: [{ key: 'settingsEntry', color: GOLD }],
    callout: {
      path: 'M 74 158 C 66 112, 38 76, 8 56',
      head: 'M 22 45 L 6 55 L 23 67',
      label: { text: '点这里', x: 56, y: 186 },
    },
  },
  {
    kind: 'mark',
    title: '进入被控设置',
    lead: '在功能菜单中选择「被控设置」',
    copy: '在功能菜单中选择「被控设置」，进入强度与连接设置。',
    img: settingsGridImg,
    marks: [{ key: 'controlledSettings', color: GOLD }],
  },
  {
    kind: 'mark',
    title: '设置强度上限并连接',
    lead: '设置强度上限后点击「连接服务器」',
    copy: '请根据自身承受能力设置 A/B 通道强度上限（插件设置中可进一步下调）。增加速率无特殊情况建议保持 1，设置完成后点击「连接服务器」。',
    img: configImg,
    marks: [{ key: 'capSliders', color: SLIDER }, { key: 'connectServerBtn', color: SCAN }],
    tip: { icon: 'bulb', text: '橙色框为强度上限，蓝色框为「连接服务器」；请先设置上限，再点击连接。' },
  },
  {
    kind: 'qr',
    title: '扫码连接',
    lead: '使用手机扫描右侧二维码',
    copy: '在「扫码连接 Socket 服务」面板中点击相机图标，使用手机 App 扫描右侧二维码。连接成功后自动进入下一步，也可点击左下角「跳过引导」直接进入插件。',
    img: remoteImg,
    marks: [{ key: 'scanCamera', color: GOLD }],
    tip: { icon: 'wifi', text: '若 APP 中持续显示「正在连接」，请确认电脑与手机处于同一局域网后重试。' },
    advanceWhen: 'scanned',
  },
  {
    kind: 'done',
    title: '连接成功',
    lead: '连接已完成',
    copy: 'App 底部出现「服务器连接成功」即表示连接完成，可以开始使用。',
    img: connectedImg,
    marks: [
      { key: 'successToast', color: GOLD },
      { key: 'capQuickA', color: SLIDER },
      { key: 'capQuickB', color: SLIDER },
    ],
    tip: { icon: 'bulb', text: '点击顶部的「0-200」，可快速唤出强度上限弹窗。' },
  },
]

const COPY = {
  kicker: (i: number, total: number) => `第 ${i} / ${total} 步`,
  skip: '跳过引导',
  prev: '上一步',
  next: '下一步',
  finish: '完成，进入插件',
  scanning: '等待扫码…请使用 App 扫描右侧二维码',
  scanned: '连接成功',
  stageShot: 'DG-LAB App 实机截图，框选处为操作位置',
  stagePreview: 'DG-LAB App 首页预览，选择版本后开始演示',
  stageSafety: '安全须知 · 请务必遵守',
  readAndNext: '我已阅读，继续',
  v4Note: '4.0 版本界面与 3.0 不同，本步骤截图以 3.0 为准。',
  qrSteps: [
    '打开 App 的「SOCKET 控制」页',
    '点击相机图标进入扫码界面',
    '扫描二维码，连接成功后自动进入下一步',
  ],
  doneNext: [
    '播放音乐，强度会随音乐实时映射',
    '强度上限与体感风格可随时在插件设置中调整',
  ],
}

export interface DglabOobeGuideProps {
  /** 引导结束（完成 / 跳过 / 关闭） */
  onComplete?: () => void
  /** 跳过时回调（用于静默标记，区别于正常完成） */
  onSkip?: () => void
  /** 是否显示右上角关闭（调试平台常驻时不一定要） */
  closable?: boolean
  /**
   * true：嵌在 DG-LAB 控制台弹窗内（铺满弹窗面板，不再叠一层全屏页）；
   * false：独立居中弹窗，尺寸与控制台弹窗一致（调试台 / 单独调用）。
   */
  contained?: boolean
}

export default function DglabOobeGuide({ onComplete, onSkip, closable = true, contained = false }: DglabOobeGuideProps) {
  const [step, setStep] = useState(0)
  const [version, setVersion] = useState<'v3' | 'v4'>('v3')
  const [scanned, setScanned] = useState(false)
  const [cardVisible, setCardVisible] = useState(true) // 切图时重放扫描光
  const [dismissed, setDismissed] = useState(false)
  const status = useDGLabStatus()
  const cardKey = useRef(0)

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const canAdvance = current.advanceWhen === 'scanned' ? scanned : true

  // 切换图片 → 重放扫描光 + 重置该步的「已扫」状态（仅 qr 步需要）
  useEffect(() => {
    cardKey.current += 1
    setCardVisible(false)
    const t = window.setTimeout(() => setCardVisible(true), 30)
    if (current.kind !== 'qr') setScanned(false)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // 真实扫码成功检测（仅在 qr 步关心）
  useEffect(() => {
    if (current.kind === 'qr' && status.state === 'bound') setScanned(true)
  }, [current.kind, status.state])

  // 选版本时同步插件设置（影响后续二维码 schema / 地址）
  const applyVersion = (v: 'v3' | 'v4') => {
    setVersion(v)
    const next = saveDGLabSettings({ version: v } as Partial<DGLabSettings>)
    getDGLabClient().setSettings({ version: v })
    void next
  }

  // qr 步实时二维码：跟随版本 / 状态生成
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (current.kind !== 'qr') { setQrUrl(null); return }
    const content = version === 'v3' ? status.qrV3 : status.qrV4
    if (!content) { setQrUrl(null); return }
    void getDGLabClient().getQR(content).then((url) => { if (!cancelled) setQrUrl(url) })
    return () => { cancelled = true }
  }, [current.kind, version, status.qrV3, status.qrV4])

  const goNext = () => {
    if (!canAdvance) return
    if (isLast) { onComplete?.(); setDismissed(true) }
    else setStep(s => Math.min(STEPS.length - 1, s + 1))
  }
  const goPrev = () => setStep(s => Math.max(0, s - 1))
  const skip = () => { onSkip?.(); onComplete?.(); setDismissed(true) }
  const close = () => { onSkip?.(); setDismissed(true) }

  // 遥控器返回：先退回上一步，第一步再关闭（交回父级）
  useTvBack(() => {
    if (step > 0) { goPrev(); return true }
    if (closable) { close(); return true }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, closable])

  // 打开引导时保活中继（默认开；用户手动停过则不会自动拉起）
  useEffect(() => {
    void getDGLabClient().ensureRelayRunning()
  }, [])

  // Esc 直接关闭引导（两种形态一致；遥控器返回走上面的 useTvBack 逐级后退）
  useEffect(() => {
    if (!closable) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closable])

  if (dismissed) return null

  const stageImg = current.img ?? homeImg
  const TipIcon = { wifi: Wifi, bulb: Lightbulb, info: Info }[current.tip?.icon ?? 'info']

  const renderMarks = (marks: { key: keyof typeof RECTS; color?: string }[]) => (
    <svg viewBox={`0 0 ${IMG_W} ${IMG_H}`} preserveAspectRatio="none" aria-hidden>
      {marks.map((m) => {
        const r = RECTS[m.key]
        const color = m.color ?? GOLD
        return (
          <g key={m.key}>
            <rect
              className="dglab-oobe-mark-stroke"
              x={r.x} y={r.y} width={r.w} height={r.h} rx={14}
              fill="none" stroke={color} strokeWidth={8}
              style={{ filter: `drop-shadow(0 0 8px ${color})` }}
            />
            {/* 四角装饰，强调「框选」 */}
            {[
              [r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1],
              [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1],
            ].map(([cx, cy, sx, sy], i) => (
              <path
                key={i}
                className="dglab-oobe-mark"
                d={`M ${cx} ${cy + 26 * sy} L ${cx} ${cy} L ${cx + 26 * sx} ${cy}`}
                fill="none" stroke={color} strokeWidth={9} strokeLinecap="round"
              />
            ))}
          </g>
        )
      })}
      {/* 扫描光：一条贯穿所有高亮区的渐变带，仅在图片首次出现时播放一次 */}
      {cardVisible && marks.length > 0 && (() => {
        const r0 = RECTS[marks[0].key]
        return (
          <rect key={cardKey.current} className="dglab-oobe-sweep" x={r0.x} y={r0.y} width={r0.w} height={r0.h}
            fill={`url(#sweep-${cardKey.current})`} />
        )
      })()}
      <defs>
        {Array.from({ length: cardKey.current + 1 }).map((_, i) => (
          <linearGradient key={i} id={`sweep-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0" />
            <stop offset="50%" stopColor="white" stopOpacity="0.55" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
    </svg>
  )

  /** 右栏步骤内容 */
  const renderBody = () => {
    // ── 前言（安全须知） ──
    if (current.kind === 'intro') {
      return (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="dglab-oobe-card" style={{ borderColor: 'rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.08)' }}>
              <p className="flex items-center gap-2 text-[12.5px] font-semibold text-red-200">
                <CircleAlert className="w-4 h-4 shrink-0" /> 出现不适
              </p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/60">
                使用过程中如有任何不适，请立即按下设备顶部任意拨轮（输出会立即停止）；情况严重请立即就医。
              </p>
            </div>
            <div className="dglab-oobe-card" style={{ borderColor: 'rgba(252,211,77,0.3)', background: 'rgba(252,211,77,0.08)' }}>
              <p className="flex items-center gap-2 text-[12.5px] font-semibold text-amber-100">
                <ShieldAlert className="w-4 h-4 shrink-0" /> 配件要求
              </p>
              <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-white/60">
                <li>乳夹：<b className="text-red-200/90">严禁</b>，严重情况可能引起房颤或心脏骤停</li>
                <li>船锚：部分高频波形可能引发肌肉痉挛</li>
                <li>双球：持续波形可能导致前列腺损伤</li>
              </ul>
              <p className="mt-1.5 text-[11px] text-white/40">以上包括但不限于，其它非贴片配件同样禁止使用。</p>
            </div>
          </div>
          <div className="dglab-oobe-card">
            <p className="flex items-center gap-2 text-[12.5px] font-semibold text-white/80">
              <Gauge className="w-4 h-4 shrink-0" style={{ color: GOLD }} /> 使用前
            </p>
            <ul className="mt-1.5 space-y-1 text-[11.5px] leading-relaxed text-white/60">
              <li>强度请由低到高逐步调整，切勿直接调至上限。</li>
              <li>贴片须贴在干燥、无破损的皮肤上；耻骨区之上（胸口、颈部以上）严禁使用。</li>
              <li>饮酒后、疲劳、驾驶或操作机械时请勿使用；患有心脏疾病、癫痫或体内植入电子设备（如心脏起搏器）者请勿使用。</li>
            </ul>
          </div>
        </div>
      )
    }

    // ── 版本选择 ──
    if (current.kind === 'version') {
      return (
        <div className="grid grid-cols-2 gap-3">
          {([
            { v: 'v3', label: 'DG-LAB 3.0', desc: '经典界面，后续步骤按 3.0 截图演示。' },
            { v: 'v4', label: 'DG-LAB 4.0', desc: '4.0 引导尚未提供，可选择，但截图仍以 3.0 为准。' },
          ] as const).map((opt) => {
            const active = version === opt.v
            return (
              <button
                key={opt.v}
                onClick={() => applyVersion(opt.v)}
                className={`dglab-oobe-version rounded-2xl border px-4 py-4 text-left ${active ? 'active' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Smartphone className="w-4 h-4" style={{ color: GOLD }} /> {opt.label}
                  </span>
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-opacity"
                    style={{ background: active ? GOLD : 'rgba(255,255,255,0.08)', opacity: active ? 1 : 0.5 }}
                  >
                    <Check className="w-3 h-3" style={{ color: active ? '#000' : 'transparent' }} />
                  </span>
                </div>
                <p className="text-[11px] text-white/55 mt-2 leading-relaxed">{opt.desc}</p>
              </button>
            )
          })}
        </div>
      )
    }

    // ── 扫码连接 ──
    if (current.kind === 'qr') {
      const relayOff = !status.running
      return (
        <div className="flex items-start gap-5">
          <div
            className={`dglab-oobe-qr shrink-0 ${qrUrl && !relayOff ? '' : 'waiting'}`}
            style={relayOff ? { opacity: 0.4, filter: 'grayscale(0.75)' } : undefined}
          >
            {qrUrl ? (
              <img src={qrUrl} alt="DG-LAB 3.0 连接二维码" className="w-[168px] h-[168px] object-contain" draggable={false} />
            ) : (
              <div className="w-[168px] h-[168px] flex items-center justify-center text-black/45">
                <QrCode className="w-10 h-10 animate-pulse" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2.5">
            {relayOff ? (
              <div className="dglab-oobe-tip accent-warn">
                <TriangleAlert className="w-3.5 h-3.5 mt-[2px] shrink-0" style={{ color: '#fcd34d' }} />
                <span>
                  中继未启动，当前二维码无法建立连接。
                  <span className="dglab-oobe-tip-detail">请先点击下方「启动中继」（或前往控制台「连接设置」启动），启动后再进行扫描。</span>
                </span>
              </div>
            ) : (
              <p className={`flex items-center gap-2 text-[12.5px] font-medium ${scanned ? 'text-emerald-300' : 'text-white/70'}`}>
                {scanned
                  ? <CircleCheck className="w-4 h-4 shrink-0" />
                  : <ScanLine className="w-4 h-4 shrink-0 animate-pulse" style={{ color: GOLD }} />}
                {scanned ? COPY.scanned : COPY.scanning}
              </p>
            )}
            {relayOff && (
              <button
                onClick={() => void getDGLabClient().manualControl('start')}
                className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-semibold text-black transition-transform active:scale-[0.98]"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})`, boxShadow: `0 6px 18px ${GOLD}33` }}
              >
                <PlugZap className="w-3.5 h-3.5" />
                启动中继
              </button>
            )}
            <ul className="space-y-1.5">
              {COPY.qrSteps.map((line, i) => (
                <li key={line} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-white/55">
                  <span
                    className="mt-[1px] w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(255,232,156,0.14)', color: GOLD }}
                  >
                    {i + 1}
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )
    }

    // ── 完成 ──
    if (current.kind === 'done') {
      return (
        <div className="space-y-2.5">
          <div className="dglab-oobe-card flex items-center gap-3" style={{ borderColor: 'rgba(52,211,153,0.28)', background: 'rgba(52,211,153,0.08)' }}>
            <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: 'rgba(52,211,153,0.18)' }}>
              <CircleCheck className="w-5 h-5 text-emerald-300" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-300">连接已建立</p>
              <p className="text-[11px] text-white/50 truncate">
                {status.deviceName ? `设备：${status.deviceName}` : '手机 App 已与插件建立连接'}
              </p>
            </div>
          </div>
          <ul className="space-y-1.5">
            {COPY.doneNext.map((line) => (
              <li key={line} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-white/55">
                <Check className="mt-[2px] w-3.5 h-3.5 shrink-0" style={{ color: GOLD }} />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )
    }

    // ── 截图说明步骤 ──
    return (
      <div className="space-y-2.5">
        <p className="text-[13px] leading-relaxed text-white/75">{current.copy}</p>
        {version === 'v4' && (
          <p className="text-[11.5px] leading-relaxed text-amber-100/70">{COPY.v4Note}</p>
        )}
      </div>
    )
  }

  return (
    <div
      className="dglab-oobe-root"
      data-mode={contained ? 'contained' : 'dialog'}
      onClick={contained ? undefined : close}
    >
      <motion.div
        initial={contained ? { opacity: 0, y: 10 } : { opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        className="dglab-oobe-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dglab-oobe-aurora-clip" aria-hidden>
          <div className="dglab-oobe-aurora" />
        </div>

        {/* 顶栏：标题 + 步骤进度 + 关闭 */}
        <header className="dglab-oobe-header">
          <div className="flex items-center gap-3 min-w-0">
            <span className="dglab-oobe-logo">
              <QrCode className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold text-white leading-tight truncate">DG-LAB 连接引导</h2>
              <p className="text-[11px] truncate" style={{ color: `${GOLD}88` }}>按步骤完成手机与插件的连接</p>
            </div>
          </div>

          <div className="dglab-oobe-dots shrink-0">
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                type="button"
                title={`${i + 1}. ${s.title}`}
                aria-label={`第 ${i + 1} 步：${s.title}`}
                aria-current={i === step ? 'step' : undefined}
                disabled={i > step}
                onClick={() => { if (i < step) setStep(i) }}
                className={`dglab-oobe-dot ${i === step ? 'active' : i < step ? 'done' : ''}`}
              />
            ))}
          </div>

          {closable ? (
            <button
              onClick={close}
              aria-label="关闭引导"
              className="shrink-0 p-2 rounded-xl bg-white/[0.06] hover:bg-red-500/25 text-white/60 hover:text-red-300 transition-colors"
            >
              <X style={{ width: 18, height: 18 }} />
            </button>
          ) : <span className="w-[34px]" />}
        </header>

        {/* 主体：左截图 / 右步骤 */}
        <div className="dglab-oobe-body">
          <div className="dglab-oobe-stage">
            <div className="dglab-oobe-phone-wrap">
              {current.kind === 'intro' ? (
                <div className="dglab-oobe-poster">
                  <span className="dglab-oobe-poster-badge"><ShieldCheck className="w-9 h-9" /></span>
                  <p className="dglab-oobe-poster-title">安全第一</p>
                  <p className="dglab-oobe-poster-sub">请阅读后开始使用</p>
                  <ul className="dglab-oobe-poster-list">
                    <li><Zap className="w-3.5 h-3.5 shrink-0" style={{ color: GOLD }} /> 不适即按拨轮</li>
                    <li><Ban className="w-3.5 h-3.5 shrink-0" style={{ color: '#fca5a5' }} /> 仅用贴片</li>
                    <li><Gauge className="w-3.5 h-3.5 shrink-0" style={{ color: SCAN }} /> 由低强度开始</li>
                  </ul>
                </div>
              ) : (
                <div className={`dglab-oobe-phone ${current.img ? '' : 'preview'}`}>
                  <img src={stageImg} alt={current.title} draggable={false} />
                  {current.marks && renderMarks(current.marks)}
                </div>
              )}
              {/* 截图外的指引箭头：从右侧空白处指向框选位置（仅个别步骤需要） */}
              {current.callout && (
                <svg className="dglab-oobe-callout" viewBox="0 0 100 200" width={100} height={200} aria-hidden>
                  <path className="dglab-oobe-callout-arrow" d={current.callout.path}
                    fill="none" stroke={GOLD} strokeWidth={5} strokeLinecap="round" />
                  <path d={current.callout.head} fill="none" stroke={GOLD} strokeWidth={5}
                    strokeLinecap="round" strokeLinejoin="round" />
                  <text x={current.callout.label.x} y={current.callout.label.y} textAnchor="middle"
                    fill={GOLD} fontSize={14} fontWeight={600} opacity={0.95}>
                    {current.callout.label.text}
                  </text>
                </svg>
              )}
            </div>
            <p className="dglab-oobe-stage-caption">
              {current.kind === 'intro' ? COPY.stageSafety : current.img ? COPY.stageShot : COPY.stagePreview}
            </p>
          </div>

          <div className="dglab-oobe-content">
            {/* 标题 + 正文 + 提示作为一组整体切换：靠 key 重挂载触发 CSS 进入动画。
                这里不用 AnimatePresence(mode="wait")——连续点「下一步」时退出动画会让
                正文卡在旧步骤（轨迹/截图已前进、文字还是上一步）。 */}
            <div key={step} className="dglab-oobe-step">
              <span className="dglab-oobe-kicker">{COPY.kicker(step + 1, STEPS.length)}</span>
              <h3 className="mt-2.5 text-[22px] leading-tight font-bold" style={{ color: GOLD }}>{current.title}</h3>
              <p className="mt-1.5 text-[12.5px] text-white/45">{current.lead}</p>

              <div className="mt-4 space-y-3">
                {renderBody()}

                {current.tip && (
                  <div className={`dglab-oobe-tip ${current.tip.icon === 'wifi' ? '' : 'accent-cyan'}`}>
                    <TipIcon className="w-3.5 h-3.5 mt-[2px] shrink-0" style={{ color: current.tip.icon === 'wifi' ? GOLD : SCAN }} />
                    <span>
                      {current.tip.text}
                      {current.tip.detail && (
                        <span className="dglab-oobe-tip-detail">{current.tip.detail}</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 右：步骤轨迹（已完成的可点回看；宽屏显示，窄屏换成顶栏进度点） */}
          <nav className="dglab-oobe-rail" aria-label="引导步骤">
            {STEPS.map((s, i) => {
              const state = i === step ? 'active' : i < step ? 'done' : ''
              return (
                <button
                  key={s.title}
                  type="button"
                  disabled={i > step}
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => { if (i < step) setStep(i) }}
                  className={`dglab-oobe-rail-item ${state}`}
                >
                  <span className="idx">
                    {i < step ? <Check style={{ width: 11, height: 11 }} /> : i + 1}
                  </span>
                  <span className="truncate">{s.title}</span>
                </button>
              )
            })}
          </nav>
        </div>

        {/* 底栏：跳过 / 上一步 / 下一步 */}
        <footer className="dglab-oobe-footer">
          <button
            onClick={skip}
            className="text-xs text-white/45 hover:text-white/70 transition-colors underline underline-offset-2"
          >
            {COPY.skip}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={goPrev}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium bg-white/[0.08] hover:bg-white/15 text-white/85 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> {COPY.prev}
              </button>
            )}
            <button
              onClick={goNext}
              disabled={!canAdvance}
              className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.98]"
              style={{
                background: canAdvance ? `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` : 'rgba(255,255,255,0.1)',
                color: canAdvance ? '#0b0b0e' : 'rgba(255,255,255,0.4)',
                boxShadow: canAdvance ? `0 8px 24px ${GOLD}33` : 'none',
                cursor: canAdvance ? 'pointer' : 'not-allowed',
              }}
            >
              {isLast ? COPY.finish : step === 0 ? COPY.readAndNext : COPY.next} <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </footer>
      </motion.div>
    </div>
  )
}

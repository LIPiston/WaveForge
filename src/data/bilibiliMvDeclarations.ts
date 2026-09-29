export interface BilibiliMvDeclaration {
  songKey: string
  bvid: string
  songTitle: string
  artists: readonly string[]
  album?: string
  videoTitle: string
  uploader: string
  duration: number
  note?: string
  verifiedAt: string
}

export const BILIBILI_MV_DECLARATION_VERSION = '2026-09-29-1'

/**
 * 东方/同人评测语料的人工核验声明（x2-doujin-ja-001..017）。
 * songKey 与评测语料解析出的真实 QQ/网易云歌曲 ID 一致（platformSource 见 corpus.json）。
 * 全部视频经 B 站 view API 于 2026-09-29 核验：标题/UP主/时长与投稿一致，均为单 P。
 */
export const BILIBILI_MV_DECLARATIONS: readonly BilibiliMvDeclaration[] = [
  {
    songKey: 'qq:612279399',
    bvid: 'BV18A4m1N7Hc',
    songTitle: 'Villain (Take the Shot)',
    artists: ['无畏契约', 'Barns Courtney', 'ARB4'],
    album: 'VALORANT Sounds Vol. 1',
    videoTitle: 'VILLAIN (TAKE THE SHOT) // 2024VCT EMEA主题曲',
    uploader: 'ACG_Planck',
    duration: 191,
    note: '开发者人工核验：VCT EMEA 主题曲视频。',
    verifiedAt: '2026-09-06',
  },
  {
    songKey: 'qq:261171780',
    bvid: 'BV14x411c7U6',
    songTitle: 'ナイト・オブ・ナイツ',
    artists: ['ビートまりお'],
    album: '東方インストライク',
    videoTitle: '[东方]ナイト—オブ—ナイツ 十六夜咲夜',
    uploader: '碧诗',
    duration: 191,
    note: '东方同人声明：B 站经典投稿（411万播放），时长与音源一致。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:104111203',
    bvid: 'BV1vb411y7nD',
    songTitle: '魔理沙は大変なものを盗んでいきました (魔理沙偷走了重要的东西)',
    artists: ['IOSYS'],
    album: '東方乙女囃子',
    videoTitle: '魔理沙は大変なものを | 魔理莎偷走了重要的东西[中文字幕]',
    uploader: '蓝狼沃奇',
    duration: 245,
    note: '东方同人声明：169万播放主流完整版 PV。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:109428217',
    bvid: 'BV1rs41197Xn',
    songTitle: 'チルノのパーフェクトさんすう教室 (琪露诺的完美算术教室)',
    artists: ['IOSYS'],
    album: 'Grimoire of IOSYS - 東方BEST ALBUM vol.1 - LIGHT',
    videoTitle: '【东方PV】琪露诺的完美算术教室【中日歌词/4K/2160p】',
    uploader: '博丽幻月',
    duration: 131,
    note: '东方同人声明：410万播放经典 PV；QQ 元数据时长 277s 与主流投稿不符，按 PV 为准。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:200091205',
    bvid: 'BV1Zs411U7GE',
    songTitle: 'お嫁にしなさいっ！',
    artists: ['IOSYS'],
    album: 'miko BEST Toho of IOSYS',
    videoTitle: '【东方PV】请娶我回家！【IOSYS】',
    uploader: 'IOSYSOFFICIAL',
    duration: 150,
    note: '东方同人声明：IOSYS 官方频道投稿。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:3594040',
    bvid: 'BV1Ds411r7Pg',
    songTitle: 'Bad Apple!! (坏苹果)',
    artists: ['nomico'],
    album: 'Lovelight',
    videoTitle: 'Bad Apple(坏苹果)-完整版最终修改',
    uploader: '火条幻想录',
    duration: 324,
    note: '东方同人声明：完整版（与音源 319s 匹配）；影絵 PV（BV1xx411c79H）为 219s 剪辑版。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:125599279',
    bvid: 'BV19s411a7tg',
    songTitle: '月に叢雲華に風(OP2 ver.',
    artists: ['幽閉サテライト'],
    videoTitle: '【东方同人PV】幽闭星光×满福神社 《月映丛云·风语花》 PV 【官方投稿】',
    uploader: '幽闭星光_Official',
    duration: 117,
    note: '东方同人声明：幽闭星光官方频道投稿（幻想万華鏡 OP2 版本）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:567423931',
    bvid: 'BV1Kx411F7xt',
    songTitle: '亡き王女の為のセプテット',
    artists: ['上海アリス幻樂団'],
    videoTitle: '【東方紅魔郷】～ 亡き王女の為のセプテット ～ 原曲【高音質】',
    uploader: '一字文',
    duration: 272,
    note: '东方原曲声明：一字文红魔乡高音质系列（社区标准投稿，含循环段落）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:611957313',
    bvid: 'BV1Kx411F7xL',
    songTitle: 'U.N.オーエンは彼女なのか？',
    artists: ['上海アリス幻樂団'],
    album: 'NOSTALGIA Music Collection ～Op.1 & Op.2～',
    videoTitle: '【東方紅魔郷】～ U.N.オーエンは彼女なのか？ ～ 原曲【高音質】',
    uploader: '一字文',
    duration: 250,
    note: '东方原曲声明：一字文红魔乡高音质系列（67万播放）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:568477272',
    bvid: 'BV1WE411Y7sw',
    songTitle: '幽雅に咲かせ、墨染の桜 ～ Border of Life',
    artists: ['上海アリス幻樂団'],
    videoTitle: '【东方原曲】上海爱丽丝幻乐团-幽雅に咲かせ、墨染の桜 ～ Border of Life',
    uploader: '摩多罗纯狐隐岐奈',
    duration: 280,
    note: '东方原曲声明：妖々梦原曲投稿。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:568477967',
    bvid: 'BV1pt411E7KP',
    songTitle: '竹取飛翔 ～ Lunatic Princess',
    artists: ['上海アリス幻樂団'],
    videoTitle: '竹取飛翔～Lunatic Princess 東方永夜抄 原曲',
    uploader: 'E_NE',
    duration: 317,
    note: '东方原曲声明：永夜抄原曲投稿（21万播放）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:567422806',
    bvid: 'BV1Rs41117Dh',
    songTitle: '月まで届け、不死の煙',
    artists: ['上海アリス幻樂団'],
    videoTitle: '【東方永夜抄】飘上月球、不死之烟「原曲」【高音質】',
    uploader: '竜崎幻也',
    duration: 346,
    note: '东方原曲声明：永夜抄高音质系列（86万播放）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:599744494',
    bvid: 'BV1Kx411F72k',
    songTitle: 'おてんば恋娘',
    artists: ['上海アリス幻樂団'],
    album: '東方紅魔郷～ the Embodiment of Scarlet Devil',
    videoTitle: '【東方紅魔郷】～ おてんば恋娘 ～ 原曲【高音質】',
    uploader: '一字文',
    duration: 173,
    note: '东方原曲声明：一字文红魔乡高音质系列；QQ 元数据时长 89s 异常。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'qq:568647960',
    bvid: 'BV1znRhYwERU',
    songTitle: '感情の摩天楼 ～ Cosmic Mind',
    artists: ['上海アリス幻樂団'],
    videoTitle: '上海アリス幻樂団-感情の摩天楼　～ Cosmic Mind',
    uploader: '雾化叁佰',
    duration: 465,
    note: '东方原曲声明：星莲船原曲投稿（17万播放）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'netease:1444168632',
    bvid: 'BV1vZ4y1j7jf',
    songTitle: '色は匂へど散りぬるを (幻想万華鏡 春雪異変の章 OP主題歌)',
    artists: ['幽閉サテライト'],
    videoTitle: '【东方同人音乐】幽闭星光 《色は匂へど散りぬるを》完整版MV【官方投稿】',
    uploader: '幽闭星光_Official',
    duration: 228,
    note: '东方同人声明：幽闭星光官方频道完整版 MV（133万播放）；QQ 无音源，走网易云。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'netease:2638598437',
    bvid: 'BV11v4y1w7Dc',
    songTitle: '泡沫、哀のまほろば',
    artists: ['幽閉サテライト'],
    album: '漢の幽閉サテライト 弐',
    videoTitle: '東方project - 泡沫、哀のまほろば MV 日语中字',
    uploader: '666不是吧',
    duration: 233,
    note: '东方同人声明：完整版 MV（与音源 240s 匹配）；官方频道 123s 投稿为 PV 短版。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'netease:22636708',
    bvid: 'BV1tx411w77H',
    songTitle: 'ネクロファンタジア',
    artists: ['上海アリス幻樂団'],
    album: '東方妖々夢 ～ Perfect Cherry Blossm. サウンドトラック',
    videoTitle: '【东方千年组神曲】 Necro Fantasia 【ネクロファンタジア】',
    uploader: '三个月的日子',
    duration: 345,
    note: '东方原曲声明：妖々梦原曲投稿（与音源 353s 匹配）。',
    verifiedAt: '2026-09-29',
  },
  {
    songKey: 'netease:22636684',
    bvid: 'BV1M34y1x7yB',
    songTitle: '少女綺想曲 ～ Dream Battle',
    artists: ['上海アリス幻樂団'],
    album: '東方永夜抄 ～ Imperishable Night. サウンドトラック',
    videoTitle: '少女绮想曲~Dream Battle (东方永夜抄-博丽灵梦主题曲)',
    uploader: '北极幸运星',
    duration: 311,
    note: '东方原曲声明：永夜抄原曲投稿（5.4万播放）。',
    verifiedAt: '2026-09-29',
  },
]

const BVID_RE = /^BV[0-9A-Za-z]{10}$/

function buildDeclarationMap(declarations: readonly BilibiliMvDeclaration[]): ReadonlyMap<string, BilibiliMvDeclaration> {
  const result = new Map<string, BilibiliMvDeclaration>()
  for (const declaration of declarations) {
    if (!declaration.songKey.trim()) throw new Error('Developer MV declaration has an empty songKey')
    if (!BVID_RE.test(declaration.bvid)) throw new Error(`Developer MV declaration has an invalid BVID: ${declaration.bvid}`)
    if (result.has(declaration.songKey)) throw new Error(`Duplicate developer MV declaration: ${declaration.songKey}`)
    result.set(declaration.songKey, Object.freeze({ ...declaration }))
  }
  return result
}

export const BILIBILI_MV_DECLARATION_MAP = buildDeclarationMap(BILIBILI_MV_DECLARATIONS)

export function getDeveloperBilibiliMvDeclaration(songKey: string): BilibiliMvDeclaration | null {
  return BILIBILI_MV_DECLARATION_MAP.get(songKey) || null
}

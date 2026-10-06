/**
 * 从专辑名提取「作品名 / IP 词」（franchise），供 MV（B 站）匹配使用。
 *
 * 动机：动画 / 游戏 / 影视的 OP/ED·主题曲，正片投稿标题通常只写作品名
 * （例：「【魔女の旅々】OP リテラチュア」「呪術廻戦 第2期 OP 青のすみか」），
 * 而平台的歌名/歌手字段里没有作品名；专辑名却几乎总带着它
 * （「TVアニメ『魔女の旅々』Original Soundtrack」）。把作品名交给匹配器
 * （franchise 命中 +25、追加召回查询、官号 IP 归属校验）比让算法猜要准。
 *
 * 风险与保守原则（宁缺毋滥：#加了错误的作品名 = 假 IP 证据，可能抬错候选）：
 *   1) 只有专辑名出现**作品关联标记**（原声/主题歌/动画/剧场版/游戏/影视剧…）时，
 *      才在无引号片段的情况下做整体提炼；普通专辑（歌名同名专辑、艺人名专辑、
 *      「After Hours」这类普通命名）一律返回 null —— 它们不含作品信息。
 *   2) 引号片段（『』「」《》〈〉）优先：这是中日文专辑标注作品名的主要形式；
 *      **圆括号/方括号不参与提取**（"(Movie ver.)" "【期間生産限定盤】" 等主要是限定/版本信息）。
 *   3) 提取结果还要过：与歌名（含去括号主体）/艺人名/整张专辑名同名 → 丢弃；
 *      噪词清洗后为空、长度不足、纯数字或唱片编号（SRCL-1234）、通用词
 *      （アニソン / サウンドトラック / コレクション / best / movie …）→ 丢弃。
 *
 * 纯函数、无副作用；命中不了就返回 null（匹配器按"没有 IP 证据"的原有口径运行）。
 */

export interface AlbumFranchiseContext {
  songTitle?: string
  artists?: string[]
}

/** 作品关联标记：出现任一才认为这张专辑与某个作品（动画/电影/游戏/剧）绑定 */
const WORK_ALBUM_HINT = /(?:サウンドトラック|オリジナル・?サウンドトラック|original\s*soundtrack|オリジナルサウンドトラック|\bost\b|主題歌|主题歌|主題曲|主题曲|テーマソング|劇伴|劇中歌|挿入歌|キャラクターソング|アニソン|(?:tv|テレビ)アニメ(?:ーション)?|アニメ|劇場版|実写映画|映画|テレビドラマ|連続ドラマ|ドラマ|ミュージカル|\bova\b|\bona\b|ゲーム|ゲームミュージック|游戏|soundtrack|anime|animation|original\s*motion\s*picture|motion\s*picture|video\s*game)/i

/** 片段内的噪词（被清除后再看剩余内容是否为作品名）。
 *  拉丁词一律加词边界：`ver` 曾无边界命中 "Anniversary" 内部，把「10th Anniversary」
 *  洗成「10th Anni sary」（真实曲库审计实测），词边界是硬要求。 */
const NOISE_TOKENS = /(?:オリジナル・?サウンドトラック|オリジナルサウンドトラック|サウンドトラック|オリジナル|original(?:\s*soundtrack)?|\bost\b|soundtrack|主題歌集|主題歌|主题歌集|主题歌|主題曲集|主題曲|主题曲集|主题曲|テーマソング|劇伴|劇中歌|挿入歌|キャラクターソング|アニソン|(?:tv|テレビ)アニメ(?:ーション)?|アニメ(?:ーション)?|劇場版|実写映画|映画|テレビドラマ|連続ドラマ|ドラマ|ゲームミュージック|ゲーム|游戏|盤|完全生産限定盤|期間生産限定盤|初回限定盤|通常盤|限定盤|deluxe(?:\s*edition)?|remaster(?:ed)?|edition|バージョン|\bversion\b|\bver\.?\b|\bsize\b|サイズ|\bvol\.?\s*\d+|\bdisc\s*\d+|\bcd\b|blu-?ray|\bdvd\b|\bhd\b|\b4k\b|特典|限定|初回|期間|生産|通常|\bcomplete\b|コンピレーション|\bcompilation\b|\bcollection\b|コレクション|ベスト|\bbest\b|アルバム|\balbum\b|\bsingle\b|シングル|\bep\b|\bmusic\b|音楽|\bselection\b|セレクション|\bmovie\b|\bfilm\b|\bdrama\b)/gi

/** 周年/纪念/巡演类词：不是作品名（"10th Anniversary Movie" 这类标注必须丢弃） */
const NON_WORK_PHRASE = /(?:anniversary|記念|纪念|周年|festival|フェス|ワンマン|ツアー|\btour\b|\bconcert\b|ライブ)/i

/** 清洗后仍是通用词（不是作品名）→ 丢弃 */
const GENERIC_ONLY = /^(?:アニメ(?:ーション)?|ゲーム|游戏|音楽|歌|曲|アニソン|サウンドトラック|主題歌|主题歌|主題曲|主题曲|テーマ|テーマソング|コレクション|ベスト|ベストアルバム|オムニバス|コンピレーション|ost|soundtrack|anime|animation|game|music|song|songs|theme|selection|compilation|collection|album|single|ep|vol|disc|cd|dvd|bluray|blu|hd|4k|movie|film|drama|tv|size|version|ver|original|complete|best|deluxe|remaster|instrumental|karaoke)$/i

/** 唱片编号 / 纯数字 / 纯符号 */
const CATALOG_LIKE = /^(?:[a-z]{2,6}[-_ ]?\d{3,}[a-z]?|\d{3,}|[\d\s\-–—_.・]+)$/i

/** 中日文作品名引号：只认这几种（圆括号/方括号多是限定盘、版本信息，不参与提取） */
const TITLE_QUOTE_RE = /[『「《〈]([^』」》〉]{1,60})[』」》〉]/g

const normalizeForCompare = (value: string): string =>
  String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/g, '')

/** 去掉片段首尾的装饰分隔符（保留名字内部的「・」等连接符，如 リコリス・リコイル） */
const trimDecorations = (value: string): string =>
  value.replace(/^[\s\u3000・,，、.。:：;；\-–—~～|／/&＆+＋'"“”‘’!！?？]+/, '')
    .replace(/[\s\u3000・,，、.。:：;；\-–—~～|／/&＆+＋'"“”‘’]+$/, '')
    .trim()

/** 去掉片段里的括号限定内容（"(Movie ver.)" "（期間生産限定盤）" 等是版本/规格说明，不是作品名） */
const stripQualifierBrackets = (value: string): string =>
  value
    .replace(/[（(][^（）()]{0,60}[）)]/g, ' ')
    .replace(/[【\[][^【】\[\]]{0,60}[】\]]/g, ' ')

/** 把片段里的噪词与多余空白洗掉，返回可能为空的剩余内容 */
const stripNoiseTokens = (value: string): string =>
  trimDecorations(
    stripQualifierBrackets(value)
      .replace(NOISE_TOKENS, ' ')
      .replace(/[\s\u3000]+/g, ' ')
      .trim(),
  )

/** 歌名去括号主体（与匹配器的 songTitleBaseNorm 同口径：去掉所有括号内容） */
const songTitleBaseOf = (songTitle: string): string =>
  songTitle.replace(/[（(][^（）()]*[）)]/g, '').replace(/[『「《〈][^』」》〉]*[』」》〉]/g, '').trim()

/**
 * 作品名出现在歌名里时是否算冗余（要丢弃）：
 *   · 歌名括号内的标注（「Eclipse (手游《明日方舟》印象曲)」）→ 不冗余：匹配器的 songTitleNorm
 *     只取括号外主体，括号里的作品名它看不到，专辑提取仍然有用；
 *   · 歌名正文里含该词（「What I've Done - Unshatter Film Soundtrack」里抽出 Unshatter）
 *     → 冗余且危险（把标题片段当作品名）→ 丢弃。
 */
function isRedundantWithSongTitle(candidateNorm: string, songTitleRaw: string, songTitleNorm: string): boolean {
  if (candidateNorm.length < 2 || !songTitleNorm.includes(candidateNorm)) return false
  const bracketSegments = songTitleRaw.match(/[（(][^（）()]*[）)]|[『「《〈][^』」》〉]*[』」》〉]|[【\[][^【】\[\]]*[】\]]/g) || []
  return !bracketSegments.some((segment) => normalizeForCompare(segment).includes(candidateNorm))
}

function isRejectedCandidate(candidate: string, album: string, normalizedContext: Set<string>, songTitleRaw: string): boolean {
  if (!candidate) return true
  const normalized = normalizeForCompare(candidate)
  const songTitleNorm = normalizeForCompare(songTitleRaw)
  if (normalized.length < 2 || normalized.length > 40) return true
  if (normalizedContext.has(normalized)) return true
  if (normalizeForCompare(album) === normalized) return true
  if (CATALOG_LIKE.test(candidate)) return true
  if (NON_WORK_PHRASE.test(candidate)) return true
  if (isRedundantWithSongTitle(normalized, songTitleRaw, songTitleNorm)) return true
  const stripped = stripNoiseTokens(candidate)
  if (stripped.length < 2) return true
  if (GENERIC_ONLY.test(stripped)) return true
  return false
}

/** 中日文字符（含假名/全角/中点）判断：只对纯 CJK 片段做「空格前截断」变体，
 *  避免英文作品名被截成 "attack" 这类泛词。 */
const CJK_ONLY_RE = /^[　-ヿ㐀-䶿一-鿿！-￮ーー・]+$/

/**
 * 作品名变体：让「作品名 + 副标题/季数」这类标注也能命中只写作品名的视频标题。
 *
 * 背景（离线评估遗留边界）：剧场版/分季专辑常把副标题写进同一引号片段
 * （「鬼滅の刃 無限列車編」「呪術廻戦 第2期」），而 B 站 OP/ED 投稿标题多数只写作品名
 * （「【鬼滅の刃】…」）。整串比较会漏掉 +25，这里补三种截断：
 *   ① 去括号后缀：「X（第2期）」→「X」；
 *   ② 去季/篇/剧场版后缀：「X 第2期」「X The Movie」→「X」；
 *   ③ 空格前截断（仅当空格前是纯 CJK 且 ≥2 字）：「鬼滅の刃 無限列車編」→「鬼滅の刃」。
 * 每个变体要求 ≥2 字且与原名不同；最多 3 个（原名 + 两个变体），避免制造过短泛词。
 */
export function franchiseVariants(nameRaw: string): string[] {
  const name = String(nameRaw || '').trim()
  if (name.length < 2) return []
  const variants: string[] = [name]
  const push = (value: string) => {
    const trimmed = trimDecorations(value)
    if (trimmed.length >= 2 && trimmed !== name && !variants.includes(trimmed)) variants.push(trimmed)
  }
  const withoutBrackets = name.replace(/[（(【\[『「《〈].*$/, '').trim()
  push(withoutBrackets)
  let stripped = withoutBrackets || name
  for (let i = 0; i < 2; i += 1) {
    const next = stripped
      .replace(/(?:the\s*movie|final\s*season|movie|season\s*\d+|part\s*\d+|cour\s*\d+)\s*$/i, '')
      .replace(/第\s*[0-9一二三四五六七八九十]+\s*[期季部]\s*$/, '')
      .replace(/[編篇劇场場]\s*$/, '')
      // 去掉残留的结尾冠词（"進撃の巨人 The Final Season" 去掉季名后会剩 "進撃の巨人 The"）
      .replace(/[\s\u3000]+(?:the|a)\s*$/i, '')
      .trim()
    if (next === stripped) break
    stripped = next
  }
  push(stripped)
  const spaceIdx = name.search(/[\s\u3000]/)
  if (spaceIdx > 0) {
    const head = name.slice(0, spaceIdx).trim()
    if (CJK_ONLY_RE.test(head)) push(head)
  }
  return variants.slice(0, 3)
}

/**
 * 从专辑名提取作品名（franchise）。命中不了返回 null。
 * 只用于「动画/游戏/影视原声」类专辑；普通专辑不做任何推断。
 */
export function extractFranchiseFromAlbum(
  albumRaw: string | null | undefined,
  ctx: AlbumFranchiseContext = {},
): string | null {
  const album = String(albumRaw || '').replace(/[\s\u3000]+/g, ' ').trim()
  if (!album) return null
  const normalizedContext = new Set<string>()
  const songTitle = String(ctx.songTitle || '').trim()
  if (songTitle) {
    normalizedContext.add(normalizeForCompare(songTitle))
    const base = songTitleBaseOf(songTitle)
    if (base) normalizedContext.add(normalizeForCompare(base))
  }
  for (const artist of ctx.artists || []) {
    const normalized = normalizeForCompare(artist)
    if (normalized) normalizedContext.add(normalized)
  }

  // ① 引号片段优先（中日文专辑标注作品名的主要形式）
  const quoted: string[] = []
  for (const match of album.matchAll(TITLE_QUOTE_RE)) {
    const cleaned = stripNoiseTokens(String(match[1] || ''))
    if (!isRejectedCandidate(cleaned, album, normalizedContext, songTitle)) quoted.push(cleaned)
  }
  if (quoted.length) {
    // 多个片段取最长者：作品名通常比「主题歌」之类的补充说明更长
    quoted.sort((a, b) => b.length - a.length)
    return quoted[0]
  }

  // ② 无引号：只有专辑名带作品关联标记时才做整体提炼，避免把普通专辑名当作品名
  if (!WORK_ALBUM_HINT.test(album)) return null
  const withoutQuotes = album.replace(/[『「《〈][^』」》〉]*[』」》〉]/g, ' ')
  const cleaned = stripNoiseTokens(withoutQuotes)
  if (isRejectedCandidate(cleaned, album, normalizedContext, songTitle)) return null
  return cleaned
}

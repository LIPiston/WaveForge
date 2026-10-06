import { describe, it, expect } from 'vitest'
import { extractFranchiseFromAlbum } from '../src/services/mvFranchise'
import { scoreCandidate, buildQueries, type MatchContext, type BilibiliVideo } from '../src/services/bilibiliApi'

const video = (partial: Partial<BilibiliVideo>): BilibiliVideo => ({
  bvid: 'BV1xxxx',
  title: '',
  duration: 0,
  play: 0,
  author: '',
  pic: '',
  typename: '音乐',
  ...partial,
})

describe('extractFranchiseFromAlbum（专辑名 → 作品名）', () => {
  it('中日文引号里的作品名（动画/剧场版/原声专辑）', () => {
    // 用户实测用例：魔女の旅々 OP リテラチュア (Anime Size)
    expect(extractFranchiseFromAlbum('TVアニメ『魔女の旅々』Original Soundtrack', { songTitle: 'リテラチュア (文学) (Anime Size)', artists: ['上田麗奈'] })).toBe('魔女の旅々')
    expect(extractFranchiseFromAlbum('TVアニメ「ぼっち・ざ・ろっく！」オリジナルサウンドトラック')).toBe('ぼっち・ざ・ろっく！')
    expect(extractFranchiseFromAlbum('「SPY×FAMILY」オリジナル・サウンドトラック')).toBe('SPY×FAMILY')
    expect(extractFranchiseFromAlbum('アニメ『鬼滅の刃』主題歌集')).toBe('鬼滅の刃')
    expect(extractFranchiseFromAlbum('劇場版『鬼滅の刃 無限列車編』オリジナルサウンドトラック')).toBe('鬼滅の刃 無限列車編')
    expect(extractFranchiseFromAlbum('TVアニメ『リコリス・リコイル』オリジナルサウンドトラック')).toBe('リコリス・リコイル')
    expect(extractFranchiseFromAlbum('映画『君の名は。』主題歌集')).toBe('君の名は')
    expect(extractFranchiseFromAlbum('TVアニメ『呪術廻戦』サウンドトラック', { songTitle: '青のすみか', artists: ['キタニタツヤ'] })).toBe('呪術廻戦')
  })

  it('无引号但带作品关联标记（原声/主题歌/动画/游戏）时整体提炼', () => {
    expect(extractFranchiseFromAlbum('鬼滅の刃 オリジナル・サウンドトラック')).toBe('鬼滅の刃')
    expect(extractFranchiseFromAlbum('進撃の巨人 Original Soundtrack')).toBe('進撃の巨人')
    expect(extractFranchiseFromAlbum('TVアニメ チェンソーマン サウンドトラック')).toBe('チェンソーマン')
    expect(extractFranchiseFromAlbum('原神 ゲームミュージック コレクション')).toBe('原神')
    expect(extractFranchiseFromAlbum('崩壊3 主题曲集')).toBe('崩壊3')
  })

  it('普通专辑不提取（歌名/艺人同名专辑、普通命名、版本限定）', () => {
    expect(extractFranchiseFromAlbum('After Hours', { songTitle: 'Blinding Lights', artists: ['The Weeknd'] })).toBeNull()
    expect(extractFranchiseFromAlbum('リテラチュア', { songTitle: 'リテラチュア', artists: ['上田麗奈'] })).toBeNull()
    expect(extractFranchiseFromAlbum('リテラチュア (Anime Size)', { songTitle: 'リテラチュア', artists: ['上田麗奈'] })).toBeNull()
    expect(extractFranchiseFromAlbum('上田麗奈', { songTitle: 'リテラチュア', artists: ['上田麗奈'] })).toBeNull()
    expect(extractFranchiseFromAlbum('', { songTitle: 'X' })).toBeNull()
    expect(extractFranchiseFromAlbum(null)).toBeNull()
    expect(extractFranchiseFromAlbum('Original Soundtrack')).toBeNull()
    expect(extractFranchiseFromAlbum('サウンドトラック')).toBeNull()
    expect(extractFranchiseFromAlbum('【期間生産限定盤】X')).toBeNull()
    expect(extractFranchiseFromAlbum('X (Movie ver.)', { songTitle: 'X' })).toBeNull()
  })

  it('引用片段与歌名/艺人同名、噪词片段、唱片编号一律丢弃', () => {
    // 引号里就是歌名 → 不是作品名
    expect(extractFranchiseFromAlbum('TVアニメ『リテラチュア』オリジナルサウンドトラック', { songTitle: 'リテラチュア' })).toBeNull()
    // 引号里是艺人名 → 不是作品名
    expect(extractFranchiseFromAlbum('TVアニメ『LiSA』オリジナルサウンドトラック', { songTitle: '紅蓮華', artists: ['LiSA'] })).toBeNull()
    // 引号里是噪词/限定盘说明 → 丢弃
    expect(extractFranchiseFromAlbum('TVアニメ『オリジナル・サウンドトラック』主題歌集')).toBeNull()
    expect(extractFranchiseFromAlbum('TVアニメ『Anime Size』主題歌集')).toBeNull()
    expect(extractFranchiseFromAlbum('TVアニメ『SRCL-1234』サウンドトラック')).toBeNull()
    // 引号噪词被丢弃后，退回整体提炼路径：整张专辑名洗掉噪词后为空 → null（不硬凑）
    expect(extractFranchiseFromAlbum('『Vol.1』サウンドトラック')).toBeNull()
  })
})

describe('专辑名参与 MV 匹配（franchise 通道）', () => {
  const animeCtx: MatchContext = {
    songTitle: 'リテラチュア (文学) (Anime Size)',
    artists: ['上田麗奈'],
    songDuration: 90,
    album: 'TVアニメ『魔女の旅々』Original Soundtrack',
  }

  it('专辑提取的作品名参与打分：命中作品名的 OP 正片相对无 IP 证据更高分', () => {
    const withAlbum = scoreCandidate(video({ title: '【魔女の旅々】OP リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), animeCtx)
    const withoutAlbum = scoreCandidate(video({ title: '【魔女の旅々】OP リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), { ...animeCtx, album: undefined })
    expect(withAlbum.score).toBeGreaterThan(withoutAlbum.score)
    // 显示声明 franchise 与专辑提取一致时不应叠加（两者取其一）
    const explicit = scoreCandidate(video({ title: '【魔女の旅々】OP リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), { ...animeCtx, franchise: '魔女の旅々', album: undefined })
    expect(explicit.score).toBe(withAlbum.score)
  })

  it('专辑提取的作品名参与查询召回（追加 标题+作品名 查询）', () => {
    const queries = buildQueries(animeCtx)
    // 查询用的是 cleanSongTitle（去掉尾部 (Anime Size) 括号），作品名作为独立检索词追加
    expect(queries.some((q) => q.includes('魔女の旅々'))).toBe(true)
    // 普通专辑不产生作品名查询
    const plain = buildQueries({ ...animeCtx, album: 'リテラチュア (Anime Size)' })
    expect(plain.some((q) => q.includes('魔女の旅々'))).toBe(false)
  })

  it('错误的作品名不会抬错候选（标题不含该作品名的候选分数不变）', () => {
    const other = video({ title: '【鬼滅の刃】OP 紅蓮華 LiSA', duration: 236, play: 100_000 })
    const withAlbum = scoreCandidate(other, animeCtx)
    const withoutAlbum = scoreCandidate(other, { ...animeCtx, album: undefined })
    expect(withAlbum.score).toBe(withoutAlbum.score)
  })
})

describe('作品名变体（去季/篇/剧场版截断）', () => {
  it('剧场版、分季、括号后缀都能截出作品主体名', async () => {
    const { franchiseVariants } = await import('../src/services/mvFranchise')
    expect(franchiseVariants('鬼滅の刃 無限列車編')).toEqual(['鬼滅の刃 無限列車編', '鬼滅の刃 無限列車', '鬼滅の刃'])
    expect(franchiseVariants('呪術廻戦 第2期')).toEqual(['呪術廻戦 第2期', '呪術廻戦'])
    expect(franchiseVariants('進撃の巨人 The Final Season')).toEqual(['進撃の巨人 The Final Season', '進撃の巨人'])
    expect(franchiseVariants('SPY×FAMILY（第2期）')).toEqual(['SPY×FAMILY（第2期）', 'SPY×FAMILY'])
    // 英文作品名不做「空格前截断」（attack / final 这类泛词会误伤无关标题）
    expect(franchiseVariants('Attack on Titan')).toEqual(['Attack on Titan'])
    // 短名/空值不出变体
    expect(franchiseVariants('')).toEqual([])
    expect(franchiseVariants('X')).toEqual([])
  })

  it('变体参与打分：剧场版专辑的作品名能命中只写主体名的 OP 视频', () => {
    const movieCtx: MatchContext = {
      songTitle: '炎', artists: ['LiSA'], songDuration: 260,
      album: '劇場版『鬼滅の刃 無限列車編』オリジナルサウンドトラック',
    }
    const opLike = video({ title: '【鬼滅の刃】炎 LiSA 主題歌', duration: 260, play: 100_000 })
    const withAlbum = scoreCandidate(opLike, movieCtx)
    const withoutAlbum = scoreCandidate(opLike, { ...movieCtx, album: undefined })
    expect(withAlbum.score).toBeGreaterThan(withoutAlbum.score)
  })
})

describe('电视音乐节目演出版（我是歌手 / 音综）', () => {
  it('节目现场版按替代录音降权，录音室正片胜出', () => {
    const popCtx: MatchContext = { songTitle: '喜欢你', artists: ['G.E.M.邓紫棋'], songDuration: 239 }
    const showVersion = scoreCandidate(
      video({ title: '【4K60帧 超清修复】G.E.M.邓紫棋｜喜欢你｜我是歌手【收藏级画质】', duration: 281, play: 642_000 }),
      popCtx,
    )
    const studio = scoreCandidate(
      video({ title: '【Hi-Res无损音质】G.E.M. 邓紫棋 - 喜欢你', duration: 240, play: 6_000 }),
      popCtx,
    )
    expect(studio.score).toBeGreaterThan(showVersion.score)
    // live 偏好用户不受此降权（他们明确要看现场）
    const livePref = scoreCandidate(
      video({ title: '【4K60帧 超清修复】G.E.M.邓紫棋｜喜欢你｜我是歌手【收藏级画质】', duration: 281, play: 642_000 }),
      popCtx,
      { preference: 'live' },
    )
    expect(livePref.score).toBeGreaterThan(showVersion.score)
  })
})

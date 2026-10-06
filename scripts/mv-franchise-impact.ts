/**
 * 离线影响评估：专辑 → 作品名（franchise）对 MV 匹配排序的影响
 *
 * 用已采集的真实候选池（benchmark/bilibili-mv/reports/production-final-*.json，
 * 43 个真实用例、平均 38 个候选/例）离线重打分 —— scoreCandidate 是纯函数，
 * 候选池与复审参数（官方认证/CC 字幕/分 P 时长/搜索排名）都在报告里，可完整复现排序。
 *
 * 四个对照臂：
 *   baseline      语料标注的 franchise（人工整理的最佳 IP 证据）
 *   no-franchise  完全不传 franchise（现状：应用侧从不传）
 *   wrong-franchise 传**别的用例**的 franchise（最坏情况：提取错误的作品名）
 *   album-derived 不传 franchise，改为传专辑名，由 extractFranchiseFromAlbum 推导
 *                 （有 franchise 的用例生成真实命名风格的专辑名；无 franchise 的用例
 *                  传歌名同名专辑，验证普通专辑不会凭空产生 IP 证据）
 *
 * 输出：Top-1/Top-5 变化清单（谁被换掉、换成了什么标题），fidelity（重打分与留存分数
 * 的偏差分布），以及每个臂的排序稳定性统计。报告写入 benchmark/bilibili-mv/reports/。
 *
 * 运行：node scripts/mv-franchise-impact.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  compareCandidates,
  detectSongDurationConsensus,
  scoreCandidate,
  type BilibiliVideo,
  type CandidateScore,
  type MatchContext,
} from '../src/services/bilibiliApi'
import { extractFranchiseFromAlbum } from '../src/services/mvFranchise'

interface CorpusCase extends MatchContext {
  id: string
  split: 'dev' | 'holdout'
  title: string
  duration: number
  category: string
  locale: string
  popularity: string
  targetVersion: NonNullable<MatchContext['targetVersion']>
  franchise?: string
}

interface StoredCandidate {
  video: BilibiliVideo
  score: number
  rank?: number
  officialVerifyType?: number
  manualZhSubtitle?: boolean
  autoSubtitle?: boolean
  ccVerification?: 'match' | 'mismatch' | 'unverified'
  effectiveDuration?: number
}

interface StoredCase {
  case: CorpusCase
  status: string
  candidates: StoredCandidate[]
}


// esbuild 打包后在 .tmp/ 下运行，import.meta.url 不再是仓库内路径 —— 以启动器设置的
// cwd（仓库根）为准，环境变量可显式覆盖。
const root = process.env.MV_IMPACT_ROOT ? resolve(process.env.MV_IMPACT_ROOT) : process.cwd()
const corpusPath = resolve(root, 'benchmark/bilibili-mv/corpus.json')
const sourceReportPath = process.env.MV_IMPACT_SOURCE
  ? resolve(root, process.env.MV_IMPACT_SOURCE)
  : resolve(root, 'benchmark/bilibili-mv/reports/production-final-2026-09-01.json')

type ArmName = 'baseline' | 'no-franchise' | 'wrong-franchise' | 'album-derived'

interface ArmResult {
  arm: ArmName
  ranked: CandidateScore[]
  rankedBvids: string[]
}

const trim = (value: string, size = 42): string => (value.length > size ? `${value.slice(0, size)}…` : value)

async function main(): Promise<void> {
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as { cases?: CorpusCase[] } | CorpusCase[]
  const cases: CorpusCase[] = Array.isArray(corpus) ? corpus : corpus.cases || []
  const corpusById = new Map(cases.map((item) => [item.id, item]))
  const report = JSON.parse(await readFile(sourceReportPath, 'utf8')) as { results: StoredCase[] }
  const storedCases = report.results.filter((item) => (item.candidates || []).length > 0)

  // 稳定的"错误作品名"来源：按用例顺序取下一个用例的 franchise（不足时回绕）
  const franchises = cases.map((item) => item.franchise).filter((value): value is string => Boolean(value))
  const nextFranchiseOf = (caseItem: CorpusCase): string => {
    const own = caseItem.franchise
    const index = own ? franchises.indexOf(own) : -1
    return franchises[(index + 1 + franchises.length) % franchises.length] || '不存在的作品'
  }

  const albumNameOf = (caseItem: CorpusCase): string =>
    caseItem.franchise
      ? `TVアニメ『${caseItem.franchise}』Original Soundtrack`
      : `${caseItem.title} (Anime Size)`

  const ctxOf = (caseItem: CorpusCase, arm: ArmName): MatchContext => {
    const base: MatchContext = {
      songTitle: caseItem.title,
      artists: caseItem.artists || [],
      songDuration: caseItem.duration,
      platform: caseItem.platform,
      id: caseItem.id,
      targetVersion: caseItem.targetVersion,
    }
    if (arm === 'baseline') return { ...base, franchise: caseItem.franchise }
    if (arm === 'no-franchise') return base
    if (arm === 'wrong-franchise') return { ...base, franchise: caseItem.franchise ? nextFranchiseOf(caseItem) : undefined }
    return { ...base, album: albumNameOf(caseItem) }
  }

  const arms: ArmName[] = ['baseline', 'no-franchise', 'wrong-franchise', 'album-derived']
  const perCase: Array<{
    id: string
    category: string
    targetVersion: string
    franchise?: string
    storedTop1: string
    storedTop1Title: string
    fidelityMaxDelta: number
    arms: Record<ArmName, { top1: string; top1Title: string; top1Score: number; top5: string[]; top1RankOfStoredTop1: number }>
    changes: Partial<Record<ArmName, { changed: boolean; newTitle: string; newScore: number; storedTop1DroppedTo: number }>>
  }> = []
  const fidelityDeltas: number[] = []

  for (const stored of storedCases) {
    const caseItem = corpusById.get(stored.case?.id || (stored as unknown as { id: string }).id)
    if (!caseItem) continue
    const videos = stored.candidates.map((candidate) => candidate.video)
    const durationOverride = detectSongDurationConsensus(videos, {
      songTitle: caseItem.title, artists: caseItem.artists || [], songDuration: caseItem.duration,
    })
    const storedTop1 = stored.candidates[0]
    const storedTop1Bvid = storedTop1?.video?.bvid || ''
    const armResults: Partial<Record<ArmName, ArmResult>> = {}
    let fidelityMaxDelta = 0
    for (const arm of arms) {
      const ctx = ctxOf(caseItem, arm)
      const scored = stored.candidates.map((candidate) => {
        const result = scoreCandidate(candidate.video, ctx, {
          rank: candidate.rank,
          officialVerifyType: candidate.officialVerifyType,
          manualZhSubtitle: candidate.manualZhSubtitle,
          autoSubtitle: candidate.autoSubtitle,
          preference: 'balanced',
          effectiveDuration: candidate.effectiveDuration,
          ccVerification: candidate.ccVerification,
          songDurationOverride: durationOverride,
        })
        if (arm === 'baseline') {
          const delta = Math.abs(result.score - candidate.score)
          fidelityMaxDelta = Math.max(fidelityMaxDelta, delta)
          fidelityDeltas.push(delta)
        }
        return result
      }).sort(compareCandidates)
      armResults[arm] = { arm, ranked: scored, rankedBvids: scored.map((item) => item.video.bvid) }
    }
    const baseline = armResults.baseline!
    const record = {
      id: caseItem.id,
      category: caseItem.category,
      targetVersion: caseItem.targetVersion,
      franchise: caseItem.franchise,
      storedTop1: storedTop1Bvid,
      storedTop1Title: trim(storedTop1?.video?.title || ''),
      fidelityMaxDelta,
      arms: Object.fromEntries(arms.map((arm) => {
        const result = armResults[arm]!
        const top1 = result.ranked[0]
        const storedRank = result.rankedBvids.indexOf(storedTop1Bvid)
        return [arm, {
          top1: top1?.video.bvid || '',
          top1Title: trim(top1?.video.title || ''),
          top1Score: Math.round(top1?.score ?? 0),
          top5: result.rankedBvids.slice(0, 5),
          top1RankOfStoredTop1: storedRank < 0 ? -1 : storedRank + 1,
        }]
      })) as Record<ArmName, { top1: string; top1Title: string; top1Score: number; top5: string[]; top1RankOfStoredTop1: number }>,
      changes: {} as Record<string, { changed: boolean; newTitle: string; newScore: number; storedTop1DroppedTo: number }>,
    }
    for (const arm of arms) {
      const result = record.arms[arm]
      const changed = result.top1 !== record.arms.baseline.top1 && result.top1 !== storedTop1Bvid
      record.changes[arm] = {
        changed,
        newTitle: result.top1Title,
        newScore: result.top1Score,
        storedTop1DroppedTo: result.top1RankOfStoredTop1,
      }
    }
    perCase.push(record)
  }

  const summarize = (arm: ArmName) => {
    const changed = perCase.filter((item) => item.changes[arm]?.changed)
    return {
      arm,
      cases: perCase.length,
      changedTop1: changed.length,
      changedCases: changed.map((item) => ({
        id: item.id,
        category: item.category,
        wasTop1: item.storedTop1Title,
        nowTop1: item.changes[arm]?.newTitle,
        storedTop1NowRank: item.changes[arm]?.storedTop1DroppedTo,
      })),
    }
  }
  const byFidelity = (limit: number) => fidelityDeltas.filter((delta) => delta <= limit).length
  // 排序保真（比分数保真更关键）：留存报告来自 2026-09-01，评分规则此后有演进，
  // 绝对分数必然有差；但「同样的上下文是否仍把当时标注的第一名排在第一位」可以直接检验。
  const keepsStoredTop1 = (arm: ArmName) => perCase.filter((item) => item.arms[arm].top1 === item.storedTop1).length
  const summary = {
    sourceReport: sourceReportPath.split(/[\\/]/).slice(-1)[0],
    casesEvaluated: perCase.length,
    fidelity: {
      maxDelta: Math.max(...fidelityDeltas, 0),
      within2: byFidelity(2),
      within10: byFidelity(10),
      total: fidelityDeltas.length,
    },
    rankFidelity: {
      baselineKeepsStoredTop1: keepsStoredTop1('baseline'),
      noFranchiseKeepsStoredTop1: keepsStoredTop1('no-franchise'),
      wrongFranchiseKeepsStoredTop1: keepsStoredTop1('wrong-franchise'),
      albumDerivedKeepsStoredTop1: keepsStoredTop1('album-derived'),
      cases: perCase.length,
    },
    arms: arms.map(summarize),
    perCase,
  }

  const reportsDir = resolve(root, 'benchmark/bilibili-mv/reports')
  await mkdir(reportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = resolve(reportsDir, `franchise-impact-${stamp}.json`)
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), 'utf8')

  const lines: string[] = []
  lines.push('# MV 匹配 · 专辑→作品名（franchise）离线影响评估', '')
  lines.push('- 数据源：`' + summary.sourceReport + '`（真实采集候选池，' + summary.casesEvaluated + ' 例）')
  lines.push(`- 重打分 fidelity：最大偏差 ${summary.fidelity.maxDelta} 分；≤2 分 ${summary.fidelity.within2}/${summary.fidelity.total}，≤10 分 ${summary.fidelity.within10}/${summary.fidelity.total}（留存报告来自旧版本代码，绝对分必然有差；排序保真见下）`)
  lines.push(`- 排序保真（仍把留存 Top-1 排在第一位）：baseline ${summary.rankFidelity.baselineKeepsStoredTop1}/${summary.rankFidelity.cases}，无 franchise ${summary.rankFidelity.noFranchiseKeepsStoredTop1}，错误 franchise ${summary.rankFidelity.wrongFranchiseKeepsStoredTop1}，专辑推导 ${summary.rankFidelity.albumDerivedKeepsStoredTop1}`)
  lines.push('')
  for (const arm of summary.arms) {
    lines.push(`## ${arm.arm} — Top-1 变化 ${arm.changedTop1}/${arm.cases}`)
    if (!arm.changedCases.length) lines.push('- 无变化')
    for (const item of arm.changedCases) {
      lines.push(`- \`${item.id}\`（${item.category}）: 「${item.wasTop1}」 → 「${item.nowTop1}」（原 Top-1 落到第 ${item.storedTop1NowRank} 位）`)
    }
    lines.push('')
  }
  const mdPath = jsonPath.replace(/\.json$/i, '.md')
  await writeFile(mdPath, lines.join('\n'), 'utf8')
  console.log(lines.join('\n'))
  console.log(`\nreport: ${jsonPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

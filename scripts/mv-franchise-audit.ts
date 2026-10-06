/**
 * 专辑名 → 作品名 提取器 · 真实曲库抽样审计
 *
 * 读入一个 { songs: [{ title, album, artists? }] } JSON（通常从应用 localStorage 的
 * 真实曲库/播放历史导出，不在仓库里），对每首歌跑 extractFranchiseFromAlbum，
 * 输出：命中率、命中清单（专辑名 → 提取结果）、以及按"看起来可疑"排序的复核清单。
 *
 * 用途：评估提取器在真实数据上的误报（假 IP 证据）与漏报，回归时重跑对比。
 * 运行：node scripts/mv-franchise-audit.mjs <library.json>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { extractFranchiseFromAlbum } from '../src/services/mvFranchise'

interface LibrarySong {
  title: string
  album: string
  artists?: string[]
}

const args = process.argv.slice(2)
const inputPath = args.find((arg) => !arg.startsWith('--'))
if (!inputPath) {
  console.error('usage: node scripts/mv-franchise-audit.mjs <library.json> [--output=report.json]')
  process.exit(1)
}
const outputArg = args.find((arg) => arg.startsWith('--output='))?.slice(9)

const data = JSON.parse(await readFile(resolve(inputPath), 'utf8')) as { songs?: LibrarySong[] } | LibrarySong[]
const songs: LibrarySong[] = Array.isArray(data) ? data : data.songs || []

const hits: Array<{ album: string; franchise: string; title: string; artists: string[] }> = []
const misses: string[] = []
for (const song of songs) {
  const franchise = extractFranchiseFromAlbum(song.album, { songTitle: song.title, artists: song.artists })
  if (franchise) hits.push({ album: song.album, franchise, title: song.title, artists: song.artists || [] })
  else misses.push(song.album)
}

/** 可疑命中启发式：作品名里出现周年/纪念/版本类词，或与专辑名长度接近（几乎整名搬用） */
const SUSPICIOUS = /(?:\d+(?:st|nd|rd|th)?\s*(?:anniversary|記念|纪念|周年)|anniversary|記念|周年|special|edition|version|ver\b|size|vol\.?\s*\d+|disc\s*\d+|\bmovie\b|\bfilm\b|\blive\b|tour|concert|festival)/i
const suspicious = hits.filter((hit) => SUSPICIOUS.test(hit.franchise))

const uniqueAlbums = new Set(songs.map((song) => song.album))
console.log(`songs=${songs.length} uniqueAlbums=${uniqueAlbums.size} extracted=${hits.length} (${(hits.length / Math.max(1, songs.length) * 100).toFixed(1)}%)`)
console.log('\n--- 命中清单 ---')
for (const hit of hits) console.log(`「${hit.album}」 → 「${hit.franchise}」  (${hit.title} / ${hit.artists.join(',')})`)
if (suspicious.length) {
  console.log('\n--- 可疑命中（需人工复核：可能是版本/纪念词被当成作品名） ---')
  for (const hit of suspicious) console.log(`「${hit.album}」 → 「${hit.franchise}」`)
}

if (outputArg) {
  const report = {
    generatedAt: new Date().toISOString(),
    input: inputPath,
    songs: songs.length,
    uniqueAlbums: uniqueAlbums.size,
    extracted: hits.length,
    hits,
    suspicious,
    misses: [...new Set(misses)],
  }
  await writeFile(resolve(outputArg), JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nreport: ${resolve(outputArg)}`)
}

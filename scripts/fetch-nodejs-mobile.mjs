/**
 * 拉取 nodejs-mobile v18 安卓发布包并解压到 android/app/libnode/（git 忽略，不入库）。
 * 用法：node scripts/fetch-nodejs-mobile.mjs
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import AdmZip from 'adm-zip'

const VERSION = 'v18.20.4'
const ASSET = `nodejs-mobile-${VERSION}-android.zip`
const DOWNLOAD_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${VERSION}/${ASSET}`

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LIB_NODE = join(ROOT, 'android', 'app', 'libnode')
const ZIP_TMP = join(ROOT, 'node_modules', '.cache', ASSET)

async function download(url, dest, expectedBytes) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`下载失败 HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || expectedBytes
  let received = 0
  const reader = response.body.getReader()
  const ws = createWriteStream(dest)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`)
    if (!ws.write(Buffer.from(value))) {
      await new Promise((resolve) => ws.once('drain', resolve))
    }
  }
  await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())))
  process.stdout.write('\n')
}

function ensureDownloaded() {
  mkdirSync(dirname(ZIP_TMP), { recursive: true })
  if (existsSync(ZIP_TMP) && statSync(ZIP_TMP).size > 10 * 1024 * 1024) {
    console.log(`已存在缓存: ${ZIP_TMP}`)
    return
  }
  console.log(`下载 ${DOWNLOAD_URL} ...`)
  download(DOWNLOAD_URL, ZIP_TMP)
}

function extractLibnode() {
  console.log('解压 libnode.so 与头文件 → android/app/libnode/ ...')
  rmSync(LIB_NODE, { recursive: true, force: true })
  mkdirSync(LIB_NODE, { recursive: true })
  const zip = new AdmZip(ZIP_TMP)
  const entries = zip.getEntries()
  for (const entry of entries) {
    // 只要 bin/<abi>/libnode.so 与 include/node 头文件
    const m = entry.entryName.match(/^(bin\/(?:arm64-v8a|armeabi-v7a|x86_64)\/libnode\.so|include\/node\/.+)$/)
    if (!m || entry.isDirectory) continue
    const out = join(LIB_NODE, m[1])
    mkdirSync(dirname(out), { recursive: true })
    zip.extractEntryTo(entry, dirname(out), false, true)
  }
  console.log('完成。libnode 已就位：')
  for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64']) {
    const p = join(LIB_NODE, 'bin', abi, 'libnode.so')
    console.log(`  - ${p}${existsSync(p) ? '' : '（缺失!）'}`)
  }
}

ensureDownloaded()
extractLibnode()

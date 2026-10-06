// 审计入口：esbuild 打包 TS 后以 node 运行（无网络请求）
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tempDir = resolve(root, '.tmp/mv-franchise-audit')
const runnerPath = resolve(tempDir, 'runner.mjs')
const passthrough = process.argv.slice(2)

await rm(tempDir, { recursive: true, force: true })
await mkdir(tempDir, { recursive: true })
await build({
  entryPoints: [resolve(root, 'scripts/mv-franchise-audit.ts')],
  outfile: runnerPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
})
const child = spawn(process.execPath, [runnerPath, ...passthrough], { stdio: 'inherit', cwd: root })
const code = await new Promise((resolveExit) => child.once('exit', (exitCode) => resolveExit(exitCode ?? 1)))
await rm(tempDir, { recursive: true, force: true })
process.exit(code)

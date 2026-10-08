#!/usr/bin/env node
/**
 * npm install 后置钩子（postinstall）
 *
 * 1. airplay-sender 补丁（chacha20-poly1305 纯 JS fallback + 设备缓冲 0.5s）。
 *    失败不阻断安装（|| true 语义保留）。
 *
 * 2. 下载 castlabs Electron 二进制（node_modules/electron/dist）。
 *    背景：electron 依赖是 castlabs/electron-releases 的 git 依赖（Widevine/VMP 版），
 *    其 package.json 没有自己的 install 脚本，npm 装完包体不会自动下载平台二进制，
 *    必须手动执行其 install.js。缺二进制时 `npm run dev:electron` 会报
 *    "electron.exe: bad option"（ELECTRON_RUN_AS_NODE 兜底路径）或直接无法启动。
 *    下载走 castlabs GitHub Releases；离线/网络失败只打印提示，不阻断安装，
 *    修复网络后重跑 `node node_modules/electron/install.js` 即可。
 */

const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

// ---- 1. airplay 补丁 -------------------------------------------------------
const patch = spawnSync(process.execPath, [path.join(ROOT, 'scripts/patch-airplay-chacha.cjs')], {
  stdio: 'inherit',
  windowsHide: true,
})
if (patch.status !== 0) {
  console.warn('[postinstall] airplay 补丁失败（已忽略，不影响安装）')
}

// ---- 2. castlabs Electron 二进制 ------------------------------------------
const electronDir = path.join(ROOT, 'node_modules', 'electron')
const electronExe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const alreadyInstalled = existsSync(electronExe) &&
  existsSync(path.join(electronDir, 'path.txt'))

if (alreadyInstalled) {
  console.log('[postinstall] Electron 二进制已存在，跳过下载')
  process.exit(0)
}

console.log('[postinstall] 下载 castlabs Electron 二进制（首次安装约 200MB，走 GitHub Releases）…')
const install = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
  stdio: 'inherit',
  windowsHide: true,
  env: process.env,
})

if (install.status !== 0 || !existsSync(electronExe)) {
  console.warn('[postinstall] Electron 二进制下载失败：请检查网络/代理（需访问 github.com）后重跑')
  console.warn('             node node_modules/electron/install.js')
  console.warn('             离线机器可先从其他机器拷贝 node_modules/electron/dist 与 path.txt')
} else {
  console.log('[postinstall] Electron 二进制就绪')
}

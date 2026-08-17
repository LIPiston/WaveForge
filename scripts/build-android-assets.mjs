/**
 * 组装安卓应用资产：
 *  1) vite 以 android 配置构建前端（单入口）→ android/app/src/main/assets/nodejs-project/dist/
 *  2) esbuild 把 android-server.mjs + local-server.mjs + 依赖打成单文件 → .../nodejs-project/main.cjs
 *  3) 递增 MainActivity.kt 的 ASSETS_VERSION，触发设备端重新解压资产
 * 用法：node scripts/build-android-assets.mjs
 */
import { build as viteBuild } from 'vite'
import { build as esbuildBuild } from 'esbuild'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project')
const MAIN_CJS = join(ASSETS_DIR, 'main.cjs')
const MAIN_ACTIVITY = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'waveforge', 'android', 'MainActivity.kt')
// @neteasecloudmusicapienhanced/api 在 require 时会扫描自身 module/ 目录做运行时插件加载，
// 无法被 esbuild 静态打包，因此标记为 external，由设备端 node_modules 提供完整依赖树。
const NETEASE_API_EXTERNAL = '@neteasecloudmusicapienhanced/api'
const NETEASE_API_VERSION = '4.39.0'

/**
 * CJS 输出下 import.meta 不可用（esbuild 置空），而 local-server.mjs 顶层有一句
 * `const __filename = fileURLToPath(import.meta.url)`（该变量实际未被使用）。
 * 打包时把它替换成安全表达式，避免 fileURLToPath('') 在启动时抛错。
 */
const fixImportMetaPlugin = {
  name: 'fix-local-server-import-meta',
  setup(build) {
    build.onLoad({ filter: /local-server\.mjs$/ }, async (args) => {
      const contents = (await readFileSync(args.path, 'utf8')).replace(
        /fileURLToPath\(import\.meta\.url\)/g,
        'process.cwd()'
      )
      return { contents, loader: 'js' }
    })
  },
}

async function buildFrontend() {
  console.log('[1/3] vite build（android 单入口）...')
  await viteBuild({ configFile: join(ROOT, 'vite.android.config.ts') })
}

async function buildServerBundle() {
  console.log('[2/3] esbuild 打包后端单文件 → main.cjs ...')
  const result = await esbuildBuild({
    entryPoints: [join(ROOT, 'android-server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: MAIN_CJS,
    logLevel: 'info',
    plugins: [fixImportMetaPlugin],
    // qq-music-api 内部有运行时动态 require（jade 模板等）也已验证可打包；
    // 仅 netease 增强 API 必须保持 external（见文件顶部注释）。
    external: [NETEASE_API_EXTERNAL],
    // nodejs-mobile 精简构建缺全局 File：undici（fetch 实现）webidl 断言引用 File，
    // 加载即 ReferenceError 崩溃（模拟器/真机启动闪退）。banner 在最顶部执行，
    // 先于 bundle 内任何模块注入 File 全局。
    banner: {
      js:
        "if (typeof globalThis.File === 'undefined') { try { const { File: __wfFile } = require('buffer'); if (__wfFile) globalThis.File = __wfFile; } catch (__e) {} }",
    },
  })
  console.log(`  bundle 完成${result.metafile ? '（' + Object.keys(result.metafile.inputs).length + ' 个输入文件）' : ''}`)
}

/** 设备端 node_modules：安装 netease 增强 API 的生产依赖树（external 包运行所需）。 */
function ensureDeviceNodeModules() {
  const apiDir = join(ASSETS_DIR, 'node_modules', '@neteasecloudmusicapienhanced', 'api')
  if (existsSync(join(apiDir, 'main.js'))) {
    console.log('  设备端 node_modules 已存在，跳过 npm install')
    return
  }
  console.log(`  安装 ${NETEASE_API_EXTERNAL}@${NETEASE_API_VERSION} 到设备端 node_modules ...`)
  execSync(
    `npm install --omit=dev --no-audit --no-fund --prefix "${ASSETS_DIR}" "${NETEASE_API_EXTERNAL}@${NETEASE_API_VERSION}"`,
    { stdio: 'inherit', cwd: ROOT }
  )
}

/** 手机遥控器页面：remote-server.cjs 运行时按 __dirname/remote-ui.html 读取，需随包携带。 */
function copyRemoteUi() {
  const src = join(ROOT, 'desktop', 'remote-ui.html')
  const dest = join(ASSETS_DIR, 'remote-ui.html')
  copyFileSync(src, dest)
  console.log('  已复制 desktop/remote-ui.html → 设备资产')
}

function bumpAssetsVersion() {
  console.log('[3/3] 递增 MainActivity.kt ASSETS_VERSION ...')
  if (!existsSync(MAIN_ACTIVITY)) throw new Error(`找不到 ${MAIN_ACTIVITY}`)
  const src = readFileSync(MAIN_ACTIVITY, 'utf8')
  const matched = src.match(/private const val ASSETS_VERSION = (\d+)/)
  if (!matched) throw new Error('MainActivity.kt 中找不到 ASSETS_VERSION 常量')
  const next = parseInt(matched[1], 10) + 1
  writeFileSync(MAIN_ACTIVITY, src.replace(`private const val ASSETS_VERSION = ${matched[1]}`, `private const val ASSETS_VERSION = ${next}`))
  console.log(`  ASSETS_VERSION ${matched[1]} → ${next}`)
}

async function main() {
  await buildFrontend()
  await buildServerBundle()
  ensureDeviceNodeModules()
  copyRemoteUi()
  bumpAssetsVersion()
  console.log('\n完成。资产目录：', ASSETS_DIR)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

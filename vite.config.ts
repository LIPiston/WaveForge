import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { splitCityData } from './scripts/split-city-data.mjs'

// 在 build/dev 启动前把 country-state-city 的城市数据按国家/地区拆分为独立 JSON 文件，
// locationHierarchy.ts 通过 import.meta.glob 按国家懒加载，避免 8MB 巨型 chunk。
const splitCityDataPlugin = (): Plugin => ({
  name: 'split-city-data',
  buildStart() {
    splitCityData()
  },
  configureServer() {
    splitCityData()
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), splitCityDataPlugin()],
  // 打包版用 loadFile()（file:// 协议）加载 dist/index.html；
  // base 必须是 './'，否则资源以 /assets/... 绝对路径引用，file:// 下会 404 导致整窗黑屏。
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 大块数据均已改为懒加载：最大的常规 chunk 约 500KB，最大的懒加载数据 chunk（城市数据）约 2MB。
    // 阈值设为 2000 让构建输出不再误报（>2MB 仍会告警，便于发现新的体积回归）。
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // 多入口：主应用 + 独立桌面播放器窗口
      input: fs
        .readdirSync(__dirname)
        .filter((file) => file.endsWith('.html'))
        .map((file) => path.resolve(__dirname, file)),
    },
  },
})

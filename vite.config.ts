import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    rollupOptions: {
      // 多入口：主应用 + 独立桌面播放器窗口
      input: fs
        .readdirSync(__dirname)
        .filter((file) => file.endsWith('.html'))
        .map((file) => path.resolve(__dirname, file)),
    },
  },
})

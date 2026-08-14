import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 单测只覆盖纯逻辑，无需浏览器环境
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

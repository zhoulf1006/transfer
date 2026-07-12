import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    // 核心逻辑均为纯 Node 模块,不依赖 Electron / jsdom
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false
  }
})

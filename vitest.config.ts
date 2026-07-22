import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  ssr: {
    // node:sqlite 是内置模块,别让 vite 尝试解析成本地文件
    external: ['node:sqlite']
  },
  test: {
    // 核心逻辑均为纯 Node 模块,不依赖 Electron / jsdom
    environment: 'node',
    include: ['src/**/*.test.ts', 'site/src/**/*.test.ts'],
    globals: false,
    server: {
      deps: {
        // 让 node:sqlite 走原生 require(vitest 不 transform)
        external: [/node:sqlite/]
      }
    }
  }
})

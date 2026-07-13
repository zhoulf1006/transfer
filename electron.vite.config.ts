import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // fastify 等原生依赖不打进 bundle,运行时从 node_modules 加载
        external: ['fastify']
      }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // preload 用 CJS(sandbox/contextIsolation 下 Electron 需要 .cjs,见 index.ts 引用)
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    build: {
      rollupOptions: {
        // 多入口:主窗 index.html + 截图遮罩 overlay.html(见 docs/screenshot-feature §4.1)
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html')
        }
      }
    }
  }
})

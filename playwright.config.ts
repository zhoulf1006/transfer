import { defineConfig } from '@playwright/test'

// e2e 驱动真实 Electron(跑的是 out/ 的构建产物),所以必须先 `electron-vite build`——
// 见 package.json 的 `e2e` 脚本。**读构建产物的取证,产物必须是当次改动的**:
// 测试运行器自己不触发构建,直接跑 playwright 量到的是上一次的产物,那张结果会长得像
// "改了但没生效",诱使去改一个本来正确的修复。
//
// 串行(workers: 1)是保守选择而非硬约束:每个用例都有自己的 userData(launch 时传
// --user-data-dir 到临时目录),单实例锁按 userData 分域,不会互撞;串行真正防的是
// 多个 Electron 实例并行放大时序抖动。
export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']]
})

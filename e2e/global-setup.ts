// e2e 全局准备:macOS 上把 Electron 指向"测试静音"副本(Info.plist 里 LSUIElement=true)。
//
// 为什么必须改 plist 而不是在 JS 里 dock.hide():Dock 图标是 Electron **原生引导期**按 plist
// 注册的,主进程 JS 里的 dock.hide() 要几百毫秒后才跑得到——于是每个实例都会闪一下再消失,
// 一轮 e2e 起若干实例就是 Dock 持续抖动。LSUIElement=true 让它从注册那一刻就是 UIElement
// (无 Dock 图标、无菜单栏),压根没有可闪的窗口期。
//
// 原件不动:副本在 node_modules/.cache/electron-quiet/,测试经 ELECTRON_OVERRIDE_DIST_PATH
// 指过去(electron npm wrapper 的原生机制);`pnpm dev` 与打包版仍用原件,Dock 行为不变。
// 脚本幂等且认版本,Electron 升级后自动重建;非 macOS 是 no-op,此处也不设变量。
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function globalSetup(): void {
  if (process.platform !== 'darwin') return
  execSync('bash scripts/quiet-electron.sh', { stdio: 'inherit' })
  process.env['ELECTRON_OVERRIDE_DIST_PATH'] = resolve('node_modules/.cache/electron-quiet/dist')
}

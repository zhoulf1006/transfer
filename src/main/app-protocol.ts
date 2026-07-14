// 自定义 app:// scheme:让打包版渲染页跑在**标准安全 origin**(app://bundle)上,
// 根治 file:// opaque origin 下 localStorage 首访卡数秒的坑(electron/electron#24441)。
//
// 设计见 docs/app-scheme-migration.md。两步:
//   1) 模块顶层(app ready 前)registerSchemesAsPrivileged —— 由 index.ts 调
//   2) app ready 后 registerAppProtocol —— 把 app://bundle/<path> 映射到 out/renderer/<path>

import { protocol, net } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** app:// 固定 host,承载打包后的渲染产物(out/renderer)。 */
export const APP_HOST = 'bundle'

/**
 * 把 app://bundle/<path> 解析成磁盘绝对路径,并防目录穿越。
 * 返回 null = 非法(host 不对 / 越权 / URL 解析失败)→ 上层回 404。
 * 纯函数,便于单测。
 *
 * @param rendererRoot 打包渲染产物根目录(绝对路径,如 out/renderer)
 * @param url          请求 URL(app://bundle/index.html 等)
 */
export function resolveAppPath(rendererRoot: string, url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.hostname !== APP_HOST) return null
  // decode(容中文/空格路径)+ 自动去查询串/锚点(URL.pathname 不含);去前导 /;空路径回落 index.html
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (p === '') p = 'index.html'
  const abs = normalize(join(rendererRoot, p))
  // 目录穿越防护:normalize 后必须仍落在 rendererRoot 之内。
  // 允许 abs === root 本身(理论上 p 为空已回落 index.html,这里冗余保险);否则要求 abs 以 root+sep 打头。
  const rootNorm = normalize(rendererRoot)
  const rootPrefix = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep
  if (abs !== rootNorm && !abs.startsWith(rootPrefix)) return null
  return abs
}

/**
 * app ready 后调用一次:把 app://bundle/* 映射到 rendererRoot/*。
 * 读盘交给 net.fetch(file://):Electron 自动补 Content-Type、处理不存在→404、支持 Range,
 * 免维护 MIME 表(借鉴 VS Code"交给 Electron 读盘判 MIME",但用新 API protocol.handle)。
 */
export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle('app', async (req) => {
    const abs = resolveAppPath(rendererRoot, req.url)
    if (!abs) return new Response('Not found', { status: 404 })
    try {
      // await 让 net.fetch 的 reject 落进本 catch:某些输入(如路径含 \0)会 reject 而非返 404,
      // 直接 return promise 会漏成 unhandled rejection / errored request;瞬时读盘错误同理。
      return await net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

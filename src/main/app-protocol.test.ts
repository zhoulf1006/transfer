import { test, expect, describe } from 'vitest'
import { join, normalize, sep } from 'node:path'
import { resolveAppPath, APP_HOST } from './app-protocol'

// 用 node path 拼 root,保证跨平台(mac /,win \)。
const ROOT = normalize(join(sep, 'app', 'out', 'renderer'))

describe('resolveAppPath', () => {
  test('正常路径 → root 下对应文件', () => {
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/index.html`)).toBe(join(ROOT, 'index.html'))
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/assets/index-abc.js`)).toBe(
      join(ROOT, 'assets', 'index-abc.js')
    )
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/overlay.html`)).toBe(join(ROOT, 'overlay.html'))
  })

  test('空路径 → 回落 index.html', () => {
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/`)).toBe(join(ROOT, 'index.html'))
    expect(resolveAppPath(ROOT, `app://${APP_HOST}`)).toBe(join(ROOT, 'index.html'))
  })

  test('URL 编码(中文/空格)被 decode', () => {
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/assets/%E4%B8%AD%E6%96%87.png`)).toBe(
      join(ROOT, 'assets', '中文.png')
    )
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/a%20b.js`)).toBe(join(ROOT, 'a b.js'))
  })

  test('查询串/锚点被忽略(不进路径)', () => {
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/index.html?v=1#top`)).toBe(
      join(ROOT, 'index.html')
    )
  })

  describe('目录穿越防护', () => {
    // 关键区分:URL 解析器会**先**归一化 pathname 里未编码的 /../(在我们拿到之前),
    // 所以未编码 ../ 会被吃成 root 内的安全路径(不存在→404),不构成越权;
    // 真正的攻击面是**编码的** ..%2f —— URL 不归一化,decode 后才现形,必须由我们挡下。
    test('编码的 ..%2f 越权 → null(核心攻击面)', () => {
      // pathname 保留为 /..%2f..%2fetc%2fpasswd,decode→ ../../etc/passwd,join 后逃出 root
      expect(resolveAppPath(ROOT, `app://${APP_HOST}/..%2f..%2fetc%2fpasswd`)).toBeNull()
      expect(resolveAppPath(ROOT, `app://${APP_HOST}/assets%2f..%2f..%2f..%2foutside`)).toBeNull()
      // 编码的 ..%2f 恰好逃到 root 同名兄弟目录(renderer-evil):startsWith 加了 sep 分隔,挡下
      expect(resolveAppPath(ROOT, `app://${APP_HOST}/..%2frenderer-evil%2fx`)).toBeNull()
    })

    test('未编码 ../ 被 URL 归一化吃掉 → 落在 root 内(安全,非 null)', () => {
      // new URL 把 /../../etc/passwd 归一成 /etc/passwd,join(root,'etc/passwd') 仍在 root 内。
      // 结果是 root 内一个多半不存在的路径(→404),不是越权,故非 null。
      expect(resolveAppPath(ROOT, `app://${APP_HOST}/../../etc/passwd`)).toBe(
        join(ROOT, 'etc', 'passwd')
      )
    })
  })

  test('路径含 \\0(null byte)→ 不算越权,留在 root 内(由 handler 的 try/catch 兜 fetch reject)', () => {
    // null byte 不是目录穿越,resolveAppPath 不该拦(它只管越权);仍落 root 内。
    // 真正的防线在 registerAppProtocol:net.fetch 对 \0 路径会 reject,handler try/catch → 404。
    expect(resolveAppPath(ROOT, `app://${APP_HOST}/index.html%00.png`)).toBe(
      join(ROOT, 'index.html\x00.png')
    )
  })

  test('host 不对 → null', () => {
    expect(resolveAppPath(ROOT, 'app://foo/index.html')).toBeNull()
    expect(resolveAppPath(ROOT, 'app://evil.com/index.html')).toBeNull()
  })

  test('URL 无法解析 → null', () => {
    expect(resolveAppPath(ROOT, 'not a url')).toBeNull()
  })
})

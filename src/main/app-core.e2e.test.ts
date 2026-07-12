import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AppCore } from './app-core'
import type { PrepareUploadRequest, RemoteDevice } from '@shared/types'

// 端到端:两个 AppCore 实例(不同 port)走 发现 → 发送 → 落盘 全链路。
// 验证装配层(app-core)本身,而非单模块。用非默认端口避免与系统冲突。

function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      const v = fn()
      if (v !== undefined) return resolve(v)
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe('AppCore 端到端', () => {
  const cores: AppCore[] = []
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(cores.map((c) => c.stop()))
    cores.length = 0
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  function mkCore(
    alias: string,
    fingerprint: string,
    httpPort: number,
    askUser: (id: string, req: PrepareUploadRequest, ip: string) => Promise<string[] | false>
  ): { core: AppCore; recvDir: string; devices: () => RemoteDevice[] } {
    const recvDir = mkdtempSync(join(tmpdir(), `core-${alias}-`))
    dirs.push(recvDir)
    let latest: RemoteDevice[] = []
    const core = new AppCore({
      identity: { alias, fingerprint },
      platform: 'darwin',
      receiveDir: recvDir,
      // 同机双实例:多播端口相同(才能互相发现),HTTP 端口不同(才能共存)——DESIGN §7/M5
      multicastPort: 56000,
      httpPort,
      events: {
        onDevicesUpdated: (d) => (latest = d),
        askUser
      }
    })
    cores.push(core)
    return { core, recvDir, devices: () => latest }
  }

  test('A 发现 B 并成功发送文件,B 完整落盘', async () => {
    const a = mkCore('A', 'FP_A', 56317, async () => false)
    const b = mkCore('B', 'FP_B', 56318, async (_id, req) => Object.keys(req.files))

    await a.core.start()
    await b.core.start()

    // A 应发现 B
    const bFp = await waitFor(() => {
      const found = a.devices().find((d) => d.info.fingerprint === 'FP_B')
      return found ? found.info.fingerprint : undefined
    })
    expect(bFp).toBe('FP_B')

    // A 发文件给 B
    const content = randomBytes(4096)
    const srcDir = mkdtempSync(join(tmpdir(), 'core-src-'))
    dirs.push(srcDir)
    const srcPath = join(srcDir, 'payload.bin')
    writeFileSync(srcPath, content)

    const res = await a.core.sendTo('FP_B', [{ id: 'payload.bin', path: srcPath }])
    expect(res.ok).toBe(true)

    const received = readFileSync(join(b.recvDir, 'payload.bin'))
    expect(received.equals(content)).toBe(true)
  })
})

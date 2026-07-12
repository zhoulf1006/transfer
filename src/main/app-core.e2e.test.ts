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
      interfaceAddr: '', // 测试用 OS 默认接口,隔离本机代理网卡
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

  // 端口回退:HTTP 端口被占(如本机已有 LocalSend)时,AppCore 应回退到下一个端口而非崩溃。
  test('HTTP 端口被占用时自动回退到下一个端口', async () => {
    const { createServer } = await import('node:net')
    const busyPort = 57317
    // 用一个裸 TCP server 占住 busyPort
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(busyPort, '0.0.0.0', () => r()))

    try {
      const c = mkCore('C', 'FP_C', busyPort, async () => false)
      await c.core.start()
      // 应回退到 busyPort+1(57318),而非崩在 57317
      expect(c.core.actualHttpPort).toBe(busyPort + 1)
      // announce/selfInfo 的 port 应反映实际端口(对方才能连对)
      const info = await fetch(
        `http://127.0.0.1:${c.core.actualHttpPort}/api/localsend/v2/info`
      ).then((r) => r.json())
      expect(info.port).toBe(busyPort + 1)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})

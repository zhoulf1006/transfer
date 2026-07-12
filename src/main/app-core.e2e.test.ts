import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AppCore } from './app-core'
import { MessageStore, type Message } from './db/messages'
import { SettingsStore } from './settings'
import type { RemoteDevice } from '@shared/types'

// 端到端:两个 AppCore 实例走 发现 → chat 发送 → 自动接收/确认 → 落盘+入库 全链路。
// 验证装配层(app-core + chat-service)。用非默认端口避免与系统冲突。

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

interface Inst {
  core: AppCore
  store: MessageStore
  recvDir: string
  devices: () => RemoteDevice[]
  messages: () => Message[]
  /** onMessageUpserted 收到的状态序列(按消息 id 分组),验证流转 */
  statusSeq: (msgId: string) => string[]
}

describe('AppCore 端到端(聊天)', () => {
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
    autoAccept: boolean
  ): Inst {
    const recvDir = mkdtempSync(join(tmpdir(), `core-${alias}-`))
    const settingsDir = mkdtempSync(join(tmpdir(), `set-${alias}-`))
    dirs.push(recvDir, settingsDir)
    const store = new MessageStore(':memory:')
    const settings = new SettingsStore(settingsDir)
    if (autoAccept) settings.setAutoAccept({ enabled: true, maxBytes: 1024 * 1024 * 1024 })
    let latest: RemoteDevice[] = []
    const seq = new Map<string, string[]>()
    const core = new AppCore({
      identity: { alias, fingerprint },
      platform: 'darwin',
      receiveDir: recvDir,
      multicastPort: 56000,
      interfaceAddr: '', // 测试用 OS 默认接口,隔离本机代理网卡
      httpPort,
      store,
      settings,
      events: {
        onDevicesUpdated: (d) => (latest = d),
        onMessageUpserted: (m) => {
          const arr = seq.get(m.id) ?? []
          arr.push(m.status)
          seq.set(m.id, arr)
        }
      }
    })
    cores.push(core)
    return {
      core,
      store,
      recvDir,
      devices: () => latest,
      messages: () => store.list({ limit: 100 }),
      statusSeq: (id) => seq.get(id) ?? []
    }
  }

  test('A 发现 B 后,自动接收下发文件成功落盘 + 两端入库', async () => {
    const a = mkCore('A', 'FP_A', 56317, false)
    const b = mkCore('B', 'FP_B', 56318, true) // B 自动接收

    await a.core.start()
    await b.core.start()

    await waitFor(() =>
      a.devices().find((d) => d.info.fingerprint === 'FP_B') ? true : undefined
    )

    const content = randomBytes(4096)
    const srcDir = mkdtempSync(join(tmpdir(), 'core-src-'))
    dirs.push(srcDir)
    const srcPath = join(srcDir, 'payload.bin')
    writeFileSync(srcPath, content)

    await a.core.chat.sendFiles('FP_B', [srcPath])

    // B 完整落盘
    const received = readFileSync(join(b.recvDir, 'payload.bin'))
    expect(received.equals(content)).toBe(true)

    // A 侧:sent 文件消息 done
    const aSent = a.messages().find((m) => m.direction === 'sent' && m.type === 'file')
    expect(aSent?.status).toBe('done')

    // B 侧:recv 文件消息 done + 有落盘路径
    const bRecv = b.messages().find((m) => m.direction === 'recv' && m.type === 'file')
    expect(bRecv?.status).toBe('done')
    expect(bRecv?.filePath).toContain('payload.bin')
    // 验证状态流转(不只终态):自动接收路径应是 accepted→done(不经 pending)
    expect(b.statusSeq(bRecv!.id)).toEqual(['accepted', 'done'])
    // A 侧 sent 流转:pending→done
    expect(a.statusSeq(aSent!.id)).toEqual(['pending', 'done'])
  })

  test('文本消息端到端:A 发文本 → B 入流(done),不落文件', async () => {
    const a = mkCore('A2', 'FP_A2', 56319, false)
    const b = mkCore('B2', 'FP_B2', 56320, false) // 文本不受自动接收影响

    await a.core.start()
    await b.core.start()
    await waitFor(() =>
      a.devices().find((d) => d.info.fingerprint === 'FP_B2') ? true : undefined
    )

    await a.core.chat.sendText('FP_B2', '你好,这是端到端文本')

    // B 侧:recv 文本 done,正文正确
    const bText = await waitFor(() => {
      const m = b.messages().find((x) => x.direction === 'recv' && x.type === 'text')
      return m ?? undefined
    })
    expect(bText.content).toBe('你好,这是端到端文本')
    expect(bText.status).toBe('done')

    // A 侧:sent 文本 done
    const aText = a.messages().find((m) => m.direction === 'sent' && m.type === 'text')
    expect(aText?.status).toBe('done')
  })

  test('离线对端:发送失败标 failed(network)', async () => {
    const a = mkCore('A3', 'FP_A3', 56321, false)
    await a.core.start()
    // 未发现任何设备,直接发给不存在的 fingerprint
    await a.core.chat.sendText('FP_NOBODY', 'hello')
    const m = a.messages().find((x) => x.direction === 'sent')
    expect(m?.status).toBe('failed')
    expect(m?.errorReason).toBe('network')
  })

  test('HTTP 端口被占用时自动回退到下一个端口', async () => {
    const { createServer } = await import('node:net')
    const busyPort = 57317
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(busyPort, '0.0.0.0', () => r()))
    try {
      const c = mkCore('C', 'FP_C', busyPort, false)
      await c.core.start()
      expect(c.core.actualHttpPort).toBe(busyPort + 1)
      const info = await fetch(
        `http://127.0.0.1:${c.core.actualHttpPort}/api/localsend/v2/info`
      ).then((r) => r.json())
      expect(info.port).toBe(busyPort + 1)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})

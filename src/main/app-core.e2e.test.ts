import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import selfsigned from 'selfsigned'
import { AppCore } from './app-core'
import { MessageStore, type Message } from './db/messages'
import { SettingsStore } from './settings'
import { certFingerprint } from '@shared/identity'
import type { RemoteDevice } from '@shared/types'

/** GET 一个 https URL 并解析 JSON,接受自签名证书(测试用) */
async function httpsGetJson(url: string): Promise<{ port: number }> {
  const https = await import('node:https')
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      })
      .on('error', reject)
  })
}

/** 生成一份真实身份(EC 证书 + 证书指纹),HTTPS pinning 端到端必须用真证书,不能用假 fingerprint 串 */
async function makeIdentity(alias: string): Promise<{
  alias: string
  fingerprint: string
  cert: string
  privateKey: string
}> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Transfer' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256'
  })
  return { alias, fingerprint: certFingerprint(pems.cert), cert: pems.cert, privateKey: pems.private }
}

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
  /** 本机证书指纹(= 对端发现/发送时用的 key) */
  fp: string
  devices: () => RemoteDevice[]
  messages: () => Message[]
  /** onMessageUpserted 收到的状态序列(按消息 id 分组),验证流转 */
  statusSeq: (msgId: string) => string[]
  /** 收到的进度事件(方向 + sent),验证真实字节进度 */
  progress: (direction: 'send' | 'recv') => number[]
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

  async function mkCore(alias: string, httpPort: number, autoAccept: boolean): Promise<Inst> {
    const identity = await makeIdentity(alias)
    const recvDir = mkdtempSync(join(tmpdir(), `core-${alias}-`))
    const settingsDir = mkdtempSync(join(tmpdir(), `set-${alias}-`))
    dirs.push(recvDir, settingsDir)
    const store = new MessageStore(':memory:')
    const settings = new SettingsStore(settingsDir)
    if (autoAccept) settings.setAutoAccept({ enabled: true, maxBytes: 1024 * 1024 * 1024 })
    let latest: RemoteDevice[] = []
    const seq = new Map<string, string[]>()
    const prog: { direction: 'send' | 'recv'; sent: number }[] = []
    const core = new AppCore({
      identity,
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
        },
        onProgress: (p) => prog.push({ direction: p.direction, sent: p.sent })
      }
    })
    cores.push(core)
    return {
      core,
      store,
      recvDir,
      fp: identity.fingerprint,
      devices: () => latest,
      messages: () => store.list({ limit: 100 }),
      statusSeq: (id) => seq.get(id) ?? [],
      progress: (direction) => prog.filter((p) => p.direction === direction).map((p) => p.sent)
    }
  }

  test('A 发现 B 后,自动接收下发文件成功落盘 + 两端入库', async () => {
    const a = await mkCore('A', 56317, false)
    const b = await mkCore('B', 56318, true) // B 自动接收

    await a.core.start()
    await b.core.start()

    await waitFor(() =>
      a.devices().find((d) => d.info.fingerprint === b.fp) ? true : undefined
    )

    // 256KB → 多个 64KB 读块,产生递增进度帧(4KB 只有单帧,验不出进度)
    const total = 256 * 1024
    const content = randomBytes(total)
    const srcDir = mkdtempSync(join(tmpdir(), 'core-src-'))
    dirs.push(srcDir)
    const srcPath = join(srcDir, 'payload.bin')
    writeFileSync(srcPath, content)

    await a.core.chat.sendFiles(b.fp, [srcPath])

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

    // ── 真实字节进度(§12.3)──
    const sendProg = a.progress('send')
    const recvProg = b.progress('recv')
    // 至少一帧,单调不减,末帧到达 total(终态强推)
    expect(sendProg.length).toBeGreaterThan(0)
    expect(recvProg.length).toBeGreaterThan(0)
    expect(sendProg[sendProg.length - 1]).toBe(total)
    expect(recvProg[recvProg.length - 1]).toBe(total)
    for (let i = 1; i < sendProg.length; i++) expect(sendProg[i]).toBeGreaterThanOrEqual(sendProg[i - 1])
    for (let i = 1; i < recvProg.length; i++) expect(recvProg[i]).toBeGreaterThanOrEqual(recvProg[i - 1])
  })

  test('文本消息端到端:A 发文本 → B 入流(done),不落文件', async () => {
    const a = await mkCore('A2', 56319, false)
    const b = await mkCore('B2', 56320, false) // 文本不受自动接收影响

    await a.core.start()
    await b.core.start()
    await waitFor(() =>
      a.devices().find((d) => d.info.fingerprint === b.fp) ? true : undefined
    )

    await a.core.chat.sendText(b.fp, '你好,这是端到端文本')

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
    const a = await mkCore('A3', 56321, false)
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
      const c = await mkCore('C', busyPort, false)
      await c.core.start()
      expect(c.core.actualHttpPort).toBe(busyPort + 1)
      // HTTPS + 自签名:测试 client 接受自签名(rejectUnauthorized:false)
      const info = await httpsGetJson(
        `https://127.0.0.1:${c.core.actualHttpPort}/api/localsend/v2/info`
      )
      expect(info.port).toBe(busyPort + 1)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})

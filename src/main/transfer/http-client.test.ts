import { test, expect, describe, afterEach } from 'vitest'
import selfsigned from 'selfsigned'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createHttpServer } from './http-server'
import { sendFiles, sendText, type SendTarget } from './http-client'
import { SessionManager } from './session'
import { certFingerprint } from '@shared/identity'
import type { DeviceInfo } from '@shared/types'

const HOST = '127.0.0.1'

async function makeReceiverTls(): Promise<{ tls: { key: string; cert: string }; fingerprint: string }> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Transfer' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256'
  })
  return { tls: { key: pems.private, cert: pems.cert }, fingerprint: certFingerprint(pems.cert) }
}

function selfInfo(): DeviceInfo {
  return {
    alias: 'Tester',
    version: '2.0',
    deviceModel: 'macOS',
    deviceType: 'desktop',
    fingerprint: 'self',
    port: 0,
    protocol: 'https',
    download: false
  }
}

describe('http-client 连接超时 + 错误分类', () => {
  const servers: FastifyInstance[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // 建连级超时:连不上(黑洞 IP,SYN 无人应,模拟对端开 VPN 局域网 IP 被隧道黑洞)
  // → 以 ETIMEDOUT 快速失败,而非干等 T_SENDER_MS(6min)。用 TEST-NET-1(192.0.2.0/24,RFC5737 保留,不可路由)。
  // 注:等 T_CONNECT_MS=10s,故 vitest 超时放宽到 15s。
  test(
    '连不可达 IP → error 且 message 含 ETIMEDOUT(非 6min 挂死)',
    async () => {
      const target: SendTarget = {
        address: '192.0.2.1',
        port: 53317,
        protocol: 'https',
        fingerprint: 'whatever'
      }
      const t0 = Date.now()
      const res = await sendText(target, selfInfo(), 'hi')
      const elapsed = Date.now() - t0
      expect(res.kind).toBe('error')
      if (res.kind === 'error') expect(res.message).toContain('ETIMEDOUT')
      // 远小于 T_SENDER_MS(6min);T_CONNECT_MS=10s + 余量
      expect(elapsed).toBeLessThan(14_000)
    },
    15_000
  )

  // 拒连:端口无人监听 → ECONNREFUSED 快速失败(不到超时)
  test('端口无监听 → error 且 message 含 ECONNREFUSED', async () => {
    // 127.0.0.1 上一个几乎不可能被占的高端口
    const target: SendTarget = {
      address: HOST,
      port: 1,
      protocol: 'https',
      fingerprint: 'whatever'
    }
    const res = await sendText(target, selfInfo(), 'hi')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.message).toContain('ECONNREFUSED')
  })

  // 指纹不符:真 server 但 target.fingerprint 是错的 → destroy(ECERT),message 含 fingerprint
  test('指纹不符 → error 且 message 含 fingerprint', async () => {
    const receiver = await makeReceiverTls()
    const server = createHttpServer({
      sessions: new SessionManager({ now: () => Date.now() }),
      tls: receiver.tls,
      selfInfo,
      receiveDir: () => tmpdir(),
      onPrepareAsk: async () => false
    })
    servers.push(server)
    const address = await server.listen({ host: HOST, port: 0 })
    const port = Number(new URL(address).port)

    const target: SendTarget = {
      address: HOST,
      port,
      protocol: 'https',
      fingerprint: 'DE:AD:BE:EF' // 故意错
    }
    const res = await sendText(target, selfInfo(), 'hi')
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.message.toLowerCase()).toContain('fingerprint')
  })

  // 回归红线(核心):握手成功后,建连级超时(socket.setTimeout(T_CONNECT_MS))必须被清除。
  // 真正会坏的场景是**单个请求内 socket 空闲 > T_CONNECT_MS**(如大文件慢传/接收方慢确认):
  // 若不清除,socket 在等响应期间空闲满 10s → 'timeout' handler destroy 掉 socket → 请求中途失败。
  //
  // 用一个 prepare-upload 响应故意延迟 ~11s(> T_CONNECT_MS)的 server:
  //  - fix 生效(setTimeout(0)):socket 不受建连超时约束,11s 后拿到响应 → done。
  //  - fix 缺失:socket 空闲满 10s 被 destroy → 请求以 socket hang up 失败。
  // (已实测:注释掉 setTimeout(0) 时本测失败 → 证明它真能抓 bug,非假通过。)
  test(
    '单请求内空闲 >10s 不被建连超时误杀(回归红线)',
    async () => {
      const receiver = await makeReceiverTls()
      // 文件走 prepare-upload → onPrepareAsk(文本会走 onTextMessage 直接 204,不经 ask,无法延迟)。
      // 慢确认:延迟 11s(> T_CONNECT_MS)再拒绝,期间发送方 socket 空闲等响应。
      const server = createHttpServer({
        sessions: new SessionManager({ now: () => Date.now() }),
        tls: receiver.tls,
        selfInfo,
        receiveDir: () => tmpdir(),
        onPrepareAsk: async () => {
          await new Promise((r) => setTimeout(r, 11_000))
          return false // 拒绝
        }
      })
      servers.push(server)
      const address = await server.listen({ host: HOST, port: 0 })
      const port = Number(new URL(address).port)
      const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: receiver.fingerprint }

      const srcDir = mkdtempSync(join(tmpdir(), 'hc-slow-'))
      dirs.push(srcDir)
      const filePath = join(srcDir, 'x.bin')
      writeFileSync(filePath, randomBytes(64))

      const t0 = Date.now()
      const res = await sendFiles(target, selfInfo(), [{ id: 'f1', path: filePath }])
      const elapsed = Date.now() - t0
      // 延迟 11s > T_CONNECT_MS(10s):socket 全程空闲等响应。
      //  - fix 生效:socket 未被建连超时 destroy,11s 后拿到 403 → rejected。
      //  - fix 缺失:socket 空闲满 10s 被 destroy → error(socket hang up),约 10s 就失败。
      expect(res.kind).toBe('rejected')
      expect(elapsed).toBeGreaterThan(10_500) // 确实等满了慢确认(证明 socket 未被提前掐断)
    },
    20_000
  )

  // 正常发文件成功路径回归(确保加超时没破坏握手后的正常传输)
  test('正常发文件成功(建连超时不影响正常传输)', async () => {
    const receiver = await makeReceiverTls()
    const recvDir = mkdtempSync(join(tmpdir(), 'hc-recv-'))
    dirs.push(recvDir)
    const server = createHttpServer({
      sessions: new SessionManager({ now: () => Date.now() }),
      tls: receiver.tls,
      selfInfo,
      receiveDir: () => recvDir,
      onPrepareAsk: async (_id, req) => Object.keys(req.files) // 全接受
    })
    servers.push(server)
    const address = await server.listen({ host: HOST, port: 0 })
    const port = Number(new URL(address).port)
    const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: receiver.fingerprint }

    const srcDir = mkdtempSync(join(tmpdir(), 'hc-src-'))
    dirs.push(srcDir)
    const filePath = join(srcDir, 'x.bin')
    writeFileSync(filePath, randomBytes(1024))

    const res = await sendFiles(target, selfInfo(), [{ id: 'f1', path: filePath }])
    expect(res.kind).toBe('done')
  })
})

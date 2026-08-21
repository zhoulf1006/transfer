// 发送端的空闲判定,与 session-idle.test.ts(接收端)对称。
//
// 两条一起才说明问题:
//  ① 慢但**持续**的传输不得被掐断 —— 拿掉 transform 里的 touch 就会红;
//  ② 对端收完却**不回包**仍必须失败 —— 这是 S4 保护,别在修 ① 的时候把它拆了。
// 只写 ① 的话,"永不超时"也能全绿。
import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import https from 'node:https'
import { Writable } from 'node:stream'
import selfsigned from 'selfsigned'
import { httpsUpload, type SendTarget } from './http-client'

const HOST = '127.0.0.1'
const IDLE_MS = 500

let dir: string | null = null
let server: https.Server | null = null

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

/**
 * 限速接收端:按**字节数**折算延迟,而不是每个 chunk 固定停顿。
 * 固定停顿会让实际速率取决于 TLS 记录的大小(实测因此掉到 320KB/s ——
 * 那是个不真实的慢链路,测出来的红是测试自己造的,不是被测代码的问题)。
 */
async function receiver(opts: {
  bytesPerSec?: number
  /** 收完后压这么久再回包(默认立刻) */
  respondAfterMs?: number
}): Promise<number> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'T' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256'
  })
  const rate = opts.bytesPerSec ?? Number.POSITIVE_INFINITY
  const srv = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!Number.isFinite(rate)) return void cb()
        setTimeout(cb, (chunk.length / rate) * 1000)
      }
    })
    req.pipe(sink)
    sink.on('finish', () => {
      setTimeout(
        () => {
          res.statusCode = 200
          res.end()
        },
        opts.respondAfterMs ?? 0
      )
    })
  })
  server = srv
  await new Promise<void>((r) => srv.listen(0, HOST, r))
  return (srv.address() as { port: number }).port
}

function upload(port: number, filePath: string, size: number): Promise<{ status: number }> {
  // 指纹只被 pinnedAgent 用,httpsUpload 自身不校验 —— 这里用不 pin 的 agent,
  // 验的是超时语义而非 pinning(pinning 另有用例)
  const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: 'n/a' }
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false })
  return httpsUpload(agent, target, '/slow', filePath, size, IDLE_MS)
}

function bigFile(mb: number): { path: string; size: number } {
  dir = mkdtempSync(join(tmpdir(), 'upload-idle-'))
  const p = join(dir, 'slow.bin')
  const bytes = randomBytes(mb * 1024 * 1024)
  writeFileSync(p, bytes)
  return { path: p, size: bytes.length }
}

describe('发送端 upload 空闲超时', () => {
  test('慢但持续的传输不被掐断:总时长数倍于空闲阈值仍成功', async () => {
    // 8MB/s 消费 16MB → 约 2s,是 IDLE_MS 的 4 倍;
    // 两次 touch 的间隔 ≈ 已缓冲(实测约 1.4MB)÷ 8MB/s ≈ 175ms,稳在阈值内
    const port = await receiver({ bytesPerSec: 8 * 1024 * 1024 })
    const f = bigFile(16)

    const started = Date.now()
    const res = await upload(port, f.path, f.size)
    const elapsed = Date.now() - started

    expect(res.status).toBe(200)
    // 少了这条,"瞬间传完"的环境会让上面那条恒真 —— 根本没碰到空闲阈值,等于什么都没验
    expect(
      elapsed,
      `总时长 ${elapsed}ms 必须超过空闲阈值 ${IDLE_MS}ms,否则本用例没有验到任何东西`
    ).toBeGreaterThan(IDLE_MS)
  }, 60_000)

  test('对端收完却迟迟不回包 → 按空闲判定失败(S4 保护还在)', async () => {
    // 收得飞快,但压着回包不发,超过阈值数倍
    const port = await receiver({ respondAfterMs: IDLE_MS * 4 })
    const f = bigFile(1)

    await expect(upload(port, f.path, f.size)).rejects.toThrow('upload timeout')
  }, 60_000)
})

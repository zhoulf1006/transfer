// 会话空闲判定:守的是"传输体在流动 = 不算空闲"。
//
// 这条只有把**真实的慢速传输体**灌进真实 http-server 才测得出:session 的单测看不见字节,
// 而 http-client 的单测跑的是快速本地传输,几十毫秒就完事,永远碰不到空闲阈值。
//
// 反向那一半同样要守——真的没有字节流动时,会话仍必须被清理。少了它,"修好误判"很容易
// 滑成"把闸拆了",而两者在正向用例上表现完全一样。
import { test, expect, describe } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import https from 'node:https'
import selfsigned from 'selfsigned'
import { createHttpServer } from './http-server'
import { SessionManager } from './session'
import { EP } from '@shared/protocol'
import type { DeviceInfo } from '@shared/types'

const HOST = '127.0.0.1'
const IDLE_MS = 300
/** 传输体总时长,取 idle 阈值的 4 倍——不修的话必然被判空闲,不靠临界值碰运气 */
const CHUNKS = 12
const GAP_MS = 100

function req(
  port: number,
  path: string,
  body: Buffer | Readable,
  len: number,
  contentType: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: HOST,
        port,
        path,
        method: 'POST',
        rejectUnauthorized: false,
        headers: { 'content-type': contentType, 'content-length': String(len) }
      },
      (res) => {
        const cs: Buffer[] = []
        res.on('data', (c) => cs.push(c as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(cs).toString() }))
      }
    )
    r.on('error', reject)
    if (Buffer.isBuffer(body)) r.end(body)
    else body.pipe(r)
  })
}

/** 慢速传输体:CHUNKS 个 1KB,每 GAP_MS 吐一个 → 总时长 ≈ CHUNKS*GAP_MS */
function slowBody(): { stream: Readable; bytes: Buffer } {
  const one = Buffer.alloc(1024, 7)
  const bytes = Buffer.concat(Array.from({ length: CHUNKS }, () => one))
  let i = 0
  const stream = new Readable({
    read() {
      if (i >= CHUNKS) return void this.push(null)
      i++
      setTimeout(() => this.push(one), GAP_MS)
    }
  })
  return { stream, bytes }
}

interface Harness {
  port: number
  sessions: SessionManager
  fileDone: () => boolean
  sweptIdle: () => boolean
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'T' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256'
  })
  const recvDir = mkdtempSync(join(tmpdir(), 'session-idle-'))
  const sessions = new SessionManager({ now: () => Date.now(), idleTimeoutMs: IDLE_MS })
  let fileDone = false
  let sweptIdle = false

  const server = createHttpServer({
    sessions,
    tls: { key: pems.private, cert: pems.cert },
    selfInfo: () => self('R'),
    receiveDir: () => recvDir,
    // 自动接收开着,这条实际不会被调用;仍给出合法实现,不留一个"只是恰好没跑到"的错类型
    onPrepareAsk: async (_id, r) => Object.keys(r.files),
    shouldAutoAcceptFiles: () => true,
    onFileDone: () => {
      fileDone = true
    }
  })
  const addr = await server.listen({ host: HOST, port: 0 })

  // 与生产同构:定期 sweep 推进超时(app-core 用 T_SWEEP_MS,这里按 idle 阈值等比缩)
  const timer = setInterval(() => {
    if (sessions.sweep().expired === 'idle') sweptIdle = true
  }, Math.max(20, IDLE_MS / 4))

  return {
    port: Number(new URL(addr).port),
    sessions,
    fileDone: () => fileDone,
    sweptIdle: () => sweptIdle,
    close: async () => {
      clearInterval(timer)
      await server.close()
      rmSync(recvDir, { recursive: true, force: true })
    }
  }
}

function self(alias: string): DeviceInfo {
  return {
    alias,
    version: '2.0',
    deviceModel: 'm',
    deviceType: 'desktop',
    fingerprint: `fp-${alias}`,
    port: 0,
    protocol: 'https',
    download: false
  }
}

/** 走真实 prepare-upload 拿 sessionId/token(自动接收开着,不经用户确认) */
async function prepare(
  port: number,
  files: Record<string, { size: number; sha256: string }>
): Promise<{ sessionId: string; tokens: Record<string, string> }> {
  const payload = Buffer.from(
    JSON.stringify({
      info: self('S'),
      files: Object.fromEntries(
        Object.entries(files).map(([id, f]) => [
          id,
          { id, fileName: `${id}.bin`, size: f.size, fileType: 'application/octet-stream', sha256: f.sha256 }
        ])
      )
    })
  )
  const res = await req(port, EP.prepareUpload, payload, payload.length, 'application/json')
  const parsed = JSON.parse(res.body) as { sessionId: string; files: Record<string, string> }
  return { sessionId: parsed.sessionId, tokens: parsed.files }
}

function uploadUrl(sessionId: string, fileId: string, token: string): string {
  return `${EP.upload}?sessionId=${sessionId}&fileId=${fileId}&token=${token}`
}

describe('会话空闲判定', () => {
  test('传输体持续流动时不算空闲:体时长远超阈值仍能收完', async () => {
    const h = await harness()
    try {
      const { stream, bytes } = slowBody()
      const { sessionId, tokens } = await prepare(h.port, {
        f1: { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      })

      const res = await req(
        h.port,
        uploadUrl(sessionId, 'f1', tokens['f1']!),
        stream,
        bytes.length,
        'application/octet-stream'
      )

      expect(res.status, 'upload 应成功').toBe(200)
      // 断这两条而不是只断 status:落盘会话被 sweep 掐掉时 upload 照样回 200
      // (markReceived 发现会话没了只是不触发 onFileDone),只看 status 分辨不出来。
      expect(h.sweptIdle(), '传输期间不得被判空闲').toBe(false)
      expect(h.fileDone(), '收完必须上报完成').toBe(true)
    } finally {
      await h.close()
    }
  }, 30_000)

  /**
   * 幂等重传路径(已收过的 fileId 再传一次)把整个 body 丢弃,期间同样在传字节。
   * 它不走 receiveFileToDir,所以不经过上面那条 touch —— 一条**独立**的路径,
   * 正向用例照不到它。丢弃一个大文件耗时超过阈值时,会话被清掉,
   * **同会话里其他还没收的文件跟着陪葬**(token 失效 → 403),这才是要防的。
   *
   * 我们自己的发送端不重传,但 app 宣称兼容 LocalSend 协议,第三方客户端会。
   */
  test('幂等重传丢弃 body 期间也算有活动:同会话的其他文件不被连坐', async () => {
    const h = await harness()
    try {
      const small = Buffer.alloc(64, 1)
      const smallSha = createHash('sha256').update(small).digest('hex')
      const { stream, bytes } = slowBody()

      const { sessionId, tokens } = await prepare(h.port, {
        f1: { size: small.length, sha256: smallSha },
        f2: { size: small.length, sha256: smallSha }
      })

      // f1 正常收完(会话仍在:f2 还挂着)
      const first = await req(
        h.port,
        uploadUrl(sessionId, 'f1', tokens['f1']!),
        small,
        small.length,
        'application/octet-stream'
      )
      expect(first.status).toBe(200)

      /**
       * f1 再传一次 → 走幂等分支。**不能 await 它**:服务端在 body 丢弃完之前就回了 200,
       * await 会立刻返回,而后台的丢弃才刚开始 —— 那样就压根没走到"丢弃耗时超过阈值"这个条件上
       * (第一版就是这么写的,于是不修也绿)。这里让它在后台跑,自己等过阈值再验。
       */
      const retry = req(
        h.port,
        uploadUrl(sessionId, 'f1', tokens['f1']!),
        stream,
        bytes.length,
        'application/octet-stream'
      )
      // 等到超过空闲阈值数倍,此刻慢速 body 仍在流(总时长 CHUNKS*GAP_MS 更长)
      await new Promise((r) => setTimeout(r, IDLE_MS * 3))

      // 关键:f2 的 token 必须还有效。会话被误清的话这里是 403
      const second = await req(
        h.port,
        uploadUrl(sessionId, 'f2', tokens['f2']!),
        small,
        small.length,
        'application/octet-stream'
      )
      expect(second.status, '会话若被误判空闲清掉,f2 会拿到 403').toBe(200)
      expect(h.sweptIdle(), '丢弃 body 期间不得被判空闲').toBe(false)
      // 收尾:确认重传那一路确实是幂等 200,且此刻才真正传完(证明上面等待期间它还在流)
      await expect(retry).resolves.toMatchObject({ status: 200 })
    } finally {
      await h.close()
    }
  }, 30_000)

  test('真的没有字节流动时,会话仍按空闲清理(闸没被拆掉)', async () => {
    const h = await harness()
    try {
      // 只谈妥、不上传 —— 会话停在 active 且无任何字节
      await prepare(h.port, { f1: { size: 1024, sha256: 'x'.repeat(64) } })
      await new Promise((r) => setTimeout(r, IDLE_MS * 4))

      expect(h.sweptIdle(), '无字节流动的 active 会话必须被清理').toBe(true)
    } finally {
      await h.close()
    }
  }, 30_000)
})

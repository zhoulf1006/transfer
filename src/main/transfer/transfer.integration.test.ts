import { test, expect, describe, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import selfsigned from 'selfsigned'
import type { FastifyInstance } from 'fastify'
import { createHttpServer } from './http-server'
import { sendFiles, sendText, cancelSession, registerTo, type SendTarget } from './http-client'
import { SessionManager } from './session'
import { certFingerprint } from '@shared/identity'
import type { DeviceInfo, PrepareUploadRequest } from '@shared/types'

const HOST = '127.0.0.1'

/** 接收方证书(EC 自签名)+ 其指纹:发送方 target.fingerprint 必须 = 它,pinning 才通过 */
async function makeReceiverTls(): Promise<{ tls: { key: string; cert: string }; fingerprint: string }> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Transfer' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256'
  })
  return { tls: { key: pems.private, cert: pems.cert }, fingerprint: certFingerprint(pems.cert) }
}

function selfInfo(alias: string, fp: string): DeviceInfo {
  return {
    alias,
    version: '2.0',
    deviceModel: 'macOS',
    deviceType: 'desktop',
    fingerprint: fp,
    port: 0,
    protocol: 'https',
    download: false
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** POST JSON 到 https(接受自签名)。返回响应 JSON。测试直连 server 用。 */
async function httpsPostJson(
  url: string,
  body: unknown
): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
  const https = await import('node:https')
  const payload = Buffer.from(JSON.stringify(body))
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        rejectUnauthorized: false,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(text) as Record<string, unknown>
          })
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/** 发起 https POST 但返回可主动 abort 的句柄(模拟发送方中途断开)。接受自签名。 */
async function httpsPostAbortable(
  url: string,
  body: unknown
): Promise<{ done: Promise<void>; abort: () => void }> {
  const https = await import('node:https')
  const payload = Buffer.from(JSON.stringify(body))
  const u = new URL(url)
  const req = https.request({
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    rejectUnauthorized: false,
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length) }
  })
  const done = new Promise<void>((resolve) => {
    req.on('response', (res) => {
      res.on('data', () => {})
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve()) // abort 触发的 error 也算结束
  })
  req.write(payload)
  req.end()
  return { done, abort: () => req.destroy() }
}

/** 轮询直到条件成立(替代固定 sleep 猜时序,避免 flaky) */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('文件收发(集成)', () => {
  let server: FastifyInstance
  let recvDir: string
  let sendDir: string
  let target: SendTarget
  let sessions: SessionManager
  let cancelledCount: number
  let receivedTexts: string[]
  let uploadCount: number
  let autoAcceptImpl: (files: PrepareUploadRequest['files']) => boolean
  // 控制接收方"弹框"决策
  let askImpl: (req: PrepareUploadRequest) => Promise<string[] | false>

  beforeEach(async () => {
    recvDir = mkdtempSync(join(tmpdir(), 'transfer-recv-'))
    sendDir = mkdtempSync(join(tmpdir(), 'transfer-send-'))
    sessions = new SessionManager({ now: () => Date.now() })
    cancelledCount = 0
    receivedTexts = []
    autoAcceptImpl = () => false // 默认不自动接收
    askImpl = async (req) => Object.keys(req.files) // 默认全接受

    const receiver = await makeReceiverTls()
    server = createHttpServer({
      sessions,
      tls: receiver.tls,
      selfInfo: () => selfInfo('Receiver', receiver.fingerprint),
      receiveDir: () => recvDir,
      onPrepareAsk: (_id, req) => askImpl(req),
      onSessionCancelled: () => cancelledCount++,
      onTextMessage: (text) => receivedTexts.push(text),
      shouldAutoAcceptFiles: (files) => autoAcceptImpl(files)
    })
    // 计数 upload 路由调用(验证文本不产生 upload)
    uploadCount = 0
    server.addHook('onRequest', async (req) => {
      if (req.url.includes('/upload?')) uploadCount++
    })
    const address = await server.listen({ host: HOST, port: 0 })
    const port = Number(new URL(address).port)
    // target.fingerprint = 接收方证书指纹 → pinning 通过
    target = { address: HOST, port, protocol: 'https', fingerprint: receiver.fingerprint }
  })

  afterEach(async () => {
    await server.close()
    rmSync(recvDir, { recursive: true, force: true })
    rmSync(sendDir, { recursive: true, force: true })
  })

  function makeFile(name: string, bytes: number): { id: string; path: string; content: Buffer } {
    const content = randomBytes(bytes)
    const path = join(sendDir, name)
    writeFileSync(path, content)
    return { id: name, path, content }
  }

  test('单文件收发:落盘字节完全一致', async () => {
    const f = makeFile('hello.bin', 5000)
    const res = await sendFiles(target, selfInfo('Sender', 'FP_SEND'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('done')
    const received = readFileSync(join(recvDir, 'hello.bin'))
    expect(received.equals(f.content)).toBe(true)
    expect(sha256(received)).toBe(sha256(f.content))
  })

  test('多文件并行收发:全部完整落盘(B2)', async () => {
    const files = [makeFile('a.bin', 3000), makeFile('b.bin', 7000), makeFile('c.bin', 1500)]
    const res = await sendFiles(
      target,
      selfInfo('Sender', 'FP_SEND'),
      files.map((f) => ({ id: f.id, path: f.path }))
    )
    expect(res.kind).toBe('done')
    if (res.kind === 'done') expect(res.sent.sort()).toEqual(['a.bin', 'b.bin', 'c.bin'])
    for (const f of files) {
      const got = readFileSync(join(recvDir, f.id))
      expect(got.equals(f.content)).toBe(true)
    }
  })

  test('接收方拒绝 → sender 得到 rejected,不产生文件', async () => {
    askImpl = async () => false
    const f = makeFile('x.bin', 1000)
    const res = await sendFiles(target, selfInfo('Sender', 'FP_SEND'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('rejected')
    expect(() => readFileSync(join(recvDir, 'x.bin'))).toThrow()
  })

  test('部分接受:只落盘被接受的文件', async () => {
    askImpl = async () => ['keep.bin'] // 只接受 keep
    const keep = makeFile('keep.bin', 2000)
    const drop = makeFile('drop.bin', 2000)
    const res = await sendFiles(target, selfInfo('Sender', 'FP_SEND'), [
      { id: keep.id, path: keep.path },
      { id: drop.id, path: drop.path }
    ])
    expect(res.kind).toBe('done')
    expect(readFileSync(join(recvDir, 'keep.bin')).equals(keep.content)).toBe(true)
    expect(() => readFileSync(join(recvDir, 'drop.bin'))).toThrow()
  })

  test('并发会话:第二个发送方拿到 busy(409)', async () => {
    // 让第一个 ask 挂起,占住会话
    let releaseFirst: () => void = () => {}
    askImpl = (req) =>
      new Promise((resolve) => {
        releaseFirst = () => resolve(Object.keys(req.files))
      })

    const f1 = makeFile('first.bin', 1000)
    const f2 = makeFile('second.bin', 1000)
    const p1 = sendFiles(target, selfInfo('S1', 'FP1'), [{ id: f1.id, path: f1.path }])

    // 等第一个会话进入 pending(轮询,不猜固定时长)
    await waitUntil(() => sessions.current?.phase === 'pending')
    const res2 = await sendFiles(target, selfInfo('S2', 'FP2'), [{ id: f2.id, path: f2.path }])
    expect(res2.kind).toBe('busy')

    releaseFirst()
    expect((await p1).kind).toBe('done')
  })

  test('重名文件自动加后缀,不覆盖', async () => {
    const first = makeFile('dup.bin', 1000)
    await sendFiles(target, selfInfo('S', 'FP'), [{ id: first.id, path: first.path }])
    // 再发一个 basename 同为 dup.bin 但内容不同的文件(放在独立子目录避免本地覆盖)
    const secondContent = randomBytes(1200)
    const secondDir = mkdtempSync(join(tmpdir(), 'transfer-send2-'))
    const secondPath = join(secondDir, 'dup.bin')
    writeFileSync(secondPath, secondContent)
    await sendFiles(target, selfInfo('S', 'FP'), [{ id: 'dup.bin', path: secondPath }])
    rmSync(secondDir, { recursive: true, force: true })

    expect(readFileSync(join(recvDir, 'dup.bin')).equals(first.content)).toBe(true)
    expect(readFileSync(join(recvDir, 'dup (1).bin')).equals(secondContent)).toBe(true)
  })

  test('cancel 端点不报错', async () => {
    await expect(cancelSession(target, 'no-such-session')).resolves.toBeUndefined()
  })

  // P1 回归:发送方在接收方弹框挂起期间断开 → respond 后检测到连接已断 → 回滚会话,
  // 不留孤儿(否则后续 prepare 会被 409 挡住直到 idle 超时)。
  test('挂起期间发送方断开 → 会话回滚,不挡后续(P1)', async () => {
    let releaseAsk: (ids: string[]) => void = () => {}
    askImpl = () => new Promise<string[]>((resolve) => (releaseAsk = resolve))

    // 发起 prepare 后立即 abort(模拟发送方超时断开)
    const prepareUrl = `https://${HOST}:${target.port}/api/localsend/v2/prepare-upload`
    const { done, abort } = await httpsPostAbortable(prepareUrl, {
      info: selfInfo('S', 'FP'),
      files: { f1: { id: 'f1', fileName: 'a.bin', size: 1, fileType: 'application/octet-stream' } }
    })

    // 等会话进入 pending,再断开连接
    await waitUntil(() => sessions.current?.phase === 'pending')
    abort()
    await done
    await new Promise((r) => setTimeout(r, 50)) // 让 abort 传播到 server socket

    // 用户此时才"接受" → respond 推进 ACTIVE,但连接已断 → server 应 onCancel 回滚
    releaseAsk(['f1'])
    // 会话应被释放(而非悬挂在 ACTIVE)
    await waitUntil(() => sessions.current === null)
    expect(sessions.current).toBeNull()

    // 后续正常发送不被 409 挡住
    askImpl = async (req) => Object.keys(req.files)
    const f = makeFile('after.bin', 500)
    const res = await sendFiles(target, selfInfo('S2', 'FP2'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('done')
  })

  // cancel 端到端:传输中途发送方 cancel → 会话清理 + onSessionCancelled 通知(§9 验收 6)
  test('发送方 cancel 会话 → 清理并通知(cancel 端到端)', async () => {
    const f = makeFile('c.bin', 1000)
    const res = await sendFiles(target, selfInfo('S', 'FP'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('done')
    // done 后会话已自然清理;这里验证一个 active 会话被 cancel 的通知路径:
    // 构造一个挂起接受、拿到 sessionId 后 cancel
    let sid = ''
    askImpl = async (req) => Object.keys(req.files)
    const g = makeFile('d.bin', 1000)
    // 手动走 prepare 拿 sessionId
    const prep = await httpsPostJson(
      `https://${HOST}:${target.port}/api/localsend/v2/prepare-upload`,
      {
        info: selfInfo('S', 'FP'),
        files: { [g.id]: { id: g.id, fileName: 'd.bin', size: 1000, fileType: 'application/octet-stream' } }
      }
    )
    sid = (await prep.json()).sessionId as string
    expect(sessions.current?.phase).toBe('active')
    await cancelSession(target, sid)
    expect(sessions.current).toBeNull()
    expect(cancelledCount).toBeGreaterThanOrEqual(1)
  })

  // S2 回归:同一会话内并发上传两个同名(basename)不同内容的文件,
  // 不能相互覆盖(原 existsSync 去重有 TOCTOU)。两个文件都应完整落盘为不同名字。
  test('同会话并发同名文件不互相覆盖(S2)', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'send-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'send-b-'))
    const contentA = randomBytes(8000)
    const contentB = randomBytes(9000)
    writeFileSync(join(dirA, 'same.bin'), contentA)
    writeFileSync(join(dirB, 'same.bin'), contentB)

    const res = await sendFiles(target, selfInfo('Sender', 'FP_SEND'), [
      { id: 'fileA', path: join(dirA, 'same.bin') },
      { id: 'fileB', path: join(dirB, 'same.bin') }
    ])
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    expect(res.kind).toBe('done')

    // 两份内容都必须完整存在(名字为 same.bin 和 same (1).bin,顺序不定)
    const got = [
      readFileSync(join(recvDir, 'same.bin')),
      readFileSync(join(recvDir, 'same (1).bin'))
    ]
    const gotHashes = got.map((b) => sha256(b)).sort()
    const wantHashes = [sha256(contentA), sha256(contentB)].sort()
    expect(gotHashes).toEqual(wantHashes)
  })

  // ── 聊天 UI 传输层(§11.2)──────────────────────────────

  test('文本消息:走 prepare-upload 直接入流,不产生 upload,对方回 204', async () => {
    let askCalled = false
    askImpl = async (req) => {
      askCalled = true
      return Object.keys(req.files)
    }
    const res = await sendText(target, selfInfo('Sender', 'FP_SEND'), '你好,这是一条消息')
    expect(res.kind).toBe('done')
    expect(receivedTexts).toEqual(['你好,这是一条消息'])
    expect(askCalled).toBe(false) // 文本不询问用户
    expect(sessions.current).toBeNull() // accepted-empty 后会话已清理
    expect(uploadCount).toBe(0) // 真断言:文本不产生任何 upload 请求(§11.2)
  })

  test('文本消息:会话立即释放,不挡后续传输', async () => {
    await sendText(target, selfInfo('S', 'FP'), 'msg1')
    // 紧接着发文件应正常(单会话锁已释放)
    const f = makeFile('after-text.bin', 1000)
    const res = await sendFiles(target, selfInfo('S', 'FP'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('done')
    expect(readFileSync(join(recvDir, 'after-text.bin')).equals(f.content)).toBe(true)
  })

  // 回归:连发两条相同文本,接收端应收到两条(曾只收到一条 = 第二条被去重/挡掉)
  test('文本消息:连发两条相同内容都应收到', async () => {
    const r1 = await sendText(target, selfInfo('S', 'FP'), 'hi')
    const r2 = await sendText(target, selfInfo('S', 'FP'), 'hi')
    expect(r1.kind).toBe('done')
    expect(r2.kind).toBe('done')
    expect(receivedTexts).toEqual(['hi', 'hi'])
  })

  test('自动接收开启:文件不询问用户,直接落盘', async () => {
    autoAcceptImpl = () => true // 全部自动接收
    let askCalled = false
    askImpl = async (req) => {
      askCalled = true
      return Object.keys(req.files)
    }
    const f = makeFile('auto.bin', 3000)
    const res = await sendFiles(target, selfInfo('S', 'FP'), [{ id: f.id, path: f.path }])
    expect(res.kind).toBe('done')
    expect(askCalled).toBe(false) // 自动接收,未询问
    expect(readFileSync(join(recvDir, 'auto.bin')).equals(f.content)).toBe(true)
  })

  test('自动接收关闭:文件仍走用户确认', async () => {
    autoAcceptImpl = () => false
    let askCalled = false
    askImpl = async (req) => {
      askCalled = true
      return Object.keys(req.files)
    }
    const f = makeFile('manual.bin', 1000)
    await sendFiles(target, selfInfo('S', 'FP'), [{ id: f.id, path: f.path }])
    expect(askCalled).toBe(true) // 关闭时必须询问
  })

  // 双向发现"用法 A":定向 POST /register 回应,拿回对方 info(替代 UDP 多播回应)
  test('registerTo:定向 POST /register 成功 → 拿回对方 info,并触发对方 onRegister', async () => {
    let registered: string | null = null
    // 重建 server 以挂 onRegister(默认 setup 没挂)
    await server.close()
    const rx = await makeReceiverTls()
    server = createHttpServer({
      sessions,
      tls: rx.tls,
      selfInfo: () => selfInfo('Receiver', rx.fingerprint),
      receiveDir: () => recvDir,
      onPrepareAsk: (_id, req) => askImpl(req),
      onSessionCancelled: () => cancelledCount++,
      onTextMessage: (text) => receivedTexts.push(text),
      shouldAutoAcceptFiles: (files) => autoAcceptImpl(files),
      onRegister: (info) => (registered = info.fingerprint)
    })
    const address = await server.listen({ host: HOST, port: 0 })
    // register 走不 pin 的 discoveryAgent(B1),fingerprint 占位即可
    target = {
      address: HOST,
      port: Number(new URL(address).port),
      protocol: 'https',
      fingerprint: rx.fingerprint
    }

    const peer = await registerTo(target, selfInfo('Sender', 'FP_SEND'))
    expect(peer?.fingerprint).toBe(rx.fingerprint) // 拿回对方(server)的 info
    expect(registered).toBe('FP_SEND') // 对方 onRegister 收到我们的 fingerprint
  })

  test('registerTo:目标不可达 → 静默返 null,不抛', async () => {
    // 连一个没人监听的端口(afterEach 会关真 server;这里直接指一个死端口)
    const dead: SendTarget = { address: HOST, port: 1, protocol: 'https', fingerprint: 'x' }
    const peer = await registerTo(dead, selfInfo('Sender', 'FP_SEND'))
    expect(peer).toBeNull()
  })
})

// TLS 指纹 pinning(HTTPS 改造核心安全断言,docs/https-migration.md §3.6)。
// 独立 describe:各自起 server,精确控制 target.fingerprint。
describe('TLS 指纹 pinning', () => {
  let server: FastifyInstance
  let recvDir: string
  let sendDir: string
  let port: number
  let realFp: string

  beforeEach(async () => {
    recvDir = mkdtempSync(join(tmpdir(), 'pin-recv-'))
    sendDir = mkdtempSync(join(tmpdir(), 'pin-send-'))
    const rx = await makeReceiverTls()
    realFp = rx.fingerprint
    server = createHttpServer({
      sessions: new SessionManager({ now: () => Date.now() }),
      tls: rx.tls,
      selfInfo: () => selfInfo('Receiver', rx.fingerprint),
      receiveDir: () => recvDir,
      onPrepareAsk: async (_id, req) => Object.keys(req.files), // 全接受
      onSessionCancelled: () => {},
      onTextMessage: () => {},
      shouldAutoAcceptFiles: () => false
    })
    const address = await server.listen({ host: HOST, port: 0 })
    port = Number(new URL(address).port)
  })

  afterEach(async () => {
    await server.close()
    rmSync(recvDir, { recursive: true, force: true })
    rmSync(sendDir, { recursive: true, force: true })
  })

  function file(): { id: string; path: string } {
    const p = join(sendDir, 'x.bin')
    writeFileSync(p, randomBytes(500))
    return { id: 'x.bin', path: p }
  }

  test('指纹匹配 → 传输成功', async () => {
    const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: realFp }
    const res = await sendFiles(target, selfInfo('S', 'FP_S'), [file()])
    expect(res.kind).toBe('done')
  })

  test('指纹不匹配 → pinning 拒绝,传输失败(不落盘)', async () => {
    const wrong = realFp.replace(/[0-9A-F]/, (c) => (c === 'A' ? 'B' : 'A')) // 改一位
    const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: wrong }
    const res = await sendFiles(target, selfInfo('S', 'FP_S'), [file()])
    expect(res.kind).toBe('error')
    // 未落盘
    expect(existsSync(join(recvDir, 'x.bin'))).toBe(false)
  })

  test('空指纹 → fail-closed,传输失败(B3)', async () => {
    const target: SendTarget = { address: HOST, port, protocol: 'https', fingerprint: '' }
    const res = await sendFiles(target, selfInfo('S', 'FP_S'), [file()])
    expect(res.kind).toBe('error')
  })
})

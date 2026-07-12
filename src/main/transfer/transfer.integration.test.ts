import { test, expect, describe, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { createHttpServer } from './http-server'
import { sendFiles, sendText, cancelSession, type SendTarget } from './http-client'
import { SessionManager } from './session'
import type { DeviceInfo, PrepareUploadRequest } from '@shared/types'

const HOST = '127.0.0.1'

function selfInfo(alias: string, fp: string): DeviceInfo {
  return {
    alias,
    version: '2.0',
    deviceModel: 'macOS',
    deviceType: 'desktop',
    fingerprint: fp,
    port: 0,
    protocol: 'http',
    download: false
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
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

    server = createHttpServer({
      sessions,
      selfInfo: () => selfInfo('Receiver', 'FP_RECV'),
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
    target = { address: HOST, port, protocol: 'http' }
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
    const ctrl = new AbortController()
    const prepareUrl = `http://${HOST}:${target.port}/api/localsend/v2/prepare-upload`
    const p = fetch(prepareUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        info: selfInfo('S', 'FP'),
        files: { f1: { id: 'f1', fileName: 'a.bin', size: 1, fileType: 'application/octet-stream' } }
      }),
      signal: ctrl.signal
    }).catch(() => undefined)

    // 等会话进入 pending,再断开连接
    await waitUntil(() => sessions.current?.phase === 'pending')
    ctrl.abort()
    await p
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
    const prep = await fetch(`http://${HOST}:${target.port}/api/localsend/v2/prepare-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        info: selfInfo('S', 'FP'),
        files: { [g.id]: { id: g.id, fileName: 'd.bin', size: 1000, fileType: 'application/octet-stream' } }
      })
    })
    sid = (await prep.json()).sessionId
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
})

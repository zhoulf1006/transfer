import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import { ChatService } from './chat-service'
import { MessageStore, type Message } from './db/messages'
import { SettingsStore } from './settings'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceInfo, PrepareUploadRequest, FileMeta } from '@shared/types'
import type { SendResult, SendTextResult, SendTarget } from './transfer/http-client'

// fake 定时器:手动触发,验证超时
class FakeTimers {
  private timers: { fn: () => void; cleared: boolean }[] = []
  set(fn: () => void): { clear: () => void } {
    const t = { fn, cleared: false }
    this.timers.push(t)
    return {
      clear: () => {
        t.cleared = true
      }
    }
  }
  fireAll(): void {
    for (const t of this.timers) if (!t.cleared) t.fn()
  }
  activeCount(): number {
    return this.timers.filter((t) => !t.cleared).length
  }
}

function peer(fp: string): DeviceInfo {
  return { alias: `Dev-${fp}`, version: '2.0', fingerprint: fp }
}

function fileReq(fp: string, files: Record<string, Partial<FileMeta>>): PrepareUploadRequest {
  const full: Record<string, FileMeta> = {}
  for (const [id, f] of Object.entries(files)) {
    full[id] = { id, fileName: f.fileName ?? `${id}.bin`, size: f.size ?? 100, fileType: f.fileType ?? 'application/octet-stream', ...f }
  }
  return { info: peer(fp), files: full }
}

describe('ChatService', () => {
  let store: MessageStore
  let settings: SettingsStore
  let timers: FakeTimers
  let upserted: Message[]
  let dirWritable: boolean
  let sendFilesResult: SendResult
  let sendTextResult: SendTextResult
  let onlinePeers: Set<string>
  let chat: ChatService
  let dirs: string[]

  beforeEach(() => {
    store = new MessageStore(':memory:')
    const sdir = mkdtempSync(join(tmpdir(), 'cs-'))
    dirs = [sdir]
    settings = new SettingsStore(sdir)
    timers = new FakeTimers()
    upserted = []
    dirWritable = true
    sendFilesResult = { kind: 'done', sessionId: 's', sent: [] }
    sendTextResult = { kind: 'done' }
    onlinePeers = new Set(['P'])

    chat = new ChatService({
      store,
      settings,
      sender: {
        sendFiles: async () => sendFilesResult,
        sendText: async () => sendTextResult
      },
      resolvePeer: (fp) =>
        onlinePeers.has(fp)
          ? { target: { address: '1.1.1.1', port: 1, protocol: 'http' } as SendTarget, alias: `Dev-${fp}` }
          : null,
      isReceiveDirWritable: () => dirWritable,
      onMessageUpserted: (m) => upserted.push(m),
      setTimer: (fn) => timers.set(fn),
      acceptTimeoutMs: 1000
    })
  })

  afterEach(() => {
    store.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  // ── 文本接收 ──
  test('handleIncomingText 入库 recv done,正文可见', () => {
    chat.handleIncomingText('你好', peer('P'))
    const m = store.list()[0]
    expect(m.type).toBe('text')
    expect(m.direction).toBe('recv')
    expect(m.status).toBe('done')
    expect(m.content).toBe('你好')
  })

  // ── 挂起 resolver 表 ──
  test('askUser 挂起 + respond(accept) → resolve fileIds + 消息转 accepted', async () => {
    const req = fileReq('P', { f1: {} })
    const p = chat.askUser('T1', req, '1.1.1.1')
    // 入库 pending
    expect(store.list()[0].status).toBe('pending')
    chat.respond('T1', true)
    expect(await p).toEqual(['f1']) // resolve 真实 fileId
    expect(store.list()[0].status).toBe('accepted')
  })

  test('respond(reject) → resolve false + 消息 rejected', async () => {
    const p = chat.askUser('T1', fileReq('P', { f1: {} }), '1.1.1.1')
    chat.respond('T1', false)
    expect(await p).toBe(false)
    expect(store.list()[0].status).toBe('rejected')
  })

  test('超时 → resolve false + 消息 expired', async () => {
    const p = chat.askUser('T1', fileReq('P', { f1: {} }), '1.1.1.1')
    timers.fireAll() // 触发超时
    expect(await p).toBe(false)
    expect(store.list()[0].status).toBe('expired')
  })

  test('重复 respond 静默忽略(不二次改状态)', async () => {
    const p = chat.askUser('T1', fileReq('P', { f1: {} }), '1.1.1.1')
    chat.respond('T1', true)
    await p
    chat.respond('T1', false) // 第二次:key 已清 → no-op
    expect(store.list()[0].status).toBe('accepted') // 未被改成 rejected
  })

  test('respond 后 timer 被清理(不再触发超时)', async () => {
    const p = chat.askUser('T1', fileReq('P', { f1: {} }), '1.1.1.1')
    chat.respond('T1', true)
    await p
    expect(timers.activeCount()).toBe(0) // timer 已 clear
  })

  test('未知 transferId 的 respond → no-op', () => {
    chat.respond('nonexistent', true) // 不抛错
    expect(store.list()).toHaveLength(0)
  })

  test('shutdown 把挂起会话 reject + 消息 expired', async () => {
    const p = chat.askUser('T1', fileReq('P', { f1: {} }), '1.1.1.1')
    chat.shutdown()
    expect(await p).toBe(false)
    expect(store.list()[0].status).toBe('expired')
    expect(timers.activeCount()).toBe(0)
  })

  // ── ③-A:fileId 精确关联落盘 ──
  test('handleFileDone 按 fileId 精确匹配转 done + 填路径', async () => {
    const p = chat.askUser('T1', fileReq('P', { fA: { fileName: 'a.bin' } }), '1.1.1.1')
    chat.respond('T1', true)
    await p
    chat.handleFileDone('fA', '/downloads/a.bin')
    const m = store.list()[0]
    expect(m.status).toBe('done')
    expect(m.filePath).toBe('/downloads/a.bin')
  })

  test('③-A:并发两文件,filePath 按 fileId 精确对应(不张冠李戴)', async () => {
    // 自动接收开。用可区分 fileName 让"哪个 fileId 对应哪个路径"可被断言。
    settings.setAutoAccept({ enabled: true, maxBytes: 1e9 })
    // fA→alpha.bin,fB→beta.bin;入库顺序 fA 先 fB 后
    chat.handleAutoAccept(
      fileReq('P', { fA: { fileName: 'alpha.bin' }, fB: { fileName: 'beta.bin' } }).files,
      peer('P')
    )
    // 关键:先落盘 fB(乱序),再落盘 fA —— 旧的"取最新 accepted"逻辑会把 fB 的路径配给 fA 那条消息
    chat.handleFileDone('fB', '/d/BETA_PATH')
    chat.handleFileDone('fA', '/d/ALPHA_PATH')
    const msgs = store.list()
    const alpha = msgs.find((m) => m.fileName === 'alpha.bin')!
    const beta = msgs.find((m) => m.fileName === 'beta.bin')!
    // 精确断言:alpha.bin 的消息必须拿到 fA 的路径,beta.bin 拿到 fB 的路径
    expect(alpha.filePath).toBe('/d/ALPHA_PATH')
    expect(beta.filePath).toBe('/d/BETA_PATH')
    expect(alpha.status).toBe('done')
    expect(beta.status).toBe('done')
  })

  // ── ③-C:落盘失败转 failed ──
  test('③-C:handleFileFailed 把消息转 failed(不留已接收假象)', async () => {
    const p = chat.askUser('T1', fileReq('P', { fA: {} }), '1.1.1.1')
    chat.respond('T1', true)
    await p
    chat.handleFileFailed('fA', 'enospc')
    const m = store.list()[0]
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('enospc')
  })

  // ── ①-A:目录不可写不自动收 ──
  test('①-A:接收目录不可写 → 不自动接收(退回询问)', () => {
    settings.setAutoAccept({ enabled: true, maxBytes: 1e9 })
    dirWritable = false
    expect(chat.shouldAutoAcceptFiles(fileReq('P', { f1: {} }).files)).toBe(false)
  })

  test('目录可写 + 阈值内 → 自动接收', () => {
    settings.setAutoAccept({ enabled: true, maxBytes: 1000 })
    dirWritable = true
    expect(chat.shouldAutoAcceptFiles(fileReq('P', { f1: { size: 500 } }).files)).toBe(true)
  })

  test('超阈值 → 不自动接收', () => {
    settings.setAutoAccept({ enabled: true, maxBytes: 1000 })
    expect(chat.shouldAutoAcceptFiles(fileReq('P', { f1: { size: 2000 } }).files)).toBe(false)
  })

  test('文本消息不自动接收(另走 handleIncomingText)', () => {
    settings.setAutoAccept({ enabled: true, maxBytes: 1e9 })
    expect(chat.shouldAutoAcceptFiles(fileReq('P', { f1: { fileType: 'text', preview: 'x' } }).files)).toBe(false)
  })

  // ── 发送 ──
  test('sendText 成功 → sent done', async () => {
    sendTextResult = { kind: 'done' }
    const m = await chat.sendText('P', 'hi')
    expect(m.direction).toBe('sent')
    expect(m.status).toBe('done')
  })

  test('sendText 离线 → failed(network)', async () => {
    onlinePeers.clear()
    const m = await chat.sendText('P', 'hi')
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('network')
  })

  test('sendFiles 对方 busy → failed(busy)', async () => {
    sendFilesResult = { kind: 'busy' }
    const [m] = await chat.sendFiles('P', ['/tmp/x.bin'])
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('busy')
  })

  test('sendFiles 对方拒绝 → rejected', async () => {
    sendFilesResult = { kind: 'rejected' }
    const [m] = await chat.sendFiles('P', ['/tmp/x.bin'])
    expect(m.status).toBe('rejected')
  })

  // ── 发送串行化 ──
  test('同 peer 发送串行化(顺序保证)', async () => {
    const order: string[] = []
    let resolve1: () => void
    const gate = new Promise<void>((r) => (resolve1 = r))
    chat = new ChatService({
      store,
      settings,
      sender: {
        sendText: async (_t, text) => {
          if (text === 'first') await gate
          order.push(text)
          return { kind: 'done' }
        },
        sendFiles: async () => sendFilesResult
      },
      resolvePeer: () => ({ target: {} as SendTarget, alias: 'P' }),
      isReceiveDirWritable: () => true,
      onMessageUpserted: () => {},
      setTimer: (fn) => timers.set(fn)
    })
    const p1 = chat.sendText('P', 'first')
    const p2 = chat.sendText('P', 'second')
    // second 不能先于 first(串行)
    resolve1!()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first', 'second'])
  })

  // ── 启动过期 ──
  test('onStartup 把遗留 pending 标 expired', () => {
    store.insert({
      id: 'old', type: 'file', direction: 'recv', peerFp: 'P', peerAlias: 'P',
      content: null, fileName: 'x', fileSize: 1, filePath: null,
      status: 'pending', errorReason: null, transferId: 'T'
    })
    chat.onStartup()
    expect(store.get('old')?.status).toBe('expired')
  })
})

import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import type { ProgressPayload } from '@shared/ipc'
import { ChatService, classifyError, classifySendError } from './chat-service'
import { MessageStore } from './db/messages'
import type { Message } from '@shared/message'
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
  let sentPaths: string[]
  let senderCalls: number

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
    sentPaths = []
    senderCalls = 0

    chat = new ChatService({
      store,
      settings,
      sender: {
        sendFiles: async (_t, files) => {
          senderCalls++
          sentPaths = files.map((f) => f.path)
          // 复刻真实行为(已实测):createReadStream 对目录**打开成功**,首次读取时才发
          // stream error(EISDIR: illegal operation on a directory, read)。修复前目录会
          // 走到这里,错误经 classifyError 兜底成 'network' —— 正是用户看到的"网络错误"。
          const dir = sentPaths.find((p) => p.includes('folder'))
          if (dir) return { kind: 'error', message: `EISDIR: illegal operation on a directory, read '${dir}'` }
          return sendFilesResult
        },
        sendText: async () => sendTextResult
      },
      resolvePeer: (fp) =>
        onlinePeers.has(fp)
          ? { target: { address: '1.1.1.1', port: 1, protocol: 'https', fingerprint: 'fp' } as SendTarget, alias: `Dev-${fp}` }
          : null,
      isReceiveDirWritable: () => dirWritable,
      // 假 fs:路径含 folder 即视为目录(真实实现用 statSync().isDirectory())
      isDirectory: (p) => p.includes('folder'),
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

  test('sendText 离线 → failed(offline)', async () => {
    onlinePeers.clear()
    const m = await chat.sendText('P', 'hi')
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('offline')
  })

  test('sendFiles 离线 → failed(offline)', async () => {
    onlinePeers.clear()
    const [m] = await chat.sendFiles('P', ['/tmp/x.bin'])
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('offline')
  })

  // 文件夹(含 macOS 的包,如 .app/.pages,访达里显示成单个文件但实际是目录)不受支持。
  // 修复前:目录被当普通文件送进 sender,createReadStream 抛 EISDIR,classifyError 兜底
  // 归成 'network' —— 用户看到"网络错误",与真实原因毫无关系。
  test('sendFiles 文件夹 → failed(directory),不是泛化的 network', async () => {
    const [m] = await chat.sendFiles('P', ['/tmp/some-folder'])
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('directory')
  })

  // sendFiles 把整批交给 sender 并把同一个 status 套用到批内所有消息,所以修复前
  // 一个文件夹会把同批的正常文件一起拖成失败。目录必须在组批之前就被剔除。
  test('sendFiles 混选 → 文件夹单独失败,同批普通文件照常发送', async () => {
    const msgs = await chat.sendFiles('P', ['/tmp/a.bin', '/tmp/some-folder', '/tmp/b.bin'])
    const byName = Object.fromEntries(msgs.map((m) => [m.fileName, m]))
    expect(byName['some-folder'].status).toBe('failed')
    expect(byName['some-folder'].errorReason).toBe('directory')
    expect(byName['a.bin'].status).toBe('done')
    expect(byName['b.bin'].status).toBe('done')
    // 关键:目录必须在组批之前被剔除,绝不能进入发往对端的批次。
    // 断言注入的 sender 收到什么,是对**外部边界(发往对端的内容)**的行为契约,
    // 不是内部调用计数——这条豁免"断言内部调用"红旗。批内顺序是偶然的、非需求,
    // 故只断集合成员不断顺序。
    expect(sentPaths).not.toContain('/tmp/some-folder')
    expect(sentPaths).toEqual(expect.arrayContaining(['/tmp/a.bin', '/tmp/b.bin']))
    expect(sentPaths).toHaveLength(2)
  })

  // 全是目录时无可发送内容:必须提前返回,不与对端建立任何会话
  // (否则平白开一次 prepare-upload,还可能占住对方的单会话锁)。
  test('sendFiles 全是文件夹 → 全部失败且完全不联系对端', async () => {
    const msgs = await chat.sendFiles('P', ['/tmp/folder-a', '/tmp/folder-b'])
    expect(msgs.every((m) => m.status === 'failed')).toBe(true)
    expect(msgs.every((m) => m.errorReason === 'directory')).toBe(true)
    // 断"一次都没调用",不是断"收到空数组"——后者区分不出"去掉早退、用空批次
    // 联系了对端"这种退化。同上,这是外部边界的行为契约,豁免"断言内部调用"红旗。
    expect(senderCalls).toBe(0)
  })

  // 返回顺序必须与入参一致:内部按"目录/可发送"分流后再合并,调用方不应感知这层重排。
  test('sendFiles 返回顺序与入参一致(内部分流对调用方透明)', async () => {
    const paths = ['/tmp/folder-1', '/tmp/a.bin', '/tmp/folder-2', '/tmp/b.bin']
    const msgs = await chat.sendFiles('P', paths)
    expect(msgs.map((m) => m.fileName)).toEqual(['folder-1', 'a.bin', 'folder-2', 'b.bin'])
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

  // ── 发送失败错误细分(连接超时/拒连/证书,主治对端开 VPN 连不上)──
  test('sendText 连接超时 → failed(timeout)', async () => {
    sendTextResult = { kind: 'error', message: 'prepare-upload failed: connect ETIMEDOUT' }
    const m = await chat.sendText('P', 'hi')
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('timeout')
  })

  test('sendText 对方未监听 → failed(refused)', async () => {
    sendTextResult = { kind: 'error', message: 'connect ECONNREFUSED 1.1.1.1:53317' }
    const m = await chat.sendText('P', 'hi')
    expect(m.errorReason).toBe('refused')
  })

  test('sendText 证书不符 → failed(cert-mismatch)', async () => {
    sendTextResult = { kind: 'error', message: 'fingerprint mismatch: AA != BB' }
    const m = await chat.sendText('P', 'hi')
    expect(m.errorReason).toBe('cert-mismatch')
  })

  test('sendFiles 连接超时 → failed(timeout)', async () => {
    sendFilesResult = { kind: 'error', message: 'connect ETIMEDOUT' }
    const [m] = await chat.sendFiles('P', ['/tmp/x.bin'])
    expect(m.status).toBe('failed')
    expect(m.errorReason).toBe('timeout')
  })

  test('sendText 其他网络错误 → failed(network)', async () => {
    sendTextResult = { kind: 'error', message: 'socket hang up' }
    const m = await chat.sendText('P', 'hi')
    expect(m.errorReason).toBe('network')
  })

  // classifyError 直接单测:关键词 → errorReason
  test('classifyError 关键词映射', () => {
    expect(classifyError('connect ETIMEDOUT')).toBe('timeout')
    expect(classifyError('request timeout')).toBe('timeout')
    expect(classifyError('connect ECONNREFUSED 1.1.1.1:1')).toBe('refused')
    expect(classifyError('fingerprint mismatch: AA != BB')).toBe('cert-mismatch')
    expect(classifyError('no peer certificate')).toBe('cert-mismatch')
    expect(classifyError('Error: ECERT xyz')).toBe('cert-mismatch')
    expect(classifyError('socket hang up')).toBe('network')
    expect(classifyError('')).toBe('network')
  })

  // 结构化分类(#21):失败来源的 HTTP 状态码 / Node 错误码在冒泡时被保留,
  // 分类不再靠猜关键词。旧的 classifyError 只在无结构信息时兜底。
  describe('classifySendError — 结构化分类', () => {
    test('协议状态码各自可辨,不再一律"网络错误"', () => {
      expect(classifySendError({ message: 'x', status: 400 })).toBe('protocol')
      expect(classifySendError({ message: 'x', status: 401 })).toBe('pin-required')
      expect(classifySendError({ message: 'x', status: 429 })).toBe('rate-limited')
      expect(classifySendError({ message: 'x', status: 500 })).toBe('peer-error')
    })

    test('本地文件错误各自可辨:文件已不存在 / 无读取权限', () => {
      expect(classifySendError({ message: 'x', code: 'ENOENT' })).toBe('file-missing')
      expect(classifySendError({ message: 'x', code: 'EACCES' })).toBe('no-permission')
      expect(classifySendError({ message: 'x', code: 'EPERM' })).toBe('no-permission')
    })

    test('传输层错误码优先于关键词猜测', () => {
      expect(classifySendError({ message: 'x', code: 'ETIMEDOUT' })).toBe('timeout')
      expect(classifySendError({ message: 'x', code: 'ECONNREFUSED' })).toBe('refused')
      expect(classifySendError({ message: 'x', code: 'ECERT' })).toBe('cert-mismatch')
    })

    test('无结构信息时退回关键词匹配(旧行为不变)', () => {
      expect(classifySendError({ message: 'connect ETIMEDOUT' })).toBe('timeout')
      expect(classifySendError({ message: 'socket hang up' })).toBe('network')
    })

    test('未知状态码/错误码落 network,但那时兜底是诚实的', () => {
      expect(classifySendError({ message: 'x', status: 418 })).toBe('network')
      expect(classifySendError({ message: 'x', code: 'EWHATEVER' })).toBe('network')
    })

    // in 运算符会走原型链:'toString' in TABLE 为 true,取出来是函数而非 ErrorReason。
    // 类型断言拦不住这个,界面会拿到函数渲染成乱码。必须用 Object.hasOwn。
    test('原型链上的键不被误当作已处理(toString/constructor)', () => {
      expect(classifySendError({ message: 'x', code: 'toString' })).toBe('network')
      expect(classifySendError({ message: 'x', code: 'constructor' })).toBe('network')
      expect(classifySendError({ message: 'x', code: 'hasOwnProperty' })).toBe('network')
    })

    // 403/409 在 http-client 就被译成 rejected/busy,不该走到分类函数;
    // 万一走到,也不能被误判成别的原因。
    test('403/409 不由本函数处理(上游已译成 rejected/busy)', () => {
      expect(classifySendError({ message: 'x', status: 403 })).toBe('network')
      expect(classifySendError({ message: 'x', status: 409 })).toBe('network')
    })
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
      isDirectory: () => false,
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

// ── 传输进度(§12.3):节流 + 终态强推 + 方向 ────────────────────
describe('ChatService 进度', () => {
  let store: MessageStore
  let settings: SettingsStore
  let dirs: string[]
  let clock: number
  let progress: ProgressPayload[]
  let sendProgressDriver: ((cb: (fileId: string, sent: number, total: number) => void, fileId: string) => void) | null
  let chat: ChatService

  beforeEach(() => {
    store = new MessageStore(':memory:')
    const sdir = mkdtempSync(join(tmpdir(), 'csp-'))
    dirs = [sdir]
    settings = new SettingsStore(sdir)
    clock = 0
    progress = []
    sendProgressDriver = null
    chat = new ChatService({
      store,
      settings,
      sender: {
        // sender 在 upload 期间用 fileId(=msgId)驱动进度回调
        sendFiles: async (_t, files, onProgress) => {
          if (sendProgressDriver && onProgress) {
            for (const f of files) sendProgressDriver(onProgress, f.id)
          }
          return { kind: 'done', sessionId: 's', sent: files.map((f) => f.id) }
        },
        sendText: async () => ({ kind: 'done' })
      },
      resolvePeer: () => ({ target: { address: '1.1.1.1', port: 1, protocol: 'https', fingerprint: 'fp' } as SendTarget, alias: 'P' }),
      isReceiveDirWritable: () => true,
      isDirectory: () => false,
      fileSize: () => 1000,
      onMessageUpserted: () => {},
      onProgress: (p) => progress.push(p),
      now: () => clock
    })
  })

  afterEach(() => {
    store.close()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  test('接收进度:按 fileId 精确关联 recv 消息,方向为 recv', () => {
    // 自动接收路径入库 accepted + 建 fileId→msgId 映射
    chat.handleAutoAccept(fileReq('P', { fA: { fileName: 'a.bin', size: 1000 } }).files, peer('P'))
    chat.handleReceiveProgress('fA', 500, 1000)
    // elapsedMs 为 null 是**有信息量的**:这条 recv 消息没走过 pending→accepted,
    // 也就没有起点可算 —— 拿不到起点时宁可不显示,不能拿 createdAt 硬凑一个数
    expect(progress).toEqual([
      { messageId: expect.any(String), sent: 500, total: 1000, direction: 'recv', elapsedMs: null }
    ])
    // 未知 fileId 静默忽略
    chat.handleReceiveProgress('unknown', 1, 2)
    expect(progress).toHaveLength(1)
  })

  test('节流:100ms 内多次进度只推首次;时间推进后再推', () => {
    chat.handleAutoAccept(fileReq('P', { fA: { size: 1000 } }).files, peer('P'))
    clock = 0
    chat.handleReceiveProgress('fA', 100, 1000) // 推
    chat.handleReceiveProgress('fA', 200, 1000) // 节流丢弃(同 tick)
    clock = 50
    chat.handleReceiveProgress('fA', 300, 1000) // 距上次 50ms<100 → 丢弃
    clock = 150
    chat.handleReceiveProgress('fA', 400, 1000) // 距上次 150ms≥100 → 推
    expect(progress.map((p) => p.sent)).toEqual([100, 400])
  })

  test('终态 100% 强制推(即使在节流窗口内),不丢完成帧', () => {
    chat.handleAutoAccept(fileReq('P', { fA: { size: 1000 } }).files, peer('P'))
    clock = 0
    chat.handleReceiveProgress('fA', 100, 1000) // 推(t=0)
    clock = 10 // 节流窗口内
    chat.handleReceiveProgress('fA', 1000, 1000) // 100% → 强制推
    expect(progress.map((p) => p.sent)).toEqual([100, 1000])
  })

  test('发送进度:fileId===msgId,方向为 send;fileSize 入库', async () => {
    sendProgressDriver = (cb, fileId) => {
      clock = 0
      cb(fileId, 500, 1000)
      clock = 200
      cb(fileId, 1000, 1000) // 完成
    }
    const [m] = await chat.sendFiles('P', ['/tmp/x.bin'])
    expect(m.fileSize).toBe(1000) // fileSize 入库
    const sendEvents = progress.filter((p) => p.direction === 'send')
    expect(sendEvents.map((p) => p.sent)).toEqual([500, 1000])
    // messageId 与该发送消息一致
    expect(new Set(sendEvents.map((p) => p.messageId))).toEqual(new Set([m.id]))
  })

  // 2-C 回归(可达场景版):传输失败后,发送方**重试同一文件**(LocalSend 重试复用同 fileId,
  // 新 prepare-upload → handleAutoAccept 走真实路径重建映射)→ 新消息首帧不被旧节流残留吞掉。
  // 若节流状态按 fileId 键控且终态不清理,同 fileId、同 clock=0 的首帧会撞旧窗口被丢——此测锁死。
  // (原测法直写私有 recvFileMsg 构造"同 msgId 重映射",该状态公开接口不可达,已改为真实重试路径;
  //  终态清理由 upsert 收口与 handleFileFailed 双保险,其公开可达后果即本场景。)
  test('失败后同一 fileId 重试(2-C):新消息首帧立即推,不被旧节流残留吞掉', () => {
    // 接收一个文件:入库 accepted + fileId→msgId 映射
    chat.handleAutoAccept(fileReq('P', { fX: { size: 1000 } }).files, peer('P'))
    const msgId = store.list()[0].id
    clock = 0
    chat.handleReceiveProgress('fX', 300, 1000) // 推 30%(写入节流时间戳=0)
    expect(progress.map((p) => p.sent)).toEqual([300])
    // 落盘失败 → handleFileFailed → updateStatus(failed) + 清映射与节流状态
    chat.handleFileFailed('fX', 'enospc')
    expect(store.get(msgId)?.status).toBe('failed')
    // 发送方重试:同 fileId 再次 prepare-upload → 新消息 + 真实路径重建映射
    chat.handleAutoAccept(fileReq('P', { fX: { size: 1000 } }).files, peer('P'))
    progress.length = 0
    clock = 0 // 同一时刻,故意撞旧节流窗口
    chat.handleReceiveProgress('fX', 100, 1000)
    expect(progress.map((p) => p.sent)).toEqual([100]) // 首帧推出,无残留污染
  })
})

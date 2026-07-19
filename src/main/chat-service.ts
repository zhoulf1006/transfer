// 聊天编排:消息持久化 + 发送/接收/确认 + 挂起 resolver 表(见 docs/DESIGN §11.2)
//
// 与 Electron 解耦:发送通过注入的 sender,UI 通知通过 onMessageUpserted 回调。
// 挂起 resolver 表(transferId → resolve)的完整生命周期在此管理(建/清/重复/退出)。

import { randomUUID } from 'node:crypto'
import type { DeviceInfo, PrepareUploadRequest } from '@shared/types'
import { T_ACCEPT_MS } from '@shared/protocol'
import { MessageStore, type Message, type ErrorReason } from './db/messages'
import { SettingsStore } from './settings'
import { isTextMessage } from './transfer/text-message'
import type { SendTarget, SendResult, SendTextResult } from './transfer/http-client'

export interface ChatSender {
  sendFiles: (
    target: SendTarget,
    files: { id: string; path: string }[],
    onProgress?: (fileId: string, sent: number, total: number) => void
  ) => Promise<SendResult>
  sendText: (target: SendTarget, text: string) => Promise<SendTextResult>
}

export interface ChatServiceDeps {
  store: MessageStore
  settings: SettingsStore
  sender: ChatSender
  /** 解析对端(fingerprint → 连接目标 + alias);离线返回 null */
  resolvePeer: (fingerprint: string) => { target: SendTarget; alias: string } | null
  /** 接收目录是否可写(自动接收前预检,①-A) */
  isReceiveDirWritable: () => boolean
  /** 取本地文件字节数(发送消息入库时填 fileSize);不存在返回 null */
  fileSize?: (path: string) => number | null
  /** 单条消息新增/更新时通知 UI */
  onMessageUpserted: (msg: Message) => void
  /** 传输进度通知 UI(不落库,§12.3):messageId + 已传/总字节 + 方向 */
  onProgress?: (p: { messageId: string; sent: number; total: number; direction: 'send' | 'recv' }) => void
  /** 注入时钟(测试) */
  now?: () => number
  /** 确认超时(默认 T_ACCEPT_MS);测试可缩短 */
  acceptTimeoutMs?: number
  /** 定时器工厂(测试可注入 fake) */
  setTimer?: (fn: () => void, ms: number) => { clear: () => void }
}

interface PendingResolver {
  resolve: (accepted: string[] | false) => void
  timer: { clear: () => void }
  messageIds: string[]
  /** 该会话请求的全部 fileId(接受时 resolve 它们) */
  fileIds: string[]
}

/**
 * 把 http-client 发送失败的错误串映射成细分 errorReason,让 UI 能给出明确文案
 * (而非一律"失败")。error 冒泡到此处只剩 message 字符串,故按关键词匹配:
 *  - ETIMEDOUT / timeout → 连接超时(主 case:对端开 VPN 时局域网 IP 被隧道黑洞)
 *  - ECONNREFUSED       → 对方未在监听(应用未开)
 *  - ECERT / fingerprint / certificate → 证书不匹配(安全语义)
 *  - 其他               → 泛化 network
 * 见 docs/send-preflight-probe.md。
 */
export function classifyError(message: string): ErrorReason {
  const m = message.toLowerCase()
  if (m.includes('etimedout') || m.includes('timeout')) return 'timeout'
  if (m.includes('econnrefused')) return 'refused'
  if (m.includes('ecert') || m.includes('fingerprint') || m.includes('certificate'))
    return 'cert-mismatch'
  return 'network'
}

export class ChatService {
  private readonly d: ChatServiceDeps
  private readonly acceptTimeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void }
  /** 进度节流用的时钟(注入可测,默认 Date.now) */
  private readonly nowMs: () => number
  /** transferId → 挂起 resolver(DESIGN §11.2.2) */
  private readonly pending = new Map<string, PendingResolver>()
  /** 进度节流:messageId → 上次推送时间戳,避免刷爆 IPC(§12.6) */
  private readonly lastProgressAt = new Map<string, number>()
  /**
   * fileId → recv 消息 id(③-A 修复):精确关联"落盘完成/失败"到入库消息,
   * 避免同名/并发文件靠 fileName 匹配导致 filePath 张冠李戴。落盘 done/failed 后删。
   */
  private readonly recvFileMsg = new Map<string, string>()
  /** 发送方本地串行化:peerFp → 上一个发送的 Promise(DESIGN §11.2.3) */
  private readonly sendQueues = new Map<string, Promise<unknown>>()

  constructor(deps: ChatServiceDeps) {
    this.d = deps
    this.acceptTimeoutMs = deps.acceptTimeoutMs ?? T_ACCEPT_MS
    this.nowMs = deps.now ?? Date.now
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms)
        return { clear: () => clearTimeout(id) }
      })
  }

  /** App 启动:把遗留 pending 消息标 expired(挂起会话已随上次进程消失) */
  onStartup(): void {
    const n = this.d.store.expireAllPending()
    if (n > 0) {
      // 不逐条推 UI(启动时 UI 会全量拉);仅确保 DB 状态正确
    }
  }

  /** 终态集合:进入这些状态后传输已结束,清理节流状态防泄漏(2-C) */
  private static readonly TERMINAL = new Set(['done', 'failed', 'rejected', 'expired'])

  private upsert(msg: Message): void {
    // 消息进入终态 → 清理进度节流条目(覆盖发送失败/拒绝/超时、接收 total=0 等所有路径,
    // 这些路径不会有 sent>=total 的完成帧来触发 emitProgress 里的清理)
    if (ChatService.TERMINAL.has(msg.status)) this.lastProgressAt.delete(msg.id)
    this.d.onMessageUpserted(msg)
  }

  // ── 接收方:http-server 的 onPrepareAsk / onTextMessage / shouldAutoAccept 由此提供 ──

  /** 文本消息到达(已由 http-server 识别):入库即 done 显示 */
  handleIncomingText(text: string, from: DeviceInfo): void {
    const msg = this.d.store.insert({
      id: randomUUID(),
      type: 'text',
      direction: 'recv',
      peerFp: from.fingerprint,
      peerAlias: from.alias,
      content: text,
      fileName: null,
      fileSize: null,
      filePath: null,
      status: 'done',
      errorReason: null,
      transferId: null
    })
    this.upsert(msg)
  }

  /** 自动接收的文件请求到达:入库 recv accepted 消息 + 建 fileId 映射(落盘完成/失败据此精确关联) */
  handleAutoAccept(files: PrepareUploadRequest['files'], from: DeviceInfo): void {
    for (const [fileId, meta] of Object.entries(files)) {
      const msg = this.d.store.insert({
        id: randomUUID(),
        type: 'file',
        direction: 'recv',
        peerFp: from.fingerprint,
        peerAlias: from.alias,
        content: null,
        fileName: meta.fileName,
        fileSize: meta.size,
        filePath: null,
        status: 'accepted',
        errorReason: null,
        transferId: null
      })
      this.recvFileMsg.set(fileId, msg.id) // ③-A:精确关联
      this.upsert(msg)
    }
  }

  /**
   * 自动接收判定(注入 http-server 的 shouldAutoAcceptFiles)。
   * ①-A:自动接收前预检接收目录可写,不可写则不自动收(退回询问),避免无人值守落盘失败。
   */
  shouldAutoAcceptFiles(files: PrepareUploadRequest['files']): boolean {
    if (isTextMessage(files)) return false // 文本另走 handleIncomingText
    if (!this.d.isReceiveDirWritable()) return false // 目录不可写 → 退回询问
    // 所有文件都满足阈值才自动收(任一超阈值则询问)
    return Object.values(files).every((f) => this.d.settings.shouldAutoAccept(f.size))
  }

  /**
   * 文件 prepare-upload 到达,需用户确认(挂起模型)。
   * 建 pending resolver + 入库 pending 文件消息 + 通知 UI,返回挂起 Promise。
   */
  askUser(transferId: string, req: PrepareUploadRequest, _fromIp: string): Promise<string[] | false> {
    // 为每个文件入库一条 pending recv 消息
    const messageIds: string[] = []
    for (const [fileId, meta] of Object.entries(req.files)) {
      const msg = this.d.store.insert({
        id: randomUUID(),
        type: 'file',
        direction: 'recv',
        peerFp: req.info.fingerprint,
        peerAlias: req.info.alias,
        content: null,
        fileName: meta.fileName,
        fileSize: meta.size,
        filePath: null,
        status: 'pending',
        errorReason: null,
        transferId
      })
      messageIds.push(msg.id)
      this.recvFileMsg.set(fileId, msg.id) // ③-A:精确关联
      this.upsert(msg)
    }

    const fileIds = Object.keys(req.files)
    return new Promise<string[] | false>((resolve) => {
      const timer = this.setTimer(() => {
        // 超时:reject(403)+ 标 expired
        this.finishPending(transferId, 'expired')
      }, this.acceptTimeoutMs)
      this.pending.set(transferId, { resolve, timer, messageIds, fileIds })
    })
  }

  /** 用户在聊天流点接收/拒绝(IPC message:respond)。重复/过期静默忽略。 */
  respond(transferId: string, accept: boolean): void {
    this.finishPending(transferId, accept ? 'accept' : 'reject')
  }

  /** 结束一个挂起会话:resolve + 更新消息状态 + 清 resolver。重复调用 no-op(P0-3)。 */
  private finishPending(transferId: string, outcome: 'accept' | 'reject' | 'expired'): void {
    const p = this.pending.get(transferId)
    if (!p) return // 重复/已清 → 静默忽略
    this.pending.delete(transferId)
    p.timer.clear()

    if (outcome === 'accept') {
      // 接受全部:标 accepted(落盘完成后由 handleFileDone 转 done)
      for (const id of p.messageIds) {
        const m = this.d.store.updateStatus(id, 'accepted')
        if (m) this.upsert(m)
      }
      p.resolve(p.fileIds) // resolve 真实 fileId 列表,http-server 据此生成 token
    } else {
      // 拒绝或超时
      const status = outcome === 'expired' ? 'expired' : 'rejected'
      for (const id of p.messageIds) {
        const m = this.d.store.updateStatus(id, status)
        if (m) this.upsert(m)
      }
      p.resolve(false)
    }
  }

  /**
   * 文件落盘完成(http-server onFileDone):按 fileId 精确匹配入库消息转 done + 填路径(③-A)。
   * filePath 用实际落盘路径(可能因去重改名与原 fileName 不同)。
   */
  handleFileDone(fileId: string, filePath: string): void {
    const msgId = this.recvFileMsg.get(fileId)
    if (!msgId) return
    this.recvFileMsg.delete(fileId)
    const m = this.d.store.updateStatus(msgId, 'done', { filePath })
    if (m) this.upsert(m)
  }

  /** 文件落盘失败(http-server 落盘错误,③-C):对应消息转 failed,不留"已接收"假象。 */
  handleFileFailed(fileId: string, reason: ErrorReason): void {
    const msgId = this.recvFileMsg.get(fileId)
    if (!msgId) return
    this.recvFileMsg.delete(fileId)
    this.lastProgressAt.delete(msgId)
    const m = this.d.store.updateStatus(msgId, 'failed', { errorReason: reason })
    if (m) this.upsert(m)
  }

  /** 接收进度(http-server onFileProgress):按 fileId 找 recv 消息 id,节流推 UI(§12.3)。 */
  handleReceiveProgress(fileId: string, received: number, total: number): void {
    const msgId = this.recvFileMsg.get(fileId)
    if (!msgId) return
    this.emitProgress(msgId, received, total, 'recv')
  }

  /**
   * 进度推送(不落库,§12.3/§12.6)。节流:每 100ms 最多推一次;100% 强制推(终态不丢)。
   */
  private emitProgress(
    messageId: string,
    sent: number,
    total: number,
    direction: 'send' | 'recv'
  ): void {
    if (!this.d.onProgress) return
    const done = total > 0 && sent >= total
    const now = this.nowMs()
    const last = this.lastProgressAt.get(messageId)
    // 节流:仅当已有过一次推送、且距上次 <100ms 才丢弃(首帧永远推;100% 强制推)
    if (!done && last !== undefined && now - last < 100) return
    this.lastProgressAt.set(messageId, now)
    this.d.onProgress({ messageId, sent, total, direction })
    if (done) this.lastProgressAt.delete(messageId) // 终态后清理节流状态
  }

  /** App 退出:所有挂起 reject(403)+ pending 消息标 expired */
  shutdown(): void {
    for (const [transferId] of [...this.pending]) {
      this.finishPending(transferId, 'expired')
    }
  }

  // ── 发送方 ──

  /** 发送文本(本地串行化排队) */
  async sendText(peerFp: string, text: string): Promise<Message> {
    return this.enqueue(peerFp, async () => {
      const peer = this.d.resolvePeer(peerFp)
      const msg = this.d.store.insert({
        id: randomUUID(),
        type: 'text',
        direction: 'sent',
        peerFp,
        peerAlias: peer?.alias ?? peerFp.slice(0, 8),
        content: text,
        fileName: null,
        fileSize: null,
        filePath: null,
        status: 'pending',
        errorReason: null,
        transferId: null
      })
      this.upsert(msg)
      // resolvePeer 契约:离线/已从发现表移除返回 null → 报"对方已离线",而非误导性的连接超时
      if (!peer) return this.fail(msg.id, 'offline')
      const res = await this.d.sender.sendText(peer.target, text)
      return this.applySendResult(msg.id, res)
    })
  }

  /** 发送文件(本地串行化排队) */
  async sendFiles(peerFp: string, filePaths: string[]): Promise<Message[]> {
    return this.enqueue(peerFp, async () => {
      const peer = this.d.resolvePeer(peerFp)
      const msgs = filePaths.map((path) => {
        const name = path.split(/[/\\]/).pop() ?? 'file'
        return this.d.store.insert({
          id: randomUUID(),
          type: 'file',
          direction: 'sent',
          peerFp,
          peerAlias: peer?.alias ?? peerFp.slice(0, 8),
          content: null,
          fileName: name,
          fileSize: this.d.fileSize?.(path) ?? null,
          filePath: path,
          status: 'pending',
          errorReason: null,
          transferId: null
        })
      })
      msgs.forEach((m) => this.upsert(m))
      if (!peer) {
        return msgs.map((m) => this.fail(m.id, 'offline'))
      }
      const files = filePaths.map((path, i) => ({ id: msgs[i].id, path }))
      // 发送进度:fileId === 发送方 msgId,直接推 UI(§12.3)
      const res = await this.d.sender.sendFiles(peer.target, files, (fileId, sent, total) =>
        this.emitProgress(fileId, sent, total, 'send')
      )
      const status =
        res.kind === 'done'
          ? 'done'
          : res.kind === 'rejected'
            ? 'rejected'
            : res.kind === 'busy'
              ? 'failed'
              : 'failed'
      const reason: ErrorReason | undefined =
        res.kind === 'busy' ? 'busy' : res.kind === 'error' ? classifyError(res.message) : undefined
      return msgs.map((m) => {
        const updated = this.d.store.updateStatus(m.id, status, reason ? { errorReason: reason } : undefined)!
        this.upsert(updated)
        return updated
      })
    })
  }

  /** 同一 peer 的发送串行化(DESIGN §11.2.3) */
  private enqueue<T>(peerFp: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendQueues.get(peerFp) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.sendQueues.set(peerFp, tail)
    // ④-A:链尾 settle 后若仍是当前尾(无后续入队)则删 key,防 Map 随 peer 增长而泄漏
    tail.then(() => {
      if (this.sendQueues.get(peerFp) === tail) this.sendQueues.delete(peerFp)
    })
    return next
  }

  private fail(msgId: string, reason: ErrorReason): Message {
    const m = this.d.store.updateStatus(msgId, 'failed', { errorReason: reason })!
    this.upsert(m)
    return m
  }

  private applySendResult(msgId: string, result: SendTextResult): Message {
    const status =
      result.kind === 'done' ? 'done' : result.kind === 'rejected' ? 'rejected' : 'failed'
    const reason: ErrorReason | undefined =
      result.kind === 'busy'
        ? 'busy'
        : result.kind === 'error'
          ? classifyError(result.message)
          : undefined
    const m = this.d.store.updateStatus(msgId, status, reason ? { errorReason: reason } : undefined)!
    this.upsert(m)
    return m
  }

  list(opts?: { limit?: number; before?: number }): Message[] {
    return this.d.store.list(opts)
  }
}

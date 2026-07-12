// 接收方 HTTP server(Fastify,见 docs/DESIGN §1.1、§5)
//
// 事实层(DESIGN §1.4):upload 是裸二进制,用 addContentTypeParser 交出 request.raw
// pipe 落盘,不用 @fastify/multipart;该路由绕过默认 bodyLimit。

import Fastify, { type FastifyInstance } from 'fastify'
import { EP } from '@shared/protocol'
import type { DeviceInfo, PrepareUploadRequest } from '@shared/types'
import { SessionManager } from './session'
import { receiveFileToDir } from './receive-file'
import { isTextMessage, extractText } from './text-message'

export interface HttpServerDeps {
  sessions: SessionManager
  /** 本机设备信息(GET /info 用) */
  selfInfo: () => DeviceInfo
  /** 接收目录 */
  receiveDir: () => string
  /**
   * 询问用户是否接收(挂起模型,DESIGN §5.1/§11.2)。
   * 返回接受的 fileId 列表(空/false 视为拒绝)。调用方负责挂起+超时(T_ACCEPT_MS)。
   */
  onPrepareAsk: (transferId: string, req: PrepareUploadRequest, fromIp: string) => Promise<string[] | false>
  /** 发现层回调:收到 /register 时登记对方(DESIGN §1.1 fallback) */
  onRegister?: (info: DeviceInfo, address: string) => void
  /** 文件落盘完成回调(供 UI/持久化)。fileId 用于精确关联入库消息 */
  onFileDone?: (info: {
    fileId: string
    fileName: string
    size: number
    path: string
    peerFp: string
  }) => void
  /** 文件落盘失败回调(③-C):对应消息转 failed */
  onFileFailed?: (fileId: string, reason: 'enospc' | 'sha256') => void
  /** 接收进度回调(§12.3):fileId + 已接收/总字节 */
  onFileProgress?: (fileId: string, received: number, total: number) => void
  /** 收到自动接收文件请求时(供入库 recv accepted 消息);需在落盘前拿到 alias */
  onAutoAccept?: (files: PrepareUploadRequest['files'], from: DeviceInfo) => void
  onSessionCancelled?: () => void
  /**
   * 收到文本消息(DESIGN §11.2):文本正文已在 preview,直接入流显示,不询问用户。
   * 返回后 server 回 204(不走 upload)。fromInfo 供入库 peer_alias。
   */
  onTextMessage?: (text: string, fromInfo: DeviceInfo) => void
  /** 自动接收判定(DESIGN §11.2):非文本文件是否全部可自动收(需目录可写预检由调用方内含) */
  shouldAutoAcceptFiles?: (files: PrepareUploadRequest['files']) => boolean
}

export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: 1024 * 1024 * 1024 }) // 1GB 兜底,upload 路由实际走流

  // upload 是裸二进制:注册一个不解析的 parser,交出 request.raw(DESIGN §1.4)
  app.addContentTypeParser('*', (_req, _payload, done) => done(null, undefined))

  // GET /info — 调试/发现
  app.get(EP.info, async () => deps.selfInfo())

  // POST /register — 双向发现 fallback(DESIGN §1.1)
  app.post(EP.register, async (req) => {
    const info = req.body as DeviceInfo
    if (info && typeof info.fingerprint === 'string') {
      deps.onRegister?.(info, req.ip)
    }
    // 响应体是本机 info(省略 port/protocol,DESIGN §1.1)
    const self = deps.selfInfo()
    return {
      alias: self.alias,
      version: self.version,
      deviceModel: self.deviceModel,
      deviceType: self.deviceType,
      fingerprint: self.fingerprint,
      download: self.download
    }
  })

  // POST /prepare-upload — 元数据 + 意图协商(挂起等弹框)
  app.post(EP.prepareUpload, async (req, reply) => {
    const body = req.body as PrepareUploadRequest
    if (!body || !body.info || !body.files || typeof body.files !== 'object') {
      return reply.code(400).send({ message: 'Invalid body' })
    }

    const decision = deps.sessions.onPrepareUpload({
      remoteIp: req.ip,
      fingerprint: body.info.fingerprint,
      files: body.files
    })

    if (decision.kind === 'busy') {
      return reply.code(409).send({ message: 'Blocked by another session' })
    }

    // ── 文本消息(DESIGN §11.2):正文在 preview,直接入流,不询问用户,回 204 ──
    if (isTextMessage(body.files)) {
      const text = extractText(body.files)
      if (text !== null) deps.onTextMessage?.(text, body.info)
      // respond 空集合 → accepted-empty(204),会话立即 clear
      deps.sessions.respond(decision.transferId, true, [])
      return reply.code(204).send()
    }

    // ── 自动接收(DESIGN §11.2):文件全部满足阈值 → 跳过询问,直接 accept 全部 ──
    let accepted: string[] | false
    if (deps.shouldAutoAcceptFiles?.(body.files)) {
      deps.onAutoAccept?.(body.files, body.info) // 入库 recv accepted 消息
      accepted = Object.keys(body.files)
    } else {
      // 挂起:等用户在聊天流点接收/拒绝(调用方负责 T_ACCEPT_MS 超时 → 返回 false)
      accepted = await deps.onPrepareAsk(decision.transferId, body, req.ip)
    }

    const result = deps.sessions.respond(
      decision.transferId,
      accepted !== false,
      accepted === false ? [] : accepted
    )

    if (result.kind === 'rejected') {
      return reply.code(403).send({ message: 'Rejected' })
    }
    if (result.kind === 'accepted-empty') {
      return reply.code(204).send() // 接受但无文件要传
    }

    // P1 修复:挂起期间发送方可能已超时断开(T_SENDER 到时)。若连接已断,
    // respond 已把会话推进到 ACTIVE 却无人来 upload → 回滚,避免孤儿会话挂到 idle 超时。
    // 判据(均已实测坐实):断开时底层 socket 被销毁(req.raw.socket.destroyed=true)。
    // 不能用 req.raw.destroyed(body 读完后正常也为 true),也不能用 reply.raw.writable
    // (客户端 abort 后它仍为 true,是误导信号)。
    if (req.raw.socket?.destroyed || req.raw.aborted) {
      deps.sessions.onCancel(result.sessionId)
      return reply
    }
    return reply.code(200).send({ sessionId: result.sessionId, files: result.files })
  })

  // POST /upload?sessionId=&fileId=&token= — 裸二进制
  app.post(EP.upload, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const { sessionId, fileId, token } = q
    if (!sessionId || !fileId || !token) {
      return reply.code(400).send({ message: 'Missing query params' })
    }

    const decision = deps.sessions.onUpload(sessionId, fileId, token, req.ip)
    if (decision.kind === 'reject') {
      return reply.code(decision.status).send({ message: 'Invalid token or IP address' })
    }

    // 已收过(幂等):丢弃流,直接 200
    if (decision.alreadyReceived) {
      req.raw.resume()
      return reply.code(200).send()
    }

    try {
      const total = Number(req.headers['content-length']) || decision.fileMeta.size || 0
      const res = await receiveFileToDir(
        req.raw,
        decision.fileMeta.fileName,
        deps.receiveDir(),
        decision.fileMeta.sha256,
        (received, tot) => deps.onFileProgress?.(fileId, received, tot),
        total
      )
      // S3:落盘期间会话可能已被 cancel。markReceived 校验 sessionId,
      // 会话已不在则 done=false 且不触发 onFileDone(避免 cancel 后误报完成)。
      const { stillActive } = deps.sessions.markReceived(sessionId, fileId)
      if (stillActive)
        deps.onFileDone?.({
          fileId, // 精确关联入库消息(③-A)
          fileName: res.fileName, // 实际落盘名(可能去重改名)
          size: res.size,
          path: res.path,
          peerFp: decision.peerFp
        })
      return reply.code(200).send()
    } catch (err) {
      // S1:落盘/校验失败 → 清理会话,不让 fileId 悬挂到 idle 超时(DESIGN §7)
      req.log.error(err)
      deps.sessions.onUploadFailed(sessionId)
      // ③-C:通知对应消息转 failed,不留"已接收"假象。sha256 不符归 sha256,其余归 enospc
      const reason = String((err as Error)?.message).includes('sha256') ? 'sha256' : 'enospc'
      deps.onFileFailed?.(fileId, reason)
      return reply.code(500).send({ message: 'Failed to receive file' })
    }
  })

  // POST /cancel?sessionId=
  app.post(EP.cancel, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (q.sessionId && deps.sessions.onCancel(q.sessionId).cancelled) {
      deps.onSessionCancelled?.()
    }
    return reply.code(200).send()
  })

  return app
}

// 发送方 HTTPS client(见 docs/DESIGN §1.1、§5.1、docs/https-migration.md §3.6)
//
// 流程:prepare-upload → 对每个被接受的 fileId 并行 upload(裸二进制)。
// 超时契约:prepare-upload 用 T_SENDER_MS(≥ 接收方弹框超时,DESIGN §5.1)。
//
// HTTPS 改造:全走 node:https(不用 fetch —— undici 做指纹 pin 别扭、Electron net 打自签名静默失败)。
// - prepare/upload/cancel:pinnedAgent(TOFU:接受自签名 + 校验证书指纹 = target.fingerprint)。
// - register:discoveryAgent(不 pin —— 此刻可能还没登记对方,无指纹可 pin;B1)。

import { basename } from 'node:path'
import { statSync, createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import https from 'node:https'
import tls from 'node:tls'
import { Transform } from 'node:stream'
import { EP, T_SENDER_MS, T_UPLOAD_MS, T_CONNECT_MS } from '@shared/protocol'
import type { DeviceInfo, FileMeta, PrepareUploadResponse } from '@shared/types'
import { encodeTextMessage } from './text-message'

export interface SendTarget {
  address: string
  port: number
  protocol: 'http' | 'https'
  /** 对端证书指纹(发现阶段记住),用于 TLS pinning(docs/https-migration.md §3.4)。
   *  register 路径不 pin(discoveryAgent),此字段可为占位。 */
  fingerprint: string
}

export interface SendFile {
  id: string
  path: string
}

export type SendResult =
  | { kind: 'done'; sessionId: string; sent: string[] }
  | { kind: 'rejected' } // 对方 403
  | { kind: 'busy' } // 对方 409
  | { kind: 'error'; message: string }

// ── TLS agents ──────────────────────────────────────────────────────────

/**
 * 指纹 pinning agent(TOFU:接受自签名,但 pin 证书指纹)。按 fingerprint 缓存复用:
 * 一次 sendFiles(1 prepare + N upload)共用 TLS 握手,keepAlive 免每请求重握手(m2)。
 *
 * ⚠️ **不用 checkServerIdentity**(实测坐实):设 `rejectUnauthorized:false` 接受自签名后,
 * Node **不再调用 checkServerIdentity**(它仅在证书通过链校验后才调)→ 指纹校验形同虚设。
 * 正解:自定义 `createConnection`,用 `tls.connect(rejectUnauthorized:false)` 建连,
 * 在连接回调里**同步比对**握手实际证书(getPeerCertificate)的 fingerprint256,不符即 destroy。
 */
const agentCache = new Map<string, https.Agent>()

/** 造一个带 code='ECERT' 的证书类错误,供上层 classifyError 区分"证书不匹配"与普通网络错误。 */
function certError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = 'ECERT'
  return err
}

function pinnedAgent(target: SendTarget): https.Agent {
  const cached = agentCache.get(target.fingerprint)
  if (cached) return cached
  const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 100 })
  // 覆盖 createConnection:用 tls.connect 建连并在回调里同步 pin(运行时 Agent 支持,官方文档)。
  type CreateConn = (
    opts: tls.ConnectionOptions,
    cb: (err: Error | null, sock?: tls.TLSSocket) => void
  ) => tls.TLSSocket
  ;(agent as unknown as { createConnection: CreateConn }).createConnection = (opts, cb) => {
    const socket = tls.connect({ ...opts, rejectUnauthorized: false }, () => {
      // 握手完成 → 清掉建连超时。⚠️ 回归红线:不清则大文件上传空闲期会被 T_CONNECT_MS 误杀
      //(connect timeout 只管"建连到握手完成",握手后交还请求级 T_UPLOAD_MS/T_SENDER_MS)。
      socket.setTimeout(0)
      // fail-closed(B3):期望指纹缺失也要响亮失败,不静默放行
      if (!target.fingerprint) {
        socket.destroy(certError('no pinned fingerprint for target'))
        return
      }
      // 握手实际证书(叶子);证书变则指纹必变(M4:整证书 SHA-256)
      const cert = socket.getPeerCertificate()
      if (!cert || !cert.fingerprint256) {
        socket.destroy(certError('no peer certificate'))
        return
      }
      if (cert.fingerprint256 !== target.fingerprint) {
        socket.destroy(
          certError(`fingerprint mismatch: ${cert.fingerprint256} != ${target.fingerprint}`)
        )
        return
      }
      cb(null, socket) // 通过
    })
    // 建连级短超时:连不上(如对端开 VPN,SYN 被灌进隧道黑洞)时快速失败,不干等 T_SENDER_MS 6min。
    // 只覆盖建连阶段;握手成功回调里 setTimeout(0) 清除(见上)。
    socket.setTimeout(T_CONNECT_MS, () => {
      const err = new Error('connect ETIMEDOUT') as NodeJS.ErrnoException
      err.code = 'ETIMEDOUT'
      socket.destroy(err)
    })
    socket.on('error', (err) => cb(err))
    return socket
  }
  agentCache.set(target.fingerprint, agent)
  return agent
}

/** 发现回应(register)专用 agent:接受任意自签名,**不 pin**(B1)。register 只传公开 DeviceInfo。 */
const discoveryAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false })

// ── https helpers(把回调式 API 包成 Promise)────────────────────────────

interface HttpsResponse {
  status: number
  body: string
}

/** 发一个带 JSON body 的请求,累积响应体。timeoutMs 为总时长硬超时。 */
function httpsJson(
  agent: https.Agent,
  target: SendTarget,
  path: string,
  method: string,
  jsonBody: unknown,
  timeoutMs: number
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const payload = jsonBody === undefined ? undefined : Buffer.from(JSON.stringify(jsonBody))
    const req = https.request(
      {
        host: target.address,
        port: target.port,
        path,
        method,
        agent,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {}
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    // 总时长硬超时(非空闲超时:setTimeout 是空闲的,大传输永不触发,M3)
    const timer = setTimeout(() => req.destroy(new Error('request timeout')), timeoutMs)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      fn()
    }
    req.on('error', (err) => done(() => reject(err)))
    req.on('close', () => clearTimeout(timer))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 流式上传文件(裸二进制 body)。进度计数发生在传输层**拉取** chunk 时(背压驱动),
 * = 真实已发送字节(DESIGN §12.1)。用 pipe(counter).pipe(req),不用 readStream.on('data')(M3)。
 */
function httpsUpload(
  agent: https.Agent,
  target: SendTarget,
  path: string,
  filePath: string,
  total: number,
  timeoutMs: number,
  onProgress?: (sent: number, total: number) => void
): Promise<HttpsResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: target.address,
      port: target.port,
      path,
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(total) // 必设:否则退化 chunked → 接收方 total=0 进度失真(M3)
      }
    })
    const timer = setTimeout(() => req.destroy(new Error('upload timeout')), timeoutMs)

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    // 计数中间流:_transform 由下游 req.write 背压驱动 → 计的是"已交给传输层"的字节
    let sent = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length
        onProgress?.(sent, total)
        cb(null, chunk)
      }
    })
    const rs = createReadStream(filePath)
    rs.on('error', (err) => {
      clearTimeout(timer)
      req.destroy()
      reject(err)
    })
    rs.pipe(counter).pipe(req)
  })
}

// ── 业务:计算文件 map / 发送 ──────────────────────────────────────────

/** 计算文件 sha256(DESIGN §9:发送方主动带 sha256,接收方校验) */
async function fileSha256(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash('sha256').update(buf).digest('hex')
}

async function buildFileMap(files: SendFile[]): Promise<Record<string, FileMeta>> {
  const map: Record<string, FileMeta> = {}
  for (const f of files) {
    const size = statSync(f.path).size
    map[f.id] = {
      id: f.id,
      fileName: basename(f.path),
      size,
      fileType: 'application/octet-stream',
      sha256: await fileSha256(f.path)
    }
  }
  return map
}

/**
 * 发送一组文件到目标设备。
 */
export async function sendFiles(
  target: SendTarget,
  selfInfo: DeviceInfo,
  files: SendFile[],
  onProgress?: (fileId: string, sent: number, total: number) => void
): Promise<SendResult> {
  const agent = pinnedAgent(target)
  let prepareRes: HttpsResponse
  try {
    prepareRes = await httpsJson(
      agent,
      target,
      EP.prepareUpload,
      'POST',
      { info: selfInfo, files: await buildFileMap(files) },
      T_SENDER_MS
    )
  } catch (err) {
    return { kind: 'error', message: `prepare-upload failed: ${(err as Error).message}` }
  }

  if (prepareRes.status === 403) return { kind: 'rejected' }
  if (prepareRes.status === 409) return { kind: 'busy' }
  if (prepareRes.status !== 200) {
    return { kind: 'error', message: `prepare-upload status ${prepareRes.status}` }
  }

  const { sessionId, files: tokens } = JSON.parse(prepareRes.body) as PrepareUploadResponse

  // 对每个被接受的文件并行 upload(协议允许并行,DESIGN §1.1)
  const byId = new Map(files.map((f) => [f.id, f]))
  const uploads = Object.entries(tokens).map(async ([fileId, token]) => {
    const file = byId.get(fileId)
    if (!file) return
    const total = statSync(file.path).size
    const path =
      `${EP.upload}` +
      `?sessionId=${encodeURIComponent(sessionId)}` +
      `&fileId=${encodeURIComponent(fileId)}` +
      `&token=${encodeURIComponent(token)}`

    const res = await httpsUpload(agent, target, path, file.path, total, T_UPLOAD_MS, (sent, t) =>
      onProgress?.(fileId, sent, t)
    )
    if (res.status < 200 || res.status >= 300) throw new Error(`upload ${fileId} status ${res.status}`)
    onProgress?.(fileId, total, total) // 补终态 100%
  })

  try {
    await Promise.all(uploads)
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }

  return { kind: 'done', sessionId, sent: Object.keys(tokens) }
}

export type SendTextResult =
  | { kind: 'done' } // 对方 204(文本已入流)或 200
  | { kind: 'rejected' } // 403
  | { kind: 'busy' } // 409
  | { kind: 'error'; message: string }

/**
 * 发送文本消息(DESIGN §11.2):编码成 fileType=text + preview,走 prepare-upload。
 * 对方识别为文本 → 直接入流 → 回 204(不走 upload)。
 */
export async function sendText(
  target: SendTarget,
  selfInfo: DeviceInfo,
  text: string
): Promise<SendTextResult> {
  const { fileId, meta } = encodeTextMessage(text)
  let res: HttpsResponse
  try {
    res = await httpsJson(
      pinnedAgent(target),
      target,
      EP.prepareUpload,
      'POST',
      { info: selfInfo, files: { [fileId]: meta } },
      T_SENDER_MS
    )
  } catch (err) {
    return { kind: 'error', message: `send text failed: ${(err as Error).message}` }
  }
  if (res.status === 403) return { kind: 'rejected' }
  if (res.status === 409) return { kind: 'busy' }
  // 204(文本已入流)或 200(对方当普通文件处理了)都算成功
  if (res.status === 204 || res.status === 200) return { kind: 'done' }
  return { kind: 'error', message: `send text status ${res.status}` }
}

/** 通知对方取消会话(DESIGN §5)。fire-and-forget。 */
export async function cancelSession(target: SendTarget, sessionId: string): Promise<void> {
  try {
    await httpsJson(
      pinnedAgent(target),
      target,
      `${EP.cancel}?sessionId=${encodeURIComponent(sessionId)}`,
      'POST',
      undefined,
      T_SENDER_MS
    )
  } catch {
    // 尽力而为
  }
}

/** register 定向回应的超时(短:对方没起 HTTP 就快速放弃,不挂住发现) */
const T_REGISTER_MS = 2000

/**
 * 双向发现"用法 A":收到对方多播 announce 后,向对方定向 `POST /register` 回应本机信息,
 * 让对方也能发现我们(替代原 UDP 多播回应,定向 TCP 更可靠;见 docs/discovery-http-register-response.md)。
 * **fire-and-forget**:超时/失败/解析异常一律静默返 null,绝不影响发现主流程。
 * **用 discoveryAgent(不 pin,B1)**:此刻可能还没登记对方,无指纹可 pin;register 只传公开信息。
 * @returns 对方在响应体回的 DeviceInfo(可用于顺带刷新登记),失败返 null。
 */
export async function registerTo(
  target: SendTarget,
  selfInfo: DeviceInfo
): Promise<DeviceInfo | null> {
  try {
    const res = await httpsJson(
      discoveryAgent,
      target,
      EP.register,
      'POST',
      selfInfo,
      T_REGISTER_MS
    )
    if (res.status < 200 || res.status >= 300) return null
    const peer = JSON.parse(res.body) as DeviceInfo
    // 校验最小字段,防对方回垃圾
    return peer && typeof peer.fingerprint === 'string' && typeof peer.alias === 'string'
      ? peer
      : null
  } catch {
    return null // 对方没起 HTTP / 超时 / 网络错 / 响应非 JSON —— 静默
  }
}

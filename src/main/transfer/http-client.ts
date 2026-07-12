// 发送方 HTTP client(见 docs/DESIGN §1.1、§5.1)
//
// 流程:prepare-upload → 对每个被接受的 fileId 并行 upload(裸二进制)。
// 超时契约:prepare-upload 用 T_SENDER_MS(≥ 接收方弹框超时,DESIGN §5.1)。

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { EP, T_SENDER_MS, T_UPLOAD_MS } from '@shared/protocol'
import type { DeviceInfo, FileMeta, PrepareUploadResponse } from '@shared/types'
import { encodeTextMessage } from './text-message'

export interface SendTarget {
  address: string
  port: number
  protocol: 'http' | 'https'
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

function baseUrl(t: SendTarget): string {
  return `${t.protocol}://${t.address}:${t.port}`
}

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
  onProgress?: (fileId: string) => void
): Promise<SendResult> {
  let prepareRes: Response
  try {
    prepareRes = await fetch(`${baseUrl(target)}${EP.prepareUpload}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ info: selfInfo, files: await buildFileMap(files) }),
      signal: AbortSignal.timeout(T_SENDER_MS)
    })
  } catch (err) {
    return { kind: 'error', message: `prepare-upload failed: ${(err as Error).message}` }
  }

  if (prepareRes.status === 403) return { kind: 'rejected' }
  if (prepareRes.status === 409) return { kind: 'busy' }
  if (prepareRes.status !== 200) {
    return { kind: 'error', message: `prepare-upload status ${prepareRes.status}` }
  }

  const { sessionId, files: tokens } = (await prepareRes.json()) as PrepareUploadResponse

  // 对每个被接受的文件并行 upload(协议允许并行,DESIGN §1.1)
  const byId = new Map(files.map((f) => [f.id, f]))
  const uploads = Object.entries(tokens).map(async ([fileId, token]) => {
    const file = byId.get(fileId)
    if (!file) return
    const body = await readFile(file.path)
    const url =
      `${baseUrl(target)}${EP.upload}` +
      `?sessionId=${encodeURIComponent(sessionId)}` +
      `&fileId=${encodeURIComponent(fileId)}` +
      `&token=${encodeURIComponent(token)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(T_UPLOAD_MS) // S4:防接收方挂起导致永挂
    })
    if (!res.ok) throw new Error(`upload ${fileId} status ${res.status}`)
    onProgress?.(fileId)
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
  let res: Response
  try {
    res = await fetch(`${baseUrl(target)}${EP.prepareUpload}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ info: selfInfo, files: { [fileId]: meta } }),
      signal: AbortSignal.timeout(T_SENDER_MS)
    })
  } catch (err) {
    return { kind: 'error', message: `send text failed: ${(err as Error).message}` }
  }
  if (res.status === 403) return { kind: 'rejected' }
  if (res.status === 409) return { kind: 'busy' }
  // 204(文本已入流)或 200(对方当普通文件处理了)都算成功
  if (res.status === 204 || res.status === 200) return { kind: 'done' }
  return { kind: 'error', message: `send text status ${res.status}` }
}

/** 通知对方取消会话(DESIGN §5) */
export async function cancelSession(target: SendTarget, sessionId: string): Promise<void> {
  try {
    await fetch(
      `${baseUrl(target)}${EP.cancel}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'POST' }
    )
  } catch {
    // 尽力而为
  }
}

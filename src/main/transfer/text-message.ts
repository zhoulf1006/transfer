// 文本消息编解码(见 docs/DESIGN §11.1、§11.3)
//
// LocalSend 源码确认:文本消息 = 单个 fileType='text' 的文件,正文放 preview 字段,
// size = utf8 字节数,fileName = 随机 uuid.txt(仅占位)。只走 prepare-upload,不走 upload。

import { randomUUID } from 'node:crypto'
import type { FileMeta } from '@shared/types'

/** 发送方文本正文上限(超过改当普通文件传,DESIGN §11.6) */
export const MAX_SEND_TEXT_BYTES = 32 * 1024
/** 接收方 preview 上限(防恶意超大,DESIGN §11.6);超限截断 */
export const MAX_RECV_PREVIEW_BYTES = 64 * 1024

/**
 * 判定一个 prepare-upload 的 files 是否是"文本消息":
 * 单文件 + fileType 为 text(LocalSend 用 'text',也容忍 'text/plain')。
 */
export function isTextMessage(files: Record<string, FileMeta>): boolean {
  const values = Object.values(files)
  if (values.length !== 1) return false
  const t = values[0].fileType
  return t === 'text' || t === 'text/plain'
}

/** 从文本消息的 files 里取正文(preview),接收方超限截断。返回 null 表示不是合法文本消息。 */
export function extractText(files: Record<string, FileMeta>): string | null {
  if (!isTextMessage(files)) return null
  const preview = Object.values(files)[0].preview
  if (typeof preview !== 'string') return null
  // 按 utf8 字节截断(防超大)
  const buf = Buffer.from(preview, 'utf8')
  if (buf.length <= MAX_RECV_PREVIEW_BYTES) return preview
  // 截断到上限(可能切断多字节字符,用 toString 容错)
  return buf.subarray(0, MAX_RECV_PREVIEW_BYTES).toString('utf8')
}

/**
 * 把文本正文编码成一个 fileType='text' 的 FileMeta(正文进 preview)。
 * 返回 { fileId, meta };调用方组装 prepare-upload 的 files map。
 */
export function encodeTextMessage(text: string): { fileId: string; meta: FileMeta } {
  const id = randomUUID()
  const size = Buffer.byteLength(text, 'utf8')
  return {
    fileId: id,
    meta: {
      id,
      fileName: `${id}.txt`,
      size,
      fileType: 'text',
      preview: text
    }
  }
}

/** 文本是否超过发送上限(超过应改当普通文件传) */
export function isTextTooLarge(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > MAX_SEND_TEXT_BYTES
}

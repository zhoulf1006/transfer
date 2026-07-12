import { test, expect, describe } from 'vitest'
import {
  isTextMessage,
  extractText,
  encodeTextMessage,
  isTextTooLarge,
  MAX_RECV_PREVIEW_BYTES
} from './text-message'
import type { FileMeta } from '@shared/types'

function fm(partial: Partial<FileMeta>): Record<string, FileMeta> {
  const meta: FileMeta = {
    id: 'x',
    fileName: 'x.txt',
    size: 1,
    fileType: 'text',
    ...partial
  }
  return { [meta.id]: meta }
}

describe('isTextMessage', () => {
  test('单个 fileType=text → 是', () => {
    expect(isTextMessage(fm({ fileType: 'text' }))).toBe(true)
    expect(isTextMessage(fm({ fileType: 'text/plain' }))).toBe(true)
  })
  test('非 text 类型 → 否', () => {
    expect(isTextMessage(fm({ fileType: 'image/png' }))).toBe(false)
    expect(isTextMessage(fm({ fileType: 'application/octet-stream' }))).toBe(false)
  })
  test('多文件 → 否(即便都是 text)', () => {
    const files = {
      a: { id: 'a', fileName: 'a.txt', size: 1, fileType: 'text' as const },
      b: { id: 'b', fileName: 'b.txt', size: 1, fileType: 'text' as const }
    }
    expect(isTextMessage(files)).toBe(false)
  })
  test('空 → 否', () => {
    expect(isTextMessage({})).toBe(false)
  })
})

describe('extractText', () => {
  test('取 preview 正文', () => {
    expect(extractText(fm({ preview: '你好世界' }))).toBe('你好世界')
  })
  test('非文本消息 → null', () => {
    expect(extractText(fm({ fileType: 'image/png', preview: 'x' }))).toBeNull()
  })
  test('无 preview → null', () => {
    expect(extractText(fm({ preview: undefined }))).toBeNull()
  })
  test('超大 preview 截断到上限', () => {
    const huge = 'a'.repeat(MAX_RECV_PREVIEW_BYTES + 1000)
    const got = extractText(fm({ preview: huge }))!
    expect(Buffer.byteLength(got, 'utf8')).toBeLessThanOrEqual(MAX_RECV_PREVIEW_BYTES)
  })
})

describe('encodeTextMessage', () => {
  test('编码成 fileType=text + preview 承载正文', () => {
    const { fileId, meta } = encodeTextMessage('hello')
    expect(meta.fileType).toBe('text')
    expect(meta.preview).toBe('hello')
    expect(meta.id).toBe(fileId)
    expect(meta.fileName).toBe(`${fileId}.txt`)
    expect(meta.size).toBe(5) // utf8 字节
  })
  test('中文 size 为 utf8 字节数', () => {
    const { meta } = encodeTextMessage('你好') // 每字 3 字节
    expect(meta.size).toBe(6)
  })
  test('往返:encode 后能被 isTextMessage/extractText 识别', () => {
    const { fileId, meta } = encodeTextMessage('round trip 测试')
    const files = { [fileId]: meta }
    expect(isTextMessage(files)).toBe(true)
    expect(extractText(files)).toBe('round trip 测试')
  })
})

describe('isTextTooLarge', () => {
  test('小文本不超限', () => {
    expect(isTextTooLarge('short')).toBe(false)
  })
  test('超 32KB 超限', () => {
    expect(isTextTooLarge('a'.repeat(33 * 1024))).toBe(true)
  })
})

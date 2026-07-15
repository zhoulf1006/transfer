import { describe, it, expect } from 'vitest'
import { pickImageItemIndices } from './clipboard-image'

describe('pickImageItemIndices — 剪贴板图片项挑选(粘贴发图)', () => {
  it('单张图片 → 命中该项下标', () => {
    expect(pickImageItemIndices([{ kind: 'file', type: 'image/png' }])).toEqual([0])
  })

  it('多张图片全部命中(用户诉求:多图全发),保序', () => {
    const items = [
      { kind: 'file', type: 'image/png' },
      { kind: 'file', type: 'image/jpeg' },
      { kind: 'file', type: 'image/gif' }
    ]
    expect(pickImageItemIndices(items)).toEqual([0, 1, 2])
  })

  it('纯文本粘贴 → 空(放行默认粘贴,不拦文字)', () => {
    expect(pickImageItemIndices([{ kind: 'string', type: 'text/plain' }])).toEqual([])
  })

  it('图文混合 → 只挑图片项的下标(文本项跳过)', () => {
    const items = [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png' },
      { kind: 'string', type: 'text/html' },
      { kind: 'file', type: 'image/webp' }
    ]
    expect(pickImageItemIndices(items)).toEqual([1, 3])
  })

  it('kind=string 但 type=image/*(如复制图片链接)→ 不当图片(必须是 file)', () => {
    // 防误判:某些来源会以 string 形式给 image/* 的 URL,不是真图片文件,不发。
    expect(pickImageItemIndices([{ kind: 'string', type: 'image/png' }])).toEqual([])
  })

  it('kind=file 但非图片(如粘贴文件)→ 跳过', () => {
    expect(pickImageItemIndices([{ kind: 'file', type: 'application/pdf' }])).toEqual([])
  })

  it('空剪贴板 → 空', () => {
    expect(pickImageItemIndices([])).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import { isImageFile } from './ipc'

describe('isImageFile', () => {
  it('常见图片扩展名 → true', () => {
    for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'shot.PNG']) {
      expect(isImageFile(n)).toBe(true)
    }
  })
  it('非图片 → false', () => {
    for (const n of ['a.txt', 'b.pdf', 'c.zip', 'd.mp4', 'noext', 'e.']) {
      expect(isImageFile(n)).toBe(false)
    }
  })
  it('null / 空 → false', () => {
    expect(isImageFile(null)).toBe(false)
    expect(isImageFile('')).toBe(false)
  })
  it('多个点取最后一段扩展名', () => {
    expect(isImageFile('my.photo.final.png')).toBe(true)
    expect(isImageFile('archive.png.zip')).toBe(false)
  })
})

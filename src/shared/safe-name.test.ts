import { test, expect, describe } from 'vitest'
import { sanitizeFileName } from './safe-name'

describe('sanitizeFileName — 路径逃逸防护', () => {
  test('剥离 posix 路径,只留 basename', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('/absolute/path/img.png')).toBe('img.png')
    expect(sanitizeFileName('a/b/c/d.txt')).toBe('d.txt')
  })

  test('剥离 windows 路径与盘符', () => {
    expect(sanitizeFileName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll')
    expect(sanitizeFileName('..\\..\\secret.txt')).toBe('secret.txt')
    // 混合分隔符
    expect(sanitizeFileName('a/b\\c/evil.exe')).toBe('evil.exe')
  })

  test('去掉危险/控制字符', () => {
    expect(sanitizeFileName('na<me>.txt')).toBe('name.txt')
    expect(sanitizeFileName('a"b|c?.png')).toBe('abc.png')
    expect(sanitizeFileName('tab\tfile.txt')).toBe('tabfile.txt')
    expect(sanitizeFileName('nul\x00byte.txt')).toBe('nulbyte.txt')
  })

  test('纯 . / .. / 空 退化为 fallback', () => {
    expect(sanitizeFileName('.')).toBe('file')
    expect(sanitizeFileName('..')).toBe('file')
    expect(sanitizeFileName('')).toBe('file')
    expect(sanitizeFileName('/')).toBe('file')
    expect(sanitizeFileName('...', 'x')).toBe('x') // 尾部点被剥光后为空
  })

  test('尾部点与空格被剥(Windows 约束)', () => {
    expect(sanitizeFileName('report.  ')).toBe('report')
    expect(sanitizeFileName('name...')).toBe('name')
  })

  test('Windows 保留设备名加前缀规避', () => {
    expect(sanitizeFileName('CON')).toBe('_CON')
    expect(sanitizeFileName('con.txt')).toBe('_con.txt')
    expect(sanitizeFileName('COM1.log')).toBe('_COM1.log')
    // 非保留名不受影响
    expect(sanitizeFileName('CONSOLE.txt')).toBe('CONSOLE.txt')
  })

  test('正常文件名原样保留', () => {
    expect(sanitizeFileName('我的照片.png')).toBe('我的照片.png')
    expect(sanitizeFileName('report-2026.pdf')).toBe('report-2026.pdf')
  })
})


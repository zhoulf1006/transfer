import { test, expect, describe } from 'vitest'
import { resolveEffective } from './resolve'

describe('resolveEffective', () => {
  test('pref=zh 直接返回 zh(不看系统)', () => {
    expect(resolveEffective('zh', ['en-US'])).toBe('zh')
  })

  test('pref=en 直接返回 en(不看系统)', () => {
    expect(resolveEffective('en', ['zh-Hans-CN'])).toBe('en')
  })

  test('system + 系统首选中文(zh-Hans-CN)→ zh', () => {
    expect(resolveEffective('system', ['zh-Hans-CN', 'en-US'])).toBe('zh')
  })

  test('system + 系统首选简写 zh → zh', () => {
    expect(resolveEffective('system', ['zh'])).toBe('zh')
  })

  test('system + 系统首选英文 → en', () => {
    expect(resolveEffective('system', ['en-US'])).toBe('en')
  })

  test('system + 系统首选其他语言(法语)→ en(只支持中英)', () => {
    expect(resolveEffective('system', ['fr-FR', 'zh-CN'])).toBe('en')
  })

  test('system + 空数组 → en(兜底)', () => {
    expect(resolveEffective('system', [])).toBe('en')
  })

  test('system + 大小写不敏感(ZH-HANS)→ zh', () => {
    expect(resolveEffective('system', ['ZH-HANS'])).toBe('zh')
  })
})

import { test, expect, describe } from 'vitest'
import { DICT } from './dict'

describe('DICT 完整性', () => {
  test('zh 与 en 键集合完全一致(防漏译/手滑)', () => {
    const zhKeys = Object.keys(DICT.zh).sort()
    const enKeys = Object.keys(DICT.en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  test('无空译文', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const [k, v] of Object.entries(DICT[lang])) {
        expect(v, `${lang}.${k} 不应为空`).toBeTruthy()
      }
    }
  })

  test('带 {var} 的键两种语言占位符一致(防插值键漏写)', () => {
    const placeholders = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const k of Object.keys(DICT.zh)) {
      const key = k as keyof typeof DICT.zh
      expect(placeholders(DICT.en[key]), `${k} 占位符应与 zh 一致`).toEqual(
        placeholders(DICT.zh[key])
      )
    }
  })
})

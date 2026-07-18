import { test, expect, describe } from 'vitest'
import { createT } from './t'
import type { Lang } from './t'

// 独立于最终字典:注入一份小字典测查表/插值/回退语义。
const DICT: Record<Lang, Record<string, string>> = {
  zh: { hello: '你好', greet: '你好 {name}', both: '{a} 和 {b}' },
  en: { hello: 'Hello', greet: 'Hi {name}', both: '{a} and {b}', onlyEn: 'only-en' }
}

describe('createT', () => {
  test('按当前语言查表命中', () => {
    let lang: Lang = 'zh'
    const t = createT(DICT, () => lang)
    expect(t('hello')).toBe('你好')
    lang = 'en'
    expect(t('hello')).toBe('Hello')
  })

  test('{var} 插值替换', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('greet', { name: '张三' })).toBe('你好 张三')
  })

  test('多占位符都替换', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('both', { a: 'A', b: 'B' })).toBe('A 和 B')
  })

  test('数字参数按字符串插值', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('greet', { name: 3 })).toBe('你好 3')
  })

  test('params 缺失时占位符原样保留,不崩', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('greet')).toBe('你好 {name}')
  })

  test('当前语言缺 key → 回退 en', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('onlyEn' as never)).toBe('only-en')
  })

  test('en 也缺 key → 回退 key 本身(开发期可见,不崩)', () => {
    const t = createT(DICT, () => 'zh')
    expect(t('missing' as never)).toBe('missing')
  })
})

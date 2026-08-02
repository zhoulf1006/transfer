// 落地页字典的键集合对齐。
//
// 为什么需要它:t() 在当前语言缺键时回落到 defaultLocale(= zh),英文页会静默混进中文,
// 而站点没有任何自动关卡能发现——`astro build` 不做类型检查(esbuild 只剥类型),
// CI 的 build.yml 只跑打包、不跑 typecheck/test,`astro check` 有脚本但无人调用。
// 类型上的 `Record<UIKey, string>` 只在编辑器与 `astro check` 里报错;这条测试是
// 目前唯一进入 `pnpm test` 的关卡(根 vitest 的 include 已覆盖 site/src)。
import { test, expect, describe } from 'vitest'
import { ui, languages, defaultLocale, useTranslations } from './ui'

describe('落地页字典', () => {
  test('每种语言的键集合与 zh 完全一致(多一个少一个都算漏)', () => {
    const expected = Object.keys(ui.zh).sort()
    for (const locale of Object.keys(languages) as (keyof typeof languages)[]) {
      expect(Object.keys(ui[locale]).sort(), `${locale} 的键集合与 zh 不一致`).toEqual(expected)
    }
  })

  test('没有意外的空文案(占位符忘了填,页面上是一片空白)', () => {
    // 中文把数字前后夹住(「当前已有 N 次下载」),英文只有前缀(「Downloads so far: N」),
    // 后缀天然为空。这是语序差异不是漏译,故显式豁免——豁免写在这里,新出现的空文案照样报。
    const BLANK_BY_DESIGN = new Set(['download.stats.suffix'])
    for (const locale of Object.keys(languages) as (keyof typeof languages)[]) {
      const blank = Object.entries(ui[locale])
        .filter(([k, v]) => v.trim() === '' && !BLANK_BY_DESIGN.has(k))
        .map(([k]) => k)
      expect(blank, `${locale} 有空文案`).toEqual([])
    }
  })

  test('en 的文案不得原样等于 zh 的中文(未翻译直接抄过去)', () => {
    // 品牌名/专有名词天然中英同形,豁免。
    const SAME_BY_DESIGN = new Set(['site.name', 'nav.github', 'download.source.github'])
    const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s)
    const untranslated = Object.keys(ui.zh)
      .filter((k) => !SAME_BY_DESIGN.has(k))
      .filter((k) => {
        const key = k as keyof typeof ui.zh
        return ui.en[key] === ui.zh[key] && hasHan(ui.zh[key])
      })
    expect(untranslated, 'en 里这些键还是中文原文').toEqual([])
  })

  test('t() 对未知键返回键本身,不返回 undefined', () => {
    // 兜底行为的回归线:少了它,渲染出来是空白而不是可见的键名。
    expect(useTranslations('en')('nope.not.a.key')).toBe('nope.not.a.key')
  })

  test('defaultLocale 是 ui 里真实存在的语言', () => {
    expect(Object.keys(ui)).toContain(defaultLocale)
  })
})

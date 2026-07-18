// 语言偏好 → 有效语言的解析(纯逻辑,注入 langs 便于测,不直接依赖 Electron)。
// main 侧 wrapper 传入 app.getPreferredSystemLanguages() 的结果调用(见 docs/i18n-follow-system.md §3)。

import type { Lang } from './t'

/** 语言偏好:跟随系统 / 强制中文 / 强制英文。存盘用。 */
export type LangPref = 'system' | 'zh' | 'en'

/**
 * 把偏好解析成实际渲染用的有效语言。
 * - 'zh'/'en':直接返回,不看系统。
 * - 'system':看系统首选语言(langs[0]);以 'zh' 开头 → zh,其余(含空/未知)→ en(只支持中英)。
 *
 * langs 由 main 侧传 app.getPreferredSystemLanguages()(按偏好排序,如 ['zh-Hans-CN','en-US'])。
 */
export function resolveEffective(pref: LangPref, langs: string[]): Lang {
  if (pref === 'zh' || pref === 'en') return pref
  const top = (langs[0] ?? '').toLowerCase()
  return top.startsWith('zh') ? 'zh' : 'en'
}

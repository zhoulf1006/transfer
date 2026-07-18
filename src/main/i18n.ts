// 主进程 i18n:持有“当前有效语言”内存态,供主进程文案(dialog/文件名前缀)读取。
// 与两个渲染 window 共享同一份字典 DICT(见 docs/i18n-follow-system.md §2.4)。

import { app } from 'electron'
import { DICT } from '@shared/i18n/dict'
import { createT } from '@shared/i18n/t'
import type { Lang } from '@shared/i18n/t'
import { resolveEffective, type LangPref } from '@shared/i18n/resolve'

// 当前有效语言;默认 zh(启动时 initMainLang 会按 settings 覆盖)。
let currentLang: Lang = 'zh'

/** 主进程翻译函数:闭包读 currentLang,故 setMainLang 后即反映新语言。 */
export const t = createT(DICT, () => currentLang)

/** 更新主进程当前有效语言(setLanguage IPC 时调用)。 */
export function setMainLang(lang: Lang): void {
  currentLang = lang
}

/** 读当前有效语言(overlay URL query 注入用)。 */
export function getMainLang(): Lang {
  return currentLang
}

/**
 * 把偏好解析成有效语言 —— system 时调 app.getPreferredSystemLanguages()。
 * 必须在 app ready 之后调用(Electron 要求)。
 */
export function resolveSystemEffective(pref: LangPref): Lang {
  return resolveEffective(pref, app.getPreferredSystemLanguages())
}

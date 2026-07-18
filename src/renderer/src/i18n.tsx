// 渲染层 i18n:React context 持有当前有效语言,驱动整树热切换。
// 两个 window(index + overlay)各包一个 <I18nProvider>;它们读同一 settings,effective 一致。
// 见 docs/i18n-follow-system.md §2.3。

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DICT, type TKey } from '@shared/i18n/dict'
import { createT, type Lang, type TFn } from '@shared/i18n/t'
import type { LangPref } from '@shared/ipc'

type I18nValue = {
  /** 翻译函数(闭包当前 lang;key 受 TKey 约束) */
  t: TFn<TKey>
  /** 当前有效语言 */
  lang: Lang
  /** 当前偏好(system/zh/en) */
  pref: LangPref
  /** 切换偏好:走 IPC 存盘 + 主进程同步,回传 effective 更新 lang(热切换) */
  setPref: (p: LangPref) => void
}

const I18nContext = createContext<I18nValue | null>(null)

/** 从 URL query 读初始语言(overlay 无闪注入用);无则 null。 */
function langFromQuery(): Lang | null {
  const q = new URLSearchParams(window.location.search).get('lang')
  return q === 'zh' || q === 'en' ? q : null
}

/**
 * lang 初值:overlay 由 URL query(?lang=)注入 → 首帧即正确(无中文闪现,langFromQuery);
 * 主窗无 query → 用占位 'zh',异步 IPC(getLanguage)拉回 effective 后校正。
 */
export function I18nProvider(props: { children: ReactNode }): JSX.Element {
  const [lang, setLang] = useState<Lang>(() => langFromQuery() ?? 'zh')
  const [pref, setPrefState] = useState<LangPref>('system')

  // 首次:拉回持久化的偏好 + 有效语言(system 已由 main 解析)。
  // 并订阅 main 广播的语言变化:覆盖"另一个 window 改了语言"(尤其常驻 overlay)——
  // 发起改语言的 window 自身也会收到(值相同,幂等无害)。
  useEffect(() => {
    window.transfer.getLanguage().then(({ pref, effective }) => {
      setPrefState(pref)
      setLang(effective)
    })
    return window.transfer.onLanguageChanged((effective) => setLang(effective))
  }, [])

  const setPref = (p: LangPref): void => {
    setPrefState(p) // 乐观更新偏好(select 立即反映选中项)
    void window.transfer.setLanguage(p).then(({ effective }) => setLang(effective))
  }

  // t 每次 render 用当前 lang 造(lang 变即整树重渲、t 重算)。
  const t = createT(DICT, () => lang)
  return <I18nContext.Provider value={{ t, lang, pref, setPref }}>{props.children}</I18nContext.Provider>
}

/** 取 i18n。必须在 <I18nProvider> 内。 */
export function useI18n(): I18nValue {
  const v = useContext(I18nContext)
  if (!v) throw new Error('useI18n must be used within <I18nProvider>')
  return v
}

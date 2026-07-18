// 极简 i18n 运行时:查表 + {var} 插值 + 回退。零依赖、不含 React。
// 主进程与两个渲染 window 共享同一份字典(见 docs/i18n-follow-system.md §2.1)。
//
// 选型:自研而非 i18next —— 调研显示一线开源 Electron 应用(VS Code/Signal/Joplin/
// Element/Bitwarden/Logseq)无一用 i18next;55 条/中英/无复数的规模,引擎卖点全用不上。

/** 有效语言(实际渲染用),非偏好。偏好 LangPref 见 @shared/ipc。 */
export type Lang = 'zh' | 'en'

/** 翻译参数:{var} 占位符的替换值。 */
export type TParams = Record<string, string | number>

/** 翻译函数签名(K=字典键联合,给 key 编译期校验;错拼键即报错)。 */
export type TFn<K extends string = string> = (key: K, params?: TParams) => string

/**
 * 造一个读“当前语言”的 t()。lang 由外部注入(renderer=context state,main=模块内 currentLang),
 * 故语言变化时同一个 t 引用即反映新语言(闭包读 getLang())。
 *
 * 泛型 K 从传入 dict 的键推导 → 返回的 t 的 key 参数被约束为字典键(错拼即编译报错,
 * 把 dict 的 TKey 完整性延伸到所有调用点,含动态 key 调用者)。
 *
 * 语义:查 dict[lang][key];缺失回退 dict.en[key];再缺回退 key 本身(开发期可见,不崩)。
 * 插值:把 `{name}` 按 params 替换;params 缺该键时占位符原样保留。
 */
export function createT<K extends string>(
  dict: Record<Lang, Record<K, string>>,
  getLang: () => Lang
): TFn<K> {
  return (key, params) => {
    const lang = getLang()
    const raw = dict[lang][key] ?? dict.en[key] ?? (key as string)
    if (!params) return raw
    return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
      name in params ? String(params[name]) : m
    )
  }
}

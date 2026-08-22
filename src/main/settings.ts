// 应用设置持久化(自动接收开关+阈值,见 docs/DESIGN §11.0)
//
// 存 userData/settings.json。默认自动接收**关**(全部文件弹确认);文本不受此约束(永远入流)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import type { LangPref } from '@shared/i18n/resolve'
import { OFFLINE_KEEP_DEFAULT_MINUTES } from '@shared/offline-keep'
import type { ReceiveDirState } from './receive-dir'

export interface AutoAcceptSettings {
  /** 是否启用自动接收(仅约束文件,文本永远自动入流) */
  enabled: boolean
  /** 自动接收的文件大小上限(字节);size ≤ maxBytes 才自动收 */
  maxBytes: number
}

/** 主题偏好:跟随系统 / 强制浅 / 强制深。存 main 侧,避开 file:// 下 localStorage 慢(3.9s)。 */
export type ThemePref = 'system' | 'light' | 'dark'

/** 截图快捷键默认值(Electron accelerator);未自定义时用它。 */
export const DEFAULT_SHORTCUT_CAPTURE = 'F1'

export interface AppSettings {
  autoAccept: AutoAcceptSettings
  theme: ThemePref
  /** 界面语言偏好:跟随系统 / 中文 / 英文。默认 system(见 docs/features/general.md)。 */
  language: LangPref
  /** 截图快捷键(Electron accelerator 字符串,如 'F1' / 'Command+Shift+A') */
  shortcutCapture: string
  /** 远端设备备注:key = 设备 fingerprint,value = 备注(非空;空即删除该键)。见 CONTEXT.md「备注(远端设备别名)」 */
  deviceAliases: Record<string, string>
  /**
   * 离线设备在列表里保留的时长(**分钟**);超时后自动从发现表删除。0 = 从不删除(永久灰置底保留)。
   * 只存分钟数,Infinity 只在 registry 运行时存在(见 @shared/offline-keep)。默认 60。
   */
  offlineKeepMinutes: number
  /**
   * 用户选定的接收文件夹(绝对路径);**null = 用系统下载目录**。
   * 不把默认路径写进来:那样系统下载目录一变,这里就留下一个过期的绝对路径。
   */
  receiveDir: string | null
  /** 有一条未读的「接收文件夹已改回默认」告知。必须持久化——它要活过重启(spec receive-dir D3)。 */
  receiveDirNotice: boolean
  /**
   * 用户选定目录时拿到的 security-scoped bookmark(base64)。**只有 Mac App Store 沙盒版用得上**:
   * 沙盒进程重启后不自动保留对用户选定目录的写权限,得靠它重新取得。
   * 少了它,沙盒版每次重启都会因写不进去而被判目录失效、退回默认——用户看到的是
   * "我明明设过,怎么又变回去了",而失败发生在收文件那一刻,离配置很远。
   * 恒与 `receiveDir` 同生共死(见 normalize):后者为 null 时它必为 null。
   */
  receiveDirBookmark: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoAccept: {
    enabled: false, // DESIGN §11.0:默认关,全部弹确认
    maxBytes: 100 * 1024 * 1024 // 100MB(启用后的默认阈值)
  },
  theme: 'system',
  language: 'system',
  shortcutCapture: DEFAULT_SHORTCUT_CAPTURE,
  deviceAliases: {},
  offlineKeepMinutes: OFFLINE_KEEP_DEFAULT_MINUTES,
  receiveDir: null,
  receiveDirNotice: false,
  receiveDirBookmark: null
}

/** 归一化(容错旧/损坏字段),保证返回合法结构 */
function normalize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  const aa = (r.autoAccept ?? {}) as Partial<AutoAcceptSettings>
  const theme: ThemePref =
    r.theme === 'light' || r.theme === 'dark' || r.theme === 'system' ? r.theme : DEFAULT_SETTINGS.theme
  const language: LangPref =
    r.language === 'zh' || r.language === 'en' || r.language === 'system'
      ? r.language
      : DEFAULT_SETTINGS.language
  // 只保证是非空字符串;是否为合法/可注册 accelerator 是运行时 register 的事,不在此校验。
  const shortcutCapture =
    typeof r.shortcutCapture === 'string' && r.shortcutCapture.trim()
      ? r.shortcutCapture
      : DEFAULT_SETTINGS.shortcutCapture
  // 接收文件夹必须是**绝对**路径:相对路径在不同 cwd 下指向不同地方,而这个值要跨进程跨重启使用。
  // isAbsolute 一条就够——空串与纯空白它同样返回 false,再加一道 trim 判断是冗余的。
  // 值本身不 trim、不去尾斜杠:它来自系统选择器,擅自改写会让它对不上真实目录
  // (目录名尾部带空格是合法的)。
  const receiveDir =
    typeof r.receiveDir === 'string' && isAbsolute(r.receiveDir)
      ? r.receiveDir
      : DEFAULT_SETTINGS.receiveDir
  // 设备备注:非 object → {};逐项过滤,保证 value 恒为非空字符串(消费端不用再判空)。
  const deviceAliases: Record<string, string> = {}
  const rawMap = r.deviceAliases as unknown
  if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
    for (const [fp, name] of Object.entries(rawMap as Record<string, unknown>)) {
      if (fp && typeof name === 'string' && name.trim()) deviceAliases[fp] = name
    }
  }
  return {
    autoAccept: {
      enabled: typeof aa.enabled === 'boolean' ? aa.enabled : DEFAULT_SETTINGS.autoAccept.enabled,
      maxBytes:
        typeof aa.maxBytes === 'number' && aa.maxBytes >= 0
          ? aa.maxBytes
          : DEFAULT_SETTINGS.autoAccept.maxBytes
    },
    theme,
    language,
    shortcutCapture,
    deviceAliases,
    // 0(从不)必须原样保留 → 用 Number.isInteger && >= 0(不能用 falsy 判断,否则 0 被吃回默认)。
    // 缺失(undefined)/负/小数/NaN/非数 → 回默认 60。
    offlineKeepMinutes:
      typeof r.offlineKeepMinutes === 'number' &&
      Number.isInteger(r.offlineKeepMinutes) &&
      r.offlineKeepMinutes >= 0
        ? r.offlineKeepMinutes
        : DEFAULT_SETTINGS.offlineKeepMinutes,
    receiveDir,
    receiveDirNotice:
      typeof r.receiveDirNotice === 'boolean'
        ? r.receiveDirNotice
        : DEFAULT_SETTINGS.receiveDirNotice,
    // 书签与它授权的那个目录绑定:没有自定义目录时留着它没有任何意义,
    // 只会让"当前用默认目录"与"却持有某处的授权"同时为真。在这里强制同步,
    // 于是调用方无论怎么写都不可能留下悬空授权。
    receiveDirBookmark:
      receiveDir && typeof r.receiveDirBookmark === 'string' && r.receiveDirBookmark
        ? r.receiveDirBookmark
        : null
  }
}

export class SettingsStore {
  private readonly file: string
  private cache: AppSettings

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json')
    this.cache = this.load()
  }

  private load(): AppSettings {
    if (existsSync(this.file)) {
      try {
        return normalize(JSON.parse(readFileSync(this.file, 'utf8')))
      } catch {
        // 损坏 → 用默认
      }
    }
    return normalize(undefined)
  }

  get(): AppSettings {
    return this.cache
  }

  getAutoAccept(): AutoAcceptSettings {
    return this.cache.autoAccept
  }

  setAutoAccept(next: Partial<AutoAcceptSettings>): AppSettings {
    this.cache = normalize({
      ...this.cache,
      autoAccept: { ...this.cache.autoAccept, ...next }
    })
    this.persist()
    return this.cache
  }

  /** 接收文件夹的两项设置。它们总是一起变(选定/退回/清告知都同时动),故作为整体存取。 */
  getReceiveDir(): ReceiveDirState {
    return { chosen: this.cache.receiveDir, notice: this.cache.receiveDirNotice }
  }

  /**
   * 沙盒授权书签(仅 MAS 版有值)。与 `receiveDir` 恒同生共死,见 normalize。
   */
  getReceiveDirBookmark(): string | null {
    return this.cache.receiveDirBookmark
  }

  /**
   * 写接收文件夹。`bookmark` **默认不给就是清空** —— 于是"退回默认时忘了清书签"
   * 这种错写不出来:调用方必须显式传,才可能留下书签。
   */
  setReceiveDir(next: ReceiveDirState, bookmark: string | null = null): ReceiveDirState {
    this.cache = normalize({
      ...this.cache,
      receiveDir: next.chosen,
      receiveDirNotice: next.notice,
      receiveDirBookmark: bookmark
    })
    this.persist()
    return this.getReceiveDir()
  }

  getTheme(): ThemePref {
    return this.cache.theme
  }

  setTheme(theme: ThemePref): ThemePref {
    this.cache = normalize({ ...this.cache, theme })
    this.persist()
    return this.cache.theme
  }

  getLanguage(): LangPref {
    return this.cache.language
  }

  setLanguage(language: LangPref): LangPref {
    this.cache = normalize({ ...this.cache, language })
    this.persist()
    return this.cache.language
  }

  getOfflineKeepMinutes(): number {
    return this.cache.offlineKeepMinutes
  }

  setOfflineKeepMinutes(minutes: number): number {
    this.cache = normalize({ ...this.cache, offlineKeepMinutes: minutes })
    this.persist()
    return this.cache.offlineKeepMinutes
  }

  getShortcutCapture(): string {
    return this.cache.shortcutCapture
  }

  setShortcutCapture(accel: string): string {
    this.cache = normalize({ ...this.cache, shortcutCapture: accel })
    this.persist()
    return this.cache.shortcutCapture
  }

  getDeviceAliases(): Record<string, string> {
    return this.cache.deviceAliases
  }

  /**
   * 设置设备备注(key = fingerprint)。空串(trim 后)→ 删除该键(恢复默认名)。
   * 返回是否持久化成功:失败则**回滚 cache**并返回 false(不留"内存改了盘没存"的假成功),
   * 供 renderer 就地反馈失败。⚠️ 与 setTheme/setAutoAccept 的"不 catch 抛异常"有意不同:
   * 本方法特意 catch + 回滚 + 返回 bool,因为要给 renderer 失败反馈。这是有意的不一致,不是疏漏。
   */
  setDeviceAlias(fingerprint: string, alias: string): boolean {
    const trimmed = alias.trim()
    const next = { ...this.cache.deviceAliases }
    if (trimmed) next[fingerprint] = trimmed
    else delete next[fingerprint]
    const prevCache = this.cache
    this.cache = normalize({ ...this.cache, deviceAliases: next })
    try {
      this.persist()
      return true
    } catch (e) {
      this.cache = prevCache
      console.error('[settings] persist deviceAlias failed:', e)
      return false
    }
  }

  private persist(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2))
  }

  /**
   * 判定一个文件是否应自动接收(纯判定,DESIGN §11.2)。
   * 文本消息不走此判定(永远入流),由调用方先排除。
   */
  shouldAutoAccept(fileSize: number): boolean {
    const aa = this.cache.autoAccept
    return aa.enabled && fileSize <= aa.maxBytes
  }
}

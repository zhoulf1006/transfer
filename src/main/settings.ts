// 应用设置持久化(自动接收开关+阈值,见 docs/DESIGN §11.0)
//
// 存 userData/settings.json。默认自动接收**关**(全部文件弹确认);文本不受此约束(永远入流)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { LangPref } from '@shared/i18n/resolve'
import { OFFLINE_KEEP_DEFAULT_MINUTES } from '@shared/offline-keep'

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
  /** 界面语言偏好:跟随系统 / 中文 / 英文。默认 system(见 docs/i18n-follow-system.md)。 */
  language: LangPref
  /** 截图快捷键(Electron accelerator 字符串,如 'F1' / 'Command+Shift+A') */
  shortcutCapture: string
  /** 远端设备备注:key = 设备 fingerprint,value = 备注(非空;空即删除该键)。见 docs/device-alias.md */
  deviceAliases: Record<string, string>
  /**
   * 离线设备在列表里保留的时长(**分钟**);超时后自动从发现表删除。0 = 从不删除(永久灰置底保留)。
   * 只存分钟数,Infinity 只在 registry 运行时存在(见 @shared/offline-keep)。默认 60。
   */
  offlineKeepMinutes: number
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
  offlineKeepMinutes: OFFLINE_KEEP_DEFAULT_MINUTES
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
        : DEFAULT_SETTINGS.offlineKeepMinutes
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
   * 供 renderer 就地反馈失败。⚠️ 与 setTheme/setAutoAccept 的"不 catch 抛异常"有意不同(见 docs/device-alias.md §2.2)。
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

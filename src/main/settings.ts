// 应用设置持久化(自动接收开关+阈值,见 docs/DESIGN §11.0)
//
// 存 userData/settings.json。默认自动接收**关**(全部文件弹确认);文本不受此约束(永远入流)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

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
  /** 截图快捷键(Electron accelerator 字符串,如 'F1' / 'Command+Shift+A') */
  shortcutCapture: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoAccept: {
    enabled: false, // DESIGN §11.0:默认关,全部弹确认
    maxBytes: 100 * 1024 * 1024 // 100MB(启用后的默认阈值)
  },
  theme: 'system',
  shortcutCapture: DEFAULT_SHORTCUT_CAPTURE
}

/** 归一化(容错旧/损坏字段),保证返回合法结构 */
function normalize(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  const aa = (r.autoAccept ?? {}) as Partial<AutoAcceptSettings>
  const theme: ThemePref =
    r.theme === 'light' || r.theme === 'dark' || r.theme === 'system' ? r.theme : DEFAULT_SETTINGS.theme
  // 只保证是非空字符串;是否为合法/可注册 accelerator 是运行时 register 的事,不在此校验。
  const shortcutCapture =
    typeof r.shortcutCapture === 'string' && r.shortcutCapture.trim()
      ? r.shortcutCapture
      : DEFAULT_SETTINGS.shortcutCapture
  return {
    autoAccept: {
      enabled: typeof aa.enabled === 'boolean' ? aa.enabled : DEFAULT_SETTINGS.autoAccept.enabled,
      maxBytes:
        typeof aa.maxBytes === 'number' && aa.maxBytes >= 0
          ? aa.maxBytes
          : DEFAULT_SETTINGS.autoAccept.maxBytes
    },
    theme,
    shortcutCapture
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

  getShortcutCapture(): string {
    return this.cache.shortcutCapture
  }

  setShortcutCapture(accel: string): string {
    this.cache = normalize({ ...this.cache, shortcutCapture: accel })
    this.persist()
    return this.cache.shortcutCapture
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

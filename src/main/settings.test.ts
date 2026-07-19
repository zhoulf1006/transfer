import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore, DEFAULT_SETTINGS } from './settings'

describe('SettingsStore', () => {
  const dirs: string[] = []
  function mkdir(): string {
    const d = mkdtempSync(join(tmpdir(), 'transfer-settings-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  test('首次无文件 → 默认(自动接收关)', () => {
    const s = new SettingsStore(mkdir())
    expect(s.getAutoAccept().enabled).toBe(false)
    expect(s.getAutoAccept().maxBytes).toBe(DEFAULT_SETTINGS.autoAccept.maxBytes)
  })

  test('setAutoAccept 持久化 + 重新加载可读', () => {
    const dir = mkdir()
    const s1 = new SettingsStore(dir)
    s1.setAutoAccept({ enabled: true, maxBytes: 5 * 1024 * 1024 })
    // 新实例从磁盘读
    const s2 = new SettingsStore(dir)
    expect(s2.getAutoAccept().enabled).toBe(true)
    expect(s2.getAutoAccept().maxBytes).toBe(5 * 1024 * 1024)
  })

  test('部分更新只改指定字段', () => {
    const s = new SettingsStore(mkdir())
    s.setAutoAccept({ enabled: true })
    expect(s.getAutoAccept().enabled).toBe(true)
    expect(s.getAutoAccept().maxBytes).toBe(DEFAULT_SETTINGS.autoAccept.maxBytes) // 未动
  })

  test('损坏的 settings.json → 回退默认不崩', () => {
    const dir = mkdir()
    writeFileSync(join(dir, 'settings.json'), 'not json {{{')
    const s = new SettingsStore(dir)
    expect(s.getAutoAccept().enabled).toBe(false)
  })

  test('非法字段被归一化', () => {
    const dir = mkdir()
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ autoAccept: { enabled: 'yes', maxBytes: -5 } })
    )
    const s = new SettingsStore(dir)
    expect(s.getAutoAccept().enabled).toBe(false) // 'yes' 非 bool → 默认
    expect(s.getAutoAccept().maxBytes).toBe(DEFAULT_SETTINGS.autoAccept.maxBytes) // 负数 → 默认
  })

  describe('shouldAutoAccept', () => {
    test('关闭时永远 false', () => {
      const s = new SettingsStore(mkdir())
      s.setAutoAccept({ enabled: false, maxBytes: 100 })
      expect(s.shouldAutoAccept(50)).toBe(false)
    })
    test('开启时按阈值判定', () => {
      const s = new SettingsStore(mkdir())
      s.setAutoAccept({ enabled: true, maxBytes: 1000 })
      expect(s.shouldAutoAccept(999)).toBe(true)
      expect(s.shouldAutoAccept(1000)).toBe(true) // ≤ 边界含等于
      expect(s.shouldAutoAccept(1001)).toBe(false)
    })
  })

  describe('theme', () => {
    test('首次无文件 → 默认 system', () => {
      const s = new SettingsStore(mkdir())
      expect(s.getTheme()).toBe('system')
    })

    test('setTheme 持久化 + 重新加载可读', () => {
      const dir = mkdir()
      new SettingsStore(dir).setTheme('dark')
      expect(new SettingsStore(dir).getTheme()).toBe('dark')
    })

    test('非法 theme 被归一化为 system', () => {
      const dir = mkdir()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'neon' }))
      expect(new SettingsStore(dir).getTheme()).toBe('system')
    })

    // 回归:setAutoAccept 曾丢掉 theme(未 spread this.cache)。改一个不能抹另一个。
    test('setAutoAccept 不抹掉已设的 theme', () => {
      const s = new SettingsStore(mkdir())
      s.setTheme('light')
      s.setAutoAccept({ enabled: true })
      expect(s.getTheme()).toBe('light')
    })
    test('setTheme 不抹掉 autoAccept', () => {
      const s = new SettingsStore(mkdir())
      s.setAutoAccept({ enabled: true, maxBytes: 42 })
      s.setTheme('dark')
      expect(s.getAutoAccept()).toEqual({ enabled: true, maxBytes: 42 })
    })
  })

  describe('language', () => {
    test('首次无文件 → 默认 system', () => {
      const s = new SettingsStore(mkdir())
      expect(s.getLanguage()).toBe('system')
    })

    test('setLanguage 持久化 + 重新加载可读', () => {
      const dir = mkdir()
      new SettingsStore(dir).setLanguage('en')
      expect(new SettingsStore(dir).getLanguage()).toBe('en')
    })

    test('非法 language 被归一化为 system', () => {
      const dir = mkdir()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ language: 'fr' }))
      expect(new SettingsStore(dir).getLanguage()).toBe('system')
    })

    // 回归:改一个偏好不能抹掉另一个(照 theme 的回归测)。
    test('setLanguage 不抹掉已设的 theme,反之亦然', () => {
      const s = new SettingsStore(mkdir())
      s.setTheme('light')
      s.setLanguage('zh')
      expect(s.getTheme()).toBe('light')
      s.setTheme('dark')
      expect(s.getLanguage()).toBe('zh')
    })
  })

  describe('shortcutCapture', () => {
    test('首次无文件 → 默认 F1', () => {
      const s = new SettingsStore(mkdir())
      expect(s.getShortcutCapture()).toBe('F1')
    })

    test('setShortcutCapture 持久化 + 重新加载可读', () => {
      const dir = mkdir()
      new SettingsStore(dir).setShortcutCapture('Command+Shift+A')
      expect(new SettingsStore(dir).getShortcutCapture()).toBe('Command+Shift+A')
    })

    test('非法(空/非字符串)shortcutCapture 归一化为默认', () => {
      const dir = mkdir()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ shortcutCapture: '   ' }))
      expect(new SettingsStore(dir).getShortcutCapture()).toBe('F1')
      const dir2 = mkdir()
      writeFileSync(join(dir2, 'settings.json'), JSON.stringify({ shortcutCapture: 123 }))
      expect(new SettingsStore(dir2).getShortcutCapture()).toBe('F1')
    })

    // 回归:改一个设置不能抹掉另一个(spread this.cache)
    test('setShortcutCapture 不抹 theme/autoAccept', () => {
      const s = new SettingsStore(mkdir())
      s.setTheme('dark')
      s.setAutoAccept({ enabled: true, maxBytes: 42 })
      s.setShortcutCapture('Control+F2')
      expect(s.getTheme()).toBe('dark')
      expect(s.getAutoAccept()).toEqual({ enabled: true, maxBytes: 42 })
    })
    test('setTheme/setAutoAccept 不抹 shortcutCapture', () => {
      const s = new SettingsStore(mkdir())
      s.setShortcutCapture('Command+Shift+X')
      s.setTheme('light')
      s.setAutoAccept({ enabled: true })
      expect(s.getShortcutCapture()).toBe('Command+Shift+X')
    })
  })

  test('持久化格式为可读 JSON', () => {
    const dir = mkdir()
    const s = new SettingsStore(dir)
    s.setAutoAccept({ enabled: true })
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(JSON.parse(raw).autoAccept.enabled).toBe(true)
  })

  describe('deviceAliases', () => {
    test('首次无文件 → 空 map', () => {
      const s = new SettingsStore(mkdir())
      expect(s.getDeviceAliases()).toEqual({})
    })

    test('setDeviceAlias 持久化 + 重新加载可读', () => {
      const dir = mkdir()
      const ok = new SettingsStore(dir).setDeviceAlias('fp1', '老张的电脑')
      expect(ok).toBe(true)
      expect(new SettingsStore(dir).getDeviceAliases()).toEqual({ fp1: '老张的电脑' })
    })

    test('trim 后存储(去首尾空白)', () => {
      const s = new SettingsStore(mkdir())
      s.setDeviceAlias('fp1', '  备注  ')
      expect(s.getDeviceAliases().fp1).toBe('备注')
    })

    test('空串(或纯空白)→ 删除该键(恢复默认名)', () => {
      const dir = mkdir()
      const s = new SettingsStore(dir)
      s.setDeviceAlias('fp1', '备注A')
      s.setDeviceAlias('fp2', '备注B')
      s.setDeviceAlias('fp1', '') // 删 fp1
      expect(s.getDeviceAliases()).toEqual({ fp2: '备注B' })
      s.setDeviceAlias('fp2', '   ') // 纯空白也删
      expect(s.getDeviceAliases()).toEqual({})
      // 持久化后重载确认 fp1/fp2 均已删
      expect(new SettingsStore(dir).getDeviceAliases()).toEqual({})
    })

    test('删不存在的键 → 幂等无副作用', () => {
      const s = new SettingsStore(mkdir())
      expect(s.setDeviceAlias('nope', '')).toBe(true)
      expect(s.getDeviceAliases()).toEqual({})
    })

    test('normalize 过滤脏数据(非 object / 空 value / 非字符串 value)', () => {
      const dir = mkdir()
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ deviceAliases: { good: '有效', empty: '', blank: '   ', num: 123, '': '空key' } })
      )
      // 只保留 good;empty/blank(空)、num(非串)、''(空key)全滤掉
      expect(new SettingsStore(dir).getDeviceAliases()).toEqual({ good: '有效' })
    })

    test('deviceAliases 为数组 → 归一化为 {}', () => {
      const dir = mkdir()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ deviceAliases: ['a', 'b'] }))
      expect(new SettingsStore(dir).getDeviceAliases()).toEqual({})
    })

    // 回归:改一个设置不能抹另一个(spread this.cache)
    test('setDeviceAlias 不抹 theme/autoAccept/shortcut', () => {
      const s = new SettingsStore(mkdir())
      s.setTheme('dark')
      s.setAutoAccept({ enabled: true, maxBytes: 42 })
      s.setShortcutCapture('Control+F2')
      s.setDeviceAlias('fp1', '备注')
      expect(s.getTheme()).toBe('dark')
      expect(s.getAutoAccept()).toEqual({ enabled: true, maxBytes: 42 })
      expect(s.getShortcutCapture()).toBe('Control+F2')
    })
    test('setTheme/setShortcut 不抹 deviceAliases', () => {
      const s = new SettingsStore(mkdir())
      s.setDeviceAlias('fp1', '备注')
      s.setTheme('light')
      s.setShortcutCapture('Command+Shift+X')
      expect(s.getDeviceAliases()).toEqual({ fp1: '备注' })
    })

    // 失败回滚:持久化失败(目录被删/不可写)→ 返回 false 且 cache 不变(不留假成功)
    test('persist 失败 → 返回 false 且 cache 回滚', () => {
      const dir = mkdir()
      const s = new SettingsStore(dir)
      s.setDeviceAlias('fp1', '原备注') // 先成功存一次
      // 删掉目录使后续 writeFileSync 失败(父目录不存在;persist 的 mkdir 只建 dirname 自身失败路径较难,
      // 改用只读文件:把 settings.json 变目录,writeFileSync 会 EISDIR)
      rmSync(join(dir, 'settings.json'))
      mkdirSync(join(dir, 'settings.json')) // 同名占位为目录 → 写文件必 EISDIR 失败
      const ok = s.setDeviceAlias('fp1', '新备注')
      expect(ok).toBe(false)
      expect(s.getDeviceAliases().fp1).toBe('原备注') // 回滚:仍是旧值,不是"新备注"
    })
  })

  describe('offlineKeepMinutes(离线设备保留时长)', () => {
    function loadRaw(dir: string, raw: unknown): SettingsStore {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(raw))
      return new SettingsStore(dir)
    }

    test('首次无文件 → 默认 60', () => {
      const s = new SettingsStore(mkdir())
      expect(s.getOfflineKeepMinutes()).toBe(60)
    })

    test('显式 0(从不)被原样保留,不回滚成 60', () => {
      // C4 防线:0 是 falsy,若 normalize 用 `x > 0 ? x : 默认` 会被吃掉 → "从不"永远选不上
      const s = loadRaw(mkdir(), { offlineKeepMinutes: 0 })
      expect(s.getOfflineKeepMinutes()).toBe(0)
    })

    test('缺失字段 → 60(区分于显式 0)', () => {
      const s = loadRaw(mkdir(), { theme: 'light' })
      expect(s.getOfflineKeepMinutes()).toBe(60)
    })

    test('非法值(负/小数/NaN/字符串/null)→ 60', () => {
      for (const bad of [-5, 1.5, NaN, 'abc', null]) {
        const s = loadRaw(mkdir(), { offlineKeepMinutes: bad })
        expect(s.getOfflineKeepMinutes()).toBe(60)
      }
    })

    test('正常值原样保留', () => {
      const s = loadRaw(mkdir(), { offlineKeepMinutes: 30 })
      expect(s.getOfflineKeepMinutes()).toBe(30)
    })

    test('setOfflineKeepMinutes 持久化 + 重新加载可读(含 0 往返)', () => {
      const dir = mkdir()
      const s1 = new SettingsStore(dir)
      s1.setOfflineKeepMinutes(0)
      // C2:存的是分钟(0),不是 Infinity —— JSON.stringify(0) 正常,JSON.stringify(Infinity) 会变 null
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).offlineKeepMinutes).toBe(0)
      const s2 = new SettingsStore(dir)
      expect(s2.getOfflineKeepMinutes()).toBe(0)
    })

    test('setOfflineKeepMinutes 不抹掉其它字段', () => {
      const s = new SettingsStore(mkdir())
      s.setTheme('dark')
      s.setOfflineKeepMinutes(120)
      expect(s.getTheme()).toBe('dark')
      expect(s.getOfflineKeepMinutes()).toBe(120)
    })
  })
})

import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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

  test('持久化格式为可读 JSON', () => {
    const dir = mkdir()
    const s = new SettingsStore(dir)
    s.setAutoAccept({ enabled: true })
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    expect(JSON.parse(raw).autoAccept.enabled).toBe(true)
  })
})

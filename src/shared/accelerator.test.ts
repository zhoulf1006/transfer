import { describe, it, expect } from 'vitest'
import {
  eventToAccelerator,
  acceleratorRejectReason,
  isValidAccelerator,
  type KeyInfo
} from './accelerator'

// 构造 KeyInfo 的便捷函数(默认无修饰)
function k(key: string, mods: Partial<KeyInfo> = {}): KeyInfo {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key, ...mods }
}

describe('eventToAccelerator', () => {
  it('mac Cmd+Shift+A → Command+Shift+A(修饰按录制实际键,不转 CommandOrControl)', () => {
    expect(eventToAccelerator(k('a', { metaKey: true, shiftKey: true }))).toBe('Command+Shift+A')
  })

  it('Win Ctrl+Shift+S → Control+Shift+S', () => {
    expect(eventToAccelerator(k('s', { ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+S')
  })

  it('功能键可无修饰:F1 → F1;F12 → F12', () => {
    expect(eventToAccelerator(k('F1'))).toBe('F1')
    expect(eventToAccelerator(k('F12'))).toBe('F12')
  })

  it('字母大小写归一为大写', () => {
    expect(eventToAccelerator(k('A', { ctrlKey: true }))).toBe('Control+A')
    expect(eventToAccelerator(k('z', { altKey: true }))).toBe('Alt+Z')
  })

  it('修饰键顺序固定 Command→Control→Alt→Shift', () => {
    expect(
      eventToAccelerator(k('k', { shiftKey: true, altKey: true, ctrlKey: true, metaKey: true }))
    ).toBe('Command+Control+Alt+Shift+K')
  })

  it('方向键 + 修饰 → Up/Down/Left/Right', () => {
    expect(eventToAccelerator(k('ArrowUp', { metaKey: true }))).toBe('Command+Up')
    expect(eventToAccelerator(k('ArrowRight', { ctrlKey: true }))).toBe('Control+Right')
  })

  it('特殊键归一:空格→Space、回车→Return', () => {
    expect(eventToAccelerator(k(' ', { ctrlKey: true }))).toBe('Control+Space')
    expect(eventToAccelerator(k('Enter', { metaKey: true }))).toBe('Command+Return')
  })

  // —— 返回 null 的情形 ——
  it('只按修饰键(无主键)→ null', () => {
    expect(eventToAccelerator(k('Meta', { metaKey: true }))).toBeNull()
    expect(eventToAccelerator(k('Shift', { shiftKey: true }))).toBeNull()
    expect(eventToAccelerator(k('Control', { ctrlKey: true }))).toBeNull()
  })

  it('普通字母/数字无修饰 → null(防裸键拦截打字)', () => {
    expect(eventToAccelerator(k('a'))).toBeNull()
    expect(eventToAccelerator(k('5'))).toBeNull()
  })

  it('不支持的键 → null', () => {
    expect(eventToAccelerator(k('Dead'))).toBeNull()
    expect(eventToAccelerator(k('CapsLock'))).toBeNull()
  })

  it('数字 + 修饰 → 合法', () => {
    expect(eventToAccelerator(k('3', { metaKey: true }))).toBe('Command+3')
  })
})

describe('acceleratorRejectReason', () => {
  it('只按修饰键 → incomplete', () => {
    expect(acceleratorRejectReason(k('Meta', { metaKey: true }))).toBe('incomplete')
  })
  it('普通字母无修饰 → need-modifier', () => {
    expect(acceleratorRejectReason(k('a'))).toBe('need-modifier')
  })
  it('不支持的键 → unsupported', () => {
    expect(acceleratorRejectReason(k('CapsLock'))).toBe('unsupported')
  })
})

describe('isValidAccelerator', () => {
  it('合法串通过', () => {
    expect(isValidAccelerator('F1')).toBe(true)
    expect(isValidAccelerator('Command+Shift+A')).toBe(true)
    expect(isValidAccelerator('Control+Alt+3')).toBe(true)
    expect(isValidAccelerator('Command+Up')).toBe(true)
  })
  it('空/非字符串 → false', () => {
    expect(isValidAccelerator('')).toBe(false)
    expect(isValidAccelerator('   ')).toBe(false)
    // @ts-expect-error 故意传非字符串
    expect(isValidAccelerator(null)).toBe(false)
  })
  it('非功能键主键无修饰 → false(裸字母不合法)', () => {
    expect(isValidAccelerator('A')).toBe(false)
    expect(isValidAccelerator('5')).toBe(false)
  })
  it('非法修饰名 → false', () => {
    expect(isValidAccelerator('Cmd+A')).toBe(false) // 'Cmd' 非 Electron 修饰名
    expect(isValidAccelerator('Super+A')).toBe(false)
  })
  it('主键非法 → false', () => {
    expect(isValidAccelerator('Command+CapsLock')).toBe(false)
    expect(isValidAccelerator('Command+F25')).toBe(false)
  })
})

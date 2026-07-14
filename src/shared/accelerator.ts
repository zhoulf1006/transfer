// KeyboardEvent → Electron accelerator 字符串(自定义截图快捷键录制用)。
// 纯函数,renderer(录制实时显示)与 main(保存前校验)共用,便于单测。
// Electron accelerator 语法:https://www.electronjs.org/docs/latest/api/accelerator

/** 录制时喂进来的最小按键信息(取 DOM KeyboardEvent 的子集,便于单测) */
export interface KeyInfo {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** KeyboardEvent.key(如 'a'/'A'/'F1'/'ArrowUp'/'Enter'/' ') */
  key: string
}

/** 功能键 F1–F24(允许无修饰单独作快捷键,默认 F1 即此类) */
function functionKey(key: string): string | null {
  const m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key)
  return m ? `F${m[1]}` : null
}

/**
 * 把主键(非修饰键)归一到 Electron 认的键名。返回 null = 不支持/不是有效主键。
 * 仅覆盖录制常用集:字母、数字、功能键、方向键、常见特殊键。
 */
function mainKey(key: string): string | null {
  // 功能键
  const fn = functionKey(key)
  if (fn) return fn
  // 字母(Electron 用大写单字母)
  if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
  // 数字(顶部数字键;小键盘由 key 值同样给 '0'-'9')
  if (/^[0-9]$/.test(key)) return key
  // 方向键
  const arrows: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right'
  }
  if (key in arrows) return arrows[key]
  // 常见特殊键(Electron 接受的名字)
  const special: Record<string, string> = {
    ' ': 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    '`': '`',
    '-': '-',
    '=': '=',
    '[': '[',
    ']': ']',
    '\\': '\\',
    ';': ';',
    "'": "'",
    ',': ',',
    '.': '.',
    '/': '/'
  }
  if (key in special) return special[key]
  return null
}

/** 是不是"不需要修饰键也能单独当快捷键"的主键(功能键)。 */
function standaloneAllowed(mainKeyName: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(mainKeyName)
}

/**
 * 录制:把一次 keydown 转成 Electron accelerator 字符串。
 * 返回 null 表示"这次按键还不构成一个可用快捷键",UI 应继续等待,原因经 acceleratorRejectReason 拿。
 * 规则:
 *  - 只按修饰键(无主键)→ null(录制未完成)。
 *  - 主键不支持 → null。
 *  - 非功能键主键**必须带至少一个修饰键**(否则如裸 'A' 会拦截正常输入)→ 无修饰时 null。
 *  - 功能键(F1–F24)可无修饰。
 * 修饰键跨平台各存各的:mac 的 Cmd→Command、Ctrl→Control;不强转 CommandOrControl(录的是实际按键)。
 */
export function eventToAccelerator(e: KeyInfo): string | null {
  const main = mainKey(e.key)
  if (main === null) return null // 只有修饰键,或不支持的主键
  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  // 非功能键且无任何修饰 → 不接受(避免裸字母键拦截打字)
  if (mods.length === 0 && !standaloneAllowed(main)) return null
  return [...mods, main].join('+')
}

/**
 * 录制被拒的原因(供 UI 提示)。仅在 eventToAccelerator 返回 null 时有意义。
 * 'incomplete' = 只按了修饰键(继续等主键);'need-modifier' = 普通键缺修饰键;'unsupported' = 键不支持。
 */
export function acceleratorRejectReason(e: KeyInfo): 'incomplete' | 'need-modifier' | 'unsupported' {
  const main = mainKey(e.key)
  if (main === null) {
    // 是不是修饰键本身
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return 'incomplete'
    return 'unsupported'
  }
  const hasMod = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
  if (!hasMod && !standaloneAllowed(main)) return 'need-modifier'
  return 'incomplete' // 理论到不了(有效时 eventToAccelerator 已返非 null)
}

/**
 * 粗校验一个 accelerator 字符串结构是否合法(main 侧保存前用;非法直接拒,不劳 register)。
 * 规则:非空;'+' 分段;末段是合法主键;前面各段是合法修饰键;非功能键主键必须有修饰段。
 */
export function isValidAccelerator(s: string): boolean {
  if (typeof s !== 'string' || !s.trim()) return false
  const parts = s.split('+')
  const last = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  const validMod = (m: string): boolean => ['Command', 'Control', 'Alt', 'Shift'].includes(m)
  // 主键合法性:反查 mainKey 的输出集(功能键/大写字母/数字/方向/特殊名)
  const validMain =
    /^F([1-9]|1[0-9]|2[0-4])$/.test(last) ||
    /^[A-Z]$/.test(last) ||
    /^[0-9]$/.test(last) ||
    ['Up', 'Down', 'Left', 'Right', 'Space', 'Return', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'].includes(last)
  if (!validMain) return false
  if (!mods.every(validMod)) return false
  if (mods.length === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(last)) return false
  return true
}

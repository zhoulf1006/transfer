// 文件名安全化与去重(纯函数,见 docs/DESIGN §7:文件名注入 / 重名)

/**
 * 将接收到的 fileName 安全化,防止路径逃逸(../、绝对路径、盘符、NUL 等)。
 * 只保留 basename;剥离路径分隔符与危险字符;空/全点名退化为 fallback。
 */
export function sanitizeFileName(raw: string, fallback = 'file'): string {
  // 统一分隔符,取最后一段(同时处理 / 和 \)
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  let name = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw

  // 去掉控制字符 / NUL,以及 Windows 保留字符 <>:"/\|?*
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '')

  // 去掉首尾空白与尾部的点(Windows 不允许尾部点/空格)
  name = name.replace(/[. ]+$/g, '').trim()

  // "." ".." 或清空后为空 → fallback
  if (name === '' || name === '.' || name === '..') return fallback

  // Windows 保留设备名(CON, PRN, NUL, COM1..9, LPT1..9)——加前缀规避
  const base = name.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
    name = `_${name}`
  }

  return name
}

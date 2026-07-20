/**
 * 下载配置 —— 落地页下载区的唯一数据源。
 *
 * - `version` / 文件名:发版时由 CI 更新(接入 latest.json 后可改为运行时拉取)。
 *   现在先内置一份,保证本地就能看到完整下载区。
 * - `sources`:每个平台构建在「R2(主) / GitHub(兜底)」两处的下载 URL。
 */

export const VERSION = '0.9.0'

// 两个下载来源的 base
const R2_BASE = 'https://dl.aloongplanet.com/releases' // Cloudflare R2 自定义域(主)
const GITHUB_REPO = 'https://github.com/zhoulf1006/transfer' // GitHub Release(兜底)

/** 下载文件名（与 electron-builder 产物、GitHub Release 资产一致） */
function macArm64(v: string) {
  return `Transfer-${v}-mac-arm64.dmg`
}
function macX64(v: string) {
  return `Transfer-${v}-mac-x64.dmg`
}
function macUniversal(v: string) {
  return `Transfer-${v}-mac-universal.dmg`
}
function winSetup(v: string) {
  return `Transfer-${v}-win-setup.exe`
}
function winPortable(v: string) {
  return `Transfer-${v}-win-portable.exe`
}

/** 给定文件名，拼出两处来源的下载 URL */
export function sources(filename: string, version = VERSION) {
  return {
    // 主:R2 自定义域,按版本目录
    r2: `${R2_BASE}/v${version}/${filename}`,
    // 兜底:GitHub Release 附件
    github: `${GITHUB_REPO}/releases/download/v${version}/${filename}`,
  }
}

export interface DownloadItem {
  os: 'mac' | 'win'
  /** 变体标签的 i18n key，如 'download.mac.arm64' */
  labelKey: string
  filename: string
  sources: ReturnType<typeof sources>
}

/** 三平台五变体下载清单 */
export const DOWNLOADS: DownloadItem[] = [
  {
    os: 'mac',
    labelKey: 'download.mac.arm64',
    filename: macArm64(VERSION),
    sources: sources(macArm64(VERSION)),
  },
  {
    os: 'mac',
    labelKey: 'download.mac.x64',
    filename: macX64(VERSION),
    sources: sources(macX64(VERSION)),
  },
  {
    os: 'mac',
    labelKey: 'download.mac.universal',
    filename: macUniversal(VERSION),
    sources: sources(macUniversal(VERSION)),
  },
  {
    os: 'win',
    labelKey: 'download.win.setup',
    filename: winSetup(VERSION),
    sources: sources(winSetup(VERSION)),
  },
  {
    os: 'win',
    labelKey: 'download.win.portable',
    filename: winPortable(VERSION),
    sources: sources(winPortable(VERSION)),
  },
]

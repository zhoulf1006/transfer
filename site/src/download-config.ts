/**
 * 下载配置 —— 落地页下载区的唯一数据源。
 *
 * - `VERSION`:**手动维护**。CI 不会改它(build.yml 里的 VERSION 取自 tag,只用于 R2
 *   上传路径,与本文件无关)。**发版时必须手动同步这里**,否则落地页的下载链接仍指向
 *   上一版产物、全部 404。
 *   **顺序有讲究**:必须先确认 Release 产物已上传到 R2 且可下载,再改这里并部署。
 *   站点走 Pages 几十秒就上线,而 DMG 要签名 + 三架构各自公证(等 Apple 几十分钟),
 *   反过来做会留下一段真实的 404 窗口。接入 latest.json 后可改为运行时拉取,届时本行可删。
 * - `sources`:每个平台构建在「R2(主) / GitHub(兜底)」两处的下载 URL。
 */

export const VERSION = '1.2.1'

// 两个下载来源的 base
const R2_BASE = 'https://dl.aloongplanet.com/releases' // Cloudflare R2 自定义域(主)
const GITHUB_REPO = 'https://github.com/zhoulf1006/transfer' // GitHub Release(兜底)
const DOWNLOAD_STATS_PUBLIC_URL = 'https://dl.aloongplanet.com/stats/downloads.json'
const DOWNLOAD_STATS_DEV_PATH = '/__download-statistics'

export function getDownloadStatsUrl(isDev: boolean) {
  return isDev ? DOWNLOAD_STATS_DEV_PATH : DOWNLOAD_STATS_PUBLIC_URL
}

export const DOWNLOAD_STATS_URL = getDownloadStatsUrl(import.meta.env.DEV)

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

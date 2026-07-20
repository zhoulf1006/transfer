/**
 * 下载配置 —— 落地页下载区的唯一数据源。
 *
 * - `version` / 文件名:发版时由 CI 更新(阶段三接入 latest.json 后可改为运行时拉取)。
 *   现在先内置一份,保证阶段一本地就能看到完整下载区。
 * - `mirrors`:每个平台构建在「海外(R2)/ 中国(Gitee)/ 兜底(GitHub)」三处的下载 URL。
 *   R2 的自定义域(dl.example.com)、Gitee 仓库地址,在阶段三接好后回填这里的常量。
 */

export const VERSION = '0.9.0'

// 三个下载来源的 base（阶段三接好后回填真实值）
const R2_BASE = 'https://dl.aloongplanet.com/releases' // Cloudflare R2 自定义域(海外/默认)
const GITEE_REPO = 'https://gitee.com/aloong/transfer' // Gitee 镜像仓库(中国)
const GITHUB_REPO = 'https://github.com/zhoulf1006/transfer' // GitHub(兜底)

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

/** 给定文件名，拼出三处来源的下载 URL */
export function sources(filename: string, version = VERSION) {
  return {
    // 海外 / 默认:R2 自定义域,按版本目录
    r2: `${R2_BASE}/v${version}/${filename}`,
    // 中国:Gitee Release 附件
    gitee: `${GITEE_REPO}/releases/download/v${version}/${filename}`,
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
  /**
   * 该文件是否会镜像到 Gitee。Gitee 免费仓库单附件 ≤100 MiB、总附件 ≤1 GiB,
   * 故只镜像小文件(mac-arm64 / win-setup / win-portable);universal(177M)/x64(98M)不镜像。
   * CI 据此决定推哪些文件到 Gitee;落地页据此决定中国用户能否把默认源切到 Gitee。
   */
  giteeAvailable: boolean
}

/** 三平台五变体下载清单 */
export const DOWNLOADS: DownloadItem[] = [
  {
    os: 'mac',
    labelKey: 'download.mac.arm64',
    filename: macArm64(VERSION),
    sources: sources(macArm64(VERSION)),
    giteeAvailable: true, // 92M，进 Gitee
  },
  {
    os: 'mac',
    labelKey: 'download.mac.x64',
    filename: macX64(VERSION),
    sources: sources(macX64(VERSION)),
    giteeAvailable: false, // 98M，接近上限，不进 Gitee，中国用户指回 R2
  },
  {
    os: 'mac',
    labelKey: 'download.mac.universal',
    filename: macUniversal(VERSION),
    sources: sources(macUniversal(VERSION)),
    giteeAvailable: false, // 177M，超 Gitee 100M 上限，中国用户指回 R2
  },
  {
    os: 'win',
    labelKey: 'download.win.setup',
    filename: winSetup(VERSION),
    sources: sources(winSetup(VERSION)),
    giteeAvailable: true, // 81M，进 Gitee
  },
  {
    os: 'win',
    labelKey: 'download.win.portable',
    filename: winPortable(VERSION),
    sources: sources(winPortable(VERSION)),
    giteeAvailable: true, // 81M，进 Gitee
  },
]

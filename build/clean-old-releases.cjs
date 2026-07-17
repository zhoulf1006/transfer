// electron-builder afterAllArtifactBuild 钩子:每次打包后只保留最近 N 个版本目录。
//
// 背景:output=release/${version}(见 electron-builder.yml),electron-builder 只写不删 → 版本累积。
// 本脚本作为 afterAllArtifactBuild 钩子(configuration.d.ts:426,Hook<BuildResult, string[]>)在打包末尾运行。
// BuildResult.outDir(packager.d.ts:94)= 本次 release/<version>,其父目录即 release/ 根。
//
// 也可脱离打包**手动运行**清理已有产物:`node build/clean-old-releases.cjs [releaseRoot]`
//   (省略 releaseRoot 则默认脚本上级的 release/)。
//
// 保留个数:默认 5,可用环境变量 KEEP_RELEASES 覆盖。
// 原则:只删严格 semver 版本目录、按 semver(非字符串)排序、删除失败只警告不拖垮打包(清理是附加动作)。

const { readdirSync, statSync, rmSync } = require('node:fs')
const { join, dirname, resolve } = require('node:path')

const KEEP = Number(process.env.KEEP_RELEASES) || 5

// 严格 semver:MAJOR.MINOR.PATCH(可带 -prerelease 后缀,如 0.7.2-beta)。非此形态的目录/散文件一律不碰。
const SEMVER_DIR = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/

/** semver 比较:主.次.补 数值序;有 prerelease 的排在同版正式版之前(1.0.0-rc < 1.0.0)。 */
function cmpSemver(a, b) {
  const pa = a.match(SEMVER_DIR)
  const pb = b.match(SEMVER_DIR)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  // 主次补相同:无 prerelease(正式)> 有 prerelease
  const preA = a.includes('-')
  const preB = b.includes('-')
  if (preA !== preB) return preA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** 清理 releaseRoot 下的旧版本目录,保留最新 keep 个。返回被删的目录名数组。 */
function cleanOldReleases(releaseRoot, keep = KEEP) {
  let entries
  try {
    entries = readdirSync(releaseRoot)
  } catch {
    return [] // release 根不存在(理论不会,打包刚写过)——静默跳过
  }
  // 只取"是目录 且 名字是严格 semver"的项;散文件(latest-mac.yml 等)与非版本目录全部忽略
  const versionDirs = entries.filter((name) => {
    if (!SEMVER_DIR.test(name)) return false
    try {
      return statSync(join(releaseRoot, name)).isDirectory()
    } catch {
      return false
    }
  })
  if (versionDirs.length <= keep) return [] // 未超额,不删

  const sorted = versionDirs.sort(cmpSemver) // 升序:旧 → 新
  const toDelete = sorted.slice(0, sorted.length - keep) // 删掉除最新 keep 个之外的
  const deleted = []
  for (const name of toDelete) {
    try {
      rmSync(join(releaseRoot, name), { recursive: true, force: true })
      deleted.push(name)
    } catch (e) {
      // 删除失败(占用/权限)只警告,不抛 —— 清理不能拖垮打包
      console.warn(`[clean-old-releases] 删除 ${name} 失败(跳过):`, e && e.message)
    }
  }
  return deleted
}

/**
 * electron-builder 钩子入口(默认导出)。收 BuildResult,从 outDir 定位 release/ 根。
 * 返回 [] —— 本钩子不追加产物,只做删除副作用。
 */
module.exports = function afterAllArtifactBuild(buildResult) {
  const releaseRoot = dirname(buildResult.outDir) // release/<version> → release
  const kept = KEEP
  const deleted = cleanOldReleases(releaseRoot, kept)
  if (deleted.length) {
    console.log(
      `[clean-old-releases] 保留最近 ${kept} 个版本,已删除 ${deleted.length} 个旧版本:${deleted.join(', ')}`
    )
  }
  return [] // Hook<BuildResult, string[]>:无追加产物
}

// 允许手动运行:`node build/clean-old-releases.cjs [releaseRoot]`
if (require.main === module) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..', 'release')
  const deleted = cleanOldReleases(root, KEEP)
  console.log(
    deleted.length
      ? `保留最近 ${KEEP} 个,已删除 ${deleted.length} 个:${deleted.join(', ')}`
      : `无需清理(版本数 ≤ ${KEEP})`
  )
}

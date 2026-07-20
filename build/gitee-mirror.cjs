#!/usr/bin/env node
/**
 * 把本次发版的"小文件"镜像到 Gitee Releases —— 给中国大陆用户一个免备案、可达的下载入口。
 *
 * Gitee 免费仓库硬限制:单附件 ≤100 MiB、仓库总附件 ≤1 GiB。故:
 *  - 只上传 ≤ MAX_MB(默认 99)的产物;超限文件(如 mac-universal 177M)跳过(落地页对中国用户指回 R2)。
 *  - 发版前**先删同 tag 的旧 Release**,避免历史版本累积撑爆 1 GiB。
 *
 * 用法:
 *   GITEE_PAT=xxx node build/gitee-mirror.cjs <owner/repo> <version> <artifacts-dir>
 *     <version>:纯版本号,不带 v(如 0.9.0);Gitee tag 用 v<version>。
 *
 * 依赖:Node 18+ 内置 fetch / FormData / Blob(CI 用 node 20,满足)。
 *
 * 失败策略:本脚本抛错即退出非 0;CI 里这一步应设 continue-on-error,
 * 让 Gitee 挂掉不拖垮 GitHub Release / R2 主流程。
 */

const fs = require('node:fs')
const path = require('node:path')

const API = 'https://gitee.com/api/v5'
const MAX_MB = Number(process.env.GITEE_MAX_MB || 99)
const MAX_BYTES = MAX_MB * 1024 * 1024

function fail(msg) {
  console.error(`[gitee-mirror] ${msg}`)
  process.exit(1)
}

const token = process.env.GITEE_PAT
const [, , repo, version, artifactsDir] = process.argv
if (!token) fail('缺少环境变量 GITEE_PAT')
if (!repo || !version || !artifactsDir) {
  fail('用法: GITEE_PAT=xxx node build/gitee-mirror.cjs <owner/repo> <version> <artifacts-dir>')
}
if (!fs.existsSync(artifactsDir)) fail(`产物目录不存在: ${artifactsDir}`)

const [owner, repoName] = repo.split('/')
if (!owner || !repoName) fail(`仓库格式应为 owner/repo,收到: ${repo}`)
const tag = `v${version}`

// 只镜像这些"小文件"(与 site/src/download-config.ts 的 giteeAvailable 一致):
//   mac-arm64 / win-setup / win-portable。用后缀匹配,避免误传 universal/x64。
const MIRROR_SUFFIXES = ['-mac-arm64.dmg', '-win-setup.exe', '-win-portable.exe']

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

async function api(pathname, init = {}) {
  const url = `${API}${pathname}`
  const res = await fetch(url, init)
  return res
}

async function main() {
  // 收集待镜像文件(去重 + 后缀过滤 + 大小过滤)
  const seen = new Set()
  const toUpload = []
  for (const full of walk(artifactsDir)) {
    const name = path.basename(full)
    if (!MIRROR_SUFFIXES.some((s) => name.endsWith(s))) continue
    if (seen.has(name)) continue
    seen.add(name)
    const size = fs.statSync(full).size
    if (size > MAX_BYTES) {
      console.warn(`[gitee-mirror] 跳过超限文件(${(size / 1048576).toFixed(1)}M > ${MAX_MB}M): ${name}`)
      continue
    }
    toUpload.push({ full, name, size })
  }
  if (toUpload.length === 0) fail('没有符合条件的文件可镜像(检查产物目录与后缀过滤)')

  // 1) 删同 tag 旧 Release(存在才删),避免容量累积
  const listRes = await api(`/repos/${owner}/${repoName}/releases?access_token=${token}`)
  if (!listRes.ok) fail(`列出 Release 失败: ${listRes.status} ${await listRes.text()}`)
  const releases = await listRes.json()
  const old = Array.isArray(releases) ? releases.find((r) => r.tag_name === tag) : null
  if (old) {
    const delRes = await api(
      `/repos/${owner}/${repoName}/releases/${old.id}?access_token=${token}`,
      { method: 'DELETE' },
    )
    // Gitee 删除成功返回 204;失败不致命,继续尝试建新的
    console.log(`[gitee-mirror] 删除旧 Release ${tag}(id=${old.id}): ${delRes.status}`)
  }

  // 2) 建新 Release
  const createBody = new URLSearchParams({
    access_token: token,
    tag_name: tag,
    name: tag,
    body: `Transfer ${tag} — 国内镜像下载。完整平台(含 universal/x64)见 GitHub Releases。`,
    // Gitee 要求 target_commitish;用默认分支 master
    target_commitish: 'master',
  })
  const createRes = await api(`/repos/${owner}/${repoName}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: createBody,
  })
  if (!createRes.ok) fail(`创建 Release 失败: ${createRes.status} ${await createRes.text()}`)
  const release = await createRes.json()
  console.log(`[gitee-mirror] 已建 Release ${tag}(id=${release.id})`)

  // 3) 逐个上传附件
  for (const f of toUpload) {
    const form = new FormData()
    form.append('access_token', token)
    const buf = fs.readFileSync(f.full)
    // 字段名必须是 'file'(Gitee attach_files 规范);带 filename 让 Gitee 用它作附件名。
    form.append('file', new Blob([buf], { type: 'application/octet-stream' }), f.name)
    const upRes = await api(
      `/repos/${owner}/${repoName}/releases/${release.id}/attach_files`,
      { method: 'POST', body: form },
    )
    if (!upRes.ok) {
      fail(`上传附件失败 ${f.name}: ${upRes.status} ${await upRes.text()}`)
    }
    console.log(`[gitee-mirror] 已上传 ${f.name} (${(f.size / 1048576).toFixed(1)} MiB)`)
  }

  console.log(`[gitee-mirror] 完成:${tag} 镜像了 ${toUpload.length} 个文件到 gitee.com/${repo}`)
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)))

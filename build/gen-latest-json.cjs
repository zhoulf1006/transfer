#!/usr/bin/env node
/**
 * 生成 latest.json —— 落地页/更新检查读取的"最新版本清单"。
 *
 * 用法:
 *   node build/gen-latest-json.cjs <version> <artifacts-dir> <out-file>
 *
 * - <version>:纯版本号,不带 v 前缀(如 0.9.0)。由 CI 从 tag 去掉 v 传入。
 * - <artifacts-dir>:已下载的所有平台产物所在目录(递归找 *.dmg / *.exe)。
 * - <out-file>:输出 latest.json 的路径。
 *
 * 产出结构(供落地页运行时拉取,阶段四接入):
 *   {
 *     "version": "0.9.0",
 *     "releasedAt": "<CI 传入的时间戳，或留空>",
 *     "files": [
 *       { "name": "Transfer-0.9.0-mac-arm64.dmg", "size": 96468992, "os": "mac", "arch": "arm64" },
 *       ...
 *     ]
 *   }
 *
 * 只描述"有哪些文件、多大",不含下载 URL —— URL 由落地页按来源(R2/Gitee/GitHub)自行拼接,
 * 保持 latest.json 与托管位置解耦。
 */

const fs = require('node:fs')
const path = require('node:path')

function fail(msg) {
  console.error(`[gen-latest-json] ${msg}`)
  process.exit(1)
}

const [, , version, artifactsDir, outFile] = process.argv
if (!version || !artifactsDir || !outFile) {
  fail('用法: node build/gen-latest-json.cjs <version> <artifacts-dir> <out-file>')
}
if (!fs.existsSync(artifactsDir)) {
  fail(`产物目录不存在: ${artifactsDir}`)
}

// 递归收集 .dmg / .exe(排除 win-unpacked 里的中间件 exe:只认带 -win-setup / -win-portable 的)
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function classify(name) {
  // 从文件名推出 os / arch(与 electron-builder artifactName 命名对齐)
  if (name.endsWith('.dmg')) {
    if (name.includes('-mac-arm64')) return { os: 'mac', arch: 'arm64' }
    if (name.includes('-mac-x64')) return { os: 'mac', arch: 'x64' }
    if (name.includes('-mac-universal')) return { os: 'mac', arch: 'universal' }
    return { os: 'mac', arch: 'unknown' }
  }
  if (name.endsWith('-win-setup.exe')) return { os: 'win', arch: 'x64', variant: 'setup' }
  if (name.endsWith('-win-portable.exe')) return { os: 'win', arch: 'x64', variant: 'portable' }
  return null // 其他 exe(中间件)忽略
}

const all = walk(artifactsDir)
const files = []
const seen = new Set()

for (const full of all) {
  const name = path.basename(full)
  if (!name.endsWith('.dmg') && !name.endsWith('.exe')) continue
  const meta = classify(name)
  if (!meta) continue // 非目标 exe
  if (seen.has(name)) continue // artifact 上传可能带目录层级,同名去重
  seen.add(name)
  const size = fs.statSync(full).size
  files.push({ name, size, ...meta })
}

if (files.length === 0) {
  fail(`在 ${artifactsDir} 未找到任何 .dmg / -win-setup.exe / -win-portable.exe 产物`)
}

// 稳定排序:mac 在前、win 在后;同 os 内按 arch 名排序,便于 diff
const osOrder = { mac: 0, win: 1 }
files.sort((a, b) => (osOrder[a.os] - osOrder[b.os]) || a.name.localeCompare(b.name))

const releasedAt = process.env.RELEASE_TIMESTAMP || '' // CI 可注入 ISO 时间戳
const payload = { version, releasedAt, files }

fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n')
console.log(`[gen-latest-json] 写出 ${outFile}:v${version}, ${files.length} 个文件`)
for (const f of files) console.log(`  - ${f.name} (${(f.size / 1048576).toFixed(1)} MiB)`)

#!/usr/bin/env node

const fs = require('node:fs')

function classifyInstaller(name) {
  if (typeof name !== 'string') return null
  const filename = name.split('/').pop()
  if (/^Transfer-.+-mac-(?:arm64|x64|universal)\.dmg$/.test(filename)) return 'mac'
  if (/^Transfer-.+-win-(?:setup|portable)\.exe$/.test(filename)) return 'win'
  return null
}

function mergeGithubAssets(previous, releases) {
  const merged = { ...previous }
  for (const release of releases) {
    if (release.draft) continue
    for (const asset of release.assets || []) {
      const os = classifyInstaller(asset.name)
      if (!os) continue
      if (!Number.isFinite(asset.download_count) || asset.download_count < 0) {
        throw new Error(`Invalid GitHub download count for ${asset.name}`)
      }
      merged[String(asset.id)] = {
        name: asset.name,
        os,
        downloads: Math.max(merged[String(asset.id)]?.downloads || 0, asset.download_count),
      }
    }
  }
  return merged
}

function mergeR2Traffic(previous, inventory, rows) {
  const merged = { ...previous }
  for (const object of inventory) {
    const os = classifyInstaller(object.Key)
    if (!object.Key.startsWith('releases/') || !os) continue
    if (!Number.isFinite(object.Size) || object.Size <= 0) {
      throw new Error(`R2 installer must have a positive size: ${object.Key}`)
    }
    if (merged[object.Key] && merged[object.Key].size !== object.Size) {
      throw new Error(`R2 object size changed for ${object.Key}`)
    }
    merged[object.Key] ||= {
      name: object.Key.split('/').pop(),
      os,
      size: object.Size,
      bytes: 0,
    }
  }
  for (const row of rows) {
    if (!Number.isFinite(row?.sum?.edgeResponseBytes) || row.sum.edgeResponseBytes < 0) {
      throw new Error('Invalid Cloudflare response bytes')
    }
    if (typeof row?.dimensions?.clientRequestPath !== 'string') {
      throw new Error('Invalid Cloudflare request path')
    }
    const key = row.dimensions.clientRequestPath.replace(/^\//, '')
    if (!merged[key]) continue
    merged[key] = { ...merged[key], bytes: merged[key].bytes + row.sum.edgeResponseBytes }
  }
  return merged
}

function buildSummary(github, r2) {
  let githubMac = 0
  let githubWin = 0
  let r2Mac = 0
  let r2Win = 0
  for (const asset of Object.values(github)) {
    if (asset.os === 'mac') githubMac += asset.downloads
    else githubWin += asset.downloads
  }
  for (const object of Object.values(r2)) {
    if (object.os === 'mac') r2Mac += object.bytes / object.size
    else r2Win += object.bytes / object.size
  }
  const githubTotal = githubMac + githubWin
  const r2Total = r2Mac + r2Win
  return {
    total: githubTotal + r2Total,
    macos: githubMac + r2Mac,
    windows: githubWin + r2Win,
    sources: { github: githubTotal, r2: r2Total },
  }
}

function validatePreviousState(previous) {
  if (previous == null) return
  if (typeof previous !== 'object' || previous.schemaVersion !== 1) {
    throw new Error('Unsupported download statistics state schema')
  }
  const cursorMs = new Date(previous.r2Cursor).getTime()
  if (!Number.isFinite(cursorMs) || cursorMs % (60 * 60 * 1000) !== 0) {
    throw new Error('Invalid R2 cursor in download statistics state')
  }
  for (const asset of Object.values(previous.github?.assets || {})) {
    if (
      !asset
      || classifyInstaller(asset.name) !== asset.os
      || !Number.isFinite(asset.downloads)
      || asset.downloads < 0
    ) throw new Error('Invalid GitHub asset in download statistics state')
  }
  for (const [key, object] of Object.entries(previous.r2?.objects || {})) {
    if (
      !object
      || classifyInstaller(key) !== object.os
      || !Number.isFinite(object.size)
      || object.size <= 0
      || !Number.isFinite(object.bytes)
      || object.bytes < 0
    ) throw new Error('Invalid R2 object in download statistics state')
  }
}

function planQueryWindows(cursor, now) {
  const hourMs = 60 * 60 * 1000
  const maxWindowMs = 24 * hourMs
  const maxLookbackMs = 7 * 24 * hourMs
  const nowMs = new Date(now).getTime()
  if (!Number.isFinite(nowMs)) throw new Error('Invalid current timestamp')
  const endMs = Math.floor(nowMs / hourMs) * hourMs
  const cursorMs = cursor ? new Date(cursor).getTime() : null
  if (cursor && (!Number.isFinite(cursorMs) || cursorMs % hourMs !== 0)) {
    throw new Error(`Invalid cursor timestamp: ${cursor}`)
  }
  const startMs = cursorMs ?? endMs - (7 * 24 - 1) * hourMs
  if (startMs > endMs) throw new Error(`Cloudflare Analytics cursor is in the future: ${cursor}`)
  if (nowMs - startMs > maxLookbackMs) {
    throw new Error(`Cloudflare Analytics data gap: cursor ${cursor} is older than seven days`)
  }
  const windows = []
  for (let windowStart = startMs; windowStart < endMs; windowStart += maxWindowMs) {
    windows.push({
      start: new Date(windowStart).toISOString(),
      end: new Date(Math.min(windowStart + maxWindowMs, endMs)).toISOString(),
    })
  }
  return windows
}

function buildAnalyticsPayload(zoneId, hostname, window) {
  return {
    query: `
      query DownloadTraffic($zoneTag: string, $filter: filter) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequestsAdaptiveGroups(limit: 10000, filter: $filter) {
              dimensions { clientRequestPath }
              sum { edgeResponseBytes }
            }
          }
        }
      }
    `,
    variables: {
      zoneTag: zoneId,
      filter: {
        datetime_geq: window.start,
        datetime_lt: window.end,
        clientRequestHTTPHost: hostname,
        clientRequestHTTPMethodName: 'GET',
        clientRequestPath_like: '/releases/%',
        edgeResponseStatus_in: [200, 206],
        requestSource: 'eyeball',
      },
    },
  }
}

async function fetchGithubReleases(fetchImpl, repository, token) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!response.ok) throw new Error(`GitHub Releases API failed with HTTP ${response.status}`)
    const current = await response.json()
    releases.push(...current)
    if (current.length < 100) return releases
  }
}

async function fetchAnalyticsRows(fetchImpl, token, payload) {
  const response = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`Cloudflare Analytics API failed with HTTP ${response.status}`)
  const body = await response.json()
  if (body.errors?.length) {
    throw new Error(`Cloudflare Analytics API error: ${body.errors.map((error) => error.message).join('; ')}`)
  }
  const zones = body.data?.viewer?.zones
  if (!Array.isArray(zones) || zones.length !== 1) {
    throw new Error('Cloudflare Analytics API did not return exactly one zone')
  }
  return zones[0].httpRequestsAdaptiveGroups || []
}

function updateStatistics(previous, releases, inventory, rows, cursor, updatedAt) {
  validatePreviousState(previous)
  const githubAssets = mergeGithubAssets(previous?.github?.assets || {}, releases)
  const r2Objects = mergeR2Traffic(previous?.r2?.objects || {}, inventory, rows)
  return {
    schemaVersion: 1,
    updatedAt,
    r2Cursor: cursor,
    summary: buildSummary(githubAssets, r2Objects),
    github: { assets: githubAssets },
    r2: { objects: r2Objects },
  }
}

async function collectStatistics(options) {
  const {
    previous,
    inventory,
    now,
    zoneId,
    hostname,
    repository,
    cloudflareToken,
    githubToken,
    fetchImpl,
  } = options
  validatePreviousState(previous)
  const releases = await fetchGithubReleases(fetchImpl, repository, githubToken)
  const windows = planQueryWindows(previous?.r2Cursor || null, now)
  const rows = []
  for (const window of windows) {
    rows.push(...await fetchAnalyticsRows(
      fetchImpl,
      cloudflareToken,
      buildAnalyticsPayload(zoneId, hostname, window),
    ))
  }
  const cursor = windows.at(-1)?.end || previous.r2Cursor
  return updateStatistics(previous, releases, inventory, rows, cursor, now)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function renderSummary(summary) {
  return [
    '## Download statistics',
    '',
    '| Total | macOS | Windows | GitHub | R2 equivalent |',
    '| ---: | ---: | ---: | ---: | ---: |',
    `| ${Math.floor(summary.total)} | ${Math.floor(summary.macos)} | ${Math.floor(summary.windows)} | ${summary.sources.github} | ${summary.sources.r2.toFixed(2)} |`,
    '',
  ].join('\n')
}

async function main() {
  const [, , stateFile, inventoryFile, outputFile] = process.argv
  if (!stateFile || !inventoryFile || !outputFile) {
    throw new Error('Usage: node build/collect-download-statistics.cjs <state-file> <inventory-file> <output-file>')
  }
  const inventoryDocument = readJsonIfPresent(inventoryFile)
  if (!Array.isArray(inventoryDocument?.Contents)) {
    throw new Error(`Invalid R2 inventory file: ${inventoryFile}`)
  }
  const state = await collectStatistics({
    previous: readJsonIfPresent(stateFile),
    inventory: inventoryDocument.Contents,
    now: new Date().toISOString(),
    zoneId: requireEnv('CF_ZONE_ID'),
    hostname: process.env.R2_PUBLIC_HOST || 'dl.aloongplanet.com',
    repository: requireEnv('GITHUB_REPOSITORY'),
    cloudflareToken: requireEnv('CF_ANALYTICS_API_TOKEN'),
    githubToken: requireEnv('GITHUB_TOKEN'),
    fetchImpl: globalThis.fetch,
  })
  fs.writeFileSync(outputFile, `${JSON.stringify(state, null, 2)}\n`)
  const summary = renderSummary(state.summary)
  process.stdout.write(summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[download-statistics] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  buildAnalyticsPayload,
  buildSummary,
  classifyInstaller,
  collectStatistics,
  fetchAnalyticsRows,
  fetchGithubReleases,
  mergeGithubAssets,
  mergeR2Traffic,
  planQueryWindows,
  renderSummary,
  updateStatistics,
  validatePreviousState,
}

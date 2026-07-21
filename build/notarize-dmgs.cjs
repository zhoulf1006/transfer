#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ARCH_ORDER = ['arm64', 'x64', 'universal']

function artifactArch(file) {
  const match = path.basename(file).match(/-mac-(arm64|x64|universal)\.dmg$/)
  return match?.[1] ?? null
}

function artifactStem(file) {
  return path.basename(file).replace(/-mac-(arm64|x64|universal)\.dmg$/, '')
}

function selectDmgArtifacts(paths) {
  const dmgPaths = paths.filter((file) => file.endsWith('.dmg'))
  const unsupported = dmgPaths.find((file) => artifactArch(file) === null)
  if (unsupported) throw new Error(`发现不支持的 DMG 产物: ${path.basename(unsupported)}`)

  const selected = dmgPaths
    .sort((left, right) => ARCH_ORDER.indexOf(artifactArch(left)) - ARCH_ORDER.indexOf(artifactArch(right)))

  if (selected.length !== ARCH_ORDER.length || selected.some((file, index) => artifactArch(file) !== ARCH_ORDER[index])) {
    throw new Error('DMG 产物必须恰好包含 arm64、x64、universal')
  }
  if (new Set(selected.map(artifactStem)).size !== 1) {
    throw new Error('三个 DMG 必须属于同一产品版本')
  }
  return selected
}

function notarizeAll(paths, notarizeOne) {
  return selectDmgArtifacts(paths).map((file) => notarizeOne(file))
}

function parseAcceptedSubmission(stdout) {
  const result = JSON.parse(stdout)
  if (result.status !== 'Accepted') {
    const submission = result.id ? ` (submission: ${result.id})` : ''
    throw new Error(`Apple 公证未通过: ${result.status ?? '未知状态'}${submission}`)
  }
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Apple 公证响应缺少 submission id')
  }
  return result.id
}

function readCredentials(env) {
  const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const missing = required.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`缺少 Apple 公证凭据: ${missing.join(', ')}`)
  return {
    appleId: env.APPLE_ID,
    password: env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: env.APPLE_TEAM_ID
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.error) throw new Error(`${command} 无法启动: ${result.error.message}`)
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} 执行失败 (exit ${result.status})${output ? `\n${output}` : ''}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function makeMountPoint() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-dmg-'))
}

function removeMountPoint(mountPoint) {
  fs.rmSync(mountPoint, { recursive: true, force: true })
}

function findTransferApp(mountPoint) {
  const appPath = path.join(mountPoint, 'Transfer.app')
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`DMG 内未找到 Transfer.app: ${mountPoint}`)
  }
  return appPath
}

function notarizeDmg(file, options) {
  const { credentials, findApp, makeMountPoint, removeMountPoint, run, writeError = console.error } = options
  run('hdiutil', ['verify', file])
  const submission = run('xcrun', [
    'notarytool', 'submit', file,
    '--apple-id', credentials.appleId,
    '--password', credentials.password,
    '--team-id', credentials.teamId,
    '--wait',
    '--output-format', 'json'
  ])
  let submissionId
  try {
    submissionId = parseAcceptedSubmission(submission.stdout)
  } catch (error) {
    let rejectedId = null
    try {
      rejectedId = JSON.parse(submission.stdout).id ?? null
    } catch {
      // 畸形响应没有可用于查询日志的 submission id，保留原始解析错误。
    }
    if (rejectedId) {
      try {
        const log = run('xcrun', [
          'notarytool', 'log', rejectedId,
          '--apple-id', credentials.appleId,
          '--password', credentials.password,
          '--team-id', credentials.teamId,
          '--output-format', 'json'
        ])
        writeError(log.stdout || log.stderr)
      } catch {
        // 日志查询只是诊断增强，不能覆盖原始公证失败。
      }
    }
    throw error
  }

  run('xcrun', ['stapler', 'staple', file])
  run('xcrun', ['stapler', 'validate', file])
  run('hdiutil', ['verify', file])
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', file])

  const mountPoint = makeMountPoint()
  let attached = false
  let operationError = null
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, file])
    attached = true
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', findApp(mountPoint)])
  } catch (error) {
    operationError = error
  }

  let cleanupError = null
  let detached = !attached
  if (attached) {
    try {
      run('hdiutil', ['detach', mountPoint])
      detached = true
    } catch {
      try {
        run('hdiutil', ['detach', '-force', mountPoint])
        detached = true
      } catch (error) {
        cleanupError = error
      }
    }
  }
  if (detached) {
    try {
      removeMountPoint(mountPoint)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (operationError) throw operationError
  if (cleanupError) throw cleanupError

  return submissionId
}

function main(argv, env = process.env) {
  const credentials = readCredentials(env)
  const ids = notarizeAll(argv, (file) => {
    console.log(`[notarize-dmgs] 开始: ${file}`)
    const id = notarizeDmg(file, {
      credentials,
      findApp: findTransferApp,
      makeMountPoint,
      removeMountPoint,
      run: runCommand,
      writeError: (message) => console.error(`[notarize-dmgs] Apple 日志:\n${message}`)
    })
    console.log(`[notarize-dmgs] 通过: ${file} (submission: ${id})`)
    return id
  })
  console.log(`[notarize-dmgs] 三个架构全部通过: ${ids.join(', ')}`)
  return ids
}

module.exports = {
  findTransferApp,
  main,
  notarizeAll,
  notarizeDmg,
  parseAcceptedSubmission,
  readCredentials,
  runCommand,
  selectDmgArtifacts
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[notarize-dmgs] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

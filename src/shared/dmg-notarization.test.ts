import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
interface CommandResult {
  stdout: string
  stderr: string
}

interface NotarizeDmgOptions {
  credentials: { appleId: string; password: string; teamId: string }
  findApp: (mountPoint: string) => string
  makeMountPoint: () => string
  removeMountPoint: (mountPoint: string) => void
  run: (command: string, args: string[]) => CommandResult
  writeError?: (message: string) => void
}

const { findTransferApp, notarizeAll, notarizeDmg, parseAcceptedSubmission, readCredentials, selectDmgArtifacts } = require('../../build/notarize-dmgs.cjs') as {
  findTransferApp: (mountPoint: string) => string
  notarizeAll: (paths: string[], notarizeOne: (file: string) => string) => string[]
  notarizeDmg: (file: string, options: NotarizeDmgOptions) => string
  parseAcceptedSubmission: (stdout: string) => string
  readCredentials: (env: Record<string, string | undefined>) => { appleId: string; password: string; teamId: string }
  selectDmgArtifacts: (paths: string[]) => string[]
}

describe('DMG 公证产物门禁', () => {
  test('只接受 arm64、x64、universal 三个完整产物', () => {
    expect(selectDmgArtifacts([
      '/release/Transfer-0.9.1-mac-universal.dmg',
      '/release/Transfer-0.9.1-mac-arm64.dmg',
      '/release/Transfer-0.9.1-mac-x64.dmg'
    ])).toEqual([
      '/release/Transfer-0.9.1-mac-arm64.dmg',
      '/release/Transfer-0.9.1-mac-x64.dmg',
      '/release/Transfer-0.9.1-mac-universal.dmg'
    ])
  })

  test('缺少任一架构时阻止发布', () => {
    expect(() => selectDmgArtifacts([
      '/release/Transfer-0.9.1-mac-arm64.dmg',
      '/release/Transfer-0.9.1-mac-universal.dmg'
    ])).toThrow('DMG 产物必须恰好包含 arm64、x64、universal')
  })

  test('出现未知架构 DMG 时阻止发布，避免漏过同目录残留产物', () => {
    expect(() => selectDmgArtifacts([
      '/release/Transfer-0.9.1-mac-arm64.dmg',
      '/release/Transfer-0.9.1-mac-x64.dmg',
      '/release/Transfer-0.9.1-mac-universal.dmg',
      '/release/Transfer-0.9.1-mac-legacy.dmg'
    ])).toThrow('发现不支持的 DMG 产物: Transfer-0.9.1-mac-legacy.dmg')
  })

  test('三个架构必须属于同一版本', () => {
    expect(() => selectDmgArtifacts([
      '/release/Transfer-0.9.0-mac-arm64.dmg',
      '/release/Transfer-0.9.1-mac-x64.dmg',
      '/release/Transfer-0.9.1-mac-universal.dmg'
    ])).toThrow('三个 DMG 必须属于同一产品版本')
  })

  test('三个架构全部成功后才返回完整 submission 清单', () => {
    const visited: string[] = []
    const ids = notarizeAll([
      '/release/Transfer-0.9.1-mac-x64.dmg',
      '/release/Transfer-0.9.1-mac-universal.dmg',
      '/release/Transfer-0.9.1-mac-arm64.dmg'
    ], (file) => {
      visited.push(file)
      return `accepted-${visited.length}`
    })

    expect(visited.map((file) => file.match(/mac-(arm64|x64|universal)/)?.[1])).toEqual(['arm64', 'x64', 'universal'])
    expect(ids).toEqual(['accepted-1', 'accepted-2', 'accepted-3'])
  })
})

describe('Apple 公证结果门禁', () => {
  test('Accepted 结果返回 submission id', () => {
    expect(parseAcceptedSubmission(JSON.stringify({
      id: '44f2c3fd-ff3d-4a81-80ce-a1a0c39c789f',
      status: 'Accepted'
    }))).toBe('44f2c3fd-ff3d-4a81-80ce-a1a0c39c789f')
  })

  test('Invalid 结果携带 submission id 并阻止发布', () => {
    expect(() => parseAcceptedSubmission(JSON.stringify({
      id: 'bad-submission-id',
      status: 'Invalid',
      message: 'Archive contains critical validation errors'
    }))).toThrow('Apple 公证未通过: Invalid (submission: bad-submission-id)')
  })

  test('Accepted 但缺少 submission id 仍视为畸形响应', () => {
    expect(() => parseAcceptedSubmission('{"status":"Accepted"}')).toThrow('Apple 公证响应缺少 submission id')
  })

  test('非 JSON 响应不能假通过', () => {
    expect(() => parseAcceptedSubmission('notary service unavailable')).toThrow(SyntaxError)
  })

  test('缺少 Team ID 时在调用 Apple 前失败', () => {
    expect(() => readCredentials({
      APPLE_ID: 'developer@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'app-password'
    })).toThrow('缺少 Apple 公证凭据: APPLE_TEAM_ID')
  })
})

describe('单个 DMG 公证与验证', () => {
  test('按 verify → submit → staple → Gatekeeper → 内部 App 签名的顺序执行', () => {
    const commands: string[] = []
    const submitArgs: string[][] = []
    const submissionId = notarizeDmg('/release/Transfer 0.9.1-mac-arm64.dmg', {
      credentials: { appleId: 'developer@example.com', password: 'app-password', teamId: 'TEAM123456' },
      findApp: () => '/tmp/mount path/Transfer.app',
      makeMountPoint: () => '/tmp/mount path',
      removeMountPoint: () => commands.push('remove-mount-point'),
      run: (command, args) => {
        commands.push(`${command} ${args.slice(0, 2).join(' ')}`)
        if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') submitArgs.push(args)
        return command === 'xcrun' && args[0] === 'notarytool'
          ? { stdout: JSON.stringify({ id: 'accepted-id', status: 'Accepted' }), stderr: '' }
          : { stdout: '', stderr: '' }
      }
    })

    expect(submissionId).toBe('accepted-id')
    expect(submitArgs[0][2]).toBe('/release/Transfer 0.9.1-mac-arm64.dmg')
    expect(commands).toEqual([
      'hdiutil verify /release/Transfer 0.9.1-mac-arm64.dmg',
      'xcrun notarytool submit',
      'xcrun stapler staple',
      'xcrun stapler validate',
      'hdiutil verify /release/Transfer 0.9.1-mac-arm64.dmg',
      'spctl --assess --type',
      'hdiutil attach -readonly',
      'codesign --verify --deep',
      'hdiutil detach /tmp/mount path',
      'remove-mount-point'
    ])
  })

  test('Apple 拒绝时读取日志，但仍抛出原始 Invalid 错误', () => {
    const commands: string[] = []
    const errors: string[] = []

    expect(() => notarizeDmg('/release/Transfer-0.9.1-mac-x64.dmg', {
      credentials: { appleId: 'developer@example.com', password: 'app-password', teamId: 'TEAM123456' },
      findApp: () => '/unused/Transfer.app',
      makeMountPoint: () => '/unused',
      removeMountPoint: () => undefined,
      run: (command, args) => {
        commands.push(`${command} ${args.slice(0, 3).join(' ')}`)
        if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') {
          return { stdout: JSON.stringify({ id: 'invalid-id', status: 'Invalid' }), stderr: '' }
        }
        if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'log') {
          return { stdout: '{"issues":[{"message":"unsigned nested code"}]}', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      },
      writeError: (message) => errors.push(message)
    })).toThrow('Apple 公证未通过: Invalid (submission: invalid-id)')

    expect(commands.some((command) => command === 'xcrun notarytool log invalid-id')).toBe(true)
    expect(errors).toEqual(['{"issues":[{"message":"unsigned nested code"}]}'])
  })

  test('内部 App 验证失败时强制卸载兜底，且不让清理错误覆盖根因', () => {
    const commands: string[] = []
    let removed = false

    expect(() => notarizeDmg('/release/Transfer-0.9.1-mac-universal.dmg', {
      credentials: { appleId: 'developer@example.com', password: 'app-password', teamId: 'TEAM123456' },
      findApp: () => '/tmp/mount/Transfer.app',
      makeMountPoint: () => '/tmp/mount',
      removeMountPoint: () => { removed = true },
      run: (command, args) => {
        commands.push(`${command} ${args.join(' ')}`)
        if (command === 'xcrun' && args[0] === 'notarytool') {
          return { stdout: JSON.stringify({ id: 'accepted-id', status: 'Accepted' }), stderr: '' }
        }
        if (command === 'codesign') throw new Error('codesign failed')
        if (command === 'hdiutil' && args[0] === 'detach' && args[1] !== '-force') throw new Error('device busy')
        return { stdout: '', stderr: '' }
      }
    })).toThrow('codesign failed')

    expect(commands).toContain('hdiutil detach -force /tmp/mount')
    expect(removed).toBe(true)
  })

  test('挂载点缺少 Transfer.app 时返回可诊断错误', () => {
    expect(() => findTransferApp('/definitely/not/a/transfer-dmg-mount')).toThrow('DMG 内未找到 Transfer.app')
  })
})

describe('GitHub Actions 发布门禁', () => {
  test('正式版在上传 artifact 和 GitHub Release 之前公证最终 DMG', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')
    const notarize = workflow.indexOf('name: Notarize and validate macOS dmgs')
    const uploadArtifact = workflow.indexOf('name: Upload dmg (artifact)')
    const publishRelease = workflow.indexOf('name: Publish to Release', uploadArtifact)

    expect(notarize).toBeGreaterThan(0)
    expect(notarize).toBeLessThan(uploadArtifact)
    expect(notarize).toBeLessThan(publishRelease)
  })

  test('预发布只停留在 GitHub Release，不启动 R2 同步 job', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')
    const syncBlock = workflow.slice(workflow.indexOf('\n  sync:'), workflow.indexOf('\n    steps:', workflow.indexOf('\n  sync:')))

    expect(syncBlock).toContain("if: startsWith(github.ref, 'refs/tags/') && !(endsWith(github.ref, '-beta') || endsWith(github.ref, '-rc') || endsWith(github.ref, '-alpha') || endsWith(github.ref, '-dev'))")
  })

  test('所有 DMG 打包入口都显式关闭 electron-builder 的内部 App 公证', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(pkg.scripts['dist:mac']).toContain('-c.mac.notarize=false')
    expect(pkg.scripts['dist:mac:package-signed']).toContain('-c.mac.notarize=false')
  })
})

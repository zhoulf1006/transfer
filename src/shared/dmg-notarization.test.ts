// The release workflow's macOS gate (docs/specs/mac-distribution.md). The DMG gate itself is tested with the
// packaging script, in build/mac-packaging.test.cjs.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import YAML from 'yaml'

describe('GitHub Actions 发布门禁', () => {
  test('手动正式 macOS 验证会走完整公证门禁，但不会创建 Release 或同步 R2', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')
    const publishSteps = [...workflow.matchAll(/- name: Publish to Release\n([\s\S]*?)(?=\n\s+- name:|\n\s{2}[a-z-]+:|$)/g)]
    const syncBlock = workflow.slice(workflow.indexOf('\n  sync:'), workflow.indexOf('\n    steps:', workflow.indexOf('\n  sync:')))

    expect(workflow).toContain('verify_formal_macos:')
    expect(workflow).toContain("github.event_name == 'workflow_dispatch' && inputs.verify_formal_macos")
    expect(publishSteps).toHaveLength(2)
    expect(publishSteps.every(([, step]) => step.includes("if: startsWith(github.ref, 'refs/tags/')"))).toBe(true)
    expect(syncBlock).toContain("if: startsWith(github.ref, 'refs/tags/') && !(endsWith(github.ref, '-beta')")
  })

  test('正式版 DMG 启用容器签名，确保 Gatekeeper 能验证最外层下载文件', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    const dmgStart = config.indexOf('\ndmg:')
    const nextSection = config.indexOf('\n\n', dmgStart)
    const dmgBlock = config.slice(dmgStart, nextSection === -1 ? undefined : nextSection)

    expect(dmgBlock).toMatch(/\n  sign: true(?:\s|#|$)/)
  })

  test('正式版在上传 artifact 和 GitHub Release 之前公证最终 DMG', () => {
    const steps = (YAML.parse(readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')) as {
      jobs: { 'build-mac': { steps: Array<{ name?: string }> } }
    }).jobs['build-mac'].steps.map((step) => step.name)
    const release = steps.indexOf('Package and notarize macOS DMGs (release)')
    const uploadArtifact = steps.indexOf('Upload dmg (artifact)')
    const publishRelease = steps.indexOf('Publish to Release')

    expect(release).toBeGreaterThan(0)
    expect(release).toBeLessThan(uploadArtifact)
    expect(uploadArtifact).toBeLessThan(publishRelease)
  })

  test('Actions artifact 保留每个正式版 DMG 的 Apple 公证日志', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')
    const uploadArtifact = workflow.slice(
      workflow.indexOf('name: Upload dmg (artifact)'),
      workflow.indexOf('name: Publish to Release', workflow.indexOf('name: Upload dmg (artifact)'))
    )

    expect(uploadArtifact).toContain('release/*/*.notary-log.json')
  })

  test('预发布只停留在 GitHub Release，不启动 R2 同步 job', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')
    const syncBlock = workflow.slice(workflow.indexOf('\n  sync:'), workflow.indexOf('\n    steps:', workflow.indexOf('\n  sync:')))

    expect(syncBlock).toContain("if: startsWith(github.ref, 'refs/tags/') && !(endsWith(github.ref, '-beta') || endsWith(github.ref, '-rc') || endsWith(github.ref, '-alpha') || endsWith(github.ref, '-dev'))")
  })

  // The macOS job's tiers (docs/specs/mac-distribution.md), read through the YAML parser
  const macJob = () => (YAML.parse(readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')) as {
    jobs: { 'build-mac': { env: Record<string, string>; steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }> } }
  }).jobs['build-mac']
  const stepNamed = (name: string) => {
    const step = macJob().steps.find((entry) => entry.name === name)
    if (!step) throw new Error(`no step named ${name}`)
    return step
  }
  const indexOfStep = (name: string) => macJob().steps.findIndex((entry) => entry.name === name)
  const APPLE = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

  test('any v* tag, and a manual run with the verification switch, select the release profile; anything else local', () => {
    expect(macJob().env.MAC_PROFILE).toBe(
      "${{ (startsWith(github.ref, 'refs/tags/') || (github.event_name == 'workflow_dispatch' && inputs.verify_formal_macos)) && 'release' || 'local' }}"
    )
  })

  test('a missing certificate secret fails the job in every tier, before packaging', () => {
    const step = stepNamed('Require the Developer ID certificate')
    expect(step.if).toBe("env.HAS_CSC != 'true'")
    expect(step.run).toMatch(/exit 1\s*$/)
    expect(indexOfStep('Require the Developer ID certificate')).toBeLessThan(indexOfStep('Package macOS DMGs (local, signed only)'))
    expect(indexOfStep('Require the Developer ID certificate')).toBeLessThan(indexOfStep('Package and notarize macOS DMGs (release)'))
  })

  test('a release-tier run missing an Apple credential fails before packaging', () => {
    const step = stepNamed('Require the Apple notarization credentials')
    expect(step.if).toBe("env.MAC_PROFILE == 'release' && env.HAS_APPLE != 'true'")
    expect(step.run).toMatch(/exit 1\s*$/)
    expect(indexOfStep('Require the Apple notarization credentials')).toBeLessThan(indexOfStep('Package and notarize macOS DMGs (release)'))
  })

  test('the release tier runs the release command with the certificate and every Apple credential', () => {
    const step = stepNamed('Package and notarize macOS DMGs (release)')
    expect(step.if).toBe("env.MAC_PROFILE == 'release'")
    expect(step.run).toBe('pnpm run dist:mac:release')
    expect(Object.keys(step.env ?? {}).sort()).toEqual(['CSC_KEY_PASSWORD', 'CSC_LINK', ...APPLE].sort())
  })

  test('the local tier runs the local command and is given no Apple credential', () => {
    const step = stepNamed('Package macOS DMGs (local, signed only)')
    expect(step.if).toBe("env.MAC_PROFILE == 'local'")
    expect(step.run).toBe('pnpm run dist:mac:local')
    expect(Object.keys(step.env ?? {}).sort()).toEqual(['CSC_KEY_PASSWORD', 'CSC_LINK'])
  })

  test('no macOS step builds unsigned', () => {
    for (const step of macJob().steps) {
      expect(step.env?.CSC_IDENTITY_AUTO_DISCOVERY, step.name).toBeUndefined()
      expect(step.run ?? '', step.name).not.toMatch(/electron-builder/)
    }
  })
})

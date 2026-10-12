// The macOS packaging steps (docs/specs/mac-distribution.md).
//
// Every external command goes through an injected runner, so these tests check which commands run, in what
// order, what fails and with which message. They never contact Apple and never build an app: a green run
// here says nothing about a real signature or a real notarization. Those are verified by real packaging runs.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import YAML from 'yaml'

const require = createRequire(import.meta.url)

interface CommandResult {
  stdout: string
  stderr: string
}
type Run = (command: string, args: string[]) => CommandResult

interface PackageOptions {
  profile: 'local' | 'release'
  env: Record<string, string | undefined>
  run: Run
  outputDir: string
  productName: string
  version: string
  arches: string[]
}

interface SignContext {
  electronPlatformName: string
  appOutDir: string
  outDir: string
  packager: { appInfo: { productFilename: string; version: string } }
}

interface HookDeps {
  env: Record<string, string | undefined>
  run: Run
  writeError: (message: string) => void
  writeNotaryLog: (file: string, contents: string) => void
  log: (message: string) => void
}

const { afterSign, certificateSource, configuredArches, findBuiltApps, packageMac, resolveLayout } = require('../../build/mac-packaging.cjs') as {
  afterSign: (context: SignContext, deps?: HookDeps) => Promise<string | undefined> | string | undefined
  certificateSource: (env: Record<string, string | undefined>, run: Run) => string
  configuredArches: (configText: string) => string[]
  findBuiltApps: (options: { outputDir: string; productName: string; arches: string[]; run: Run }) => Array<{ arch: string; app: string }>
  packageMac: (options: PackageOptions) => { apps: Array<{ arch: string; app: string }>; dmgs: string[] }
  resolveLayout: (configText: string, packageJsonText: string) => { productName: string; version: string; outputDir: string; arches: string[] }
}

const BUILDER_CONFIG = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
const ARCHES = ['universal', 'arm64', 'x64']

// Shaped after real `security find-identity -v -p codesigning` output (hashes and names replaced)
const IDENTITIES_WITH_DEVELOPER_ID = [
  '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: Example Dev (TEAM123456)"',
  '  2) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Development: Example Dev (DEVTEAM999)"',
  '     2 valid identities found'
].join('\n')
const IDENTITIES_WITHOUT_DEVELOPER_ID = [
  '  1) 89ABCDEF0123456789ABCDEF0123456789ABCDEF "Apple Development: Example Dev (DEVTEAM999)"',
  '  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 "Apple Distribution: Example Dev (TEAM123456)"',
  '     2 valid identities found'
].join('\n')

const keychain = (stdout: string): Run => (command, args) => {
  if (command === 'security' && args[0] === 'find-identity') return { stdout, stderr: '' }
  throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
}

// Shaped after real `codesign --display --verbose=4` output, which codesign writes to stderr
const SIGNED_DEVELOPER_ID = [
  'Format=app bundle with Mach-O thin (arm64)',
  'Authority=Developer ID Application: Example Dev (TEAM123456)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Aug 22, 2026 at 17:50:50',
  'TeamIdentifier=TEAM123456'
].join('\n')
const SIGNED_APP_STORE = [
  'Format=app bundle with Mach-O universal (x86_64 arm64)',
  'Authority=Apple Mac OS Application Signing',
  'Authority=Apple Worldwide Developer Relations Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=TEAM123456'
].join('\n')
const SIGNED_ADHOC = ['Format=app bundle with Mach-O thin (arm64)', 'Signature=adhoc', 'TeamIdentifier=not set'].join('\n')
const DMG_SIGNED = ['Authority=Developer ID Application: Example Dev (TEAM123456)', 'Timestamp=Aug 22, 2026 at 17:51:02', 'TeamIdentifier=TEAM123456'].join('\n')
const DMG_OTHER_TEAM = ['Authority=Developer ID Application: Someone Else (OTHERTEAM1)', 'Timestamp=Aug 22, 2026 at 17:51:02', 'TeamIdentifier=OTHERTEAM1'].join('\n')

const APPLE_ENV = { APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password', APPLE_TEAM_ID: 'TEAM123456' }

describe('architecture set from the builder config', () => {
  test('reads the DMG target architectures from the real config', () => {
    expect(configuredArches(BUILDER_CONFIG)).toEqual(['universal', 'arm64', 'x64'])
  })

  test.each([
    {
      name: 'no dmg target',
      config: 'mac:\n  target:\n    - target: zip\n      arch: [arm64]\n',
      message: 'electron-builder.yml has no mac dmg target with an arch list'
    },
    {
      name: 'an unknown arch',
      config: 'mac:\n  target:\n    - target: dmg\n      arch: [arm64, ia32]\n',
      message: 'unsupported mac arch in electron-builder.yml: ia32'
    },
    {
      name: 'an arch listed twice',
      config: 'mac:\n  target:\n    - target: dmg\n      arch: [arm64, arm64]\n',
      message: 'electron-builder.yml lists a mac arch twice'
    }
  ])('fails on $name', ({ config, message }) => {
    expect(() => configuredArches(config)).toThrow(message)
  })
})

describe('certificate source check', () => {
  test('a Developer ID Application identity in the keychain is accepted', () => {
    expect(certificateSource({}, keychain(IDENTITIES_WITH_DEVELOPER_ID))).toBe(
      'keychain: Developer ID Application: Example Dev (TEAM123456)'
    )
  })

  test('no Developer ID Application identity fails with the install hint', () => {
    expect(() => certificateSource({}, keychain(IDENTITIES_WITHOUT_DEVELOPER_ID))).toThrow(
      /no valid "Developer ID Application" signing identity[\s\S]*security find-identity -v$/
    )
  })

  test('CSC_LINK is accepted without reading the keychain, since the builder imports it', () => {
    expect(certificateSource({ CSC_LINK: 'base64-p12' }, () => {
      throw new Error('the keychain must not be queried')
    })).toBe('CSC_LINK')
  })

  test('an empty CSC_LINK does not count as a certificate', () => {
    expect(() => certificateSource({ CSC_LINK: '  ' }, keychain(IDENTITIES_WITHOUT_DEVELOPER_ID))).toThrow(
      /no valid "Developer ID Application" signing identity/
    )
  })
})

// Real temporary directories stand in for the build output; only external commands are faked.
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Creates <outputDir>/<subdir>/Transfer.app/Contents/MacOS/Transfer for each entry and returns outputDir */
function buildOutput(subdirs: string[]): string {
  const outputDir = mkdtempSync(join(tmpdir(), 'mac-packaging-'))
  tempDirs.push(outputDir)
  for (const subdir of subdirs) {
    const macos = join(outputDir, subdir, 'Transfer.app', 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, 'Transfer'), '')
  }
  return outputDir
}

/** A `lipo -archs` runner answering from a table keyed by the build subdirectory */
const lipo = (bySubdir: Record<string, string>): Run => (command, args) => {
  if (command !== 'lipo' || args[0] !== '-archs') throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  const subdir = Object.keys(bySubdir).find((key) => args[1].includes(`/${key}/Transfer.app/`))
  if (!subdir) throw new Error(`no lipo answer for ${args[1]}`)
  return { stdout: `${bySubdir[subdir]}\n`, stderr: '' }
}

const LIPO_ANSWERS: Record<string, string> = { mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' }
const BUILD_SUBDIRS = ['mac', 'mac-arm64', 'mac-universal']

describe('locating the built apps', () => {
  test('identifies each app by its binary architectures, whatever its directory is called', () => {
    // x64 builds into mac/, the others into mac-<arch>/ — the names are not a reliable guide
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const apps = findBuiltApps({ outputDir, productName: 'Transfer', arches: ARCHES, run: lipo(LIPO_ANSWERS) })
    expect(apps).toEqual([
      { arch: 'universal', app: join(outputDir, 'mac-universal', 'Transfer.app') },
      { arch: 'arm64', app: join(outputDir, 'mac-arm64', 'Transfer.app') },
      { arch: 'x64', app: join(outputDir, 'mac', 'Transfer.app') }
    ])
  })

  test.each([
    {
      name: 'nothing has been built',
      subdirs: [] as string[],
      answers: {} as Record<string, string>,
      message: 'no built Transfer.app under'
    },
    {
      name: 'an arch is missing',
      subdirs: ['mac-arm64', 'mac-universal'],
      answers: { 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' },
      message: 'no built app for x64 under'
    },
    {
      name: 'a binary has unexpected architectures',
      subdirs: [...BUILD_SUBDIRS, 'mac-old'],
      answers: { ...LIPO_ANSWERS, 'mac-old': 'i386' },
      message: 'unexpected binary architectures: i386'
    },
    {
      // A universal build that crashed leaves its per-arch build behind in <outDir>-<arch>-temp
      name: 'a crashed universal build left its arm64 temp app behind',
      subdirs: [...BUILD_SUBDIRS, 'mac-universal-arm64-temp'],
      answers: { ...LIPO_ANSWERS, 'mac-universal-arm64-temp': 'arm64' },
      message: 'two built apps for arm64'
    }
  ])('fails when $name', ({ subdirs, answers, message }) => {
    const outputDir = buildOutput(subdirs)
    expect(() => findBuiltApps({ outputDir, productName: 'Transfer', arches: ARCHES, run: lipo(answers) })).toThrow(message)
  })

  test('fails on a leftover app for an arch the config no longer lists', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64'])
    expect(() => findBuiltApps({
      outputDir,
      productName: 'Transfer',
      arches: ['arm64'],
      run: lipo({ mac: 'x86_64', 'mac-arm64': 'arm64' })
    })).toThrow('built app for an arch the config does not list (x64)')
  })
})

/**
 * A recording runner for one packaging build. electron-builder writes a DMG for every configured arch unless
 * the arch is in `skipDmg`; codesign answers apps with `appSignature` (or a per-subdir override) and DMGs with
 * `dmgSignature`; `stapler validate` fails for apps whose subdir is in `unstapled`.
 */
function buildRunner(outputDir: string, opts: {
  appSignature?: string
  appOverrides?: Record<string, string>
  dmgSignature?: string
  skipDmg?: string[]
  unstapled?: string[]
} = {}) {
  const commands: string[] = []
  const run: Run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'electron-builder') {
      // Like the real builder: the apps and DMGs exist only once the build has run
      for (const subdir of BUILD_SUBDIRS) {
        const macos = join(outputDir, subdir, 'Transfer.app', 'Contents', 'MacOS')
        mkdirSync(macos, { recursive: true })
        writeFileSync(join(macos, 'Transfer'), '')
      }
      for (const arch of ARCHES) {
        if (!(opts.skipDmg ?? []).includes(arch)) writeFileSync(join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg`), 'new')
      }
      return { stdout: '', stderr: '' }
    }
    if (command === 'codesign' && args[0] === '--display') {
      const target = args.at(-1)!
      if (target.endsWith('.dmg')) return { stdout: '', stderr: opts.dmgSignature ?? DMG_SIGNED }
      const subdir = Object.keys(opts.appOverrides ?? {}).find((key) => target.includes(`/${key}/`))
      return { stdout: '', stderr: subdir ? opts.appOverrides![subdir] : (opts.appSignature ?? SIGNED_DEVELOPER_ID) }
    }
    if (command === 'xcrun' && args[0] === 'stapler' && args[1] === 'validate') {
      if ((opts.unstapled ?? []).some((subdir) => args[2].includes(`/${subdir}/`))) throw new Error(`${args[2]} does not have a ticket stapled to it.`)
    }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

const pkg = (outputDir: string, run: Run, profile: 'local' | 'release', env: Record<string, string | undefined> = { CSC_LINK: 'base64-p12' }) =>
  packageMac({ profile, env, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })

describe('one build, local profile', () => {
  test('builds the apps and DMGs in one builder call with notarization off and no hook, then checks every signature', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = buildRunner(outputDir)

    const result = pkg(outputDir, run, 'local')

    const app = (subdir: string) => join(outputDir, subdir, 'Transfer.app')
    const dmg = (arch: string) => join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg`)
    expect(result.dmgs).toEqual(ARCHES.map(dmg))
    expect(commands.filter((c) => !c.startsWith('lipo'))).toEqual([
      'electron-vite build',
      'electron-builder --mac --publish never -c.mac.notarize=false',
      ...['mac-universal', 'mac-arm64', 'mac'].flatMap((s) => [
        `codesign --display --verbose=4 ${app(s)}`,
        `codesign --verify --deep --strict --verbose=2 ${app(s)}`
      ]),
      ...ARCHES.flatMap((arch) => [
        `codesign --verify --verbose=4 ${dmg(arch)}`,
        `codesign --display --verbose=4 ${dmg(arch)}`
      ])
    ])
  })

  test('fails before building anything when there is no certificate', () => {
    const outputDir = buildOutput([])
    const commands: string[] = []
    const run: Run = (command, args) => {
      commands.push([command, ...args].join(' '))
      return keychain(IDENTITIES_WITHOUT_DEVELOPER_ID)(command, args)
    }

    expect(() => pkg(outputDir, run, 'local', {})).toThrow(/no valid "Developer ID Application" signing identity/)
    expect(commands).toEqual(['security find-identity -v -p codesigning'])
  })

  test.each([
    { name: 'an ad-hoc signature', signature: SIGNED_ADHOC },
    { name: 'an App Store signature', signature: SIGNED_APP_STORE }
  ])('fails on $name instead of shipping it', ({ signature }) => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { run } = buildRunner(outputDir, { appOverrides: { 'mac-arm64': signature } })

    expect(() => pkg(outputDir, run, 'local')).toThrow(
      `not signed with a Developer ID Application identity: ${join(outputDir, 'mac-arm64', 'Transfer.app')}`
    )
  })

  test('fails when the builder left no DMG for an arch', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { run } = buildRunner(outputDir, { skipDmg: ['x64'] })

    expect(() => pkg(outputDir, run, 'local')).toThrow(
      `no DMG for x64 after the build: ${join(outputDir, 'Transfer-1.2.1-mac-x64.dmg')}`
    )
  })

  test('fails when a DMG is signed by a different team from the app inside it', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { run } = buildRunner(outputDir, { dmgSignature: DMG_OTHER_TEAM })

    expect(() => pkg(outputDir, run, 'local')).toThrow('TEAM123456')
  })
})

describe('one build, release profile', () => {
  test('adds the notarization hook to the same builder call, and confirms every app carries its ticket', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = buildRunner(outputDir)

    pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', ...APPLE_ENV })

    expect(commands).toContain('electron-builder --mac --publish never -c.mac.notarize=false -c.afterSign=build/mac-packaging.cjs')
    for (const s of ['mac-universal', 'mac-arm64', 'mac']) {
      expect(commands).toContain(`xcrun stapler validate ${join(outputDir, s, 'Transfer.app')}`)
    }
  })

  test('refuses to build without every Apple credential', () => {
    const outputDir = buildOutput([])
    const { commands, run } = buildRunner(outputDir)

    expect(() => pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password' })).toThrow('APPLE_TEAM_ID')
    expect(commands).toEqual([])
  })

  test('fails when an app came out of the build without a stapled ticket (the hook did not run on it)', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { run } = buildRunner(outputDir, { unstapled: ['mac'] })

    expect(() => pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', ...APPLE_ENV })).toThrow('does not have a ticket stapled to it')
  })
})

describe('a rebuild leaves nothing from an earlier run behind', () => {
  test('a DMG left over from an earlier run does not pass as this run\'s output', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    writeFileSync(join(outputDir, 'Transfer-1.2.1-mac-x64.dmg'), 'stale')
    const { run } = buildRunner(outputDir, { skipDmg: ['x64'] })

    expect(() => pkg(outputDir, run, 'local')).toThrow('no DMG for x64 after the build')
  })

  test('build output directories from an earlier run are cleared before the build, so a leftover app never reaches the hook', () => {
    // A crashed universal build leaves <outDir>-<arch>-temp behind; Mac App Store output (mas-*) is not ours to clear
    const outputDir = buildOutput([...BUILD_SUBDIRS, 'mac-universal-arm64-temp', 'mas-universal'])
    let seenAtBuild: string[] = []
    const { run: inner } = buildRunner(outputDir)
    const run: Run = (command, args) => {
      if (command === 'electron-builder') {
        seenAtBuild = BUILD_SUBDIRS.concat('mac-universal-arm64-temp', 'mas-universal').filter((d) => existsSync(join(outputDir, d)))
      }
      return inner(command, args)
    }

    // Only what was on disk when the build started matters here, not how the leftover would fail later
    try {
      pkg(outputDir, run, 'local')
    } catch {
      // asserted below
    }

    expect(seenAtBuild).toEqual(['mas-universal'])
  })

  test('the notarization logs of the apps and DMGs being rebuilt are removed', () => {
    // A local package must never sit next to a log claiming it was notarized
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const staleLogs = ARCHES.flatMap((arch) => [
      join(outputDir, `Transfer-1.2.1-mac-${arch}.app.notary-log.json`),
      join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg.notary-log.json`)
    ])
    for (const log of staleLogs) writeFileSync(log, '{"status":"Accepted"}')
    const { run } = buildRunner(outputDir)

    pkg(outputDir, run, 'local')

    expect(staleLogs.filter((log) => existsSync(log))).toEqual([])
  })
})

/**
 * A runner for the hook: `notarytool submit` answers Accepted with an id derived from the submitted file,
 * unless that file's name contains `reject`; `notarytool log` answers the matching log.
 */
function notaryRunner(reject: string | null = null) {
  const commands: string[] = []
  const idOf = (file: string) => `id-${file.split('/').at(-1)!.replace(/[^a-z0-9]+/gi, '-')}`
  const run: Run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') {
      const status = reject && args[2].includes(reject) ? 'Invalid' : 'Accepted'
      return { stdout: JSON.stringify({ id: idOf(args[2]), status }), stderr: '' }
    }
    if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'log') {
      return { stdout: JSON.stringify({ jobId: args[2], status: 'Accepted', issues: [] }), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

/** The context electron-builder passes to afterSign, as far as the hook reads it */
const signContext = (outputDir: string, subdir: string, platform = 'darwin'): SignContext => ({
  electronPlatformName: platform,
  appOutDir: join(outputDir, subdir),
  outDir: outputDir,
  packager: { appInfo: { productFilename: 'Transfer', version: '1.2.1' } }
})

describe('afterSign hook: notarize each signed app before its DMG is built', () => {
  test('zips, submits, keeps the log, staples and validates the app it is called for', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner()
    const logs: Array<{ file: string; contents: string }> = []
    const progress: string[] = []

    const id = await afterSign(signContext(outputDir, 'mac-arm64'), {
      env: APPLE_ENV, run,
      writeError: () => undefined,
      writeNotaryLog: (file, contents) => logs.push({ file, contents }),
      log: (message) => progress.push(message)
    })

    const app = join(outputDir, 'mac-arm64', 'Transfer.app')
    expect(id).toBe('id-Transfer-arm64-zip')
    expect(commands.map((c) => c.replace(/ --apple-id .*$/, ''))).toEqual([
      `lipo -archs ${join(app, 'Contents', 'MacOS', 'Transfer')}`,
      expect.stringMatching(new RegExp(`^ditto -c -k --keepParent ${app} .*/Transfer-arm64\\.zip$`)),
      expect.stringMatching(/^xcrun notarytool submit .*\/Transfer-arm64\.zip$/),
      'xcrun notarytool log id-Transfer-arm64-zip',
      `xcrun stapler staple ${app}`,
      `xcrun stapler validate ${app}`
    ])
    expect(logs).toEqual([{
      file: join(outputDir, 'Transfer-1.2.1-mac-arm64.app.notary-log.json'),
      contents: JSON.stringify({ jobId: 'id-Transfer-arm64-zip', status: 'Accepted', issues: [] })
    }])
    expect(progress).toEqual([`[mac] notarizing arm64: ${app}`, '[mac] accepted arm64 (submission: id-Transfer-arm64-zip)'])
  })

  test('does nothing for a Mac App Store build', async () => {
    const outputDir = buildOutput(['mas-universal'])
    const { commands, run } = notaryRunner()

    await afterSign(signContext(outputDir, 'mas-universal', 'mas'), {
      env: APPLE_ENV, run, writeError: () => undefined, writeNotaryLog: () => undefined, log: () => undefined
    })

    expect(commands).toEqual([])
  })

  test('fails without every Apple credential instead of skipping', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner()

    await expect(Promise.resolve().then(() => afterSign(signContext(outputDir, 'mac'), {
      env: { APPLE_ID: 'developer@example.com' }, run, writeError: () => undefined, writeNotaryLog: () => undefined, log: () => undefined
    }))).rejects.toThrow('APPLE_APP_SPECIFIC_PASSWORD')
    expect(commands).toEqual([])
  })

  test('a rejected app fails the build with the original error, unstapled', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner('arm64')

    await expect(Promise.resolve().then(() => afterSign(signContext(outputDir, 'mac-arm64'), {
      env: APPLE_ENV, run, writeError: () => undefined, writeNotaryLog: () => undefined, log: () => undefined
    }))).rejects.toThrow('Invalid (submission: id-Transfer-arm64-zip)')
    expect(commands.some((c) => c.startsWith('xcrun stapler staple'))).toBe(false)
  })
})

describe('where the steps look', () => {
  test('product name, version, output directory and arches come from the project files', () => {
    const packageJson = JSON.stringify({ name: 'transfer', version: '9.8.7' })
    expect(resolveLayout(BUILDER_CONFIG, packageJson)).toEqual({
      productName: 'Transfer',
      version: '9.8.7',
      outputDir: 'release/9.8.7',
      arches: ['universal', 'arm64', 'x64']
    })
  })

  test('an output directory using a macro other than ${version} is refused rather than guessed', () => {
    const config = BUILDER_CONFIG.replace('output: release/${version}', 'output: release/${arch}/${version}')
    expect(() => resolveLayout(config, JSON.stringify({ version: '9.8.7' }))).toThrow(
      'directories.output may only use ${version}: release/${arch}/${version}'
    )
  })
})

describe('commands and config', () => {
  const scripts = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>
  }).scripts

  test('the two entries are named after their environment', () => {
    expect(scripts['dist:mac:local']).toBe('node build/mac-packaging.cjs local')
    expect(scripts['dist:mac:release']).toBe('node build/mac-packaging.cjs release && pnpm run mac:notarize-dmg')
    expect(scripts['mac:notarize-dmg']).toBe('node build/notarize-dmgs.cjs')
  })

  test('the names that described mechanisms are gone, with no aliases', () => {
    for (const old of ['dist:mac', 'dist:mac:package-signed', 'notarize:mac:dmgs', 'dist:mac:sign', 'mac:sign', 'mac:notarize-app', 'mac:dmg']) {
      expect(scripts[old], old).toBeUndefined()
    }
  })

  test('built-in notarization is off in the builder config', () => {
    // electron-builder notarizes whenever Apple credentials are loaded unless this is explicitly false
    expect((YAML.parse(BUILDER_CONFIG) as { mac: { notarize: unknown } }).mac.notarize).toBe(false)
  })
})

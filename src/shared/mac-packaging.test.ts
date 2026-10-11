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

interface StepOptions {
  env: Record<string, string | undefined>
  run: Run
  outputDir: string
  productName: string
  version: string
  arches: string[]
}

interface NotarizeOptions extends StepOptions {
  writeError: (message: string) => void
  writeNotaryLog: (file: string, contents: string) => void
}

const { buildDmgs, certificateSource, configuredArches, findBuiltApps, notarizeApps, resolveLayout, signApps } = require('../../build/mac-packaging.cjs') as {
  resolveLayout: (configText: string, packageJsonText: string) => { productName: string; version: string; outputDir: string; arches: string[] }
  buildDmgs: (options: StepOptions) => string[]
  notarizeApps: (options: NotarizeOptions) => string[]
  signApps: (options: StepOptions) => Array<{ arch: string; app: string }>
  findBuiltApps: (options: { outputDir: string; productName: string; arches: string[]; run: Run }) => Array<{ arch: string; app: string }>
  certificateSource: (env: Record<string, string | undefined>, run: Run) => string
  configuredArches: (configText: string) => string[]
}

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

const BUILDER_CONFIG = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')

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

// Real temporary directories stand in for the build output; only `lipo` is faked.
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

describe('locating the built apps', () => {
  const ARCHES = ['universal', 'arm64', 'x64']

  test('identifies each app by its binary architectures, whatever its directory is called', () => {
    // x64 builds into mac/, the others into mac-<arch>/ — the names are not a reliable guide
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const apps = findBuiltApps({
      outputDir,
      productName: 'Transfer',
      arches: ARCHES,
      run: lipo({ mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' })
    })
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
      subdirs: ['mac', 'mac-arm64', 'mac-universal', 'mac-old'],
      answers: { mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64', 'mac-old': 'i386' },
      message: 'unexpected binary architectures: i386'
    },
    {
      // A universal build that crashed leaves its per-arch build behind in <outDir>-<arch>-temp
      name: 'a crashed universal build left its arm64 temp app behind',
      subdirs: ['mac', 'mac-arm64', 'mac-universal', 'mac-universal-arm64-temp'],
      answers: { mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64', 'mac-universal-arm64-temp': 'arm64' },
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

const LIPO_ANSWERS: Record<string, string> = { mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' }

/**
 * A recording runner for the packaging steps: the build commands succeed, `lipo` answers from the build
 * output table, and `codesign --display` answers with `signature` (or per-app overrides).
 */
function packagingRunner(signature: string, overrides: Record<string, string> = {}) {
  const commands: string[] = []
  const run: Run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'codesign' && args[0] === '--display') {
      const subdir = Object.keys(overrides).find((key) => args.at(-1)!.includes(`/${key}/`))
      return { stdout: '', stderr: subdir ? overrides[subdir] : signature }
    }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

describe('mac:sign', () => {
  const ARCHES = ['universal', 'arm64', 'x64']

  test('builds every arch with notarization off, then confirms each app is Developer ID signed', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { commands, run } = packagingRunner(SIGNED_DEVELOPER_ID)

    const apps = signApps({ env: { CSC_LINK: 'base64-p12' }, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })

    expect(apps.map((entry) => entry.arch)).toEqual(ARCHES)
    const app = (subdir: string) => join(outputDir, subdir, 'Transfer.app')
    expect(commands).toEqual([
      'electron-vite build',
      'electron-builder --mac dir --universal --arm64 --x64 --publish never -c.mac.notarize=false',
      ...['mac', 'mac-arm64', 'mac-universal'].map((s) => `lipo -archs ${join(app(s), 'Contents', 'MacOS', 'Transfer')}`),
      ...['mac-universal', 'mac-arm64', 'mac'].flatMap((s) => [
        `codesign --display --verbose=4 ${app(s)}`,
        `codesign --verify --deep --strict --verbose=2 ${app(s)}`
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

    expect(() => signApps({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })).toThrow(
      /no valid "Developer ID Application" signing identity/
    )
    expect(commands).toEqual(['security find-identity -v -p codesigning'])
  })

  test.each([
    { name: 'an ad-hoc signature', signature: SIGNED_ADHOC },
    { name: 'an App Store signature', signature: SIGNED_APP_STORE }
  ])('fails on $name instead of packaging it', ({ signature }) => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { run } = packagingRunner(SIGNED_DEVELOPER_ID, { 'mac-arm64': signature })

    expect(() => signApps({ env: { CSC_LINK: 'base64-p12' }, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })).toThrow(
      `not signed with a Developer ID Application identity: ${join(outputDir, 'mac-arm64', 'Transfer.app')}`
    )
  })
})

const APPLE_ENV = { APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password', APPLE_TEAM_ID: 'TEAM123456' }

/**
 * A runner for the notarization steps: `notarytool submit` answers Accepted with an id derived from the
 * submitted file, unless that file's name contains `reject`; `notarytool log` answers the matching log.
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

describe('mac:notarize-app', () => {
  const ARCHES = ['universal', 'arm64', 'x64']

  test('zips, submits, keeps the log, staples and validates each app in config order', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { commands, run } = notaryRunner()
    const logs: Array<{ file: string; contents: string }> = []

    notarizeApps({
      env: APPLE_ENV, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES,
      writeError: () => undefined,
      writeNotaryLog: (file, contents) => logs.push({ file, contents })
    })

    const app = (subdir: string) => join(outputDir, subdir, 'Transfer.app')
    const steps = commands.filter((c) => !c.startsWith('lipo')).map((c) => c.replace(/ --apple-id .*$/, ''))
    expect(steps).toEqual(['mac-universal', 'mac-arm64', 'mac'].flatMap((subdir, i) => {
      const arch = ARCHES[i]
      return [
        expect.stringMatching(new RegExp(`^ditto -c -k --keepParent ${app(subdir)} .*/Transfer-${arch}\\.zip$`)),
        expect.stringMatching(new RegExp(`^xcrun notarytool submit .*/Transfer-${arch}\\.zip$`)),
        `xcrun notarytool log id-Transfer-${arch}-zip`,
        `xcrun stapler staple ${app(subdir)}`,
        `xcrun stapler validate ${app(subdir)}`
      ]
    }))
    expect(logs.map((entry) => entry.file)).toEqual(ARCHES.map((arch) => join(outputDir, `Transfer-1.2.1-mac-${arch}.app.notary-log.json`)))
    expect(JSON.parse(logs[0].contents)).toEqual({ jobId: 'id-Transfer-universal-zip', status: 'Accepted', issues: [] })
  })

  test('refuses to run without every Apple credential, before touching anything', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { commands, run } = notaryRunner()

    expect(() => notarizeApps({
      env: { APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password' },
      run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES,
      writeError: () => undefined, writeNotaryLog: () => undefined
    })).toThrow('APPLE_TEAM_ID')
    expect(commands).toEqual([])
  })

  test('a rejected app stops the step with the original error, unstapled, before later arches', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { commands, run } = notaryRunner('arm64')

    expect(() => notarizeApps({
      env: APPLE_ENV, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES,
      writeError: () => undefined, writeNotaryLog: () => undefined
    })).toThrow('Invalid (submission: id-Transfer-arm64-zip)')
    expect(commands.some((c) => c === `xcrun stapler staple ${join(outputDir, 'mac-arm64', 'Transfer.app')}`)).toBe(false)
    expect(commands.some((c) => c.includes('Transfer-x64.zip'))).toBe(false)
  })
})

const DMG_SIGNED = ['Authority=Developer ID Application: Example Dev (TEAM123456)', 'Timestamp=Aug 22, 2026 at 17:51:02', 'TeamIdentifier=TEAM123456'].join('\n')
const DMG_OTHER_TEAM = ['Authority=Developer ID Application: Someone Else (OTHERTEAM1)', 'Timestamp=Aug 22, 2026 at 17:51:02', 'TeamIdentifier=OTHERTEAM1'].join('\n')

/**
 * electron-builder writes the DMG for each arch it is asked to build, unless the arch is in `skip`; codesign
 * answers that apps are Developer ID signed by TEAM123456 and DMGs with `dmgSignature`
 */
function dmgRunner(outputDir: string, dmgSignature: string, skip: string[] = []) {
  const commands: string[] = []
  const run: Run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'electron-builder' && args.includes('--prepackaged')) {
      const arch = args[2].replace(/^--/, '')
      if (!skip.includes(arch)) writeFileSync(join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg`), 'new')
      return { stdout: '', stderr: '' }
    }
    if (command === 'codesign' && args[0] === '--display') {
      return { stdout: '', stderr: args.at(-1)!.endsWith('.dmg') ? dmgSignature : SIGNED_DEVELOPER_ID }
    }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

describe('mac:dmg', () => {
  const ARCHES = ['universal', 'arm64', 'x64']

  test('builds each DMG from its app without re-signing it, then checks the DMG signature itself', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { commands, run } = dmgRunner(outputDir, DMG_SIGNED)

    const dmgs = buildDmgs({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })

    const app = (subdir: string) => join(outputDir, subdir, 'Transfer.app')
    const dmg = (arch: string) => join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg`)
    expect(dmgs).toEqual(ARCHES.map(dmg))
    expect(commands.filter((c) => !c.startsWith('lipo'))).toEqual([
      ...['mac-universal', 'mac-arm64', 'mac'].map((subdir, i) =>
        `electron-builder --mac dmg --${ARCHES[i]} --prepackaged ${app(subdir)} --publish never -c.mac.notarize=false`),
      ...['mac-universal', 'mac-arm64', 'mac'].flatMap((subdir, i) => [
        `codesign --display --verbose=4 ${app(subdir)}`,
        `codesign --verify --verbose=4 ${dmg(ARCHES[i])}`,
        `codesign --display --verbose=4 ${dmg(ARCHES[i])}`
      ])
    ])
  })

  test('fails when the builder left no DMG for an arch', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { run } = dmgRunner(outputDir, DMG_SIGNED, ['x64'])

    expect(() => buildDmgs({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })).toThrow(
      `no DMG for x64 after the build: ${join(outputDir, 'Transfer-1.2.1-mac-x64.dmg')}`
    )
  })

  test('fails when a DMG is signed by a different team from the app inside it', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const { run } = dmgRunner(outputDir, DMG_OTHER_TEAM)

    expect(() => buildDmgs({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })).toThrow(
      'TEAM123456'
    )
  })
})

describe('a rebuild leaves nothing from an earlier run behind', () => {
  const ARCHES = ['universal', 'arm64', 'x64']

  test('mac:dmg does not accept a DMG left over from an earlier run as this run\'s output', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    writeFileSync(join(outputDir, 'Transfer-1.2.1-mac-x64.dmg'), 'stale')
    const { run } = dmgRunner(outputDir, DMG_SIGNED, ['x64'])

    expect(() => buildDmgs({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })).toThrow(
      'no DMG for x64 after the build'
    )
  })

  test('mac:dmg removes the notarization logs of the DMGs it rebuilds', () => {
    // A local package must never sit next to a log claiming it was notarized
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const staleLogs = ARCHES.map((arch) => join(outputDir, `Transfer-1.2.1-mac-${arch}.dmg.notary-log.json`))
    for (const log of staleLogs) writeFileSync(log, '{"status":"Accepted"}')
    const { run } = dmgRunner(outputDir, DMG_SIGNED)

    buildDmgs({ env: {}, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })

    expect(staleLogs.filter((log) => existsSync(log))).toEqual([])
  })

  test('mac:sign removes the notarization logs of the apps it rebuilds', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64', 'mac-universal'])
    const staleLogs = ARCHES.map((arch) => join(outputDir, `Transfer-1.2.1-mac-${arch}.app.notary-log.json`))
    for (const log of staleLogs) writeFileSync(log, '{"status":"Accepted"}')
    const { run } = packagingRunner(SIGNED_DEVELOPER_ID)

    signApps({ env: { CSC_LINK: 'base64-p12' }, run, outputDir, productName: 'Transfer', version: '1.2.1', arches: ARCHES })

    expect(staleLogs.filter((log) => existsSync(log))).toEqual([])
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

  test('the two entries are named after their environment and compose the step scripts in order', () => {
    expect(scripts['dist:mac:local']).toBe('pnpm run mac:sign && pnpm run mac:dmg')
    expect(scripts['dist:mac:release']).toBe(
      'pnpm run mac:sign && pnpm run mac:notarize-app && pnpm run mac:dmg && pnpm run mac:notarize-dmg'
    )
    expect(scripts['mac:sign']).toBe('node build/mac-packaging.cjs sign')
    expect(scripts['mac:notarize-app']).toBe('node build/mac-packaging.cjs notarize-app')
    expect(scripts['mac:dmg']).toBe('node build/mac-packaging.cjs dmg')
    expect(scripts['mac:notarize-dmg']).toBe('node build/notarize-dmgs.cjs')
  })

  test('the names that described mechanisms are gone, with no aliases', () => {
    for (const old of ['dist:mac', 'dist:mac:package-signed', 'notarize:mac:dmgs', 'dist:mac:sign']) {
      expect(scripts[old], old).toBeUndefined()
    }
  })

  test('built-in notarization is off in the builder config', () => {
    // electron-builder notarizes whenever Apple credentials are loaded unless this is explicitly false
    expect((YAML.parse(BUILDER_CONFIG) as { mac: { notarize: unknown } }).mac.notarize).toBe(false)
  })
})

// Tests for mac-packaging.cjs (copy both files into the project together; run with `node --test <dir>`).
//
// Every external command goes through an injected runner, so these tests check which commands run, in what
// order, what fails and with which message. They never contact Apple and never build an app: a green run here
// says nothing about a real signature or a real notarization. Those are verified by real packaging runs.
//
// `main` runs real commands and is tested only for its argument and location checks: the hook path it derives and
// the DMG gate's loop over the selected DMGs are covered only by a real release packaging run.
const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const mac = require('./mac-packaging.cjs')

const ARCHES = ['universal', 'arm64', 'x64']
const BUILD_SUBDIRS = ['mac', 'mac-arm64', 'mac-universal']
const LIPO_ANSWERS = { mac: 'x86_64', 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' }
const PRODUCT = 'Demo'
const VERSION = '1.2.1'
const APPLE_ENV = { APPLE_ID: 'developer@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password', APPLE_TEAM_ID: 'TEAM123456' }

const CONFIG = {
  productName: PRODUCT,
  directories: { output: 'release/${version}' },
  mac: { notarize: false, target: [{ target: 'dmg', arch: ['universal', 'arm64', 'x64'] }] },
  dmg: { artifactName: '${productName}-${version}-mac-${arch}.dmg' }
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

const keychain = (stdout) => (command, args) => {
  if (command === 'security' && args[0] === 'find-identity') return { stdout, stderr: '' }
  throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
}

// Real temporary directories stand in for the build output; only external commands are faked.
const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-packaging-test-'))
  tempDirs.push(dir)
  return dir
}

function makeApps(outputDir, subdirs) {
  for (const subdir of subdirs) {
    const macos = path.join(outputDir, subdir, `${PRODUCT}.app`, 'Contents', 'MacOS')
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(macos, PRODUCT), '')
  }
}

function buildOutput(subdirs) {
  const outputDir = tempDir()
  makeApps(outputDir, subdirs)
  return outputDir
}

/** A `lipo -archs` runner answering from a table keyed by the build subdirectory */
const lipo = (bySubdir) => (command, args) => {
  if (command !== 'lipo' || args[0] !== '-archs') throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  const subdir = Object.keys(bySubdir).find((key) => args[1].includes(`/${key}/${PRODUCT}.app/`))
  if (!subdir) throw new Error(`no lipo answer for ${args[1]}`)
  return { stdout: `${bySubdir[subdir]}\n`, stderr: '' }
}

const dmgPath = (outputDir, arch) => path.join(outputDir, `${PRODUCT}-${VERSION}-mac-${arch}.dmg`)
const appPath = (outputDir, subdir) => path.join(outputDir, subdir, `${PRODUCT}.app`)

/**
 * A recording runner for one packaging build. Like the real builder, the apps and DMGs exist only once
 * electron-builder has run; it writes a DMG for every arch unless the arch is in `skipDmg`. codesign answers apps
 * with `appSignature` (or a per-subdir override) and DMGs with `dmgSignature`; `stapler validate` fails for apps
 * whose subdir is in `unstapled`.
 */
function buildRunner(outputDir, opts = {}) {
  const commands = []
  const run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'electron-builder') {
      makeApps(outputDir, BUILD_SUBDIRS)
      for (const arch of ARCHES) {
        if (!(opts.skipDmg ?? []).includes(arch)) fs.writeFileSync(dmgPath(outputDir, arch), 'new')
      }
      return { stdout: '', stderr: '' }
    }
    if (command === 'codesign' && args[0] === '--display') {
      const target = args.at(-1)
      if (target.endsWith('.dmg')) return { stdout: '', stderr: opts.dmgSignature ?? DMG_SIGNED }
      const subdir = Object.keys(opts.appOverrides ?? {}).find((key) => target.includes(`/${key}/`))
      return { stdout: '', stderr: subdir ? opts.appOverrides[subdir] : SIGNED_DEVELOPER_ID }
    }
    if (command === 'xcrun' && args[0] === 'stapler' && args[1] === 'validate') {
      if ((opts.unstapled ?? []).some((subdir) => args[2].includes(`/${subdir}/`))) throw new Error(`${args[2]} does not have a ticket stapled to it.`)
    }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

const pkg = (outputDir, run, profile, env = { CSC_LINK: 'base64-p12' }) =>
  mac.packageMac({ profile, env, run, outputDir, productName: PRODUCT, version: VERSION, arches: ARCHES, hookPath: 'build/mac-packaging.cjs' })

describe('configuration', () => {
  test('reads the DMG target architectures in config order', () => {
    assert.deepEqual(mac.configuredArches(CONFIG), ['universal', 'arm64', 'x64'])
  })

  for (const [name, target, message] of [
    ['no dmg target', [{ target: 'zip', arch: ['arm64'] }], 'electron-builder.yml has no mac dmg target with an arch list'],
    ['an unknown arch', [{ target: 'dmg', arch: ['arm64', 'ia32'] }], 'unsupported mac arch in electron-builder.yml: ia32'],
    ['an arch listed twice', [{ target: 'dmg', arch: ['arm64', 'arm64'] }], 'electron-builder.yml lists a mac arch twice']
  ]) {
    test(`fails on ${name}`, () => {
      assert.throws(() => mac.configuredArches({ mac: { target } }), { message })
    })
  }

  test('product name, version, output directory and arches come from the project files', () => {
    assert.deepEqual(mac.resolveLayout(CONFIG, JSON.stringify({ version: '9.8.7' })), {
      productName: PRODUCT, version: '9.8.7', outputDir: 'release/9.8.7', arches: ARCHES
    })
  })

  test('an output directory using a macro other than ${version} is refused rather than guessed', () => {
    const config = { ...CONFIG, directories: { output: 'release/${arch}/${version}' } }
    assert.throws(() => mac.resolveLayout(config, JSON.stringify({ version: '9.8.7' })), {
      message: 'directories.output may only use ${version}: release/${arch}/${version}'
    })
  })

  test('the DMG name pattern is required, and the error says what to write', () => {
    // The default pattern drops the arch for the default architecture, so a file could not be mapped to its arch
    const { dmg, ...withoutDmg } = CONFIG
    assert.throws(() => mac.resolveLayout(withoutDmg, JSON.stringify({ version: '1.0.0' })), {
      message: 'electron-builder.yml must set dmg.artifactName: ${productName}-${version}-mac-${arch}.dmg (found: nothing)'
    })
    assert.throws(() => mac.resolveLayout({ ...CONFIG, dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' } }, JSON.stringify({ version: '1.0.0' })), {
      message: 'electron-builder.yml must set dmg.artifactName: ${productName}-${version}-mac-${arch}.dmg (found: ${productName}-${version}-${arch}.${ext})'
    })
  })

  test('a config without productName is refused', () => {
    const { productName, ...withoutName } = CONFIG
    assert.throws(() => mac.resolveLayout(withoutName, JSON.stringify({ version: '1.0.0' })), { message: 'electron-builder.yml has no productName' })
  })

  test('js-yaml comes from electron-builder\'s dependency tree, and its absence is explained', () => {
    assert.equal(typeof mac.yamlParser().load, 'function')
    const missing = () => { throw new Error("Cannot find module 'electron-builder/package.json'") }
    assert.throws(() => mac.yamlParser(missing), /cannot load js-yaml through electron-builder .*is electron-builder installed\?/)
  })
})

describe('certificate source check', () => {
  test('a Developer ID Application identity in the keychain is accepted', () => {
    assert.equal(mac.certificateSource({}, keychain(IDENTITIES_WITH_DEVELOPER_ID)), 'keychain: Developer ID Application: Example Dev (TEAM123456)')
  })

  test('no Developer ID Application identity fails with the install hint', () => {
    assert.throws(() => mac.certificateSource({}, keychain(IDENTITIES_WITHOUT_DEVELOPER_ID)), /no valid "Developer ID Application" signing identity[\s\S]*security find-identity -v$/)
  })

  test('CSC_LINK is accepted without reading the keychain, since the builder imports it', () => {
    assert.equal(mac.certificateSource({ CSC_LINK: 'base64-p12' }, () => { throw new Error('the keychain must not be queried') }), 'CSC_LINK')
  })

  test('an empty CSC_LINK does not count as a certificate', () => {
    assert.throws(() => mac.certificateSource({ CSC_LINK: '  ' }, keychain(IDENTITIES_WITHOUT_DEVELOPER_ID)), /no valid "Developer ID Application" signing identity/)
  })
})

describe('locating the built apps', () => {
  test('identifies each app by its binary architectures, whatever its directory is called', () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    assert.deepEqual(mac.findBuiltApps({ outputDir, productName: PRODUCT, arches: ARCHES, run: lipo(LIPO_ANSWERS) }), [
      { arch: 'universal', app: appPath(outputDir, 'mac-universal') },
      { arch: 'arm64', app: appPath(outputDir, 'mac-arm64') },
      { arch: 'x64', app: appPath(outputDir, 'mac') }
    ])
  })

  for (const [name, subdirs, answers, message] of [
    ['nothing has been built', [], {}, 'no built Demo.app under'],
    ['an arch is missing', ['mac-arm64', 'mac-universal'], { 'mac-arm64': 'arm64', 'mac-universal': 'x86_64 arm64' }, 'no built app for x64 under'],
    ['a binary has unexpected architectures', [...BUILD_SUBDIRS, 'mac-old'], { ...LIPO_ANSWERS, 'mac-old': 'i386' }, 'unexpected binary architectures: i386'],
    // A universal build that crashed leaves its per-arch build behind in <outDir>-<arch>-temp
    ['a crashed universal build left its arm64 temp app behind', [...BUILD_SUBDIRS, 'mac-universal-arm64-temp'], { ...LIPO_ANSWERS, 'mac-universal-arm64-temp': 'arm64' }, 'two built apps for arm64']
  ]) {
    test(`fails when ${name}`, () => {
      const outputDir = buildOutput(subdirs)
      assert.throws(() => mac.findBuiltApps({ outputDir, productName: PRODUCT, arches: ARCHES, run: lipo(answers) }), (error) => error.message.includes(message))
    })
  }

  test('fails on a leftover app for an arch the config no longer lists', () => {
    const outputDir = buildOutput(['mac', 'mac-arm64'])
    assert.throws(() => mac.findBuiltApps({ outputDir, productName: PRODUCT, arches: ['arm64'], run: lipo({ mac: 'x86_64', 'mac-arm64': 'arm64' }) }), {
      message: `built app for an arch the config does not list (x64): ${appPath(outputDir, 'mac')}`
    })
  })
})

describe('one build, local profile', () => {
  test('builds the apps and DMGs in one builder call with notarization off and no hook, then checks every signature', () => {
    const outputDir = tempDir()
    const { commands, run } = buildRunner(outputDir)

    const result = pkg(outputDir, run, 'local')

    assert.deepEqual(result.dmgs, ARCHES.map((arch) => dmgPath(outputDir, arch)))
    assert.deepEqual(commands.filter((c) => !c.startsWith('lipo')), [
      'electron-vite build',
      'electron-builder --mac --publish never -c.mac.notarize=false',
      ...['mac-universal', 'mac-arm64', 'mac'].flatMap((s) => [
        `codesign --display --verbose=4 ${appPath(outputDir, s)}`,
        `codesign --verify --deep --strict --verbose=2 ${appPath(outputDir, s)}`
      ]),
      ...ARCHES.flatMap((arch) => [`codesign --verify --verbose=4 ${dmgPath(outputDir, arch)}`, `codesign --display --verbose=4 ${dmgPath(outputDir, arch)}`])
    ])
  })

  test('fails before building anything when there is no certificate', () => {
    const outputDir = tempDir()
    const commands = []
    const run = (command, args) => { commands.push([command, ...args].join(' ')); return keychain(IDENTITIES_WITHOUT_DEVELOPER_ID)(command, args) }
    assert.throws(() => pkg(outputDir, run, 'local', {}), /no valid "Developer ID Application" signing identity/)
    assert.deepEqual(commands, ['security find-identity -v -p codesigning'])
  })

  for (const [name, signature] of [['an ad-hoc signature', SIGNED_ADHOC], ['an App Store signature', SIGNED_APP_STORE]]) {
    test(`fails on ${name} instead of shipping it`, () => {
      const outputDir = tempDir()
      const { run } = buildRunner(outputDir, { appOverrides: { 'mac-arm64': signature } })
      assert.throws(() => pkg(outputDir, run, 'local'), { message: `not signed with a Developer ID Application identity: ${appPath(outputDir, 'mac-arm64')}` })
    })
  }

  test('fails when the builder left no DMG for an arch', () => {
    const outputDir = tempDir()
    const { run } = buildRunner(outputDir, { skipDmg: ['x64'] })
    assert.throws(() => pkg(outputDir, run, 'local'), { message: `no DMG for x64 after the build: ${dmgPath(outputDir, 'x64')}` })
  })

  test('fails when a DMG is signed by a different team from the app inside it', () => {
    const outputDir = tempDir()
    const { run } = buildRunner(outputDir, { dmgSignature: DMG_OTHER_TEAM })
    assert.throws(() => pkg(outputDir, run, 'local'), { message: 'DMG Team ID does not match: expected TEAM123456' })
  })
})

describe('one build, release profile', () => {
  test('adds this file as the afterSign hook to the same builder call, and confirms every app carries its ticket', () => {
    const outputDir = tempDir()
    const { commands, run } = buildRunner(outputDir)
    pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', ...APPLE_ENV })
    assert.ok(commands.includes('electron-builder --mac --publish never -c.mac.notarize=false -c.afterSign=build/mac-packaging.cjs'))
    for (const s of ['mac-universal', 'mac-arm64', 'mac']) assert.ok(commands.includes(`xcrun stapler validate ${appPath(outputDir, s)}`), s)
  })

  test('refuses to build without every Apple credential', () => {
    const outputDir = tempDir()
    const { commands, run } = buildRunner(outputDir)
    assert.throws(() => pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b' }), { message: 'missing Apple notarization credentials: APPLE_TEAM_ID' })
    assert.deepEqual(commands, [])
  })

  test('fails when an app came out of the build without a stapled ticket (the hook did not run on it)', () => {
    const outputDir = tempDir()
    const { run } = buildRunner(outputDir, { unstapled: ['mac'] })
    assert.throws(() => pkg(outputDir, run, 'release', { CSC_LINK: 'base64-p12', ...APPLE_ENV }), /does not have a ticket stapled to it/)
  })
})

describe('a rebuild leaves nothing from an earlier run behind', () => {
  test('a DMG left over from an earlier run does not pass as this run\'s output', () => {
    const outputDir = tempDir()
    fs.writeFileSync(dmgPath(outputDir, 'x64'), 'stale')
    const { run } = buildRunner(outputDir, { skipDmg: ['x64'] })
    assert.throws(() => pkg(outputDir, run, 'local'), /no DMG for x64 after the build/)
  })

  test('build output directories from an earlier run are cleared before the build, so a leftover app never reaches the hook', () => {
    // A crashed universal build leaves <outDir>-<arch>-temp behind; Mac App Store output (mas-*) is not ours to clear
    const outputDir = buildOutput([...BUILD_SUBDIRS, 'mac-universal-arm64-temp', 'mas-universal'])
    let seenAtBuild = []
    const { run: inner } = buildRunner(outputDir)
    const run = (command, args) => {
      if (command === 'electron-builder') seenAtBuild = [...BUILD_SUBDIRS, 'mac-universal-arm64-temp', 'mas-universal'].filter((d) => fs.existsSync(path.join(outputDir, d)))
      return inner(command, args)
    }
    try {
      pkg(outputDir, run, 'local')
    } catch {
      // only what was on disk when the build started is asserted
    }
    assert.deepEqual(seenAtBuild, ['mas-universal'])
  })

  test('the notarization logs of the apps and DMGs being rebuilt are removed', () => {
    // A local package must never sit next to a log claiming it was notarized
    const outputDir = tempDir()
    const stale = ARCHES.flatMap((arch) => [
      path.join(outputDir, `${PRODUCT}-${VERSION}-mac-${arch}.app.notary-log.json`),
      `${dmgPath(outputDir, arch)}.notary-log.json`
    ])
    for (const file of stale) fs.writeFileSync(file, '{"status":"Accepted"}')
    const { run } = buildRunner(outputDir)
    pkg(outputDir, run, 'local')
    assert.deepEqual(stale.filter((file) => fs.existsSync(file)), [])
  })
})

/** A runner for notarization: `submit` answers Accepted unless the file name contains `reject`; `log` answers the matching log */
function notaryRunner(reject = null) {
  const commands = []
  const idOf = (file) => `id-${path.basename(file).replace(/[^a-z0-9]+/gi, '-')}`
  const run = (command, args) => {
    commands.push([command, ...args].join(' '))
    if (command === 'lipo') return lipo(LIPO_ANSWERS)(command, args)
    if (command === 'codesign' && args[0] === '--display') return { stdout: '', stderr: DMG_SIGNED }
    if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'submit') {
      return { stdout: JSON.stringify({ id: idOf(args[2]), status: reject && args[2].includes(reject) ? 'Invalid' : 'Accepted' }), stderr: '' }
    }
    if (command === 'xcrun' && args[0] === 'notarytool' && args[1] === 'log') return { stdout: JSON.stringify({ jobId: args[2], status: 'Accepted', issues: [] }), stderr: '' }
    return { stdout: '', stderr: '' }
  }
  return { commands, run }
}

const signContext = (outputDir, subdir, platform = 'darwin') => ({
  electronPlatformName: platform,
  appOutDir: path.join(outputDir, subdir),
  outDir: outputDir,
  packager: { appInfo: { productFilename: PRODUCT, version: VERSION } }
})

const quietHook = (env, run, extra = {}) => ({ env, run, writeError: () => {}, writeNotaryLog: () => {}, log: () => {}, ...extra })

describe('afterSign hook: notarize each signed app before its DMG is built', () => {
  test('zips, submits, keeps the log, staples and validates the app it is called for', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner()
    const logs = []
    const progress = []
    const id = await mac.afterSign(signContext(outputDir, 'mac-arm64'), quietHook(APPLE_ENV, run, {
      writeNotaryLog: (file, contents) => logs.push({ file, contents }),
      log: (message) => progress.push(message)
    }))
    const app = appPath(outputDir, 'mac-arm64')
    assert.equal(id, 'id-Demo-arm64-zip')
    const steps = commands.map((c) => c.replace(/ --apple-id .*$/, ''))
    assert.equal(steps[0], `lipo -archs ${path.join(app, 'Contents', 'MacOS', PRODUCT)}`)
    assert.match(steps[1], new RegExp(`^ditto -c -k --keepParent ${app} .*/Demo-arm64\\.zip$`))
    assert.match(steps[2], /^xcrun notarytool submit .*\/Demo-arm64\.zip$/)
    assert.deepEqual(steps.slice(3), ['xcrun notarytool log id-Demo-arm64-zip', `xcrun stapler staple ${app}`, `xcrun stapler validate ${app}`])
    assert.deepEqual(logs, [{ file: path.join(outputDir, `${PRODUCT}-${VERSION}-mac-arm64.app.notary-log.json`), contents: JSON.stringify({ jobId: 'id-Demo-arm64-zip', status: 'Accepted', issues: [] }) }])
    assert.deepEqual(progress, [`[mac] notarizing arm64: ${app}`, '[mac] accepted arm64 (submission: id-Demo-arm64-zip)'])
  })

  test('does nothing for a Mac App Store build', async () => {
    const outputDir = buildOutput(['mas-universal'])
    const { commands, run } = notaryRunner()
    await mac.afterSign(signContext(outputDir, 'mas-universal', 'mas'), quietHook(APPLE_ENV, run))
    assert.deepEqual(commands, [])
  })

  test('fails without every Apple credential instead of skipping', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner()
    await assert.rejects(mac.afterSign(signContext(outputDir, 'mac'), quietHook({ APPLE_ID: 'a' }, run)), /APPLE_APP_SPECIFIC_PASSWORD/)
    assert.deepEqual(commands, [])
  })

  test('a rejected app fails the build with the original error, unstapled', async () => {
    const outputDir = buildOutput(BUILD_SUBDIRS)
    const { commands, run } = notaryRunner('arm64')
    await assert.rejects(mac.afterSign(signContext(outputDir, 'mac-arm64'), quietHook(APPLE_ENV, run)), { message: 'Apple notarization not accepted: Invalid (submission: id-Demo-arm64-zip)' })
    assert.equal(commands.some((c) => c.startsWith('xcrun stapler staple')), false)
  })
})

describe('DMG gate: which DMGs', () => {
  const layout = { productName: PRODUCT, version: VERSION, arches: ARCHES }

  test('selects exactly the expected DMG for each configured arch, in config order', () => {
    const files = ['/r/Demo-1.2.1-mac-x64.dmg', '/r/Demo-1.2.1-mac-arm64.dmg', '/r/Demo-1.2.1-mac-universal.dmg', '/r/Demo-1.2.1-mac-arm64.dmg.blockmap']
    assert.deepEqual(mac.selectDmgArtifacts(files, layout), ['/r/Demo-1.2.1-mac-universal.dmg', '/r/Demo-1.2.1-mac-arm64.dmg', '/r/Demo-1.2.1-mac-x64.dmg'])
  })

  test('a missing DMG fails before any submission', () => {
    assert.throws(() => mac.selectDmgArtifacts(['/r/Demo-1.2.1-mac-arm64.dmg', '/r/Demo-1.2.1-mac-universal.dmg'], layout), { message: 'missing DMG for x64: Demo-1.2.1-mac-x64.dmg' })
  })

  test('a leftover DMG (another version, another name) fails rather than slipping past', () => {
    const files = ['/r/Demo-1.2.1-mac-x64.dmg', '/r/Demo-1.2.1-mac-arm64.dmg', '/r/Demo-1.2.1-mac-universal.dmg', '/r/Demo-1.2.0-mac-arm64.dmg']
    assert.throws(() => mac.selectDmgArtifacts(files, layout), { message: 'unexpected DMG: Demo-1.2.0-mac-arm64.dmg' })
  })

  test('the app inside a mounted DMG is looked up by the product name', () => {
    const mountPoint = buildOutput([])
    fs.mkdirSync(path.join(mountPoint, `${PRODUCT}.app`))
    assert.equal(mac.findMountedApp(mountPoint, PRODUCT), path.join(mountPoint, `${PRODUCT}.app`))
    assert.throws(() => mac.findMountedApp(mountPoint, 'Other'), { message: `no Other.app in the mounted DMG: ${mountPoint}` })
  })
})

describe('DMG gate: signature and Apple results', () => {
  test('accepts a Developer ID Application DMG with the right Team ID and a secure timestamp', () => {
    assert.doesNotThrow(() => mac.assertDmgSignature(DMG_SIGNED, 'TEAM123456'))
  })

  for (const [name, output, message] of [
    ['no Developer ID Application authority', 'Timestamp=Jul 21, 2026 at 16:14:39\nTeamIdentifier=TEAM123456', 'DMG is not signed by a Developer ID Application identity'],
    ['another Team ID', DMG_OTHER_TEAM, 'DMG Team ID does not match: expected TEAM123456'],
    ['the timestamp turned off', 'Authority=Developer ID Application: X (TEAM123456)\nTimestamp=none\nTeamIdentifier=TEAM123456', 'DMG signature has no secure timestamp']
  ]) {
    test(`refuses a DMG with ${name}`, () => {
      assert.throws(() => mac.assertDmgSignature(output, 'TEAM123456'), { message })
    })
  }

  test('an Accepted log must belong to this submission and carry no error', () => {
    assert.deepEqual(mac.parseAcceptedLog(JSON.stringify({ jobId: 'ABC-1', status: 'Accepted', issues: null }), 'abc-1').issues, [])
    assert.throws(() => mac.parseAcceptedLog(JSON.stringify({ jobId: 'other', status: 'Accepted', issues: [] }), 'abc-1'), { message: 'Apple notarization log is for another submission: expected abc-1' })
    assert.throws(() => mac.parseAcceptedLog(JSON.stringify({ jobId: 'abc-1', status: 'Accepted', issues: [{ severity: 'error' }] }), 'abc-1'), { message: 'Apple notarization log has 1 error-level issue(s)' })
  })

  test('a submission must be Accepted with an id, and malformed output never passes', () => {
    assert.equal(mac.parseAcceptedSubmission(JSON.stringify({ id: 'abc', status: 'Accepted' })), 'abc')
    assert.throws(() => mac.parseAcceptedSubmission(JSON.stringify({ id: 'bad', status: 'Invalid' })), { message: 'Apple notarization not accepted: Invalid (submission: bad)' })
    assert.throws(() => mac.parseAcceptedSubmission('{"status":"Accepted"}'), { message: 'Apple notarization response has no submission id' })
    assert.throws(() => mac.parseAcceptedSubmission('service unavailable'), SyntaxError)
  })
})

describe('DMG gate: one DMG', () => {
  const options = (run, extra = {}) => ({
    credentials: { appleId: 'a@example.com', password: 'p', teamId: 'TEAM123456' },
    findApp: (mountPoint) => path.join(mountPoint, `${PRODUCT}.app`),
    makeMountPoint: () => '/tmp/mount point',
    removeMountPoint: () => {},
    run,
    writeError: () => {},
    writeNotaryLog: () => {},
    ...extra
  })

  test('runs verify → submit → log → staple → Gatekeeper → the app inside, then detaches and removes the mount point', () => {
    const { commands, run } = notaryRunner()
    const logs = []
    const removed = []
    const id = mac.notarizeDmg('/r/Demo 1.2.1-mac-arm64.dmg', options(run, {
      writeNotaryLog: (file, contents) => { commands.push('notary-log-kept'); logs.push({ file, contents }) },
      removeMountPoint: (mountPoint) => { commands.push('mount-point-removed'); removed.push(mountPoint) }
    }))
    assert.equal(id, 'id-Demo-1-2-1-mac-arm64-dmg')
    assert.deepEqual(commands.map((c) => c.split(' ').slice(0, 3).join(' ')), [
      'hdiutil verify /r/Demo', 'codesign --verify --verbose=4', 'codesign --display --verbose=4',
      'xcrun notarytool submit', 'xcrun notarytool log', 'notary-log-kept', 'xcrun stapler staple', 'xcrun stapler validate',
      'hdiutil verify /r/Demo', 'spctl --assess --type', 'hdiutil attach -readonly', 'codesign --verify --deep',
      'xcrun stapler validate', 'hdiutil detach /tmp/mount', 'mount-point-removed'
    ])
    assert.ok(commands.includes('xcrun stapler validate /tmp/mount point/Demo.app'))
    // Apple's log is kept unmodified next to the DMG it belongs to
    assert.deepEqual(logs, [{ file: '/r/Demo 1.2.1-mac-arm64.dmg.notary-log.json', contents: JSON.stringify({ jobId: 'id-Demo-1-2-1-mac-arm64-dmg', status: 'Accepted', issues: [] }) }])
    assert.deepEqual(removed, ['/tmp/mount point'])
  })

  test('a DMG without a secure timestamp fails before it is submitted', () => {
    const commands = []
    const run = (command, args) => {
      commands.push(`${command} ${args.slice(0, 2).join(' ')}`)
      if (command === 'codesign' && args[0] === '--display') return { stdout: '', stderr: 'Authority=Developer ID Application: X (TEAM123456)\nTeamIdentifier=TEAM123456' }
      return { stdout: '', stderr: '' }
    }
    assert.throws(() => mac.notarizeDmg('/r/Demo-1.2.1-mac-arm64.dmg', options(run)), { message: 'DMG signature has no secure timestamp' })
    assert.equal(commands.includes('xcrun notarytool submit'), false)
  })

  test('a rejection fetches the log for diagnosis but throws the original error', () => {
    const errors = []
    const { commands, run } = notaryRunner('x64')
    assert.throws(() => mac.notarizeDmg('/r/Demo-1.2.1-mac-x64.dmg', options(run, { writeError: (message) => errors.push(message) })), {
      message: 'Apple notarization not accepted: Invalid (submission: id-Demo-1-2-1-mac-x64-dmg)'
    })
    assert.ok(commands.some((c) => c.startsWith('xcrun notarytool log id-Demo-1-2-1-mac-x64-dmg')))
    // The log body itself reaches the diagnostics
    assert.deepEqual(errors, [JSON.stringify({ jobId: 'id-Demo-1-2-1-mac-x64-dmg', status: 'Accepted', issues: [] })])
  })

  test('a failure inside the mounted image still detaches (forcing if needed), and cleanup never hides the cause', () => {
    const commands = []
    let removed = false
    const { run: inner } = notaryRunner()
    const run = (command, args) => {
      commands.push(`${command} ${args.join(' ')}`)
      if (command === 'codesign' && args.includes('--deep')) throw new Error('codesign failed')
      if (command === 'hdiutil' && args[0] === 'detach' && args[1] !== '-force') throw new Error('device busy')
      return inner(command, args)
    }
    assert.throws(() => mac.notarizeDmg('/r/Demo-1.2.1-mac-universal.dmg', options(run, { removeMountPoint: () => { removed = true } })), { message: 'codesign failed' })
    assert.ok(commands.includes('hdiutil detach -force /tmp/mount point'))
    assert.equal(removed, true)
  })
})

describe('command line', () => {
  test('an unknown subcommand prints the usage', () => {
    assert.throws(() => mac.main(['dmg']), { message: 'usage: node <path>/mac-packaging.cjs <local|release|notarize-dmg>' })
  })

  test('outside the project root it says so instead of guessing', () => {
    const elsewhere = tempDir()
    assert.throws(() => mac.main(['local'], {}, elsewhere), { message: `run from the project root: no electron-builder.yml in ${elsewhere}` })
  })
})

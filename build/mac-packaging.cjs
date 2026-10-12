#!/usr/bin/env node
// macOS packaging (docs/specs/mac-distribution.md): one electron-builder call builds and signs every configured
// arch's .app and DMG. The release profile adds this file as the afterSign hook, which notarizes and staples each
// .app before its DMG is built; the DMGs are then gated by build/notarize-dmgs.cjs (mac:notarize-dmg).
// Run through the package scripts (pnpm run dist:mac:local / dist:mac:release): the build calls electron-vite and
// electron-builder by name, which resolve from node_modules/.bin only there.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const YAML = require('yaml')
const { spawnSync } = require('node:child_process')
const { assertDmgSignature, readCredentials, runCommand, submitForNotarization } = require('./notarize-dmgs.cjs')

const KNOWN_ARCHES = ['arm64', 'x64', 'universal']

/** The architectures of the macOS DMG target in electron-builder.yml, in config order. */
function configuredArches(configText) {
  const config = YAML.parse(configText)
  const targets = config?.mac?.target ?? []
  const dmg = targets.find((entry) => entry?.target === 'dmg')
  const arches = dmg?.arch ?? []
  if (arches.length === 0) throw new Error('electron-builder.yml has no mac dmg target with an arch list')
  const unknown = arches.filter((arch) => !KNOWN_ARCHES.includes(arch))
  if (unknown.length > 0) throw new Error(`unsupported mac arch in electron-builder.yml: ${unknown.join(', ')}`)
  if (new Set(arches).size !== arches.length) throw new Error('electron-builder.yml lists a mac arch twice')
  return arches
}

/** The valid "Developer ID Application" identities in `security find-identity -v -p codesigning` output. */
function developerIdIdentities(output) {
  return [...output.matchAll(/^\s*\d+\) [0-9A-F]{40} "(Developer ID Application: [^"]+)"$/gm)].map((m) => m[1])
}

/**
 * Where the Developer ID certificate comes from, or an error when there is none (no unsigned build exists).
 * CI provides CSC_LINK, which electron-builder imports into a temporary keychain itself, so it is not in the
 * login keychain yet. Locally the identity must already be in the keychain. -v lists only valid identities, as
 * electron-builder's own lookup does, so an identity with a broken trust chain counts as missing.
 */
function certificateSource(env, run) {
  if (env.CSC_LINK && env.CSC_LINK.trim() !== '') return 'CSC_LINK'
  const listing = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const found = developerIdIdentities(listing.stdout)
  if (found.length === 0) {
    throw new Error(
      'no valid "Developer ID Application" signing identity in the keychain, and CSC_LINK is not set.\n' +
        'Every macOS package is signed with it: install the certificate (locally) or configure the CSC_LINK secret (CI).\n' +
        'To also list identities that are present but not trusted (for example a missing intermediate certificate):\n' +
        '  security find-identity -v'
    )
  }
  return `keychain: ${found[0]}`
}

/** `lipo -archs` output → the electron-builder arch name */
function archFromLipo(output) {
  const found = output.trim().split(/\s+/).sort().join(' ')
  if (found === 'arm64') return 'arm64'
  if (found === 'x86_64') return 'x64'
  if (found === 'arm64 x86_64') return 'universal'
  throw new Error(`unexpected binary architectures: ${output.trim() || '(none)'}`)
}

/** The arch of one built app, read from its main binary */
function appArch(app, productName, run) {
  return archFromLipo(run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', productName)]).stdout)
}

/**
 * The built `<productName>.app` for every configured arch, in config order.
 *
 * Located from the build output rather than from guessed paths: x64 builds into `mac/` and the other
 * architectures into `mac-<arch>/`. Each app's arch is read from its main binary, and the set must match the
 * config exactly, so a missing, duplicated or leftover app fails here instead of being shipped.
 */
function findBuiltApps({ outputDir, productName, arches, run }) {
  const candidates = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'mac' || entry.name.startsWith('mac-')))
      .map((entry) => path.join(outputDir, entry.name, `${productName}.app`))
      .filter((app) => fs.existsSync(app))
    : []
  if (candidates.length === 0) {
    throw new Error(`no built ${productName}.app under ${outputDir}; the build produced nothing`)
  }

  const byArch = new Map()
  for (const app of candidates) {
    const arch = appArch(app, productName, run)
    if (!arches.includes(arch)) throw new Error(`built app for an arch the config does not list (${arch}): ${app}`)
    if (byArch.has(arch)) throw new Error(`two built apps for ${arch}: ${byArch.get(arch)} and ${app}`)
    byArch.set(arch, app)
  }
  const missing = arches.filter((arch) => !byArch.has(arch))
  if (missing.length > 0) throw new Error(`no built app for ${missing.join(', ')} under ${outputDir}`)
  return arches.map((arch) => ({ arch, app: byArch.get(arch) }))
}

/**
 * Fails unless `codesign --display` output names a Developer ID Application authority. electron-builder skips
 * signing without an error when it finds no identity, so a build is never trusted to have signed.
 */
function assertDeveloperIdSigned(output, app) {
  const lines = output.split(/\r?\n/)
  if (!lines.some((line) => line.startsWith('Authority=Developer ID Application:'))) {
    throw new Error(`not signed with a Developer ID Application identity: ${app}`)
  }
}

/** The TeamIdentifier field of `codesign --display` output */
function teamIdentifier(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith('TeamIdentifier='))
  return line ? line.slice('TeamIdentifier='.length).trim() : null
}

/** The notarization log kept next to the version's artifacts for one arch's app */
function appNotaryLogFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.app.notary-log.json`)
}

/** The DMG electron-builder writes for one arch (dmg.artifactName in electron-builder.yml) */
function dmgFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.dmg`)
}

// Passed as -c.afterSign in the release profile; electron-builder takes this module's `afterSign` export
const HOOK = 'build/mac-packaging.cjs'

/**
 * One electron-builder call builds and signs every configured arch's .app and DMG, the way the builder is meant to
 * be used, so everything it does inside a single build (app-update.yml, for one) still happens. Built-in
 * notarization stays off; the release profile notarizes each .app through the afterSign hook instead, after signing
 * and before that arch's DMG is built. Signatures, and in release the stapled tickets, are confirmed on the result.
 */
function packageMac({ profile, env, run, outputDir, productName, version, arches }) {
  if (profile !== 'local' && profile !== 'release') throw new Error(`unknown profile: ${profile}`)
  const release = profile === 'release'
  // Both checks come before the build: the hook would otherwise fail only after minutes of packing
  if (release) readCredentials(env)
  certificateSource(env, run)

  // Anything an earlier run left must not pass for this run's output: the builder could fail to write a DMG
  // without an error, a local package must never sit next to a log claiming it was notarized, and a leftover
  // app (a crashed universal build leaves <outDir>-<arch>-temp) must be gone before the hook submits anything.
  // Only this build's own mac/ and mac-*/ outputs are cleared; Mac App Store output (mas-*) is left alone
  if (fs.existsSync(outputDir)) {
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'mac' || entry.name.startsWith('mac-'))) {
        fs.rmSync(path.join(outputDir, entry.name), { recursive: true, force: true })
      }
    }
  }
  for (const arch of arches) {
    const dmg = dmgFile(outputDir, productName, version, arch)
    fs.rmSync(appNotaryLogFile(outputDir, productName, version, arch), { force: true })
    fs.rmSync(dmg, { force: true })
    fs.rmSync(`${dmg}.notary-log.json`, { force: true })
  }

  run('electron-vite', ['build'])
  run('electron-builder', [
    '--mac', '--publish', 'never', '-c.mac.notarize=false',
    ...(release ? [`-c.afterSign=${HOOK}`] : [])
  ])

  const apps = findBuiltApps({ outputDir, productName, arches, run })
  const teams = new Map()
  for (const { arch, app } of apps) {
    const display = run('codesign', ['--display', '--verbose=4', app])
    const output = [display.stdout, display.stderr].join('\n')
    assertDeveloperIdSigned(output, app)
    teams.set(arch, teamIdentifier(output))
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    // In release every app must leave the build stapled; a hook that never ran would leave it bare
    if (release) run('xcrun', ['stapler', 'validate', app])
  }

  // DMG signing writes no log line, so each DMG's signature is checked against the team of the app inside it
  const dmgs = arches.map((arch) => {
    const dmg = dmgFile(outputDir, productName, version, arch)
    if (!fs.existsSync(dmg)) throw new Error(`no DMG for ${arch} after the build: ${dmg}`)
    run('codesign', ['--verify', '--verbose=4', dmg])
    const display = run('codesign', ['--display', '--verbose=4', dmg])
    assertDmgSignature([display.stdout, display.stderr].join('\n'), teams.get(arch))
    return dmg
  })
  return { apps, dmgs }
}

/**
 * The afterSign hook: notarize and staple the .app electron-builder has just signed, before its DMG is built — a
 * DMG made from an app without its own ticket cannot get one afterwards, and the app is what users drag out.
 * Mac App Store builds are not notarized here. Missing credentials fail the build rather than skip.
 */
async function afterSign(context, deps = {}) {
  if (context.electronPlatformName !== 'darwin') return undefined
  const {
    env = process.env,
    run = runCommand,
    writeError = (message) => console.error(`[mac] Apple log:\n${message}`),
    writeNotaryLog = (file, contents) => fs.writeFileSync(file, contents),
    log = (message) => console.log(message)
  } = deps
  const credentials = readCredentials(env)
  const { productFilename, version } = context.packager.appInfo
  const app = path.join(context.appOutDir, `${productFilename}.app`)
  const arch = appArch(app, productFilename, run)

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-notarize-app-'))
  try {
    // Each submission waits on Apple for minutes; say which app is being waited on
    log(`[mac] notarizing ${arch}: ${app}`)
    // notarytool takes an archive, not a bundle; --keepParent keeps the .app as the archive's root
    const zip = path.join(workDir, `${productFilename}-${arch}.zip`)
    run('ditto', ['-c', '-k', '--keepParent', app, zip])
    const { submissionId, log: notaryLog } = submitForNotarization(zip, { credentials, run, writeError })
    writeNotaryLog(appNotaryLogFile(context.outDir, productFilename, version, arch), notaryLog)
    run('xcrun', ['stapler', 'staple', app])
    run('xcrun', ['stapler', 'validate', app])
    log(`[mac] accepted ${arch} (submission: ${submissionId})`)
    return submissionId
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

/** Product name, version, versioned output directory and arches, from electron-builder.yml and package.json */
function resolveLayout(configText, packageJsonText) {
  const config = YAML.parse(configText)
  const { version } = JSON.parse(packageJsonText)
  const output = config?.directories?.output
  if (typeof output !== 'string') throw new Error('electron-builder.yml has no directories.output')
  const outputDir = output.split('${version}').join(version)
  if (outputDir.includes('${')) throw new Error(`directories.output may only use \${version}: ${output}`)
  return { productName: config.productName, version, outputDir, arches: configuredArches(configText) }
}

// Build commands stream their progress to the terminal; every other command's output is captured for checks
const STREAMED = new Set(['electron-vite', 'electron-builder'])

function runStep(command, args) {
  if (!STREAMED.has(command)) return runCommand(command, args)
  console.log(`[mac] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`)
  return { stdout: '', stderr: '' }
}

function main(argv, env = process.env) {
  const profile = argv[0]
  if (profile !== 'local' && profile !== 'release') throw new Error('usage: node build/mac-packaging.cjs <local|release>')
  const root = path.join(__dirname, '..')
  const layout = resolveLayout(
    fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'),
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  )
  const result = packageMac({ profile, env, run: runStep, ...layout, outputDir: path.join(root, layout.outputDir) })
  console.log(`[mac] ${profile} packaging done for ${layout.arches.join(', ')}`)
  return result
}

module.exports = {
  afterSign,
  certificateSource,
  configuredArches,
  findBuiltApps,
  packageMac,
  resolveLayout
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[mac] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

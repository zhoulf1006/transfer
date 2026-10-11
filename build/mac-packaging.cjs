#!/usr/bin/env node
// The macOS packaging steps (docs/specs/mac-distribution.md): mac:sign, mac:notarize-app and mac:dmg;
// mac:notarize-dmg is build/notarize-dmgs.cjs. Run them through the package scripts (pnpm run mac:sign, ...):
// the build steps call electron-vite and electron-builder by name, which resolve from node_modules/.bin only there.

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

/**
 * The built `<productName>.app` for every configured arch, in config order.
 *
 * Located from the build output rather than from guessed paths: `--dir` writes x64 to `mac/` and the other
 * architectures to `mac-<arch>/`. Each app's arch is read from its main binary, and the set must match the
 * config exactly, so a missing, duplicated or leftover app fails here instead of being packaged.
 */
function findBuiltApps({ outputDir, productName, arches, run }) {
  const candidates = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'mac' || entry.name.startsWith('mac-')))
      .map((entry) => path.join(outputDir, entry.name, `${productName}.app`))
      .filter((app) => fs.existsSync(app))
    : []
  if (candidates.length === 0) {
    throw new Error(`no built ${productName}.app under ${outputDir}; run mac:sign first`)
  }

  const byArch = new Map()
  for (const app of candidates) {
    const arch = archFromLipo(run('lipo', ['-archs', path.join(app, 'Contents', 'MacOS', productName)]).stdout)
    if (!arches.includes(arch)) throw new Error(`built app for an arch the config does not list (${arch}): ${app}`)
    if (byArch.has(arch)) throw new Error(`two built apps for ${arch}: ${byArch.get(arch)} and ${app}`)
    byArch.set(arch, app)
  }
  const missing = arches.filter((arch) => !byArch.has(arch))
  if (missing.length > 0) throw new Error(`no built app for ${missing.join(', ')} under ${outputDir}; run mac:sign first`)
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

/**
 * mac:sign — check the certificate source, build and sign every configured arch's .app (no DMG, built-in
 * notarization off), then confirm each app's signature on the result.
 */
function signApps({ env, run, outputDir, productName, version, arches }) {
  certificateSource(env, run)
  // Logs from an earlier run would describe apps this run is about to replace
  for (const arch of arches) fs.rmSync(appNotaryLogFile(outputDir, productName, version, arch), { force: true })
  run('electron-vite', ['build'])
  run('electron-builder', ['--mac', 'dir', ...arches.map((arch) => `--${arch}`), '--publish', 'never', '-c.mac.notarize=false'])
  const apps = findBuiltApps({ outputDir, productName, arches, run })
  for (const { app } of apps) {
    const display = run('codesign', ['--display', '--verbose=4', app])
    assertDeveloperIdSigned([display.stdout, display.stderr].join('\n'), app)
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  }
  return apps
}

/** The notarization log kept next to the version's artifacts for one arch's app */
function appNotaryLogFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.app.notary-log.json`)
}

/**
 * mac:notarize-app — notarize and staple each signed app before any DMG is built: a DMG made from an app
 * without its own ticket cannot get one afterwards, and the app is what users drag out of the DMG.
 */
function notarizeApps({ env, run, outputDir, productName, version, arches, writeError, writeNotaryLog, log = () => {} }) {
  const credentials = readCredentials(env)
  const apps = findBuiltApps({ outputDir, productName, arches, run })
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-notarize-app-'))
  try {
    return apps.map(({ arch, app }) => {
      // notarytool takes an archive, not a bundle; --keepParent keeps Transfer.app as the archive's root
      const zip = path.join(workDir, `${productName}-${arch}.zip`)
      // Each submission waits on Apple for minutes; say which app is being waited on
      log(`[mac] notarizing ${arch}: ${app}`)
      run('ditto', ['-c', '-k', '--keepParent', app, zip])
      const { submissionId, log: notaryLog } = submitForNotarization(zip, { credentials, run, writeError })
      writeNotaryLog(appNotaryLogFile(outputDir, productName, version, arch), notaryLog)
      log(`[mac] accepted ${arch} (submission: ${submissionId})`)
      run('xcrun', ['stapler', 'staple', app])
      run('xcrun', ['stapler', 'validate', app])
      return submissionId
    })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

/** The DMG electron-builder writes for one arch (dmg.artifactName in electron-builder.yml) */
function dmgFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.dmg`)
}

/** The TeamIdentifier field of `codesign --display` output */
function teamIdentifier(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith('TeamIdentifier='))
  return line ? line.slice('TeamIdentifier='.length).trim() : null
}

/**
 * mac:dmg — build each arch's DMG from its existing app. --prepackaged skips packing and therefore signing
 * and built-in notarization, so a stapled app keeps its signature and ticket. DMG signing writes no log line,
 * so each DMG's signature is checked here against the team that signed the app inside it.
 */
function buildDmgs({ run, outputDir, productName, version, arches }) {
  const apps = findBuiltApps({ outputDir, productName, arches, run })
  // A DMG or log left by an earlier run must not pass for this run's output: the builder could fail to
  // write a DMG without an error, and a local DMG must never sit next to a log claiming it was notarized
  for (const { arch } of apps) {
    const dmg = dmgFile(outputDir, productName, version, arch)
    fs.rmSync(dmg, { force: true })
    fs.rmSync(`${dmg}.notary-log.json`, { force: true })
  }
  for (const { arch, app } of apps) {
    run('electron-builder', ['--mac', 'dmg', `--${arch}`, '--prepackaged', app, '--publish', 'never', '-c.mac.notarize=false'])
  }
  return apps.map(({ arch, app }) => {
    const dmg = dmgFile(outputDir, productName, version, arch)
    if (!fs.existsSync(dmg)) throw new Error(`no DMG for ${arch} after the build: ${dmg}`)
    const appDisplay = run('codesign', ['--display', '--verbose=4', app])
    const team = teamIdentifier([appDisplay.stdout, appDisplay.stderr].join('\n'))
    run('codesign', ['--verify', '--verbose=4', dmg])
    const dmgDisplay = run('codesign', ['--display', '--verbose=4', dmg])
    assertDmgSignature([dmgDisplay.stdout, dmgDisplay.stderr].join('\n'), team)
    return dmg
  })
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

const STEPS = {
  sign: (options) => signApps(options),
  'notarize-app': (options) => notarizeApps({
    ...options,
    writeError: (message) => console.error(`[mac] Apple log:\n${message}`),
    writeNotaryLog: (file, contents) => fs.writeFileSync(file, contents),
    log: (message) => console.log(message)
  }),
  dmg: (options) => buildDmgs(options)
}

function main(argv, env = process.env) {
  const step = STEPS[argv[0]]
  if (!step) throw new Error(`usage: node build/mac-packaging.cjs <${Object.keys(STEPS).join('|')}>`)
  const root = path.join(__dirname, '..')
  const layout = resolveLayout(
    fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'),
    fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  )
  const result = step({ env, run: runStep, ...layout, outputDir: path.join(root, layout.outputDir) })
  console.log(`[mac] ${argv[0]} done for ${layout.arches.join(', ')}`)
  return result
}

module.exports = {
  buildDmgs,
  certificateSource,
  configuredArches,
  findBuiltApps,
  notarizeApps,
  resolveLayout,
  signApps
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[mac] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

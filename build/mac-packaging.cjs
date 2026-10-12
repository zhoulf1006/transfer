#!/usr/bin/env node
// macOS Developer ID packaging for electron-builder projects (electron-scaffold's macos-signing.md, section 3).
//
//   node build/mac-packaging.cjs local          one builder call: sign every arch's .app and DMG, never notarize
//   node build/mac-packaging.cjs release        the same call plus this file as the afterSign hook, which notarizes
//                                               and staples each .app before its DMG is built
//   node build/mac-packaging.cjs notarize-dmg   the DMG gate: notarize, staple and verify every DMG
//
// Run from the project root through the package scripts: the build calls electron-vite and electron-builder by
// name, which resolve from node_modules/.bin only there. Requirements in electron-builder.yml: a mac `dmg` target
// with an arch list, `directories.output` using at most `${version}`, `mac.notarize: false`, and
// `dmg.artifactName: ${productName}-${version}-mac-${arch}.dmg` (checked at run time). The release profile and the
// DMG gate read APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; the certificate comes from the login
// keychain or, in CI, from CSC_LINK. The YAML parser is the js-yaml that electron-builder itself depends on.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const KNOWN_ARCHES = ['arm64', 'x64', 'universal']
const DMG_ARTIFACT_NAME = '${productName}-${version}-mac-${arch}.dmg'

/**
 * The js-yaml electron-builder depends on, resolved through electron-builder's own dependency tree so the project
 * needs no YAML parser of its own. `resolve` is injectable for tests.
 */
function yamlParser(resolve = require.resolve) {
  try {
    const builderLib = path.dirname(resolve('app-builder-lib/package.json', { paths: [path.dirname(resolve('electron-builder/package.json'))] }))
    return require(resolve('js-yaml', { paths: [builderLib] }))
  } catch (error) {
    throw new Error(
      'cannot load js-yaml through electron-builder (electron-builder → app-builder-lib → js-yaml); ' +
        `is electron-builder installed? (${error instanceof Error ? error.message : String(error)})`
    )
  }
}

/** The architectures of the macOS DMG target in electron-builder.yml, in config order. */
function configuredArches(config) {
  const targets = config?.mac?.target ?? []
  const dmg = Array.isArray(targets) ? targets.find((entry) => entry?.target === 'dmg') : null
  const arches = dmg?.arch ?? []
  if (arches.length === 0) throw new Error('electron-builder.yml has no mac dmg target with an arch list')
  const unknown = arches.filter((arch) => !KNOWN_ARCHES.includes(arch))
  if (unknown.length > 0) throw new Error(`unsupported mac arch in electron-builder.yml: ${unknown.join(', ')}`)
  if (new Set(arches).size !== arches.length) throw new Error('electron-builder.yml lists a mac arch twice')
  return arches
}

/**
 * Product name, version, versioned output directory (relative to the project root) and arches, from the parsed
 * electron-builder.yml and package.json text. The DMG naming is required, not reproduced: electron-builder's
 * default pattern drops the arch for the default architecture, so a file name could not be mapped back to its arch.
 */
function resolveLayout(config, packageJsonText) {
  const { version } = JSON.parse(packageJsonText)
  const output = config?.directories?.output
  if (typeof output !== 'string') throw new Error('electron-builder.yml has no directories.output')
  const outputDir = output.split('${version}').join(version)
  if (outputDir.includes('${')) throw new Error(`directories.output may only use \${version}: ${output}`)
  if (config?.dmg?.artifactName !== DMG_ARTIFACT_NAME) {
    throw new Error(`electron-builder.yml must set dmg.artifactName: ${DMG_ARTIFACT_NAME} (found: ${config?.dmg?.artifactName ?? 'nothing'})`)
  }
  if (typeof config.productName !== 'string' || config.productName === '') throw new Error('electron-builder.yml has no productName')
  return { productName: config.productName, version, outputDir, arches: configuredArches(config) }
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

function readCredentials(env) {
  const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const missing = required.filter((name) => !env[name])
  if (missing.length > 0) throw new Error(`missing Apple notarization credentials: ${missing.join(', ')}`)
  return { appleId: env.APPLE_ID, password: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID }
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

/** A DMG's signature: Developer ID Application authority, the expected Team ID, a secure timestamp */
function assertDmgSignature(output, teamId) {
  const lines = output.split(/\r?\n/)
  if (!lines.some((line) => line.startsWith('Authority=Developer ID Application:'))) {
    throw new Error('DMG is not signed by a Developer ID Application identity')
  }
  if (!lines.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error(`DMG Team ID does not match: expected ${teamId}`)
  }
  if (!lines.some((line) => line.startsWith('Timestamp=') && !['', 'none'].includes(line.slice('Timestamp='.length).trim().toLowerCase()))) {
    throw new Error('DMG signature has no secure timestamp')
  }
}

/** The notarization log kept next to the version's artifacts for one arch's app */
function appNotaryLogFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.app.notary-log.json`)
}

/** The DMG electron-builder writes for one arch, given the required dmg.artifactName */
function dmgFile(outputDir, productName, version, arch) {
  return path.join(outputDir, `${productName}-${version}-mac-${arch}.dmg`)
}

function parseAcceptedSubmission(stdout) {
  const result = JSON.parse(stdout)
  if (result.status !== 'Accepted') {
    const submission = result.id ? ` (submission: ${result.id})` : ''
    throw new Error(`Apple notarization not accepted: ${result.status ?? 'unknown status'}${submission}`)
  }
  if (typeof result.id !== 'string' || result.id.length === 0) {
    throw new Error('Apple notarization response has no submission id')
  }
  return result.id
}

function parseAcceptedLog(stdout, submissionId) {
  const result = JSON.parse(stdout)
  if (typeof result.jobId !== 'string' || result.jobId.toLowerCase() !== submissionId.toLowerCase()) {
    throw new Error(`Apple notarization log is for another submission: expected ${submissionId}`)
  }
  if (result.status !== 'Accepted') {
    throw new Error(`Apple notarization log status is not Accepted: ${result.status ?? 'unknown status'}`)
  }
  const issues = Array.isArray(result.issues) ? result.issues : []
  const errors = issues.filter((issue) => issue?.severity === 'error')
  if (errors.length > 0) {
    throw new Error(`Apple notarization log has ${errors.length} error-level issue(s)`)
  }
  return { ...result, issues }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} failed (exit ${result.status})${output ? `\n${output}` : ''}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Submits one file to Apple and waits; returns the submission id and its Accepted log (raw JSON). A rejection
 * fetches the log for diagnosis, but a failure to fetch it never replaces the original error.
 */
function submitForNotarization(file, { credentials, run, writeError }) {
  const auth = ['--apple-id', credentials.appleId, '--password', credentials.password, '--team-id', credentials.teamId]
  const submission = run('xcrun', ['notarytool', 'submit', file, ...auth, '--wait', '--output-format', 'json'])
  let submissionId
  try {
    submissionId = parseAcceptedSubmission(submission.stdout)
  } catch (error) {
    let rejectedId = null
    try {
      rejectedId = JSON.parse(submission.stdout).id ?? null
    } catch {
      // A malformed response has no submission id to fetch a log for; the parse error stands.
    }
    if (rejectedId) {
      try {
        const log = run('xcrun', ['notarytool', 'log', rejectedId, ...auth, '--output-format', 'json'])
        writeError(log.stdout || log.stderr)
      } catch {
        // The log is diagnostics only; failing to fetch it must not replace the rejection.
      }
    }
    throw error
  }
  const acceptedLog = run('xcrun', ['notarytool', 'log', submissionId, ...auth, '--output-format', 'json'])
  parseAcceptedLog(acceptedLog.stdout, submissionId)
  return { submissionId, log: acceptedLog.stdout }
}

/**
 * One electron-builder call builds and signs every configured arch's .app and DMG, the way the builder is meant to
 * be used, so everything it does inside a single build (app-update.yml, for one) still happens. Built-in
 * notarization stays off; the release profile notarizes each .app through the afterSign hook instead, after signing
 * and before that arch's DMG is built. Signatures, and in release the stapled tickets, are confirmed on the result.
 */
function packageMac({ profile, env, run, outputDir, productName, version, arches, hookPath }) {
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
    ...(release ? [`-c.afterSign=${hookPath}`] : [])
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

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-notarize-app-'))
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

/**
 * The DMGs to gate, in config order: every `.dmg` in the version directory must be one of the expected names
 * (one per configured arch), and every expected name must be there — a leftover or a missing DMG fails before any
 * submission.
 */
function selectDmgArtifacts(files, { productName, version, arches }) {
  const expected = new Map(arches.map((arch) => [path.basename(dmgFile('', productName, version, arch)), arch]))
  const dmgs = files.filter((file) => file.endsWith('.dmg'))
  const unexpected = dmgs.filter((file) => !expected.has(path.basename(file)))
  if (unexpected.length > 0) throw new Error(`unexpected DMG: ${unexpected.map((file) => path.basename(file)).join(', ')}`)
  return arches.map((arch) => {
    const found = dmgs.find((file) => expected.get(path.basename(file)) === arch)
    if (!found) throw new Error(`missing DMG for ${arch}: ${path.basename(dmgFile('', productName, version, arch))}`)
    return found
  })
}

function makeMountPoint() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mac-dmg-'))
}

function removeMountPoint(mountPoint) {
  fs.rmSync(mountPoint, { recursive: true, force: true })
}

function findMountedApp(mountPoint, productName) {
  const appPath = path.join(mountPoint, `${productName}.app`)
  if (!fs.existsSync(appPath) || !fs.statSync(appPath).isDirectory()) {
    throw new Error(`no ${productName}.app in the mounted DMG: ${mountPoint}`)
  }
  return appPath
}

/** The DMG gate for one DMG: verify, check the signature, notarize, staple, assess, and check the app inside */
function notarizeDmg(file, options) {
  const {
    credentials,
    findApp,
    makeMountPoint: mount,
    removeMountPoint: unmount,
    run,
    writeError = console.error,
    writeNotaryLog = (logFile, contents) => fs.writeFileSync(logFile, contents)
  } = options
  run('hdiutil', ['verify', file])
  run('codesign', ['--verify', '--verbose=4', file])
  const signature = run('codesign', ['--display', '--verbose=4', file])
  assertDmgSignature([signature.stdout, signature.stderr].filter(Boolean).join('\n'), credentials.teamId)
  const { submissionId, log } = submitForNotarization(file, { credentials, run, writeError })
  writeNotaryLog(`${file}.notary-log.json`, log)

  run('xcrun', ['stapler', 'staple', file])
  run('xcrun', ['stapler', 'validate', file])
  run('hdiutil', ['verify', file])
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', file])

  const mountPoint = mount()
  let attached = false
  let operationError = null
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, file])
    attached = true
    const appPath = findApp(mountPoint)
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    // The app inside must carry its own ticket: users drag it out of the DMG, leaving the DMG's ticket behind,
    // and `spctl --assess` succeeds online by looking the ticket up, so only `stapler validate` tells them apart
    run('xcrun', ['stapler', 'validate', appPath])
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
      unmount(mountPoint)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (operationError) throw operationError
  if (cleanupError) throw cleanupError
  return submissionId
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

function main(argv, env = process.env, root = process.cwd()) {
  const command = argv[0]
  if (!['local', 'release', 'notarize-dmg'].includes(command)) {
    throw new Error('usage: node <path>/mac-packaging.cjs <local|release|notarize-dmg>')
  }
  const configFile = path.join(root, 'electron-builder.yml')
  if (!fs.existsSync(configFile)) throw new Error(`run from the project root: no electron-builder.yml in ${root}`)
  const layout = resolveLayout(yamlParser().load(fs.readFileSync(configFile, 'utf8')), fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const outputDir = path.join(root, layout.outputDir)

  if (command === 'notarize-dmg') {
    const credentials = readCredentials(env)
    const files = fs.readdirSync(outputDir).map((name) => path.join(outputDir, name))
    const ids = selectDmgArtifacts(files, layout).map((file) => {
      console.log(`[mac] gating ${file}`)
      const id = notarizeDmg(file, {
        credentials,
        findApp: (mountPoint) => findMountedApp(mountPoint, layout.productName),
        makeMountPoint,
        removeMountPoint,
        run: runCommand,
        writeError: (message) => console.error(`[mac] Apple log:\n${message}`)
      })
      console.log(`[mac] passed ${file} (submission: ${id})`)
      return id
    })
    console.log(`[mac] all ${layout.arches.join(', ')} DMGs passed: ${ids.join(', ')}`)
    return ids
  }

  // electron-builder resolves the hook relative to the project root, wherever this file was copied to
  const hookPath = path.relative(root, __filename)
  if (hookPath.startsWith('..') || path.isAbsolute(hookPath)) throw new Error(`this script must live inside the project: ${__filename}`)
  const result = packageMac({ profile: command, env, run: runStep, ...layout, outputDir, hookPath })
  console.log(`[mac] ${command} packaging done for ${layout.arches.join(', ')}`)
  return result
}

module.exports = {
  afterSign,
  assertDmgSignature,
  certificateSource,
  configuredArches,
  findBuiltApps,
  findMountedApp,
  main,
  notarizeDmg,
  packageMac,
  parseAcceptedLog,
  parseAcceptedSubmission,
  readCredentials,
  resolveLayout,
  selectDmgArtifacts,
  submitForNotarization,
  yamlParser
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`[mac] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

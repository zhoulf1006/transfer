// Transfer's side of the macOS packaging (docs/specs/mac-distribution.md).
//
// The packaging script and its behaviour tests are electron-scaffold's asset, copied unchanged into build/
// (mac-packaging.cjs, mac-packaging.test.cjs; the latter runs under node --test as part of `pnpm test`). This file
// checks only what is Transfer's own: that its builder config satisfies the script, and what the package scripts run.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)

const { resolveLayout, yamlParser } = require('../../build/mac-packaging.cjs') as {
  resolveLayout: (config: unknown, packageJsonText: string) => { productName: string; version: string; outputDir: string; arches: string[] }
  yamlParser: () => { load: (text: string) => unknown }
}

// Parsed the way the packaging script parses it at run time
const BUILDER_CONFIG = yamlParser().load(readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')) as {
  mac: { notarize: unknown }
}
const scripts = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>
}).scripts

describe('the builder config satisfies the packaging script', () => {
  test('product name, versioned output directory, DMG naming and the three architectures', () => {
    // resolveLayout refuses a config without the required DMG name pattern or with other output macros
    expect(resolveLayout(BUILDER_CONFIG, JSON.stringify({ name: 'transfer', version: '9.8.7' }))).toEqual({
      productName: 'Transfer',
      version: '9.8.7',
      outputDir: 'release/9.8.7',
      arches: ['universal', 'arm64', 'x64']
    })
  })

  test('built-in notarization is off', () => {
    // electron-builder notarizes whenever Apple credentials are loaded unless this is explicitly false
    expect(BUILDER_CONFIG.mac.notarize).toBe(false)
  })
})

describe('package scripts', () => {
  test('the two entries are named after their environment and run the packaging script', () => {
    expect(scripts['dist:mac:local']).toBe('node build/mac-packaging.cjs local')
    expect(scripts['dist:mac:release']).toBe('node build/mac-packaging.cjs release && node build/mac-packaging.cjs notarize-dmg')
  })

  test('the names that described mechanisms are gone, with no aliases', () => {
    for (const old of ['dist:mac', 'dist:mac:package-signed', 'notarize:mac:dmgs', 'dist:mac:sign', 'mac:sign', 'mac:notarize-app', 'mac:dmg', 'mac:notarize-dmg']) {
      expect(scripts[old], old).toBeUndefined()
    }
  })

  test('the packaging script\'s own tests run in the test gate, before vitest', () => {
    // pnpm appends arguments to the end of the script, so vitest must come last for `pnpm test <file>` to filter it
    expect(scripts.test).toMatch(/^node --test build\/mac-packaging\.test\.cjs && .* vitest run$/)
  })
})

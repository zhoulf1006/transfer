import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildAnalyticsPayload,
  buildSummary,
  collectStatistics,
  fetchAnalyticsRows,
  fetchGithubReleases,
  mergeGithubAssets,
  mergeR2Traffic,
  planQueryWindows,
  updateStatistics,
  validatePreviousState,
} = require('../../build/collect-download-statistics.cjs') as {
  mergeGithubAssets: (
    previous: Record<string, unknown>,
    releases: Array<Record<string, unknown>>,
  ) => Record<string, { name: string; os: 'mac' | 'win'; downloads: number }>
  mergeR2Traffic: (
    previous: Record<string, unknown>,
    inventory: Array<{ Key: string; Size: number }>,
    rows: Array<{ dimensions: { clientRequestPath: string }; sum: { edgeResponseBytes: number } }>,
  ) => Record<string, { name: string; os: 'mac' | 'win'; size: number; bytes: number }>
  buildSummary: (
    github: Record<string, { os: 'mac' | 'win'; downloads: number }>,
    r2: Record<string, { os: 'mac' | 'win'; size: number; bytes: number }>,
  ) => {
    total: number
    macos: number
    windows: number
    sources: { github: number; r2: number }
  }
  planQueryWindows: (cursor: string | null, now: string) => Array<{ start: string; end: string }>
  buildAnalyticsPayload: (
    zoneId: string,
    hostname: string,
    window: { start: string; end: string },
  ) => { query: string; variables: Record<string, unknown> }
  fetchGithubReleases: (
    fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<unknown>,
    repository: string,
    token: string,
  ) => Promise<Array<Record<string, unknown>>>
  fetchAnalyticsRows: (
    fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>,
    token: string,
    payload: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>
  updateStatistics: (
    previous: Record<string, unknown> | null,
    releases: Array<Record<string, unknown>>,
    inventory: Array<{ Key: string; Size: number }>,
    rows: Array<{ dimensions: { clientRequestPath: string }; sum: { edgeResponseBytes: number } }>,
    cursor: string,
    updatedAt: string,
  ) => Record<string, unknown>
  collectStatistics: (options: Record<string, unknown>) => Promise<Record<string, any>>
  validatePreviousState: (previous: unknown) => void
}

describe('mergeGithubAssets', () => {
  it('counts installer assets from public releases including prereleases', () => {
    const merged = mergeGithubAssets({}, [
      {
        draft: false,
        prerelease: false,
        tag_name: 'v1.0.0',
        assets: [
          { id: 11, name: 'Transfer-1.0.0-mac-arm64.dmg', download_count: 7 },
          { id: 12, name: 'checksums.txt', download_count: 99 },
          { id: 13, name: 'Unrelated-1.0.0.dmg', download_count: 40 },
        ],
      },
      {
        draft: false,
        prerelease: true,
        tag_name: 'v1.1.0-beta',
        assets: [
          { id: 21, name: 'Transfer-1.1.0-win-setup.exe', download_count: 3 },
        ],
      },
      {
        draft: true,
        prerelease: false,
        tag_name: 'v2.0.0',
        assets: [
          { id: 31, name: 'Transfer-2.0.0-mac-x64.dmg', download_count: 50 },
        ],
      },
    ])

    expect(merged).toEqual({
      '11': { name: 'Transfer-1.0.0-mac-arm64.dmg', os: 'mac', downloads: 7 },
      '21': { name: 'Transfer-1.1.0-win-setup.exe', os: 'win', downloads: 3 },
    })
  })

  it('keeps deleted assets and never decreases an observed download count', () => {
    const previous = {
      '11': { name: 'Transfer-1.0.0-mac-arm64.dmg', os: 'mac', downloads: 7 },
      '12': { name: 'Transfer-0.9.0-win-portable.exe', os: 'win', downloads: 4 },
    }

    const merged = mergeGithubAssets(previous, [
      {
        draft: false,
        assets: [
          { id: 11, name: 'Transfer-1.0.0-mac-arm64.dmg', download_count: 5 },
        ],
      },
    ])

    expect(merged).toEqual(previous)
  })

  it('rejects an invalid GitHub download count instead of corrupting the state', () => {
    expect(() => mergeGithubAssets({}, [{
      draft: false,
      assets: [{ id: 11, name: 'Transfer-1.0.0-mac-arm64.dmg', download_count: -1 }],
    }])).toThrow(/download count/i)
  })
})

describe('R2 equivalent downloads', () => {
  it('adds installer response bytes and combines them with GitHub counts', () => {
    const r2 = mergeR2Traffic(
      {},
      [
        { Key: 'releases/v1.0.0/Transfer-1.0.0-mac-arm64.dmg', Size: 100 },
        { Key: 'releases/v1.0.0/Transfer-1.0.0-win-setup.exe', Size: 200 },
        { Key: 'stats/downloads.json', Size: 500 },
      ],
      [
        {
          dimensions: { clientRequestPath: '/releases/v1.0.0/Transfer-1.0.0-mac-arm64.dmg' },
          sum: { edgeResponseBytes: 200 },
        },
        {
          dimensions: { clientRequestPath: '/releases/v1.0.0/Transfer-1.0.0-win-setup.exe' },
          sum: { edgeResponseBytes: 50 },
        },
        {
          dimensions: { clientRequestPath: '/stats/downloads.json' },
          sum: { edgeResponseBytes: 999 },
        },
      ],
    )

    expect(buildSummary(
      {
        '11': { os: 'mac', downloads: 3 },
        '21': { os: 'win', downloads: 4 },
      },
      r2,
    )).toEqual({
      total: 9.25,
      macos: 5,
      windows: 4.25,
      sources: { github: 7, r2: 2.25 },
    })
  })

  it('rejects replacing an existing R2 path with a different object size', () => {
    const key = 'releases/v1.0.0/Transfer-1.0.0-mac-arm64.dmg'
    expect(() => mergeR2Traffic(
      {
        [key]: {
          name: 'Transfer-1.0.0-mac-arm64.dmg',
          os: 'mac',
          size: 100,
          bytes: 200,
        },
      },
      [{ Key: key, Size: 101 }],
      [],
    )).toThrow(/size changed/i)
  })

  it('rejects a zero-byte installer because it cannot define an equivalent download', () => {
    expect(() => mergeR2Traffic(
      {},
      [{ Key: 'releases/v1.0.0/Transfer-1.0.0-mac-arm64.dmg', Size: 0 }],
      [],
    )).toThrow(/positive size/i)
  })

  it('rejects invalid response bytes instead of corrupting the state', () => {
    const key = 'releases/v1.0.0/Transfer-1.0.0-mac-arm64.dmg'
    expect(() => mergeR2Traffic(
      {},
      [{ Key: key, Size: 100 }],
      [{ dimensions: { clientRequestPath: `/${key}` }, sum: { edgeResponseBytes: -1 } }],
    )).toThrow(/response bytes/i)
  })
})

describe('planQueryWindows', () => {
  it('queries only complete hours and splits recovery into 24-hour windows', () => {
    const windows = planQueryWindows('2026-07-20T08:00:00.000Z', '2026-07-22T10:37:15.000Z')

    expect(windows).toEqual([
      { start: '2026-07-20T08:00:00.000Z', end: '2026-07-21T08:00:00.000Z' },
      { start: '2026-07-21T08:00:00.000Z', end: '2026-07-22T08:00:00.000Z' },
      { start: '2026-07-22T08:00:00.000Z', end: '2026-07-22T10:00:00.000Z' },
    ])
  })

  it('fails instead of silently skipping a cursor outside the seven-day lookback', () => {
    expect(() => planQueryWindows(
      '2026-07-14T10:00:00.000Z',
      '2026-07-22T10:37:15.000Z',
    )).toThrow(/data gap/i)
  })

  it('keeps the first run strictly inside the seven-day analytics retention window', () => {
    const windows = planQueryWindows(null, '2026-07-22T10:37:15.000Z')

    expect(windows[0]?.start).toBe('2026-07-15T11:00:00.000Z')
    expect(windows.at(-1)?.end).toBe('2026-07-22T10:00:00.000Z')
  })

  it('rejects an invalid or future cursor', () => {
    expect(() => planQueryWindows('not-a-date', '2026-07-22T10:37:15.000Z'))
      .toThrow(/timestamp/i)
    expect(() => planQueryWindows('2026-07-22T11:00:00.000Z', '2026-07-22T10:37:15.000Z'))
      .toThrow(/cursor/i)
  })
})

describe('validatePreviousState', () => {
  it('rejects an unsupported or numerically unsafe persisted state', () => {
    expect(() => validatePreviousState({ schemaVersion: 2 })).toThrow(/schema/i)
    expect(() => validatePreviousState({
      schemaVersion: 1,
      r2Cursor: '2026-07-22T10:00:00.000Z',
      github: {
        assets: {
          '11': { name: 'Transfer-1.0.0-mac-arm64.dmg', os: 'mac', downloads: -1 },
        },
      },
      r2: { objects: {} },
    })).toThrow(/github asset/i)
  })
})

describe('buildAnalyticsPayload', () => {
  it('limits R2 traffic to successful installer GETs from real visitors', () => {
    const payload = buildAnalyticsPayload(
      'zone-123',
      'dl.aloongplanet.com',
      { start: '2026-07-22T08:00:00.000Z', end: '2026-07-22T09:00:00.000Z' },
    )

    expect(payload.variables).toEqual({
      zoneTag: 'zone-123',
      filter: {
        datetime_geq: '2026-07-22T08:00:00.000Z',
        datetime_lt: '2026-07-22T09:00:00.000Z',
        clientRequestHTTPHost: 'dl.aloongplanet.com',
        clientRequestHTTPMethod: 'GET',
        clientRequestPath_like: '/releases/%',
        edgeResponseStatus_in: [200, 206],
        requestSource: 'eyeball',
      },
    })
    expect(payload.query).toContain('httpRequestsAdaptiveGroups')
    expect(payload.query).toContain('clientRequestPath')
    expect(payload.query).toContain('edgeResponseBytes')
  })
})

describe('fetchGithubReleases', () => {
  it('paginates through every public GitHub release', async () => {
    const requested: string[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
    const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
      requested.push(url)
      expect(init.headers.Authorization).toBe('Bearer github-token')
      const body = url.includes('page=2') ? [{ id: 101 }] : pageOne
      return { ok: true, json: async () => body }
    }

    const releases = await fetchGithubReleases(fetchImpl, 'owner/repo', 'github-token')

    expect(releases).toHaveLength(101)
    expect(requested).toEqual([
      'https://api.github.com/repos/owner/repo/releases?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/releases?per_page=100&page=2',
    ])
  })
})

describe('fetchAnalyticsRows', () => {
  it('rejects GraphQL errors even when Cloudflare returns HTTP 200', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: 'zone is not authorized' }] }),
    })

    await expect(fetchAnalyticsRows(fetchImpl, 'cf-token', { query: 'query' }))
      .rejects.toThrow(/zone is not authorized/)
  })
})

describe('updateStatistics', () => {
  it('produces the persistent public JSON document used by Pages', () => {
    const state = updateStatistics(
      null,
      [{
        draft: false,
        assets: [{ id: 11, name: 'Transfer-1.0.0-mac-arm64.dmg', download_count: 3 }],
      }],
      [{ Key: 'releases/v1.0.0/Transfer-1.0.0-win-setup.exe', Size: 200 }],
      [{
        dimensions: { clientRequestPath: '/releases/v1.0.0/Transfer-1.0.0-win-setup.exe' },
        sum: { edgeResponseBytes: 50 },
      }],
      '2026-07-22T10:00:00.000Z',
      '2026-07-22T10:05:00.000Z',
    )

    expect(state).toMatchObject({
      schemaVersion: 1,
      updatedAt: '2026-07-22T10:05:00.000Z',
      r2Cursor: '2026-07-22T10:00:00.000Z',
      summary: {
        total: 3.25,
        macos: 3,
        windows: 0.25,
        sources: { github: 3, r2: 0.25 },
      },
    })
  })
})

describe('collectStatistics', () => {
  it('collects GitHub and the next complete Cloudflare interval end to end', async () => {
    const fetchImpl = async (url: string) => {
      if (url.includes('api.github.com')) {
        return {
          ok: true,
          json: async () => [{
            draft: false,
            assets: [{ id: 11, name: 'Transfer-1.0.0-mac-arm64.dmg', download_count: 3 }],
          }],
        }
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              zones: [{
                httpRequestsAdaptiveGroups: [{
                  dimensions: { clientRequestPath: '/releases/v1.0.0/Transfer-1.0.0-win-setup.exe' },
                  sum: { edgeResponseBytes: 50 },
                }],
              }],
            },
          },
        }),
      }
    }

    const state = await collectStatistics({
      previous: {
        schemaVersion: 1,
        r2Cursor: '2026-07-22T09:00:00.000Z',
        github: { assets: {} },
        r2: { objects: {} },
      },
      inventory: [{ Key: 'releases/v1.0.0/Transfer-1.0.0-win-setup.exe', Size: 200 }],
      now: '2026-07-22T10:05:00.000Z',
      zoneId: 'zone-123',
      hostname: 'dl.aloongplanet.com',
      repository: 'owner/repo',
      cloudflareToken: 'cf-token',
      githubToken: 'github-token',
      fetchImpl,
    })

    expect(state.r2Cursor).toBe('2026-07-22T10:00:00.000Z')
    expect(state.summary).toEqual({
      total: 3.25,
      macos: 3,
      windows: 0.25,
      sources: { github: 3, r2: 0.25 },
    })
  })
})

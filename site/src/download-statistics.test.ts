import { describe, expect, it } from 'vitest'
import { getDownloadStatsUrl } from './download-config'
import { parseDownloadSummary } from './download-statistics'

describe('getDownloadStatsUrl', () => {
  it('uses the same-origin proxy only in local development', () => {
    expect(getDownloadStatsUrl(true)).toBe('/__download-statistics')
    expect(getDownloadStatsUrl(false)).toBe('https://dl.aloongplanet.com/stats/downloads.json')
  })
})

describe('parseDownloadSummary', () => {
  it('validates and floors public totals for display', () => {
    expect(parseDownloadSummary({
      schemaVersion: 1,
      summary: {
        total: 12.99,
        macos: 7.8,
        windows: 5.19,
        sources: { github: 10, r2: 2.99 },
      },
    })).toEqual({ total: 12, macos: 7, windows: 5 })
  })

  it('rejects malformed or unsafe totals instead of rendering fake numbers', () => {
    expect(parseDownloadSummary(null)).toBeNull()
    expect(parseDownloadSummary({ schemaVersion: 2, summary: {} })).toBeNull()
    expect(parseDownloadSummary({
      schemaVersion: 1,
      summary: { total: 1, macos: -1, windows: 2 },
    })).toBeNull()
    expect(parseDownloadSummary({
      schemaVersion: 1,
      summary: { total: 100, macos: 1, windows: 2 },
    })).toBeNull()
  })
})

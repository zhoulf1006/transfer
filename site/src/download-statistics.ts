export interface DownloadSummary {
  total: number
  macos: number
  windows: number
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseDownloadSummary(value: unknown): DownloadSummary | null {
  if (!value || typeof value !== 'object') return null
  const document = value as Record<string, unknown>
  if (document.schemaVersion !== 1 || !document.summary || typeof document.summary !== 'object') {
    return null
  }
  const summary = document.summary as Record<string, unknown>
  if (
    !isNonNegativeFinite(summary.total)
    || !isNonNegativeFinite(summary.macos)
    || !isNonNegativeFinite(summary.windows)
    || Math.abs(summary.total - summary.macos - summary.windows) > 1e-6
  ) return null
  return {
    total: Math.floor(summary.total),
    macos: Math.floor(summary.macos),
    windows: Math.floor(summary.windows),
  }
}

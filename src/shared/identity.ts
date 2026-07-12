import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceInfo } from './types'
import { PROTOCOL_VERSION, DEFAULT_PORT } from './protocol'

/** process.platform → deviceModel 显示名(纯函数,见 DESIGN §6) */
export function platformToModel(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return platform
  }
}

/** HTTP 模式下 fingerprint = 随机串(防自发现,见 DESIGN §1.1/§6) */
export function generateFingerprint(): string {
  return randomBytes(32).toString('hex')
}

/** 每文件上传 token */
export function generateToken(): string {
  return randomBytes(16).toString('hex')
}

export function generateSessionId(): string {
  return randomUUID()
}

export interface Identity {
  alias: string
  fingerprint: string
}

/** 组装本机 DeviceInfo(用于多播 announce / prepare-upload 的 info) */
export function buildDeviceInfo(
  identity: Identity,
  platform: NodeJS.Platform,
  port: number = DEFAULT_PORT
): DeviceInfo {
  return {
    alias: identity.alias,
    version: PROTOCOL_VERSION,
    deviceModel: platformToModel(platform),
    deviceType: 'desktop',
    fingerprint: identity.fingerprint,
    port,
    protocol: 'http',
    download: false
  }
}

import { randomBytes, randomUUID, X509Certificate } from 'node:crypto'
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

/**
 * HTTPS 模式下 fingerprint = 证书的 SHA-256(DER 整证书),冒号分隔大写 hex。
 * 用途:①自发现去重 ②TLS 指纹 pinning(见 docs/https-migration.md §3.2)。
 * 格式与 Node getPeerCertificate().fingerprint256 一致,两端可直接比对。
 */
export function certFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
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
  /** 证书指纹(SHA-256 of DER 整证书)= certFingerprint(cert) */
  fingerprint: string
  /** EC P-256 自签名证书(PEM) */
  cert: string
  /** 证书私钥(PEM) */
  privateKey: string
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
    protocol: 'https',
    download: false
  }
}

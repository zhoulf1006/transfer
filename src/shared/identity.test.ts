import { test, expect, describe } from 'vitest'
import { X509Certificate } from 'node:crypto'
import selfsigned from 'selfsigned'
import {
  platformToModel,
  certFingerprint,
  generateToken,
  buildDeviceInfo
} from './identity'
import { PROTOCOL_VERSION } from './protocol'

describe('platformToModel', () => {
  test('已知平台映射', () => {
    expect(platformToModel('darwin')).toBe('macOS')
    expect(platformToModel('win32')).toBe('Windows')
    expect(platformToModel('linux')).toBe('Linux')
  })
  test('未知平台原样返回', () => {
    expect(platformToModel('freebsd' as NodeJS.Platform)).toBe('freebsd')
  })
})

describe('certFingerprint', () => {
  test('= 证书 SHA-256(冒号分隔大写 hex),与 X509Certificate.fingerprint256 一致', async () => {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'Transfer' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256'
    })
    const fp = certFingerprint(pems.cert)
    // 格式:冒号分隔大写十六进制(32 字节 → 32 段两位 hex)
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    // 与 Node 原生 fingerprint256 完全一致(pinning 两端比对的就是它)
    expect(fp).toBe(new X509Certificate(pems.cert).fingerprint256)
  })
  test('同一证书稳定、不同证书不同', async () => {
    const a = await selfsigned.generate([], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })
    const b = await selfsigned.generate([], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })
    expect(certFingerprint(a.cert)).toBe(certFingerprint(a.cert))
    expect(certFingerprint(a.cert)).not.toBe(certFingerprint(b.cert))
  })
})

describe('随机标识', () => {
  test('token 为 32 hex 且每次不同', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{32}$/)
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('buildDeviceInfo', () => {
  test('组装含 port/protocol 的本机 info(protocol=https)', () => {
    const info = buildDeviceInfo(
      { alias: 'Mac', fingerprint: 'fp', cert: '', privateKey: '' },
      'darwin',
      53317
    )
    expect(info).toMatchObject({
      alias: 'Mac',
      version: PROTOCOL_VERSION,
      deviceModel: 'macOS',
      deviceType: 'desktop',
      fingerprint: 'fp',
      port: 53317,
      protocol: 'https',
      download: false
    })
  })
})

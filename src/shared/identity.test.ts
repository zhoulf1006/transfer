import { test, expect, describe } from 'vitest'
import {
  platformToModel,
  generateFingerprint,
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

describe('随机标识', () => {
  test('fingerprint 为 64 hex 且每次不同', () => {
    const a = generateFingerprint()
    const b = generateFingerprint()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
  test('token 为 32 hex 且每次不同', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{32}$/)
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('buildDeviceInfo', () => {
  test('组装含 port/protocol 的本机 info', () => {
    const info = buildDeviceInfo({ alias: 'Mac', fingerprint: 'fp' }, 'darwin', 53317)
    expect(info).toMatchObject({
      alias: 'Mac',
      version: PROTOCOL_VERSION,
      deviceModel: 'macOS',
      deviceType: 'desktop',
      fingerprint: 'fp',
      port: 53317,
      protocol: 'http',
      download: false
    })
  })
})

import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { loadOrCreateIdentity, saveAlias } from './device-identity'
import { certFingerprint } from '@shared/identity'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'transfer-identity-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('loadOrCreateIdentity', () => {
  test('首启:生成 alias + EC 证书,fingerprint = 证书指纹,写盘', async () => {
    const dir = tmp()
    const id = await loadOrCreateIdentity(dir)

    expect(id.alias).toBeTruthy()
    expect(id.cert).toContain('BEGIN CERTIFICATE')
    expect(id.privateKey).toContain('BEGIN')
    // fingerprint 必须 = 证书指纹(不是随机串)
    expect(id.fingerprint).toBe(certFingerprint(id.cert))
    expect(id.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    // 证书可被解析,是 EC 密钥
    const x509 = new X509Certificate(id.cert)
    expect(x509.publicKey.asymmetricKeyType).toBe('ec')
    // 已持久化
    expect(existsSync(join(dir, 'identity.json'))).toBe(true)
  })

  test('已完整:直接读文件,不重新生成证书(fingerprint/cert 不变)', async () => {
    const dir = tmp()
    const first = await loadOrCreateIdentity(dir)
    const second = await loadOrCreateIdentity(dir)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.cert).toBe(first.cert)
    expect(second.privateKey).toBe(first.privateKey)
    expect(second.alias).toBe(first.alias)
  })

  test('老用户迁移:仅有 alias+随机 fingerprint、无 cert → 生成证书 + fingerprint 改证书指纹,保留 alias', async () => {
    const dir = tmp()
    // 模拟老 HTTP 版 identity.json(只有 alias + 随机串 fingerprint)
    const legacyFp = 'a'.repeat(64)
    writeFileSync(
      join(dir, 'identity.json'),
      JSON.stringify({ alias: 'My Old Mac', fingerprint: legacyFp })
    )
    const id = await loadOrCreateIdentity(dir)

    expect(id.alias).toBe('My Old Mac') // alias 保留
    expect(id.cert).toContain('BEGIN CERTIFICATE') // 证书已生成
    expect(id.fingerprint).not.toBe(legacyFp) // fingerprint 变了
    expect(id.fingerprint).toBe(certFingerprint(id.cert)) // 变成证书指纹
    // 覆写后再读应稳定(迁移只发生一次)
    const again = await loadOrCreateIdentity(dir)
    expect(again.fingerprint).toBe(id.fingerprint)
    expect(again.cert).toBe(id.cert)
  })

  test('损坏文件:重建(不抛)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'identity.json'), '{ not valid json')
    const id = await loadOrCreateIdentity(dir)
    expect(id.fingerprint).toBe(certFingerprint(id.cert))
  })
})

describe('saveAlias', () => {
  test('只改 alias,证书/私钥/fingerprint 不变', async () => {
    const dir = tmp()
    const before = await loadOrCreateIdentity(dir)
    await saveAlias(dir, 'Renamed')
    const after = await loadOrCreateIdentity(dir)

    expect(after.alias).toBe('Renamed')
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after.cert).toBe(before.cert)
    expect(after.privateKey).toBe(before.privateKey)
    // 落盘内容一致
    const onDisk = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'))
    expect(onDisk.alias).toBe('Renamed')
    expect(onDisk.cert).toBe(before.cert)
  })
})

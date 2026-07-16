// 本机身份持久化(见 docs/DESIGN §6、docs/https-migration.md §3.3)
//
// HTTPS 改造:identity.json 除 alias/fingerprint 外,新增 cert/privateKey(EC P-256 自签名证书)。
// fingerprint = certFingerprint(cert)(SHA-256 of DER 整证书),不再是随机串。
// 老用户(仅有 alias/fingerprint、无 cert)升级:生成证书 → fingerprint 改证书指纹 → 覆写。
//
// selfsigned 5.x 是 async-only,故 loadOrCreateIdentity / saveAlias 均为 async。
//
// 支持 env 覆盖 userData 目录(TRANSFER_USERDATA)与端口(TRANSFER_PORT),
// 以便"同机多实例"测试:不同 userData → 不同证书/fingerprint → 不互相隐藏(DESIGN §6 M4)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import selfsigned from 'selfsigned'
import type { Identity } from '@shared/identity'
import { certFingerprint } from '@shared/identity'

function defaultAlias(): string {
  try {
    return `${userInfo().username}'s ${hostname()}`
  } catch {
    return hostname()
  }
}

/** 生成 EC P-256 自签名证书(10 年有效期)。async:selfsigned 5.x 仅异步 API。 */
async function generateCert(): Promise<{ cert: string; privateKey: string }> {
  const notBefore = new Date()
  const notAfter = new Date(notBefore.getTime() + 3650 * 24 * 60 * 60 * 1000) // 10 年
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Transfer' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: notAfter
  })
  return { cert: pems.cert, privateKey: pems.private }
}

function writeIdentity(userDataDir: string, identity: Identity): void {
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(userDataDir, 'identity.json'), JSON.stringify(identity, null, 2))
}

/**
 * 从 userData 目录加载身份,不存在或缺证书则生成并持久化。
 * - 完整(alias+fingerprint+cert+privateKey)→ 直接用。
 * - 老用户(有 alias 无 cert)→ 生成证书 + fingerprint 改证书指纹 → 覆写(见 §3.3 迁移)。
 * - 全无(首启)→ 生成 alias + 证书 → 写盘。
 */
export async function loadOrCreateIdentity(userDataDir: string): Promise<Identity> {
  const file = join(userDataDir, 'identity.json')
  let alias: string | undefined
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Identity>
      if (
        typeof parsed.alias === 'string' &&
        typeof parsed.fingerprint === 'string' &&
        typeof parsed.cert === 'string' &&
        typeof parsed.privateKey === 'string'
      ) {
        // 完整,直接用(快路径:不生成证书)
        return {
          alias: parsed.alias,
          fingerprint: parsed.fingerprint,
          cert: parsed.cert,
          privateKey: parsed.privateKey
        }
      }
      // 老用户:保留 alias,证书缺失 → 下面重建
      if (typeof parsed.alias === 'string') alias = parsed.alias
    } catch {
      // 损坏 → 重建
    }
  }
  const { cert, privateKey } = await generateCert()
  const identity: Identity = {
    alias: alias ?? defaultAlias(),
    fingerprint: certFingerprint(cert),
    cert,
    privateKey
  }
  writeIdentity(userDataDir, identity)
  return identity
}

/** 改别名:保留证书/私钥/fingerprint 不变,只改 alias。async(依赖 loadOrCreateIdentity)。 */
export async function saveAlias(userDataDir: string, alias: string): Promise<void> {
  const current = await loadOrCreateIdentity(userDataDir)
  writeIdentity(userDataDir, { ...current, alias })
}

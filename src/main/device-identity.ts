// 本机身份持久化(见 docs/DESIGN §6)
//
// 支持 env 覆盖 userData 目录(TRANSFER_USERDATA)与端口(TRANSFER_PORT),
// 以便"同机多实例"测试:不同 userData → 不同 fingerprint → 不互相隐藏(DESIGN §6 M4)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import type { Identity } from '@shared/identity'
import { generateFingerprint } from '@shared/identity'

function defaultAlias(): string {
  try {
    return `${userInfo().username}'s ${hostname()}`
  } catch {
    return hostname()
  }
}

/** 从 userData 目录加载身份,不存在则生成并持久化。 */
export function loadOrCreateIdentity(userDataDir: string): Identity {
  const file = join(userDataDir, 'identity.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Identity>
      if (typeof parsed.alias === 'string' && typeof parsed.fingerprint === 'string') {
        return { alias: parsed.alias, fingerprint: parsed.fingerprint }
      }
    } catch {
      // 损坏 → 重建
    }
  }
  const identity: Identity = { alias: defaultAlias(), fingerprint: generateFingerprint() }
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })
  writeFileSync(file, JSON.stringify(identity, null, 2))
  return identity
}

export function saveAlias(userDataDir: string, alias: string): void {
  const current = loadOrCreateIdentity(userDataDir)
  const next: Identity = { ...current, alias }
  writeFileSync(join(userDataDir, 'identity.json'), JSON.stringify(next, null, 2))
}

// resolvePeer 在线/离线解析单测。
// 契约:只解析"可达的在线对端"——offline 灰置底设备(§12.2 两段过期)当离线返回 null,
// 让 chat-service 报"对方已离线"而非误导的连接超时(修 bug:离线误报 VPN)。
// 不起网络:经 handleDevice 注入设备,cast 操纵 registry.status 模拟 prune 后的 offline。

import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import type { DeviceInfo, RemoteDevice } from '@shared/types'
import type { SendTarget } from './transfer/http-client'

describe('AppCore resolvePeer 在线/离线', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  function mkdir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }

  function makeCore(): AppCore {
    const settings = new SettingsStore(mkdir('rp-set-'))
    const store = new MessageStore(':memory:')
    const core = new AppCore({
      identity: { alias: 'me', fingerprint: 'self-fp', cert: 'c', privateKey: 'k' },
      platform: 'darwin',
      receiveDir: mkdir('rp-recv-'),
      store,
      settings,
      events: { onDevicesUpdated: () => {}, onMessageUpserted: () => {}, onProgress: () => {} }
    })
    return core
  }

  function addDevice(core: AppCore, fp: string): void {
    const info: DeviceInfo = {
      alias: `Dev-${fp}`,
      version: '2.1',
      fingerprint: fp,
      deviceModel: 'Mac',
      port: 53317,
      protocol: 'https'
    }
    ;(core as unknown as { handleDevice: (i: DeviceInfo, addr: string) => void }).handleDevice(
      info,
      '192.168.1.5'
    )
  }

  /** 把已注入设备的 registry status 改为 offline(模拟 prune 后灰置底)。 */
  function markOffline(core: AppCore, fp: string): void {
    const registry = (core as unknown as { registry: { list: () => RemoteDevice[] } }).registry
    const dev = registry.list().find((d) => d.info.fingerprint === fp)!
    dev.status = 'offline'
  }

  function resolve(core: AppCore, fp: string): { target: SendTarget; alias: string } | null {
    return (
      core as unknown as {
        resolvePeer: (fp: string) => { target: SendTarget; alias: string } | null
      }
    ).resolvePeer(fp)
  }

  test('在线设备 → 返回 target(可发送)', () => {
    const core = makeCore()
    addDevice(core, 'fp-A')
    const peer = resolve(core, 'fp-A')
    expect(peer).not.toBeNull()
    expect(peer!.target.fingerprint).toBe('fp-A')
  })

  test('offline 灰置底设备 → 返回 null(报已离线,不当在线去连)', () => {
    const core = makeCore()
    addDevice(core, 'fp-A')
    markOffline(core, 'fp-A')
    expect(resolve(core, 'fp-A')).toBeNull()
  })

  test('未发现的设备 → 返回 null', () => {
    const core = makeCore()
    expect(resolve(core, 'never-seen')).toBeNull()
  })
})

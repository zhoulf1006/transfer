// 对端可达性契约测试(经高层 seam:core.chat.sendText + MessageStore)。
// 契约:offline 灰置底(§12.2 两段过期)/从未发现的对端 → 消息 failed(offline),
// 报"对方已离线"而非误导的连接超时(修 bug:离线误报 VPN)。离线路径不触网,可安全单测。
// 在线对端的解析与 TLS pinning 由 e2e 覆盖(app-core.e2e.test.ts:真实双端发送成功)。
// 不起网络的折衷:setup 仍用 cast(handleDevice 注设备/置离线),断言全走公开面。

import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import type { DeviceInfo, RemoteDevice } from '@shared/types'

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

  function makeCore(): { core: AppCore; store: MessageStore } {
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
    return { core, store }
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

  test('offline 灰置底对端 → sendText 消息标 failed(offline),不误报连接超时', async () => {
    const { core, store } = makeCore()
    addDevice(core, 'fp-A')
    markOffline(core, 'fp-A')
    await core.chat.sendText('fp-A', 'hello')
    const m = store.list().find((x) => x.direction === 'sent')
    expect(m?.status).toBe('failed')
    expect(m?.errorReason).toBe('offline')
  })

  test('从未发现的对端 → sendText 消息标 failed(offline)', async () => {
    const { core, store } = makeCore()
    await core.chat.sendText('never-seen', 'hello')
    const m = store.list().find((x) => x.direction === 'sent')
    expect(m?.status).toBe('failed')
    expect(m?.errorReason).toBe('offline')
  })
})

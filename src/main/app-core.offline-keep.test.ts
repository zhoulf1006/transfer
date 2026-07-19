// app-core ↔ registry 离线保留时长接线单测。
// 覆盖:①构造时从 settings 读初值传给 registry;②setOfflineKeepMinutes 运行时打通 registry
// 并立即 prune + emitDevices(缩短后超期设备即时消失,不等 5s tick)。
// 不起网络:handleDevice 注入设备,cast 驱动 registry 状态/prune。

import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import type { DeviceInfo, RemoteDevice } from '@shared/types'

describe('AppCore 离线保留时长接线', () => {
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

  /** 建 core;可预置 settings.json 的 offlineKeepMinutes。捕获 onDevicesUpdated 推送。 */
  function makeCore(offlineKeepMinutes?: number): { core: AppCore; updates: RemoteDevice[][] } {
    const setDir = mkdir('ok-set-')
    if (offlineKeepMinutes !== undefined) {
      writeFileSync(join(setDir, 'settings.json'), JSON.stringify({ offlineKeepMinutes }))
    }
    const settings = new SettingsStore(setDir)
    const store = new MessageStore(':memory:')
    const updates: RemoteDevice[][] = []
    const core = new AppCore({
      identity: { alias: 'me', fingerprint: 'self-fp', cert: 'c', privateKey: 'k' },
      platform: 'darwin',
      receiveDir: mkdir('ok-recv-'),
      store,
      settings,
      events: {
        onDevicesUpdated: (d) => updates.push(d),
        onMessageUpserted: () => {},
        onProgress: () => {}
      }
    })
    return { core, updates }
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

  /** 直接把设备 status 置 offline 并把 lastSeen 推到很久以前(模拟长期离线)。 */
  function markOfflineLongAgo(core: AppCore, fp: string): void {
    const registry = (core as unknown as { registry: { list: () => RemoteDevice[] } }).registry
    const dev = registry.list().find((d) => d.info.fingerprint === fp)!
    dev.status = 'offline'
    dev.lastSeen = -1e12 // 极久以前 → 任何有限 keep 都算超期
  }

  function keepMs(core: AppCore): number {
    return (core as unknown as { registry: { offlineKeepMs: number } }).registry.offlineKeepMs
  }

  test('构造时从 settings 读初值传给 registry(60min → 3.6e6 ms)', () => {
    const { core } = makeCore(60)
    expect(keepMs(core)).toBe(60 * 60_000)
  })

  test('构造时 settings 为 0(从不)→ registry offlineKeepMs = Infinity', () => {
    const { core } = makeCore(0)
    expect(keepMs(core)).toBe(Infinity)
  })

  test('setOfflineKeepMinutes 运行时改 → registry 阈值同步变化', () => {
    const { core } = makeCore(60)
    core.setOfflineKeepMinutes(10)
    expect(keepMs(core)).toBe(10 * 60_000)
    core.setOfflineKeepMinutes(0)
    expect(keepMs(core)).toBe(Infinity)
  })

  test('缩短保留时长后立即 prune + emitDevices,超期离线设备当即消失(不等 5s tick)', () => {
    const { core, updates } = makeCore(60)
    addDevice(core, 'A')
    markOfflineLongAgo(core, 'A')
    const before = updates.length
    core.setOfflineKeepMinutes(10) // A idle 远超 10min → 应立即被删并推一次更新
    expect(updates.length).toBeGreaterThan(before) // emitDevices 被调用
    expect(updates[updates.length - 1].map((d) => d.info.fingerprint)).not.toContain('A')
  })

  test('setOfflineKeepMinutes 持久化(重建 core 仍读到)', () => {
    const { core } = makeCore(60)
    core.setOfflineKeepMinutes(30)
    const settings = (core as unknown as { opts: { settings: SettingsStore } }).opts.settings
    expect(settings.getOfflineKeepMinutes()).toBe(30)
  })
})

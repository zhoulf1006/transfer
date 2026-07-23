// app-core ↔ registry 离线保留时长接线单测。
// 覆盖(断言全走公开面:listDevices/onDevicesUpdated/同目录重建 SettingsStore):
// ①0=永不删(Infinity)与运行时修改立即生效;②缩短后立即 prune+emit(不等 5s tick);③持久化写盘。
// 已知覆盖缺口:「构造时从 settings 读初值传给 registry」无行为触发点可测——prune 仅由
// start() 的 5s tick(需起网络)或 setOfflineKeepMinutes(会覆盖初值)触发;settings 读值与
// registry prune 语义各有单测,该接线待 AppCore 提供注入 seam 后补行为测试。
// 不起网络的折衷:setup 仍用 cast(handleDevice 注设备/置离线),断言不碰私有状态。

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
  function makeCore(offlineKeepMinutes?: number): {
    core: AppCore
    updates: RemoteDevice[][]
    setDir: string
  } {
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
    return { core, updates, setDir }
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

  test('0=永不删:超期离线设备 prune 后仍在列表;改回有限时长立即删(行为可见)', () => {
    const { core } = makeCore(60)
    addDevice(core, 'A')
    markOfflineLongAgo(core, 'A')
    core.setOfflineKeepMinutes(0) // 触发立即 prune;Infinity 语义 → 不删
    expect(core.listDevices().map((d) => d.info.fingerprint)).toContain('A')
    core.setOfflineKeepMinutes(10) // 有限阈值 → 超期设备当即被删
    expect(core.listDevices().map((d) => d.info.fingerprint)).not.toContain('A')
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

  test('setOfflineKeepMinutes 持久化:同目录重建 SettingsStore 读到新值(写盘生效)', () => {
    const { core, setDir } = makeCore(60)
    core.setOfflineKeepMinutes(30)
    // 关键:必须"重建后仍读到"才证明落盘——读同一实例只是内存 cache,写盘逻辑删掉也绿
    const reloaded = new SettingsStore(setDir)
    expect(reloaded.getOfflineKeepMinutes()).toBe(30)
  })
})

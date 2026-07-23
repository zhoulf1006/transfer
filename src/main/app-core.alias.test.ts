// 设备备注(applyAliases 合并 + setRemoteAlias 刷新)单测。见 docs/device-alias.md。
// 不起网络(不 call start):只驱动 handleDevice(填 registry + 触发 emitDevices)、listDevices、setRemoteAlias。

import { test, expect, describe, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import type { DeviceInfo, RemoteDevice } from '@shared/types'

describe('AppCore 设备备注', () => {
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

  /** 构造一个不联网的 AppCore + 捕获 onDevicesUpdated 的最新推送。 */
  function makeCore(): {
    core: AppCore
    settings: SettingsStore
    setDir: string
    updates: RemoteDevice[][]
    addDevice: (fp: string, alias: string) => void
  } {
    const setDir = mkdir('alias-set-')
    const settings = new SettingsStore(setDir)
    const store = new MessageStore(':memory:')
    const updates: RemoteDevice[][] = []
    const core = new AppCore({
      identity: { alias: 'me', fingerprint: 'self-fp', cert: 'c', privateKey: 'k' },
      platform: 'darwin',
      receiveDir: mkdir('alias-recv-'),
      store,
      settings,
      events: {
        onDevicesUpdated: (d) => updates.push(d),
        onMessageUpserted: () => {},
        onProgress: () => {}
      }
    })
    // 经 handleDevice 注入设备(private,测试用 cast):填 registry + 触发一次 emitDevices
    const addDevice = (fp: string, alias: string): void => {
      const info: DeviceInfo = {
        alias,
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
    return { core, settings, setDir, updates, addDevice }
  }

  test('无备注:listDevices 显示默认名 alias,hasCustomAlias=false,defaultAlias=原名', () => {
    const { core, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    const [d] = core.listDevices()
    expect(d.info.alias).toBe('Alice-MacBook')
    expect(d.info.defaultAlias).toBe('Alice-MacBook')
    expect(d.info.hasCustomAlias).toBe(false)
  })

  test('有备注:alias 被备注替换,defaultAlias 保留原名,hasCustomAlias=true', () => {
    const { core, settings, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    settings.setDeviceAlias('fp-A', '老张的电脑')
    const [d] = core.listDevices()
    expect(d.info.alias).toBe('老张的电脑') // 显示名 = 备注
    expect(d.info.defaultAlias).toBe('Alice-MacBook') // 原名保留
    expect(d.info.hasCustomAlias).toBe(true)
  })

  test('Bug#1:备注设成与默认名相同,hasCustomAlias 仍为 true(不靠字符串比对)', () => {
    const { core, settings, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    settings.setDeviceAlias('fp-A', 'Alice-MacBook') // 备注 == 默认名
    const [d] = core.listDevices()
    expect(d.info.alias).toBe('Alice-MacBook')
    expect(d.info.hasCustomAlias).toBe(true) // ★ 关键:仍识别为"有备注",菜单能显示[清除备注]
  })

  test('setRemoteAlias 成功 → 返回 {ok:true} 且推一次合并后的 devices:updated', () => {
    const { core, updates, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    const before = updates.length
    const r = core.setRemoteAlias('fp-A', '老张的电脑')
    expect(r).toEqual({ ok: true })
    expect(updates.length).toBe(before + 1) // 立即刷新
    const pushed = updates[updates.length - 1]
    expect(pushed[0].info.alias).toBe('老张的电脑') // 推送内容已合并备注
    expect(pushed[0].info.hasCustomAlias).toBe(true)
  })

  test('setRemoteAlias 空串 → 删备注恢复默认名', () => {
    const { core, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    core.setRemoteAlias('fp-A', '临时备注')
    expect(core.listDevices()[0].info.alias).toBe('临时备注')
    core.setRemoteAlias('fp-A', '') // 清除
    const [d] = core.listDevices()
    expect(d.info.alias).toBe('Alice-MacBook') // 恢复默认
    expect(d.info.hasCustomAlias).toBe(false)
  })

  test('备注给离线/未在列表的 fingerprint:先写后现,设备出现时自动生效(永久保留)', () => {
    const { core, settings, addDevice } = makeCore()
    settings.setDeviceAlias('fp-late', '预设备注') // 设备还没出现就写备注
    expect(core.listDevices()).toHaveLength(0)
    addDevice('fp-late', 'Bob-PC') // 设备之后才被发现
    const [d] = core.listDevices()
    expect(d.info.alias).toBe('预设备注') // 自动套用
    expect(d.info.hasCustomAlias).toBe(true)
  })

  test('setRemoteAlias 持久化失败 → 返回 {ok:false} 且不推更新', () => {
    const { core, setDir, updates, addDevice } = makeCore()
    addDevice('fp-A', 'Alice-MacBook')
    // 真实 persist 失败(不 mock 自己的模块):settings 目录改只读 →
    // writeFileSync 创建 settings.json 时 EACCES → setDeviceAlias catch+回滚 → false
    chmodSync(setDir, 0o555)
    try {
      const before = updates.length
      const r = core.setRemoteAlias('fp-A', '存不上')
      expect(r).toEqual({ ok: false })
      expect(updates.length).toBe(before) // 失败不刷新
    } finally {
      chmodSync(setDir, 0o755) // 恢复写权限,afterEach 的 rmSync 需要
    }
  })

  test('两台同默认名设备,备注按各自 fingerprint 独立,互不影响', () => {
    const { core, settings, addDevice } = makeCore()
    addDevice('fp-A', '同名设备')
    addDevice('fp-B', '同名设备')
    settings.setDeviceAlias('fp-A', '客厅') // 只备注 A
    const list = core.listDevices()
    const a = list.find((d) => d.info.fingerprint === 'fp-A')!
    const b = list.find((d) => d.info.fingerprint === 'fp-B')!
    expect(a.info.alias).toBe('客厅')
    expect(b.info.alias).toBe('同名设备') // B 不受影响
    expect(b.info.hasCustomAlias).toBe(false)
  })

  // 覆盖漏洞补:setRemoteAlias 对**不在 registry** 的 fp(离线已真删/从未发现)——设计声称允许(永久保留)。
  // 真风险:emitDevices→applyAliases 遍历空/不含该 fp 的 registry,不能崩;备注仍写盘,待设备出现生效。
  test('setRemoteAlias 对不在列表的 fingerprint:{ok:true} 不崩,备注入盘,推一次(空列表)', () => {
    const { core, settings, updates } = makeCore()
    expect(core.listDevices()).toHaveLength(0) // registry 空
    const before = updates.length
    const r = core.setRemoteAlias('fp-ghost', '幽灵设备备注') // 该 fp 从未被发现
    expect(r).toEqual({ ok: true }) // 允许写(不校验在线)
    expect(settings.getDeviceAliases()['fp-ghost']).toBe('幽灵设备备注') // 已入盘
    expect(updates.length).toBe(before + 1) // 仍推一次(即便列表空,不崩)
    expect(updates[updates.length - 1]).toHaveLength(0) // 推的是空列表(该 fp 不在 registry)
  })
})

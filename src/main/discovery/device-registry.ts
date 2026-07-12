// 已发现设备的内存表(纯逻辑,带过期,见 docs/DESIGN §3)
//
// 时间通过注入 now() 获取,过期通过 prune(now) 主动推进 —— 可单测。

import type { DeviceInfo, RemoteDevice } from '@shared/types'

export interface DeviceRegistryOpts {
  now: () => number
  /** 超过该时长未再听到则视为离线(默认 15s) */
  ttlMs?: number
}

export class DeviceRegistry {
  /** key = fingerprint(设备唯一标识) */
  private devices = new Map<string, RemoteDevice>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(opts: DeviceRegistryOpts) {
    this.now = opts.now
    this.ttlMs = opts.ttlMs ?? 15_000
  }

  /**
   * 记录/刷新一个设备。返回是否发生了可见变化(新增,或既有设备信息有更新),
   * 便于调用方决定是否推 devices:updated。单纯刷新 lastSeen 不算变化。
   */
  upsert(info: DeviceInfo, address: string, port: number, protocol: 'http' | 'https'): boolean {
    const existing = this.devices.get(info.fingerprint)
    const now = this.now()
    const next: RemoteDevice = { info, address, port, protocol, lastSeen: now }
    this.devices.set(info.fingerprint, next)

    if (!existing) return true
    // 判断除 lastSeen 外是否有实质变化
    return (
      existing.address !== address ||
      existing.port !== port ||
      existing.protocol !== protocol ||
      existing.info.alias !== info.alias
    )
  }

  /** 移除过期设备。返回被移除的 fingerprint 列表(可能触发 devices:updated)。 */
  prune(): string[] {
    const now = this.now()
    const removed: string[] = []
    for (const [fp, dev] of this.devices) {
      if (now - dev.lastSeen >= this.ttlMs) {
        this.devices.delete(fp)
        removed.push(fp)
      }
    }
    return removed
  }

  list(): RemoteDevice[] {
    return [...this.devices.values()]
  }

  remove(fingerprint: string): void {
    this.devices.delete(fingerprint)
  }

  clear(): void {
    this.devices.clear()
  }
}

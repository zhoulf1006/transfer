import { test, expect, describe, beforeEach } from 'vitest'
import { DeviceRegistry } from './device-registry'
import type { DeviceInfo } from '@shared/types'

function info(fp: string, alias = fp): DeviceInfo {
  return { alias, version: '2.0', fingerprint: fp }
}

describe('DeviceRegistry', () => {
  let clock: number
  let reg: DeviceRegistry
  const now = () => clock

  beforeEach(() => {
    clock = 1000
    reg = new DeviceRegistry({ now, ttlMs: 15_000 })
  })

  test('新设备 upsert 返回 true 并可列出', () => {
    expect(reg.upsert(info('A'), '1.1.1.1', 53317, 'http')).toBe(true)
    expect(reg.list()).toHaveLength(1)
  })

  test('相同信息刷新只更新 lastSeen,返回 false(无可见变化)', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    clock += 5000
    expect(reg.upsert(info('A'), '1.1.1.1', 53317, 'http')).toBe(false)
  })

  test('地址/别名变化返回 true', () => {
    reg.upsert(info('A', 'Old'), '1.1.1.1', 53317, 'http')
    expect(reg.upsert(info('A', 'New'), '1.1.1.1', 53317, 'http')).toBe(true)
    expect(reg.upsert(info('A', 'New'), '2.2.2.2', 53317, 'http')).toBe(true)
  })

  test('prune 移除超过 ttl 未刷新的设备', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    reg.upsert(info('B'), '2.2.2.2', 53317, 'http')
    clock += 10_000
    reg.upsert(info('B'), '2.2.2.2', 53317, 'http') // 刷新 B
    clock += 5_000 // A 距上次 15s,B 距上次 5s
    const removed = reg.prune()
    expect(removed).toEqual(['A'])
    expect(reg.list().map((d) => d.info.fingerprint)).toEqual(['B'])
  })

  test('remove / clear', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    reg.remove('A')
    expect(reg.list()).toHaveLength(0)
    reg.upsert(info('B'), '2.2.2.2', 53317, 'http')
    reg.clear()
    expect(reg.list()).toHaveLength(0)
  })
})

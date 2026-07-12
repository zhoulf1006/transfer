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
    reg = new DeviceRegistry({ now, ttlMs: 15_000, offlineKeepMs: 60_000 })
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

  test('新设备默认 status=online', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    expect(reg.list()[0].status).toBe('online')
  })

  test('prune 两段:online 超 TTL 转 offline(保留),再超 keep 才真删(§12.2)', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    reg.upsert(info('B'), '2.2.2.2', 53317, 'http')
    clock += 10_000
    reg.upsert(info('B'), '2.2.2.2', 53317, 'http') // 刷新 B(在线)
    clock += 5_000 // A 距上次 15s(≥TTL),B 距上次 5s
    // 第一段:A 转 offline 但仍在列表,B 仍 online
    const r1 = reg.prune()
    expect(r1.changed).toBe(true)
    expect(r1.removed).toEqual([])
    expect(reg.list().find((d) => d.info.fingerprint === 'A')?.status).toBe('offline')
    expect(reg.list().find((d) => d.info.fingerprint === 'B')?.status).toBe('online')
    // 第二段:A 离线满 keep(TTL+keep=75s)后真删
    clock += 60_000 // A 距上次 75s
    const r2 = reg.prune()
    expect(r2.removed).toEqual(['A'])
    expect(reg.list().map((d) => d.info.fingerprint)).toEqual(['B'])
  })

  test('离线设备重新上线 → 转 online 且 upsert 返回 true(可见变化)', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    clock += 20_000
    reg.prune() // A → offline
    expect(reg.list()[0].status).toBe('offline')
    // 重新听到 A
    const changed = reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    expect(changed).toBe(true) // 离线转在线是可见变化
    expect(reg.list()[0].status).toBe('online')
  })

  test('prune 无变化时 changed=false(不触发 UI 刷新)', () => {
    reg.upsert(info('A'), '1.1.1.1', 53317, 'http')
    clock += 5_000 // 未超 TTL
    expect(reg.prune().changed).toBe(false)
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

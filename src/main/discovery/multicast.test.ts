import { test, expect, describe, afterEach } from 'vitest'
import { MulticastDiscovery } from './multicast'
import type { Announcement } from '@shared/types'

// 集成测:两个真实 socket 在非默认端口互相发现。
// 用非 53317 端口,避免与系统上真实 LocalSend / 其他实例冲突。
const TEST_PORT = 55317
const TEST_ADDR = '224.0.0.167'

function announcementFactory(alias: string, fingerprint: string) {
  return (announce: boolean): Announcement => ({
    alias,
    version: '2.0',
    deviceModel: 'macOS',
    deviceType: 'desktop',
    fingerprint,
    port: TEST_PORT,
    protocol: 'http',
    download: false,
    announce
  })
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const v = fn()
      if (v !== undefined) return resolve(v)
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 30)
    }
    tick()
  })
}

describe('MulticastDiscovery(集成)', () => {
  const running: MulticastDiscovery[] = []
  afterEach(() => {
    for (const m of running) m.stop()
    running.length = 0
  })

  test('两个实例互相发现,且不发现自己', async () => {
    const seenByA: string[] = []
    const seenByB: string[] = []

    const a = new MulticastDiscovery({
      selfFingerprint: 'FP_A',
      buildAnnouncement: announcementFactory('Device-A', 'FP_A'),
      onDevice: (info) => seenByA.push(info.fingerprint),
      port: TEST_PORT,
      multicastAddr: TEST_ADDR
    })
    const b = new MulticastDiscovery({
      selfFingerprint: 'FP_B',
      buildAnnouncement: announcementFactory('Device-B', 'FP_B'),
      onDevice: (info) => seenByB.push(info.fingerprint),
      port: TEST_PORT,
      multicastAddr: TEST_ADDR
    })
    running.push(a, b)

    await a.start()
    await b.start() // b 启动时 announce(true),a 应收到并回应

    // A 应发现 B,B 应发现 A
    await waitFor(() => (seenByA.includes('FP_B') ? true : undefined))
    await waitFor(() => (seenByB.includes('FP_A') ? true : undefined))

    // 防自发现:A 不应发现 FP_A,B 不应发现 FP_B(尽管 loopback 默认开)
    expect(seenByA).not.toContain('FP_A')
    expect(seenByB).not.toContain('FP_B')
  })

  // 防自发现强证:loopback 默认开,本实例发出的 announce 自己会收到;
  // 若 fingerprint 过滤失效,onDevice 会被自己的广播触发。用"另一个 socket 冒充
  // 相同 fingerprint 发包"来确认:相同 fingerprint 的报文一定被丢弃(而非碰巧没收到)。
  test('相同 fingerprint 的报文被丢弃(防自发现真生效)', async () => {
    const seen: string[] = []
    const a = new MulticastDiscovery({
      selfFingerprint: 'FP_SELF',
      buildAnnouncement: announcementFactory('Me', 'FP_SELF'),
      onDevice: (info) => seen.push(info.fingerprint),
      port: TEST_PORT,
      multicastAddr: TEST_ADDR
    })
    running.push(a)
    await a.start() // a 自己 announce(true),loopback 会让 a 收到自己的包

    // 再用独立 socket 主动发一个 fingerprint=FP_SELF 的报文(冒充"自己")
    const { createSocket } = await import('node:dgram')
    const s = createSocket({ type: 'udp4', reuseAddr: true })
    await new Promise<void>((r) => s.bind(() => r()))
    s.send(
      Buffer.from(JSON.stringify(announcementFactory('Impostor', 'FP_SELF')(true))),
      TEST_PORT,
      TEST_ADDR
    )
    // 同时发一个不同 fingerprint 的,作为"过滤器确实在工作、不是全丢"的对照
    s.send(
      Buffer.from(JSON.stringify(announcementFactory('Other', 'FP_OTHER')(true))),
      TEST_PORT,
      TEST_ADDR
    )
    await waitFor(() => (seen.includes('FP_OTHER') ? true : undefined))
    s.close()

    // FP_OTHER 收到了(证明 socket 在正常收包);FP_SELF 一个都不能有(被过滤)
    expect(seen).toContain('FP_OTHER')
    expect(seen).not.toContain('FP_SELF')
  })

  test('非法报文不会导致 onDevice 触发或崩溃', async () => {
    const seen: string[] = []
    const a = new MulticastDiscovery({
      selfFingerprint: 'FP_A',
      buildAnnouncement: announcementFactory('Device-A', 'FP_A'),
      onDevice: (info) => seen.push(info.fingerprint),
      port: TEST_PORT,
      multicastAddr: TEST_ADDR
    })
    running.push(a)
    await a.start()

    // 手动发一段非 JSON 和一段缺字段的 JSON 到多播组
    const { createSocket } = await import('node:dgram')
    const s = createSocket({ type: 'udp4', reuseAddr: true })
    await new Promise<void>((r) => s.bind(() => r()))
    s.send(Buffer.from('not json'), TEST_PORT, TEST_ADDR)
    s.send(Buffer.from(JSON.stringify({ hello: 'world' })), TEST_PORT, TEST_ADDR)
    await new Promise((r) => setTimeout(r, 200))
    s.close()

    expect(seen).toHaveLength(0)
  })
})

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { MulticastDiscovery } from './multicast'
import type { Announcement } from '@shared/types'

// socket 僵死检测 + 自动重建的单测(discovery-socket-recovery.md §6)。
// 用注入的 fake socket + fake clock 确定性驱动,不起真 dgram。
// 真实 socket 收发的回归在 multicast.test.ts(集成测)。

const HB_MAGIC = Buffer.from('HB\0')

/** Fake dgram socket:记录调用、手动触发 listening/message/error/close。 */
class FakeSocket extends EventEmitter {
  closed = false
  bound = false
  members: string[] = []
  loopback: boolean | null = null
  sent: { buf: Buffer; port: number; addr: string }[] = []
  /** listening 是否自动触发(false 模拟 bind 挂住,测看门狗) */
  autoListen: boolean

  constructor(autoListen = true) {
    super()
    this.autoListen = autoListen
  }
  bind(_port: number, cb?: () => void): void {
    this.bound = true
    if (cb) cb()
    if (this.autoListen) setImmediate(() => this.emit('listening'))
  }
  addMembership(addr: string, _iface?: string): void {
    this.members.push(addr)
  }
  setMulticastLoopback(f: boolean): void {
    this.loopback = f
  }
  setMulticastInterface(): void {}
  setBroadcast(): void {}
  send(buf: Buffer, port: number, addr: string): void {
    this.sent.push({ buf, port, addr })
  }
  close(cb?: () => void): void {
    this.closed = true
    if (cb) setImmediate(cb) // close 异步:模拟 'close' callback
  }
  /** 测试辅助:模拟收到自己心跳回环(回投 buf) */
  echo(buf: Buffer): void {
    this.emit('message', buf, { address: '127.0.0.1' })
  }
}

function factory(alias: string, fp: string) {
  return (announce: boolean): Announcement => ({
    alias,
    version: '2.0',
    deviceModel: 'macOS',
    deviceType: 'desktop',
    fingerprint: fp,
    port: 53317,
    protocol: 'https',
    download: false,
    announce
  })
}

/** 建一个注入 fake socket + fake clock 的 discovery;返回句柄便于驱动。 */
function mkDiscovery(opts?: {
  autoListen?: boolean
  interfaceAddr?: string
  onDevice?: (fp: string) => void
}) {
  const sockets: FakeSocket[] = []
  let clock = 0
  const d = new MulticastDiscovery(
    {
      selfFingerprint: 'FP_SELF',
      buildAnnouncement: factory('Me', 'FP_SELF'),
      onDevice: (info) => opts?.onDevice?.(info.fingerprint),
      port: 53317,
      interfaceAddr: opts?.interfaceAddr ?? ''
    },
    {
      createSocket: () => {
        const s = new FakeSocket(opts?.autoListen ?? true)
        sockets.push(s)
        // FakeSocket 只实现了机制用到的方法;转成 Socket 供注入(测试 fake 惯例)
        return s as unknown as import('node:dgram').Socket
      },
      monotonicNow: () => clock
    }
  )
  return {
    d,
    sockets,
    current: () => sockets[sockets.length - 1],
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('socket 僵死检测 + 重建', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function startReady(h: ReturnType<typeof mkDiscovery>): Promise<void> {
    const p = h.d.start()
    await vi.advanceTimersByTimeAsync(1) // 触发 setImmediate(listening) + onListening
    await p
  }

  test('1. 心跳健康:回自己 nonce → 不重建', async () => {
    const h = mkDiscovery()
    await startReady(h)
    expect(h.sockets).toHaveLength(1)
    expect(h.current().loopback).toBe(true) // 钉死 loopback

    // 触发一次心跳 tick → 发探测
    await vi.advanceTimersByTimeAsync(3000)
    const probe = h.current().sent.find((s) => s.buf.subarray(0, 3).equals(HB_MAGIC))
    expect(probe).toBeTruthy()
    // 回投自己的探测包(健康)
    h.current().echo(probe!.buf)
    // 再推进多轮,时钟同步推进 → 不判死
    for (let i = 0; i < 5; i++) {
      h.advance(3000)
      await vi.advanceTimersByTimeAsync(3000)
      const p = h.current().sent.filter((s) => s.buf.subarray(0, 3).equals(HB_MAGIC)).at(-1)
      h.current().echo(p!.buf)
    }
    expect(h.sockets).toHaveLength(1) // 没重建
  })

  test('2. 心跳判死(时间维度):9s 未回 → 重建', async () => {
    const h = mkDiscovery()
    await startReady(h)
    // 发探测,但不回
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.current().sent.some((s) => s.buf.subarray(0, 3).equals(HB_MAGIC))).toBe(true)
    // 时钟推进 ≥9s(真实经过时间),下个 tick 判死
    h.advance(9000)
    await vi.advanceTimersByTimeAsync(3000)
    // 重建:旧 close + 建新
    expect(h.sockets[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(600) // 等 close callback + 退避(500ms)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBeGreaterThanOrEqual(2) // 建了新 socket
  })

  test('2b. B1 回归:事件循环繁忙(多 tick 但时钟只走 <9s)→ 不误判', async () => {
    const h = mkDiscovery()
    await startReady(h)
    await vi.advanceTimersByTimeAsync(3000) // 发探测
    // 模拟繁忙:setInterval 补偿触发多次,但真实时间(clock)只走了 6s
    h.advance(2000)
    await vi.advanceTimersByTimeAsync(3000)
    h.advance(2000)
    await vi.advanceTimersByTimeAsync(3000)
    h.advance(2000) // 累计 clock=6s < 9s
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.sockets).toHaveLength(1) // 未重建(证明不数 tick)
  })

  test('3. nonce 防假活:别人的 nonce 不清在途 → 仍判死', async () => {
    const h = mkDiscovery()
    await startReady(h)
    await vi.advanceTimersByTimeAsync(3000) // 发探测
    // 喂一个"别人的"心跳包(前缀对,nonce 不对)
    h.current().echo(Buffer.concat([HB_MAGIC, Buffer.from('x'.repeat(16))]))
    h.advance(9000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(h.sockets[0].closed).toBe(true) // 仍判死重建
  })

  test('4. 心跳包不污染业务:HB\\0 包不触发 onDevice', async () => {
    const seen: string[] = []
    const h = mkDiscovery({ onDevice: (fp) => seen.push(fp) })
    await startReady(h)
    // 心跳包(即便 fingerprint 缺失)不进 handleMessage
    h.current().echo(Buffer.concat([HB_MAGIC, Buffer.from('y'.repeat(16))]))
    // 正常业务包进 handleMessage
    h.current().echo(Buffer.from(JSON.stringify(factory('Peer', 'FP_PEER')(true))))
    await vi.advanceTimersByTimeAsync(1)
    expect(seen).toEqual(['FP_PEER']) // 只有业务包,心跳包没混进来
  })

  test('6. BINDING 看门狗:listening 永不触发 → 8s 后重建', async () => {
    const h = mkDiscovery({ autoListen: false }) // bind 后不 listening(挂住)
    h.d.start().catch(() => {})
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0].closed).toBe(false) // 还卡着
    // 推进看门狗超时
    await vi.advanceTimersByTimeAsync(8000)
    expect(h.sockets[0].closed).toBe(true) // 看门狗 close 了卡死 socket
    await vi.advanceTimersByTimeAsync(600) // 退避后重建
    expect(h.sockets.length).toBeGreaterThanOrEqual(2)
  })

  test('7. 重建原子性:关旧等 close callback 再建新', async () => {
    const h = mkDiscovery()
    await startReady(h)
    // 触发运行期可恢复 error
    h.current().emit('error', Object.assign(new Error('down'), { code: 'ENETDOWN' }))
    expect(h.sockets[0].closed).toBe(true)
    // close callback + 退避后才建新
    await vi.advanceTimersByTimeAsync(1) // close callback
    await vi.advanceTimersByTimeAsync(500) // 退避 500ms
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBe(2)
  })

  test('8. 退避递增:连续重建失败间隔按表增长', async () => {
    const h = mkDiscovery({ autoListen: false }) // 永远 listening 不了 → 连续重建
    h.d.start().catch(() => {})
    await vi.advanceTimersByTimeAsync(1)
    // 每次:看门狗 8s → close → 退避 → 建新。退避表 [500,1000,2000,5000,10000]
    const socketCountAfter = async (watchdog: number, backoff: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(watchdog) // 看门狗触发
      await vi.advanceTimersByTimeAsync(1) // close callback
      await vi.advanceTimersByTimeAsync(backoff) // 退避
      await vi.advanceTimersByTimeAsync(1)
      return h.sockets.length
    }
    expect(await socketCountAfter(8000, 500)).toBe(2) // 第1次退避 500
    expect(await socketCountAfter(8000, 1000)).toBe(3) // 第2次退避 1000
    expect(await socketCountAfter(8000, 2000)).toBe(4) // 第3次退避 2000
  })

  test('9. 幂等:重建进行中(退避期)不叠加建多 socket', async () => {
    const h = mkDiscovery()
    await startReady(h)
    const s0 = h.current()
    // 触发重建;s0 的监听会被 removeAllListeners 摘掉、close(finish)进入退避 setTimeout。
    s0.emit('error', Object.assign(new Error('down'), { code: 'ENETDOWN' }))
    await vi.advanceTimersByTimeAsync(1) // close callback → 进入退避
    // 退避期(rebuilding=true,socket=null):announce 等外部调用不该触发第二次重建
    h.d.announce(true) // 门控跳过
    // heartbeat tick 也不该在 REBUILDING 触发(hbTimer 已 stop)
    await vi.advanceTimersByTimeAsync(500) // 退避到点
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBe(2) // 只建了一个新的,没叠加
  })

  test('10. stop 竞态:重建 delay 期间 stop → 不建新 socket', async () => {
    const h = mkDiscovery()
    await startReady(h)
    h.current().emit('error', Object.assign(new Error('down'), { code: 'ENETDOWN' }))
    await vi.advanceTimersByTimeAsync(1) // close callback,进入退避 setTimeout
    // 退避未到就 stop
    h.d.stop()
    await vi.advanceTimersByTimeAsync(2000) // 退避时间过了
    expect(h.sockets.length).toBe(1) // 没建新 socket(退避 timer 被清)
  })

  test('5. EADDRNOTAVAIL 归可恢复(非致命)→ 退避重建', async () => {
    const h = mkDiscovery()
    await startReady(h)
    h.current().emit('error', Object.assign(new Error('no addr'), { code: 'EADDRNOTAVAIL' }))
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(500) // 退避(非 30s 慢重试)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBe(2) // 500ms 退避后就重建(证明不是致命 30s)
  })

  test('5b. 真致命(EACCES)→ 30s 慢重试(非 500ms 退避)', async () => {
    const h = mkDiscovery()
    await startReady(h)
    h.current().emit('error', Object.assign(new Error('perm'), { code: 'EACCES' }))
    await vi.advanceTimersByTimeAsync(1) // close callback
    await vi.advanceTimersByTimeAsync(500) // 500ms 内不该重建(致命是 30s)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBe(1) // 还没重建
    await vi.advanceTimersByTimeAsync(30000) // 30s 慢重试
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sockets.length).toBe(2)
  })

  test('12. 测试隔离模式(interfaceAddr=""):重建后 joinedInterfaces 仍为 []', async () => {
    const h = mkDiscovery({ interfaceAddr: '' })
    await startReady(h)
    // 首次:OS 默认接口 addMembership(无 iface 参数),members 记 1 个组地址
    expect(h.current().members).toEqual(['224.0.0.167'])
    // 重建
    h.current().emit('error', Object.assign(new Error('down'), { code: 'ENETDOWN' }))
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(1)
    // 重建后仍是 OS 默认接口(join 1 个组,没因重算变成多接口)
    expect(h.current().members).toEqual(['224.0.0.167'])
  })

  test('announce 门控:重建期(非 READY)announce 跳过不抛', async () => {
    const h = mkDiscovery()
    await startReady(h)
    h.current().emit('error', Object.assign(new Error('down'), { code: 'ENETDOWN' }))
    // 重建中调 announce(模拟 app-core 定时器)→ 不抛
    expect(() => h.d.announce(true)).not.toThrow()
  })
})

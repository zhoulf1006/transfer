// 传输总耗时的记录。起点不是"消息创建"那么简单:
//   · 发送方 —— 点发送即开始,起点就是消息创建时刻;
//   · 接收方 —— 消息创建时用户还没点接收,那段是**他自己犹豫的时间**,不算传输。
//     起点必须是点接收(转 accepted)那一刻。
// 两端各自反映"我这边等了多久",这是用户裁定的口径(从点发送算起)。
import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageStore } from './messages'
import type { Message } from '@shared/message'

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

/** 可控时钟:测时长必须能推进时间,不能靠真等 */
function makeStore(): { store: MessageStore; tick: (ms: number) => void } {
  dir = mkdtempSync(join(tmpdir(), 'dur-'))
  let t = 1_000_000
  const store = new MessageStore(join(dir, 'messages.db'), () => t)
  return { store, tick: (ms) => void (t += ms) }
}

function msg(over: Partial<Message>): Omit<Message, 'createdAt' | 'durationMs'> & { createdAt?: number } {
  return {
    id: 'm1',
    type: 'file',
    direction: 'sent',
    peerFp: 'FP',
    peerAlias: 'Peer',
    content: null,
    fileName: 'a.bin',
    fileSize: 1024,
    filePath: null,
    status: 'pending',
    errorReason: null,
    transferId: 't1',
    ...over
  } as Omit<Message, 'createdAt' | 'durationMs'> & { createdAt?: number }
}

describe('传输总耗时', () => {
  test('发送方:起点是消息创建时刻(点发送即开始)', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', direction: 'sent', status: 'pending' }))
    tick(18_000)
    const done = store.updateStatus('m1', 'done', { filePath: '/tmp/a.bin' })!

    expect(done.durationMs).toBe(18_000)
    store.close()
  })

  test('接收方:起点是点接收那一刻,不含之前的犹豫时间', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', direction: 'recv', status: 'pending' }))
    tick(120_000) // 用户犹豫了两分钟才点接收 —— 这段不算
    store.updateStatus('m1', 'accepted')
    tick(5_000) // 真正传输 5 秒
    const done = store.updateStatus('m1', 'done', { filePath: '/tmp/a.bin' })!

    expect(done.durationMs, '犹豫的 120s 不能算进传输耗时').toBe(5_000)
    store.close()
  })

  test('失败也记耗时(花掉的时间是事实)', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', direction: 'sent', status: 'pending' }))
    tick(74_000)
    const failed = store.updateStatus('m1', 'failed', { errorReason: 'enospc' })!

    expect(failed.durationMs).toBe(74_000)
    store.close()
  })

  test('文本消息不记耗时:它的气泡里根本没有文件行,无处显示', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', type: 'text', content: 'hi', fileName: null, status: 'pending' }))
    tick(300)
    expect(store.updateStatus('m1', 'sent')!.durationMs).toBeNull()
    store.close()
  })

  test('没发生过传输的终态不记耗时:对方拒绝 / 超时过期', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', status: 'pending' }))
    store.insert(msg({ id: 'm2', status: 'pending' }))
    tick(60_000)

    expect(store.updateStatus('m1', 'rejected')!.durationMs, '对方拒绝:没传过,不该有耗时').toBeNull()
    expect(store.updateStatus('m2', 'expired')!.durationMs, '超时过期:没传过,不该有耗时').toBeNull()
    store.close()
  })

  test('已记录的耗时不被后续状态变更覆盖', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', status: 'pending' }))
    tick(10_000)
    const first = store.updateStatus('m1', 'done', { filePath: '/tmp/a.bin' })!
    tick(999_000)
    const again = store.updateStatus('m1', 'done', { filePath: '/tmp/a.bin' })!

    expect(first.durationMs).toBe(10_000)
    expect(again.durationMs, '重复置终态不得把耗时改写成后来的时间差').toBe(10_000)
    store.close()
  })

  test('升级前的老消息读回 null,不是 0', () => {
    const { store } = makeStore()
    // 直接插一条终态消息(模拟历史数据落库时还没有这个字段的情形)
    store.insert(msg({ id: 'old', status: 'done', filePath: '/tmp/a.bin' }))
    const got = store.get('old')!

    // 从未经历"传输中 → 终态"的转换,所以没有起点可算 → null
    expect(got.durationMs, '拿不到耗时时必须是 null,0 会被界面显示成 0s').toBeNull()
    store.close()
  })

  test('重启丢起点:进程内没记过起点的消息转终态,耗时为 null 而不是荒谬的大数', () => {
    const { store, tick } = makeStore()
    store.insert(msg({ id: 'm1', direction: 'recv', status: 'accepted', createdAt: 1 }))
    tick(50)
    // 这条 insert 时就是 accepted,没走过 pending→accepted 的转换 —— 相当于重启后的残留
    const done = store.updateStatus('m1', 'done', { filePath: '/tmp/a.bin' })!

    expect(done.durationMs, '没有可信起点时宁可不显示,也不能拿 createdAt 硬算').toBeNull()
    store.close()
  })
})

import { test, expect, describe, beforeEach } from 'vitest'
import { MessageStore, LIST_MAX_LIMIT, type Message } from './messages'

function baseMsg(over: Partial<Message>): Omit<Message, 'createdAt'> & { createdAt?: number } {
  // 用 'in' 判断而非 ?? ,否则显式传 null 会被默认值覆盖(content:null → 'hello' 的坑)
  const has = <K extends keyof Message>(k: K): boolean => k in over
  return {
    id: has('id') ? over.id! : 'm1',
    type: has('type') ? over.type! : 'text',
    direction: has('direction') ? over.direction! : 'recv',
    peerFp: has('peerFp') ? over.peerFp! : 'FP',
    peerAlias: has('peerAlias') ? over.peerAlias! : 'Peer',
    content: has('content') ? over.content! : 'hello',
    fileName: has('fileName') ? over.fileName! : null,
    fileSize: has('fileSize') ? over.fileSize! : null,
    filePath: has('filePath') ? over.filePath! : null,
    status: has('status') ? over.status! : 'done',
    errorReason: has('errorReason') ? over.errorReason! : null,
    transferId: has('transferId') ? over.transferId! : null,
    createdAt: over.createdAt
  }
}

describe('MessageStore', () => {
  let clock: number
  let store: MessageStore

  beforeEach(() => {
    clock = 1000
    store = new MessageStore(':memory:', () => clock)
  })

  test('insert + get', () => {
    store.insert(baseMsg({ id: 'm1', content: 'hi' }))
    const got = store.get('m1')
    expect(got?.content).toBe('hi')
    expect(got?.createdAt).toBe(1000)
  })

  test('insert 用注入时钟填 createdAt', () => {
    clock = 5555
    const m = store.insert(baseMsg({ id: 'm2' }))
    expect(m.createdAt).toBe(5555)
  })

  test('updateStatus 改状态 + error_reason', () => {
    store.insert(baseMsg({ id: 'm1', status: 'pending' }))
    const updated = store.updateStatus('m1', 'failed', { errorReason: 'enospc' })
    expect(updated?.status).toBe('failed')
    expect(updated?.errorReason).toBe('enospc')
    expect(store.get('m1')?.status).toBe('failed')
  })

  test('updateStatus 填 filePath', () => {
    store.insert(baseMsg({ id: 'm1', type: 'file', status: 'accepted' }))
    store.updateStatus('m1', 'done', { filePath: '/downloads/a.png' })
    expect(store.get('m1')?.filePath).toBe('/downloads/a.png')
  })

  test('updateStatus 不存在的 id → null', () => {
    expect(store.updateStatus('nope', 'done')).toBeNull()
  })

  test('updateStatusByTransferId 批量更新', () => {
    store.insert(baseMsg({ id: 'm1', transferId: 'T1', status: 'pending' }))
    store.insert(baseMsg({ id: 'm2', transferId: 'T1', status: 'pending' }))
    store.insert(baseMsg({ id: 'm3', transferId: 'T2', status: 'pending' }))
    const affected = store.updateStatusByTransferId('T1', 'rejected')
    expect(affected.sort()).toEqual(['m1', 'm2'])
    expect(store.get('m1')?.status).toBe('rejected')
    expect(store.get('m3')?.status).toBe('pending') // 未受影响
  })

  test('expireAllPending 把 pending 标 expired', () => {
    store.insert(baseMsg({ id: 'm1', status: 'pending' }))
    store.insert(baseMsg({ id: 'm2', status: 'done' }))
    store.insert(baseMsg({ id: 'm3', status: 'pending' }))
    expect(store.expireAllPending()).toBe(2)
    expect(store.get('m1')?.status).toBe('expired')
    expect(store.get('m2')?.status).toBe('done') // done 不变
    expect(store.get('m3')?.status).toBe('expired')
  })

  describe('list 分页', () => {
    beforeEach(() => {
      // 插入 5 条,created_at 100..500
      for (let i = 1; i <= 5; i++) {
        clock = i * 100
        store.insert(baseMsg({ id: `m${i}` }))
      }
    })

    test('默认按 created_at 升序', () => {
      const all = store.list()
      expect(all.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    })

    test('limit 取最新 N 条(升序返回)', () => {
      const last2 = store.list({ limit: 2 })
      expect(last2.map((m) => m.id)).toEqual(['m4', 'm5'])
    })

    test('before 游标分页(取更早的)', () => {
      // before=300 → created_at<300 的最近 limit 条 = m1,m2
      const older = store.list({ before: 300, limit: 10 })
      expect(older.map((m) => m.id)).toEqual(['m1', 'm2'])
    })

    test('limit 超上限被钳到 LIST_MAX_LIMIT', () => {
      const r = store.list({ limit: 99999 })
      expect(r.length).toBeLessThanOrEqual(LIST_MAX_LIMIT)
    })
  })

  test('file 消息完整字段往返', () => {
    store.insert(
      baseMsg({
        id: 'f1',
        type: 'file',
        direction: 'sent',
        content: null,
        fileName: 'photo.png',
        fileSize: 2048,
        status: 'sent'
      })
    )
    const got = store.get('f1')!
    expect(got.type).toBe('file')
    expect(got.fileName).toBe('photo.png')
    expect(got.fileSize).toBe(2048)
    expect(got.content).toBeNull()
  })

  describe('listReceivedFiles(下载列表,§12.5)', () => {
    beforeEach(() => {
      // 只 recv+file+done 才该出现;造各种干扰项
      clock = 100
      store.insert(baseMsg({ id: 'r1', type: 'file', direction: 'recv', status: 'done', fileName: 'a.png' }))
      clock = 200
      store.insert(baseMsg({ id: 'r2', type: 'file', direction: 'recv', status: 'done', fileName: 'b.png' }))
      // 干扰:sent 文件、recv 文本、recv 文件但未 done
      store.insert(baseMsg({ id: 's1', type: 'file', direction: 'sent', status: 'done' }))
      store.insert(baseMsg({ id: 't1', type: 'text', direction: 'recv', status: 'done' }))
      store.insert(baseMsg({ id: 'p1', type: 'file', direction: 'recv', status: 'accepted' }))
      store.insert(baseMsg({ id: 'f1', type: 'file', direction: 'recv', status: 'failed' }))
    })

    test('只返回 recv+file+done,按接收时间降序(最新在前)', () => {
      const got = store.listReceivedFiles()
      expect(got.map((m) => m.id)).toEqual(['r2', 'r1']) // 降序
    })

    test('limit 生效', () => {
      expect(store.listReceivedFiles({ limit: 1 }).map((m) => m.id)).toEqual(['r2'])
    })

    test('before 游标取更早的', () => {
      expect(store.listReceivedFiles({ before: 200 }).map((m) => m.id)).toEqual(['r1'])
    })
  })
})

import { test, expect, describe, beforeEach } from 'vitest'
import { SessionManager } from './session'
import type { FileMeta } from '@shared/types'

function meta(id: string, size = 100): FileMeta {
  return { id, fileName: `${id}.bin`, size, fileType: 'application/octet-stream' }
}

function filesOf(...ids: string[]): Record<string, FileMeta> {
  return Object.fromEntries(ids.map((id) => [id, meta(id)]))
}

describe('SessionManager', () => {
  let clock: number
  let sm: SessionManager
  const now = () => clock

  beforeEach(() => {
    clock = 1000
    sm = new SessionManager({ now, dialogTimeoutMs: 30_000, idleTimeoutMs: 30_000 })
  })

  // ── prepare-upload / 单会话 / 409 ──────────────────────
  test('首个 prepare-upload → ask,并占用会话(pending)', () => {
    const d = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    expect(d.kind).toBe('ask')
    expect(sm.current?.phase).toBe('pending')
  })

  test('别的设备在会话占用期间 prepare-upload → 409 busy', () => {
    sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    const d = sm.onPrepareUpload({ remoteIp: '2.2.2.2', fingerprint: 'B', files: filesOf('f2') })
    expect(d.kind).toBe('busy')
  })

  test('同 IP+fingerprint 的重试覆盖旧 PENDING(H3),不返回 409', () => {
    const first = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1')
    })
    const retry = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1')
    })
    expect(retry.kind).toBe('ask')
    // 新 transferId 覆盖旧的:用旧 transferId 响应应失效
    if (first.kind === 'ask' && retry.kind === 'ask') {
      expect(sm.respond(first.transferId, true).kind).toBe('rejected')
      expect(sm.respond(retry.transferId, true).kind).toBe('accepted')
    }
  })

  test('active 传输中,即便同 IP+fingerprint 也 → 409(不打断)', () => {
    const d = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    if (d.kind === 'ask') sm.respond(d.transferId, true)
    expect(sm.current?.phase).toBe('active')
    const again = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1')
    })
    expect(again.kind).toBe('busy')
  })

  // ── respond / 接受集合 / 部分接受 ──────────────────────
  test('接受全部 → active,返回每文件 token', () => {
    const d = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1', 'f2')
    })
    if (d.kind !== 'ask') throw new Error('expected ask')
    const r = sm.respond(d.transferId, true)
    expect(r.kind).toBe('accepted')
    if (r.kind === 'accepted') {
      expect(Object.keys(r.files).sort()).toEqual(['f1', 'f2'])
      expect(r.sessionId).toBeTruthy()
    }
  })

  test('部分接受 → 只返回接受文件的 token', () => {
    const d = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1', 'f2', 'f3')
    })
    if (d.kind !== 'ask') throw new Error('expected ask')
    const r = sm.respond(d.transferId, true, ['f1', 'f3'])
    if (r.kind !== 'accepted') throw new Error('expected accepted')
    expect(Object.keys(r.files).sort()).toEqual(['f1', 'f3'])
  })

  test('用户拒绝 → rejected 且清理会话', () => {
    const d = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    if (d.kind !== 'ask') throw new Error('expected ask')
    expect(sm.respond(d.transferId, false).kind).toBe('rejected')
    expect(sm.current).toBeNull()
  })

  // 三态 respond(DESIGN §11.2.1)
  test('接受但空集合(文本/选0文件)→ accepted-empty(204),立即清理不进 active', () => {
    const d = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    if (d.kind !== 'ask') throw new Error('expected ask')
    expect(sm.respond(d.transferId, true, []).kind).toBe('accepted-empty')
    expect(sm.current).toBeNull() // 不进 active、不占单会话锁
  })

  test('accepted-empty 后单会话锁立即释放(下一个 prepare 不被 409)', () => {
    const d1 = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    if (d1.kind !== 'ask') throw new Error('expected ask')
    sm.respond(d1.transferId, true, []) // 文本 accept
    // 立即来第二个会话,应 ask 而非 busy
    const d2 = sm.onPrepareUpload({ remoteIp: '2.2.2.2', fingerprint: 'B', files: filesOf('f2') })
    expect(d2.kind).toBe('ask')
  })

  test('错误/过期 transferId 响应 → rejected', () => {
    sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    expect(sm.respond('bogus', true).kind).toBe('rejected')
  })

  // ── upload 校验 ────────────────────────────────────────
  function setupActive(ip = '1.1.1.1', ids = ['f1']) {
    const d = sm.onPrepareUpload({ remoteIp: ip, fingerprint: 'A', files: filesOf(...ids) })
    if (d.kind !== 'ask') throw new Error('expected ask')
    const r = sm.respond(d.transferId, true)
    if (r.kind !== 'accepted') throw new Error('expected accepted')
    return r
  }

  test('合法 upload → accept', () => {
    const r = setupActive()
    const u = sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1')
    expect(u.kind).toBe('accept')
  })

  test('token 不匹配 → 403', () => {
    const r = setupActive()
    expect(sm.onUpload(r.sessionId, 'f1', 'wrong', '1.1.1.1')).toEqual({
      kind: 'reject',
      status: 403
    })
  })

  test('IP 绑定:来源 IP 不符 → 403(B3)', () => {
    const r = setupActive('1.1.1.1')
    expect(sm.onUpload(r.sessionId, 'f1', r.files.f1, '9.9.9.9')).toEqual({
      kind: 'reject',
      status: 403
    })
  })

  test('sessionId 不符 → 403', () => {
    const r = setupActive()
    expect(sm.onUpload('other-session', 'f1', r.files.f1, '1.1.1.1').kind).toBe('reject')
  })

  test('未接受的 fileId(部分接受被拒的)→ 403', () => {
    const d = sm.onPrepareUpload({
      remoteIp: '1.1.1.1',
      fingerprint: 'A',
      files: filesOf('f1', 'f2')
    })
    if (d.kind !== 'ask') throw new Error('expected ask')
    const r = sm.respond(d.transferId, true, ['f1'])
    if (r.kind !== 'accepted') throw new Error('expected accepted')
    // f2 未被接受,即便捏造 token 也 403
    expect(sm.onUpload(r.sessionId, 'f2', 'any', '1.1.1.1').kind).toBe('reject')
  })

  test('PENDING 门控:pending 阶段的 upload → 403(H1)', () => {
    const d = sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    if (d.kind !== 'ask') throw new Error('expected ask')
    // 尚未 respond,伪造 upload
    expect(sm.onUpload('guess', 'f1', 'guess', '1.1.1.1').kind).toBe('reject')
  })

  test('重复 upload 已收 fileId → 幂等 accept(alreadyReceived)', () => {
    const r = setupActive()
    sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1')
    sm.markReceived(r.sessionId, 'f1') // 收完即清理(单文件)
    // 会话已清理,重复 upload 落到无会话 → 403(而非崩溃)
    expect(sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1').kind).toBe('reject')
  })

  test('多文件:重复 upload 未收完会话中的已收文件 → alreadyReceived=true', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1')
    sm.markReceived(r.sessionId, 'f1') // f2 未收,会话仍在
    const again = sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1')
    expect(again).toMatchObject({ kind: 'accept', alreadyReceived: true })
  })

  // ── 完成判定(并行 upload)──────────────────────────────
  test('并行多文件:全部 markReceived 才算 done 并清理', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    expect(sm.markReceived(r.sessionId, 'f1').done).toBe(false)
    expect(sm.current?.phase).toBe('active')
    expect(sm.markReceived(r.sessionId, 'f2').done).toBe(true)
    expect(sm.current).toBeNull()
  })

  // ── cancel ────────────────────────────────────────────
  test('发送方 cancel 正确 sessionId → 清理', () => {
    const r = setupActive()
    expect(sm.onCancel(r.sessionId).cancelled).toBe(true)
    expect(sm.current).toBeNull()
  })

  test('cancel 错误 sessionId → 不影响当前会话', () => {
    const r = setupActive()
    expect(sm.onCancel('nope').cancelled).toBe(false)
    expect(sm.current?.sessionId).toBe(r.sessionId)
  })

  // ── 超时 ──────────────────────────────────────────────
  test('弹框超时:pending 超 dialogTimeout → expired dialog 并清理', () => {
    sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    clock += 29_999
    expect(sm.sweep().expired).toBeNull()
    clock += 1
    expect(sm.sweep().expired).toBe('dialog')
    expect(sm.current).toBeNull()
  })

  test('空闲超时:active 无字节超 idleTimeout → expired idle', () => {
    setupActive()
    clock += 30_000
    expect(sm.sweep().expired).toBe('idle')
    expect(sm.current).toBeNull()
  })

  test('upload 有字节会 reset 空闲计时器', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    clock += 20_000
    sm.onUpload(r.sessionId, 'f1', r.files.f1, '1.1.1.1') // reset
    clock += 20_000 // 距上次活动仅 20s
    expect(sm.sweep().expired).toBeNull()
    clock += 10_000 // 累计 30s 无活动
    expect(sm.sweep().expired).toBe('idle')
  })

  // ── S1:落盘失败清理会话 ────────────────────────────────
  test('onUploadFailed 清理当前会话(S1)', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    expect(sm.onUploadFailed(r.sessionId).cleared).toBe(true)
    expect(sm.current).toBeNull()
  })

  test('onUploadFailed 错误 sessionId 不影响会话', () => {
    const r = setupActive()
    expect(sm.onUploadFailed('nope').cleared).toBe(false)
    expect(sm.current?.sessionId).toBe(r.sessionId)
  })

  // ── S3:markReceived 反映会话是否仍存活 ──────────────────
  test('markReceived 在会话已被 cancel 后返回 stillActive=false(S3)', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    sm.onCancel(r.sessionId) // 落盘期间对方 cancel
    const m = sm.markReceived(r.sessionId, 'f1')
    expect(m.stillActive).toBe(false)
    expect(m.done).toBe(false)
  })

  test('markReceived 正常情况 stillActive=true', () => {
    const r = setupActive('1.1.1.1', ['f1', 'f2'])
    const m = sm.markReceived(r.sessionId, 'f1')
    expect(m.stillActive).toBe(true)
    expect(m.done).toBe(false)
  })

  test('超时清理后可接受新会话', () => {
    sm.onPrepareUpload({ remoteIp: '1.1.1.1', fingerprint: 'A', files: filesOf('f1') })
    clock += 30_000
    sm.sweep()
    const d = sm.onPrepareUpload({ remoteIp: '2.2.2.2', fingerprint: 'B', files: filesOf('f2') })
    expect(d.kind).toBe('ask')
  })
})

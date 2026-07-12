// 接收方会话状态机(纯逻辑,见 docs/DESIGN §5 / §5.1)
//
// 设计原则:本模块只管"状态与判定",不做 I/O(落盘、发 IPC、起真实定时器都由调用方做)。
// 时间通过注入的 now() 获取,超时通过 sweep(now) 主动推进 —— 因此完全可单测。

import type { FileMeta } from '@shared/types'
import { T_DIALOG_MS, T_IDLE_MS } from '@shared/protocol'
import { generateSessionId, generateToken } from '@shared/identity'

export type SessionPhase = 'pending' | 'active'

export interface PendingRequest {
  /** 发送方来源 IP(用于 IP 绑定与重试识别) */
  remoteIp: string
  /** 发送方 fingerprint(用于重试识别) */
  fingerprint: string
  /** 请求里的全部文件(fileId -> meta) */
  files: Record<string, FileMeta>
}

interface Session {
  phase: SessionPhase
  sessionId: string
  remoteIp: string
  fingerprint: string
  /** 请求的全部文件 */
  requested: Record<string, FileMeta>
  /** 接受集合:fileId -> token(仅 active 阶段有) */
  accepted: Map<string, string>
  /** 尚未收完的 fileId(接受集合的子集) */
  pending: Set<string>
  /** 最近一次活动时间(pending 起算弹框超时;active 起算空闲超时) */
  lastActivity: number
}

// ── prepare-upload 决策结果 ────────────────────────────────
export type PrepareDecision =
  | { kind: 'ask'; transferId: string } // 新 PENDING,需向用户弹框
  | { kind: 'busy' } // 409:已有别的设备的会话

// ── 用户响应结果 ──────────────────────────────────────────
export type RespondResult =
  | { kind: 'accepted'; sessionId: string; files: Record<string, string> }
  | { kind: 'rejected' } // 403(全拒绝 / 无有效 transferId)

// ── upload 校验结果 ───────────────────────────────────────
export type UploadDecision =
  | { kind: 'accept'; fileMeta: FileMeta; alreadyReceived: boolean }
  | { kind: 'reject'; status: 403 | 409 }

export interface SessionManagerOpts {
  now: () => number
  dialogTimeoutMs?: number
  idleTimeoutMs?: number
}

/**
 * 单会话管理器:同一时刻至多一个 pending/active 会话(DESIGN §5 单会话不变量)。
 */
export class SessionManager {
  private session: Session | null = null
  /** transferId(本地) -> sessionId,弹框响应用;pending 阶段 sessionId 尚未对外暴露 */
  private transferId: string | null = null
  private readonly now: () => number
  private readonly dialogTimeoutMs: number
  private readonly idleTimeoutMs: number

  constructor(opts: SessionManagerOpts) {
    this.now = opts.now
    this.dialogTimeoutMs = opts.dialogTimeoutMs ?? T_DIALOG_MS
    this.idleTimeoutMs = opts.idleTimeoutMs ?? T_IDLE_MS
  }

  /** 当前会话快照(测试/调试用) */
  get current(): { phase: SessionPhase; sessionId: string } | null {
    return this.session ? { phase: this.session.phase, sessionId: this.session.sessionId } : null
  }

  /**
   * prepare-upload 到达。返回 ask(需弹框)或 busy(409)。
   * 同 IP+fingerprint 的重试会覆盖旧 PENDING(DESIGN §5 H3)。
   */
  onPrepareUpload(req: PendingRequest): PrepareDecision {
    if (this.session) {
      const same =
        this.session.remoteIp === req.remoteIp && this.session.fingerprint === req.fingerprint
      // 只有旧会话仍在 pending(用户未响应)时才允许重试覆盖;active 传输中不打断
      if (same && this.session.phase === 'pending') {
        // 覆盖:丢弃旧 pending,用新的(调用方负责关旧弹框)
        this.clear()
      } else {
        return { kind: 'busy' }
      }
    }

    const transferId = generateSessionId()
    this.transferId = transferId
    this.session = {
      phase: 'pending',
      sessionId: generateSessionId(),
      remoteIp: req.remoteIp,
      fingerprint: req.fingerprint,
      requested: req.files,
      accepted: new Map(),
      pending: new Set(),
      lastActivity: this.now()
    }
    return { kind: 'ask', transferId }
  }

  /**
   * 用户对弹框的响应。acceptedFileIds 省略 = 接受全部;空数组 = 全拒绝。
   * transferId 必须匹配当前 pending 会话,否则视为过期 → rejected。
   */
  respond(transferId: string, accept: boolean, acceptedFileIds?: string[]): RespondResult {
    const s = this.session
    if (!s || s.phase !== 'pending' || this.transferId !== transferId) {
      return { kind: 'rejected' }
    }

    const ids = acceptedFileIds ?? Object.keys(s.requested)
    // 只接受确实存在于请求里的 fileId
    const valid = ids.filter((id) => id in s.requested)

    if (!accept || valid.length === 0) {
      this.clear()
      return { kind: 'rejected' }
    }

    const files: Record<string, string> = {}
    for (const id of valid) {
      const token = generateToken()
      s.accepted.set(id, token)
      s.pending.add(id)
      files[id] = token
    }
    s.phase = 'active'
    s.lastActivity = this.now()
    return { kind: 'accepted', sessionId: s.sessionId, files }
  }

  /**
   * upload 到达时的校验(DESIGN §5 不变量)。校验 sessionId+fileId+token+IP,
   * 且仅 active 阶段、fileId ∈ 接受集合。重复已收 fileId → 幂等(accept + alreadyReceived)。
   */
  onUpload(sessionId: string, fileId: string, token: string, remoteIp: string): UploadDecision {
    const s = this.session
    // 无会话 / 非本会话 / 非 active(含 pending 门控)→ 403
    if (!s || s.sessionId !== sessionId || s.phase !== 'active') {
      return { kind: 'reject', status: 403 }
    }
    // IP 绑定
    if (s.remoteIp !== remoteIp) {
      return { kind: 'reject', status: 403 }
    }
    // fileId 必须在接受集合且 token 匹配
    const expected = s.accepted.get(fileId)
    if (expected === undefined || expected !== token) {
      return { kind: 'reject', status: 403 }
    }
    // 有活动 → reset 空闲计时器
    s.lastActivity = this.now()

    const alreadyReceived = !s.pending.has(fileId)
    return { kind: 'accept', fileMeta: s.requested[fileId], alreadyReceived }
  }

  /**
   * 标记某文件已成功落盘。
   * - stillActive:该 sessionId 是否仍是当前会话(S3:落盘期间被 cancel 则 false)
   * - done:该会话是否已全部收完(收完即清理)
   * 幂等:重复标记同一 fileId 不影响。
   */
  markReceived(sessionId: string, fileId: string): { done: boolean; stillActive: boolean } {
    const s = this.session
    if (!s || s.sessionId !== sessionId) return { done: false, stillActive: false }
    s.pending.delete(fileId)
    s.lastActivity = this.now()
    const done = s.pending.size === 0
    if (done) this.clear()
    return { done, stillActive: true }
  }

  /**
   * 某文件落盘失败(S1 修复)。清理会话,不让失败的 fileId 悬挂到 idle 超时。
   * 发送方的 Promise.all 会因该文件 500 整体 reject,会话已无继续意义。
   */
  onUploadFailed(sessionId: string): { cleared: boolean } {
    const s = this.session
    if (!s || s.sessionId !== sessionId) return { cleared: false }
    this.clear()
    return { cleared: true }
  }

  /** 发送方 cancel(校验 sessionId)。返回是否确实取消了当前会话。 */
  onCancel(sessionId: string): { cancelled: boolean } {
    const s = this.session
    if (!s || s.sessionId !== sessionId) return { cancelled: false }
    this.clear()
    return { cancelled: true }
  }

  /**
   * 主动推进超时。调用方定期(或在收到事件时)调用。
   * 返回被清理的会话类型,便于调用方发对应通知 / resolve 挂起的 403。
   */
  sweep(): { expired: 'dialog' | 'idle' | null } {
    const s = this.session
    if (!s) return { expired: null }
    const elapsed = this.now() - s.lastActivity
    if (s.phase === 'pending' && elapsed >= this.dialogTimeoutMs) {
      this.clear()
      return { expired: 'dialog' }
    }
    if (s.phase === 'active' && elapsed >= this.idleTimeoutMs) {
      this.clear()
      return { expired: 'idle' }
    }
    return { expired: null }
  }

  private clear(): void {
    this.session = null
    this.transferId = null
  }
}

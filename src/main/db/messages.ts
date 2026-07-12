// 消息持久化(node:sqlite,见 docs/DESIGN §11.3)
//
// node:sqlite 是全同步 API,跑在主进程事件循环。控制:created_at 索引 + list 分页上限。
// 单进程同步写 ⇒ 无并发写竞争。

import { createRequire } from 'node:module'
import { renameSync, existsSync } from 'node:fs'

// node:sqlite 用动态 require 加载,避开打包器(vite/rollup)对 `node:sqlite` 的静态解析
// (它会误把前缀剥成 'sqlite' 当本地模块找)。运行时是 Electron 35 / Node 22 内置。
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>

export type MessageType = 'text' | 'file'
export type Direction = 'sent' | 'recv'
export type MessageStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'sent'
  | 'done'
  | 'failed'
  | 'expired'
export type ErrorReason = 'busy' | 'enospc' | 'sha256' | 'network' | 'no-file' | 'unknown'

export interface Message {
  id: string
  type: MessageType
  direction: Direction
  peerFp: string
  peerAlias: string
  content: string | null
  fileName: string | null
  fileSize: number | null
  filePath: string | null
  status: MessageStatus
  errorReason: ErrorReason | null
  transferId: string | null
  createdAt: number
}

/** list 硬上限(DESIGN §11.3:禁止无分页全量查询) */
export const LIST_MAX_LIMIT = 200

interface Row {
  id: string
  type: string
  direction: string
  peer_fp: string
  peer_alias: string
  content: string | null
  file_name: string | null
  file_size: number | null
  file_path: string | null
  status: string
  error_reason: string | null
  transfer_id: string | null
  created_at: number
}

function rowToMessage(r: Row): Message {
  return {
    id: r.id,
    type: r.type as MessageType,
    direction: r.direction as Direction,
    peerFp: r.peer_fp,
    peerAlias: r.peer_alias,
    content: r.content,
    fileName: r.file_name,
    fileSize: r.file_size,
    filePath: r.file_path,
    status: r.status as MessageStatus,
    errorReason: r.error_reason as ErrorReason | null,
    transferId: r.transfer_id,
    createdAt: r.created_at
  }
}

export class MessageStore {
  private db: DatabaseSyncInstance

  /**
   * @param dbPath 数据库文件路径,或 ':memory:'(测试)
   * @param now 注入时钟(测试),默认 Date.now
   */
  constructor(
    dbPath: string,
    private readonly now: () => number = Date.now
  ) {
    this.db = this.openOrRebuild(dbPath)
    this.migrate()
  }

  /** 打开 DB;损坏则备份坏文件后重建(DESIGN §11.6) */
  private openOrRebuild(dbPath: string): DatabaseSyncInstance {
    try {
      return new DatabaseSync(dbPath)
    } catch (err) {
      if (dbPath !== ':memory:' && existsSync(dbPath)) {
        // 坏文件改名备份,不直接覆盖(留恢复余地)
        try {
          renameSync(dbPath, `${dbPath}.corrupt.${this.now()}`)
        } catch {
          // 备份失败也继续尝试重建
        }
      }
      return new DatabaseSync(dbPath) // 重建空库
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        direction    TEXT NOT NULL,
        peer_fp      TEXT NOT NULL,
        peer_alias   TEXT NOT NULL,
        content      TEXT,
        file_name    TEXT,
        file_size    INTEGER,
        file_path    TEXT,
        status       TEXT NOT NULL,
        error_reason TEXT,
        transfer_id  TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `)
  }

  /** 插入一条消息(createdAt 未给则用 now) */
  insert(msg: Omit<Message, 'createdAt'> & { createdAt?: number }): Message {
    const createdAt = msg.createdAt ?? this.now()
    this.db
      .prepare(
        `INSERT INTO messages
         (id,type,direction,peer_fp,peer_alias,content,file_name,file_size,file_path,status,error_reason,transfer_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        msg.id,
        msg.type,
        msg.direction,
        msg.peerFp,
        msg.peerAlias,
        msg.content,
        msg.fileName,
        msg.fileSize,
        msg.filePath,
        msg.status,
        msg.errorReason,
        msg.transferId,
        createdAt
      )
    return { ...msg, createdAt }
  }

  /** 更新状态(可带 error_reason / file_path)。返回更新后的消息,不存在返回 null。 */
  updateStatus(
    id: string,
    status: MessageStatus,
    extra?: { errorReason?: ErrorReason; filePath?: string }
  ): Message | null {
    const cur = this.get(id)
    if (!cur) return null
    const errorReason = extra?.errorReason ?? cur.errorReason
    const filePath = extra?.filePath ?? cur.filePath
    this.db
      .prepare(`UPDATE messages SET status=?, error_reason=?, file_path=? WHERE id=?`)
      .run(status, errorReason, filePath, id)
    return { ...cur, status, errorReason, filePath }
  }

  /** 按 transferId 更新状态(挂起会话用)。返回受影响的消息 id 列表。 */
  updateStatusByTransferId(
    transferId: string,
    status: MessageStatus,
    extra?: { errorReason?: ErrorReason }
  ): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE transfer_id=?`)
      .all(transferId) as unknown as { id: string }[]
    for (const { id } of rows) this.updateStatus(id, status, extra)
    return rows.map((r) => r.id)
  }

  /** 把所有 pending 消息标为 expired(App 启动时调用,DESIGN §11.6) */
  expireAllPending(): number {
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE status='pending'`)
      .all() as unknown as { id: string }[]
    for (const { id } of rows) this.updateStatus(id, 'expired')
    return rows.length
  }

  get(id: string): Message | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as unknown as Row | undefined
    return r ? rowToMessage(r) : null
  }

  /**
   * 拉历史(按 created_at 升序,聊天视图)。分页:before=游标(created_at),limit 上限 LIST_MAX_LIMIT。
   * 返回该页消息(升序)。
   */
  list(opts?: { limit?: number; before?: number }): Message[] {
    const limit = Math.min(opts?.limit ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
    let rows: Row[]
    if (opts?.before !== undefined) {
      // 取 before 之前最近的 limit 条,再升序返回
      rows = this.db
        .prepare(
          `SELECT * FROM (SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?)
           ORDER BY created_at ASC`
        )
        .all(opts.before, limit) as unknown as Row[]
    } else {
      // 最新 limit 条,升序
      rows = this.db
        .prepare(
          `SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT ?)
           ORDER BY created_at ASC`
        )
        .all(limit) as unknown as Row[]
    }
    return rows.map(rowToMessage)
  }

  close(): void {
    this.db.close()
  }
}

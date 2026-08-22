// 消息持久化(node:sqlite,见 docs/DESIGN §11.3)
//
// node:sqlite 是全同步 API,跑在主进程事件循环。控制:created_at 索引 + list 分页上限。
// 单进程同步写 ⇒ 无并发写竞争。

import { createRequire } from 'node:module'
import { renameSync, existsSync } from 'node:fs'

// 消息形状与状态词汇是 main 与 renderer 共享的同一份(见 shared/message 头部说明),
// 不在此重复声明——否则两侧各改各的、编译器不会察觉。
import type { Direction, ErrorReason, Message, MessageStatus, MessageType } from '@shared/message'

// node:sqlite 用动态 require 加载,避开打包器(vite/rollup)对 `node:sqlite` 的静态解析
// (它会误把前缀剥成 'sqlite' 当本地模块找)。运行时是 Electron 35 / Node 22 内置。
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>

/** list 硬上限(DESIGN §11.3:禁止无分页全量查询) */
export const LIST_MAX_LIMIT = 200

/**
 * messages 表的列声明 —— **建表与补列的唯一事实源**(见 migrate)。
 *
 * 改表结构就改这里,不要另写 ALTER:两处各写一份时,"加了列却忘了补"这种错
 * 在结构上就成为可能,而它只在老用户升级时才暴露。
 *
 * ⚠️ **新增列必须可空**(不写 NOT NULL、也不给默认值)。两个理由:
 * ①有数据的老库补列时,"NOT NULL 且无默认值"会被 SQLite 拒绝(空表却能加 ——
 *   所以开发时发现不了,只有老用户升级才炸);
 * ②用户装了新版写了库、再降级回旧版时,旧版的 INSERT 不带新列 —— 列不可空就写不进去。
 *
 * 改动之后别忘了往 messages.migrate.test.ts 的 HISTORY_SCHEMAS 追加改动前的建表语句,
 * 否则从那个版本升级的路径就此失去覆盖。
 */
export const MESSAGE_COLUMNS = {
  id: 'TEXT PRIMARY KEY',
  type: 'TEXT NOT NULL',
  direction: 'TEXT NOT NULL',
  peer_fp: 'TEXT NOT NULL',
  peer_alias: 'TEXT NOT NULL',
  content: 'TEXT',
  file_name: 'TEXT',
  file_size: 'INTEGER',
  file_path: 'TEXT',
  status: 'TEXT NOT NULL',
  error_reason: 'TEXT',
  transfer_id: 'TEXT',
  created_at: 'INTEGER NOT NULL',
  /** 传输总耗时(毫秒)。终态时写入;升级前的老消息为 null */
  duration_ms: 'INTEGER'
} as const

/**
 * 哪些终态该定格耗时。**与 message.ts 的 TERMINAL 不是一回事**:
 * 那张表答的是"还会不会有进度帧"(用于清理节流状态),这张答的是"传输真的发生过吗"。
 * 拒绝与过期都是终态,但一个字节都没传过,给它们一个耗时是在编造。
 */
/** 所有终态 —— 起点在这些状态下一律清掉,否则 Map 会随 rejected/expired 的消息无限增长 */
const TERMINAL_FOR_START = new Set<MessageStatus>(['done', 'failed', 'rejected', 'expired', 'sent'])

const RECORDS_DURATION: Record<MessageStatus, boolean> = {
  pending: false,
  accepted: false,
  sent: false, // 文本消息的终态;文本气泡没有文件行,无处显示耗时
  done: true,
  failed: true,
  rejected: false,
  expired: false
}

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
  duration_ms: number | null
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
    createdAt: r.created_at,
    // 老库的行没有这一列 → undefined,统一收敛成 null
    durationMs: r.duration_ms ?? null
  }
}

export class MessageStore {
  private db: DatabaseSyncInstance

  /**
   * 传输起点(消息 id → 时刻),**只在内存**。
   *
   * 不落库是有意的:从"开始"到"终态"必定在同一次运行内 —— app 重启则传输中断,
   * 那条消息根本走不到终态(启动时会被标 expired),也就不需要起点。为它加一个库字段
   * 只会多一列永远读不出意义的数据。
   *
   * 起点按方向取:发送方是**消息创建时刻**(点发送即开始,含发送前算摘要那段);
   * 接收方是**转 accepted 那一刻**(此前是用户自己在犹豫,不算传输)。
   */
  private readonly startedAt = new Map<string, number>()

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

  /**
   * 建表 + **按需补列**。两件事都从 `MESSAGE_COLUMNS` 派生,所以加列时只改那一处。
   *
   * 补列这一步不能省:`CREATE TABLE IF NOT EXISTS` 对**已存在的表是 no-op**,
   * 只把新列写进建表语句的话,新装用户一切正常,而老用户的库根本不会被加列,
   * 第一次写就 `table messages has no column named ...` 抛异常 —— 而这条路径
   * 只在"老库 + 新代码"下才走,日常开发库都是新建的,永远碰不到。守它的是
   * messages.migrate.test.ts。
   *
   * 每次启动都跑一遍(构造函数里调),因此**幂等**:已有的列跳过。不引版本号 ——
   * 列是否存在本身就是可查的事实,再维护一个版本号等于给同一件事记两笔账。
   */
  private migrate(): void {
    const defs = Object.entries(MESSAGE_COLUMNS)
      .map(([name, type]) => `${name} ${type}`)
      .join(',\n        ')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        ${defs}
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `)

    const existing = new Set(
      (
        this.db.prepare(`SELECT name FROM pragma_table_info('messages')`).all() as unknown as {
          name: string
        }[]
      ).map((r) => r.name)
    )
    for (const [name, type] of Object.entries(MESSAGE_COLUMNS)) {
      if (existing.has(name)) continue
      // ⚠️ 实测:ADD COLUMN 写成"NOT NULL 且无默认值"时,**空表能加、有数据的表会拒绝**
      // (Cannot add a NOT NULL column with default value NULL)。也就是说这道约束
      // **只在真实老库上生效** —— 开发时用的新建空库照样通过,又是一条只在升级路径上
      // 暴露的坑。别指望它替你把关,规矩写在 MESSAGE_COLUMNS 的注释里。
      this.db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
    }
  }

  /**
   * 插入一条消息(createdAt 未给则用 now)。
   * **durationMs 不在入参里**:它由本类在终态时算出并落库,调用方给不了也不该给 ——
   * 允许外部塞值等于允许伪造耗时。
   */
  insert(msg: Omit<Message, 'createdAt' | 'durationMs'> & { createdAt?: number }): Message {
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
    // 发送方:点发送即开始计时。接收方此刻还在等用户点接收,起点留到 accepted 时再记。
    if (msg.type === 'file' && msg.direction === 'sent' && !TERMINAL_FOR_START.has(msg.status)) {
      this.startedAt.set(msg.id, createdAt)
    }
    return { ...msg, createdAt, durationMs: null }
  }

  /**
   * 传输已用毫秒数(进行中的消息用)。没有起点时返回 null。
   * 终态的消息不走这里 —— 它们的耗时已定格在 durationMs 里。
   */
  elapsedMs(id: string): number | null {
    const started = this.startedAt.get(id)
    return started === undefined ? null : this.now() - started
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

    // 接收方的起点:用户点接收的那一刻(之前那段是他自己在犹豫,不算传输)
    if (status === 'accepted' && cur.type === 'file' && !this.startedAt.has(id)) {
      this.startedAt.set(id, this.now())
    }

    // 终态定格。**已有值不覆盖** —— 重复置终态(幂等重传、重复 respond)不得把它改写成后来的时间差。
    // 注:这条与下面的起点清理是**两道冗余防线**(清了起点就算不出新值,查了 null 就不会重算)。
    // 实测任一道单独失效功能仍正确,因此测试也只能守住两者的合取 —— 拆掉其中一道不会有东西报红,
    // 但系统就此只剩单点防护。要动它们中的任何一个,先想清楚另一个是否还在。
    // 拿不到起点时保持 null:老消息、重启后的残留都属这类,宁可不显示也不硬拿 createdAt 算。
    let durationMs = cur.durationMs
    if (durationMs === null && RECORDS_DURATION[status] === true) {
      const started = this.startedAt.get(id)
      if (started !== undefined) durationMs = this.now() - started
    }
    if (TERMINAL_FOR_START.has(status)) this.startedAt.delete(id)

    this.db
      .prepare(`UPDATE messages SET status=?, error_reason=?, file_path=?, duration_ms=? WHERE id=?`)
      .run(status, errorReason, filePath, durationMs, id)
    return { ...cur, status, errorReason, filePath, durationMs }
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

  /**
   * 已接收文件列表(§12.5,下载列表):recv + file + done,按接收时间降序(最新在前)。
   * 复用 created_at 索引;limit 上限 LIST_MAX_LIMIT。
   */
  listReceivedFiles(opts?: { limit?: number; before?: number }): Message[] {
    const limit = Math.min(opts?.limit ?? LIST_MAX_LIMIT, LIST_MAX_LIMIT)
    const where = `direction = 'recv' AND type = 'file' AND status = 'done'`
    const rows = (
      opts?.before !== undefined
        ? this.db
            .prepare(
              `SELECT * FROM messages WHERE ${where} AND created_at < ? ORDER BY created_at DESC LIMIT ?`
            )
            .all(opts.before, limit)
        : this.db
            .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
            .all(limit)
    ) as unknown as Row[]
    return rows.map(rowToMessage)
  }

  close(): void {
    this.db.close()
  }
}

// schema 迁移门禁。守的不是"这次加的那一列",而是**机制**:
// 任何一个历史版本的库,被新代码打开后列都必须齐全,且老数据不丢。
//
// 为什么这道门禁非有不可:`CREATE TABLE IF NOT EXISTS` 对**已存在的表是 no-op** ——
// 把新列写进建表语句,新装用户一切正常,而老用户的库根本不会被加列,第一次写就
// `table messages has no column named ...` 抛异常。这条路径只在"老库 + 新代码"这个
// 组合下才走,而日常开发里库都是新建的,**永远碰不到**。
//
// ⚠️ **下次改表结构时**:①往 `MESSAGE_COLUMNS` 加/改列(建表与补列都从它派生,不必另写 ALTER);
// ②把改动前的建表语句作为新的一条追加进下面的 `HISTORY_SCHEMAS`。漏了 ② 不会有任何东西报错,
// 但从那个版本升级的路径就此失去覆盖。
import { test, expect, describe, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { MessageStore, MESSAGE_COLUMNS } from './messages'

// 与生产代码同一手法:静态 import 'node:sqlite' 会被打包器把前缀剥成 'sqlite' 当本地模块找
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})
function tmpDb(name = 'messages.db'): string {
  dir = mkdtempSync(join(tmpdir(), 'mig-'))
  return join(dir, name)
}

/**
 * 历史 schema 快照 —— **取自当时真实的建表语句**,不是照着现在的结构删几列想出来的。
 * 每条代表"某个已发布版本的用户库长什么样",测试遍历它们验证都能升上来。
 */
const HISTORY_SCHEMAS: Array<{ name: string; ddl: string }> = [
  {
    name: 'v1 — 13 列(v1.2.0 及更早)',
    ddl: `CREATE TABLE messages (
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
    );`
  }
]

/** 按某个历史 DDL 造一个"老用户的库",塞两条老消息 */
function seedLegacyDb(path: string, ddl: string): void {
  const db = new DatabaseSync(path)
  db.exec(ddl)
  const ins = db.prepare(
    `INSERT INTO messages (id,type,direction,peer_fp,peer_alias,content,file_name,file_size,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  ins.run('old-text', 'text', 'recv', 'FP', 'Peer', '旧文本', null, null, 'done', 1000)
  ins.run('old-file', 'file', 'sent', 'FP', 'Peer', null, 'a.bin', 4096, 'done', 2000)
  db.close()
}

function columnsOf(path: string): string[] {
  const db = new DatabaseSync(path)
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('messages')`).all() as unknown as {
      name: string
    }[]
  ).map((r) => r.name)
  db.close()
  return cols
}

// 四条里只有第一条独立守得住机制:另外三条在"补列功能完全没实现"时也是绿的
// (老库照样能打开、不做 ALTER 当然幂等、没有新列当然不影响旧写法)。
// 它们是配套断言,防的是"补列时把别的东西弄坏了",不能拿来代替第一条。
describe('schema 迁移', () => {
  test.each(HISTORY_SCHEMAS)('$name 的库升级后,列必须齐全', ({ ddl }) => {
    const p = tmpDb()
    seedLegacyDb(p, ddl)
    // 前置:这个老库确实缺列,否则本用例什么都没验(自证不是空对空)
    const before = columnsOf(p)
    const missing = Object.keys(MESSAGE_COLUMNS).filter((c) => !before.includes(c))
    expect(missing.length, '老库应当缺至少一列,否则该快照已与当前结构相同,失去测试意义').toBeGreaterThan(0)

    new MessageStore(p).close()

    expect(columnsOf(p).sort()).toEqual(Object.keys(MESSAGE_COLUMNS).sort())
  })

  test.each(HISTORY_SCHEMAS)('$name 的库升级后,老数据一条不丢且读得出来', ({ ddl }) => {
    const p = tmpDb()
    seedLegacyDb(p, ddl)

    const store = new MessageStore(p)
    const all = store.list({ limit: 50 })
    store.close()

    expect(all.map((m) => m.id).sort()).toEqual(['old-file', 'old-text'])
    const text = all.find((m) => m.id === 'old-text')!
    expect(text.content, '老行的既有字段不能在迁移中被抹掉').toBe('旧文本')
    expect(text.createdAt).toBe(1000)
  })

  test('迁移是幂等的:重复打开同一个库不出错、列不重复', () => {
    const p = tmpDb()
    seedLegacyDb(p, HISTORY_SCHEMAS[0]!.ddl)

    new MessageStore(p).close()
    const once = columnsOf(p)
    new MessageStore(p).close()
    new MessageStore(p).close()

    expect(columnsOf(p)).toEqual(once)
  })

  /**
   * 降级安全:用户装了新版(库里已有新列)、又装回旧版。
   * 旧版的 INSERT 不带新列,**新列必须允许为空**,否则旧版一发消息就失败。
   * 这条守的是"新增列不得写成 NOT NULL 且无默认值"。
   */
  test('降级安全:不带新列的 INSERT 必须成功', () => {
    const p = tmpDb()
    new MessageStore(p).close() // 新版建库,列齐全

    const db = new DatabaseSync(p)
    const legacyCols = HISTORY_SCHEMAS[0]!.ddl
      .replace(/[\s\S]*\(/, '')
      .replace(/\)[\s;]*$/, '')
      .split(',')
      .map((l) => l.trim().split(/\s+/)[0]!)
      .filter(Boolean)
    const insert = (): void => {
      db.prepare(
        `INSERT INTO messages (id,type,direction,peer_fp,peer_alias,status,created_at) VALUES (?,?,?,?,?,?,?)`
      ).run('downgraded', 'text', 'recv', 'FP', 'Peer', 'done', 3000)
    }

    // arrayContaining([]) 对任何数组都真,是个恒真断言 —— 改成真的判定:旧列必须全在当前结构里
    expect(
      legacyCols.filter((c) => !Object.keys(MESSAGE_COLUMNS).includes(c)),
      '旧版的列必须全部仍存在于当前结构中,否则那是删列,不在本门禁的覆盖范围内'
    ).toEqual([])
    expect(insert, '旧版不带新列的写入不得失败 —— 新列必须可空').not.toThrow()
    db.close()
  })
})

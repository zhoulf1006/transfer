import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldStartSession, persistAndSend, type ShotState } from './screenshot-service'

// F1 守卫(§4.2):仅 idle 且无抓屏 in-flight 才启动新截图会话。
describe('shouldStartSession — F1 守卫', () => {
  it('idle 且未抓屏 → 启动', () => {
    expect(shouldStartSession('idle', false)).toBe(true)
  })

  it('idle 但抓屏 in-flight → 忽略(防并发抓屏)', () => {
    // 极端时序:上次 F1 已进 idle 但抓屏 promise 未结束,capturing 仍 true。
    expect(shouldStartSession('idle', true)).toBe(false)
  })

  it.each<ShotState>(['capturing', 'selecting', 'editing'])(
    '非 idle 态(%s)→ 忽略(editing 中按 F1 也忽略)',
    (state) => {
      expect(shouldStartSession(state, false)).toBe(false)
      expect(shouldStartSession(state, true)).toBe(false)
    }
  )
})

// 截图"发到聊天"的原图落盘策略(§4.2):成功保留原图(否则发送端缩略图读空文件→回退图标,
// 即本次修的 bug),失败删副本免碎片。dir 首次不存在需自动建。
describe('persistAndSend — 截图原图持久化', () => {
  const dirs: string[] = []
  function freshDir(): string {
    // 用一个尚不存在的子目录,顺带验证 mkdir recursive
    const d = join(mkdtempSync(join(tmpdir(), 'transfer-shot-')), 'sent-images')
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs) rmSync(join(d, '..'), { recursive: true, force: true })
    dirs.length = 0
  })

  const PNG = Buffer.from([1, 2, 3, 4])

  it('发送成功 → 文件写入且保留,返回路径', async () => {
    const dir = freshDir()
    let sentPath: string | null = null
    const ret = await persistAndSend(dir, 'a.png', PNG, async (p) => {
      // 发送时刻文件必须已存在(sendFiles 要能读到原图)
      expect(existsSync(p)).toBe(true)
      sentPath = p
    })
    expect(ret).toBe(join(dir, 'a.png'))
    expect(sentPath).toBe(join(dir, 'a.png'))
    // 关键:成功后文件仍在(此前 bug 是发完即删)
    expect(existsSync(join(dir, 'a.png'))).toBe(true)
    expect(readFileSync(join(dir, 'a.png')).equals(PNG)).toBe(true)
  })

  it('发送失败(send 抛)→ 删掉副本,返回 null', async () => {
    const dir = freshDir()
    const ret = await persistAndSend(dir, 'b.png', PNG, async () => {
      throw new Error('network')
    })
    expect(ret).toBeNull()
    // 失败:刚写的副本被删,不留碎片
    expect(existsSync(join(dir, 'b.png'))).toBe(false)
  })

  it('目录不存在 → 自动 mkdir recursive', async () => {
    const dir = freshDir() // 该目录此刻不存在
    expect(existsSync(dir)).toBe(false)
    await persistAndSend(dir, 'c.png', PNG, async () => {})
    expect(existsSync(join(dir, 'c.png'))).toBe(true)
  })
})

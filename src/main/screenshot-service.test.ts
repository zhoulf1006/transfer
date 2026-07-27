// 已知覆盖缺口:ensureScreenPermission 的**接线**无自动化覆盖 —— 它直接调模块顶层
// import 的 systemPreferences / desktopCapturer / dialog,没有注入 seam。因此
// "probe 分支真的调了 desktopCapturer"、"guide 分支真的弹了对话框" 只有决策
// (decideScreenPermission)被测到,动作本身没有。
// 补测条件:若将来这三者经 ScreenshotDeps 注入(与 getMainWindow / sendFiles 同法),
// 即可对 ensureScreenPermission 写行为测试。在此之前,该分支靠真机验证:
// `tccutil reset ScreenCapture <bundleId>` 后启动打包版按 F1,断言 app 出现在
// 「系统设置 → 隐私与安全性 → 屏幕录制」列表中(修复前不会出现,这正是死锁所在)。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldStartSession,
  shouldRestoreMain,
  decideScreenPermission,
  probeScreenAccess,
  persistAndSend,
  type ShotState
} from './screenshot-service'

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

// 隐主窗恢复守卫(§4.5):截图按钮触发时隐过主窗,endSession 才恢复。
// 覆盖:未隐过不恢复、隐过且当前隐藏才恢复、主窗已被其它路径显示则不再 show、无主窗不崩。
describe('shouldRestoreMain — 隐主窗恢复守卫', () => {
  it('本次隐过主窗 + 主窗存在 + 当前隐藏 → 恢复', () => {
    expect(shouldRestoreMain(true, true, false)).toBe(true)
  })

  it('本次未隐主窗(F1 路径)→ 不恢复(即使主窗恰好隐藏,也不是我们隐的)', () => {
    expect(shouldRestoreMain(false, true, false)).toBe(false)
  })

  it('隐过但主窗已不存在(被关闭)→ 不恢复(避免访问已销毁窗口)', () => {
    expect(shouldRestoreMain(true, false, false)).toBe(false)
  })

  it('隐过但主窗当前已可见(已被别的路径显示)→ 不重复 show', () => {
    expect(shouldRestoreMain(true, true, true)).toBe(false)
  })
})

// 截图"发到聊天"的原图落盘策略(§4.2):成功保留原图(否则发送端缩略图读空文件→回退图标,
// 即本次修的 bug),失败删副本免碎片。dir 首次不存在需自动建。
// 屏幕录制权限决策(§4.5)。macOS 上 getMediaAccessStatus('screen') 对**从未询问过**的
// app 返回 'denied' 而非 'not-determined'(底层是 CGPreflightScreenCaptureAccess 的布尔),
// 据此直接引导用户去系统设置会形成死锁:不调 desktopCapturer → macOS 不把 app 登记进
// 「屏幕录制」列表 → 用户在列表里找不到它 → 永远无法授权。
describe('decideScreenPermission — 屏幕录制权限决策', () => {
  it('未授权且尚未尝试采集 → 先探测(而非直接引导设置)', () => {
    // 真的调一次 desktopCapturer 是让 macOS 弹授权框并登记 app 的唯一途径。
    expect(decideScreenPermission('darwin', 'denied', false)).toBe('probe')
  })

  it('已授权 → 直接放行(不多做一次探测)', () => {
    expect(decideScreenPermission('darwin', 'granted', false)).toBe('proceed')
  })

  it('已探测过仍未授权 → 引导系统设置(此时 app 已被登记,用户找得到它)', () => {
    expect(decideScreenPermission('darwin', 'denied', true)).toBe('guide')
  })

  // 回归锁:旧实现对 denied / restricted 写了专门分支,是 bug 的一部分。
  // 现在的意图是"非 granted 一律同等对待",未来任何按 status 细分的改动都该在此处红。
  it.each(['denied', 'restricted', 'not-determined', 'unknown', '未来新增的状态'])(
    '非 granted 的任何 status(%s)一律先探测,不按状态细分',
    (status) => {
      expect(decideScreenPermission('darwin', status, false)).toBe('probe')
      expect(decideScreenPermission('darwin', status, true)).toBe('guide')
    }
  )

  it('非 macOS 恒放行:没有这项权限,任何 status 都不该拦', () => {
    // Windows 上 getMediaAccessStatus 恒 'granted',但不能靠它——真值是"平台没这个概念"。
    expect(decideScreenPermission('win32', 'denied', false)).toBe('proceed')
    expect(decideScreenPermission('win32', 'denied', true)).toBe('proceed')
  })
})

// 探测必须有界(§4.2 不变量:任何路径都不能让 state 卡在 capturing,否则 F1 被永久吞)。
// 探测发生在 beginSession 置 capturing=true 之后的 await 里 —— 挂起走不到 catch/finally,
// 会从"失败分支都回 idle"那条保护下面绕过去。
describe('probeScreenAccess — 探测有界', () => {
  it('探测永不返回 → 超时后仍然返回(不把 capturing 卡死)', async () => {
    const never = (): Promise<never> => new Promise<never>(() => {})
    await expect(probeScreenAccess(never, 10)).resolves.toBeUndefined()
  })

  it('探测已完成 → 立即返回,不干等满超时(已授权时不该白卡几秒)', async () => {
    const t0 = Date.now()
    await probeScreenAccess(async () => [], 10_000)
    // 显式断言耗时,不靠 vitest 全局 testTimeout 兜底 —— 那个一旦被调大,
    // 本条就会在实现坏掉(无条件等满超时)的情况下静默变绿。
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('探测抛异常 → 吞掉不外抛(授权与否以 status 复查为准,抛出去会把会话打成失败)', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('not authorized')
    }
    await expect(probeScreenAccess(boom, 10_000)).resolves.toBeUndefined()
  })
})

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

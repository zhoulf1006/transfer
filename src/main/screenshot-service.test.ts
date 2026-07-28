// 已知覆盖缺口:屏幕录制权限的两个**动作**无自动化覆盖 —— primeScreenPermission 真的
// 调了 desktopCapturer、ensureScreenPermission 真的弹了引导框,都直接依赖模块顶层 import
// 的 systemPreferences / desktopCapturer / dialog,没有注入 seam;被测到的只有决策
// (needsScreenPermission)。
// 补测条件:若将来这三者经 ScreenshotDeps 注入(与 getMainWindow / sendFiles 同法),
// 即可对二者写行为测试。在此之前靠真机验证:`tccutil reset ScreenCapture <bundleId>`
// 后启动打包版,断言①启动即弹系统授权框且不伴随自家引导框 ②app 出现在
// 「系统设置 → 隐私与安全性 → 屏幕录制」列表中(修复前不会出现,正是死锁所在)。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldStartSession,
  shouldRestoreMain,
  needsScreenPermission,
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

// 屏幕录制权限(§4.5)。macOS 上 getMediaAccessStatus('screen') 对**从未询问过**的 app
// 返回 'denied' 而非 'not-determined'(底层是 CGPreflightScreenCaptureAccess 的布尔,没有
// 第三态),所以"非 granted"既可能是没问过、也可能是问过被拒,单看它分不出来——本函数
// 因此不做区分,只回答"够不够用",由两个调用点各自决定怎么办:
//   启动时 → 触发一次系统询问(把 app 登记进「屏幕录制」列表)
//   按 F1 时 → 引导去系统设置
describe('needsScreenPermission — 是否缺屏幕录制权限', () => {
  it('macOS 未授权 → 缺', () => {
    expect(needsScreenPermission('darwin', 'denied')).toBe(true)
  })

  it('macOS 已授权 → 不缺', () => {
    expect(needsScreenPermission('darwin', 'granted')).toBe(false)
  })

  // 回归锁:最初的 bug 就是给 denied / restricted / not-determined 写了不同分支。
  // 意图是"非 granted 一律同等对待",未来任何按 status 细分的改动都该在此处红。
  it.each(['denied', 'restricted', 'not-determined', 'unknown', '未来新增的状态'])(
    '非 granted 的任何 status(%s)一律视为缺,不按状态细分',
    (status) => {
      expect(needsScreenPermission('darwin', status)).toBe(true)
    }
  )

  it('非 macOS 恒不缺:平台没有这项权限', () => {
    // Windows 上 getMediaAccessStatus 恒 'granted',但不能靠它——真值是"平台没这个概念"。
    expect(needsScreenPermission('win32', 'denied')).toBe(false)
  })
})

// 截图"发到聊天"的原图落盘策略(§4.2):成功保留原图(否则发送端缩略图读空文件→回退图标),
// 失败删副本免碎片。dir 首次不存在需自动建。
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

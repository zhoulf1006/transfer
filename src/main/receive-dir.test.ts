// 接收文件夹的决策逻辑(spec: receive-dir 的 A4/A5、C 组、D4)。
//
// 这里**不碰真实文件系统**:目录能不能用由外层探测后作为入参传进来。
// 这么切的理由是覆盖面——"所在卷已卸载""沙盒 bookmark 解析失败"这类状态在测试机上
// 难以复现,但它们进到决策这一层时形态完全相同(都只是"这个目录现在不可用"),
// 于是一个布尔入参就把整组失效分支都覆盖了。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveReceiveDir, chooseDir, displayPath, type ReceiveDirState } from './receive-dir'

const DEFAULT = '/Users/me/Downloads'
const CUSTOM = '/Volumes/SSD/收件'

/** 探针替身:只有列在 usable 里的目录算可用 */
const probe = (...usable: string[]) => (dir: string): boolean => usable.includes(dir)

const state = (chosen: string | null, notice = false): ReceiveDirState => ({ chosen, notice })

describe('resolveReceiveDir — 本次该往哪儿落,状态要不要改', () => {
  it('没选过自定义目录时用默认目录,状态不变', () => {
    const r = resolveReceiveDir(state(null), DEFAULT, probe(DEFAULT))
    expect(r.dir).toBe(DEFAULT)
    expect(r.next).toBeNull()
  })

  it('自定义目录可用时就用它,状态不变', () => {
    const r = resolveReceiveDir(state(CUSTOM), DEFAULT, probe(DEFAULT, CUSTOM))
    expect(r.dir).toBe(CUSTOM)
    expect(r.next).toBeNull()
  })

  /**
   * spec 的 C1(目录没了)/C2(不可写)/C3(卷已卸载)/C4(沙盒 bookmark 解析失败)在这一层
   * 是**同一个分支**——四种成因进到决策时都只剩"这个目录现在不可用"这一个布尔。
   *
   * 所以这里只写一条。拆成四条 `it.each` 会让覆盖清单上多出三行,而它们跑的是
   * 一模一样的输入、验的是一模一样的分支——记账虚增,且掩盖了"成因的区分发生在探测层"
   * 这个真实结构。四种成因各自能不能被探测出来,是 isDirWritable 的事,不在这里。
   */
  it('C1-C4 自定义目录不可用(不论何种成因) → 退回默认目录并置告知标记', () => {
    const r = resolveReceiveDir(state(CUSTOM), DEFAULT, probe(DEFAULT))
    expect(r.dir).toBe(DEFAULT)
    expect(r.next).toEqual({ chosen: null, notice: true })
  })

  it('C5 收文件前才发现失效:本次仍给出默认目录(文件不能因此收不到)', () => {
    const r = resolveReceiveDir(state(CUSTOM), DEFAULT, probe(DEFAULT))
    expect(r.dir).toBe(DEFAULT)
  })

  it('C7 退回之后目录又可用了,也不会自己切回去', () => {
    // 退回时 chosen 已被清成 null,原路径没有留存 —— 于是"目录回来了"这件事
    // 在决策这一层根本不可观测。断言的正是这个不可观测性。
    const afterFallback = state(null, true)
    const r = resolveReceiveDir(afterFallback, DEFAULT, probe(DEFAULT, CUSTOM))
    expect(r.dir).toBe(DEFAULT)
    expect(r.next).toBeNull()
  })

  it('C8 重选的新目录又失效:标记重新置位', () => {
    const dismissed = state(CUSTOM, false) // 用户此前点过「知道了」
    const r = resolveReceiveDir(dismissed, DEFAULT, probe(DEFAULT))
    expect(r.next).toEqual({ chosen: null, notice: true })
  })

  it('已经有未读告知时再次失效,不重复改写状态', () => {
    // chosen 已是 null,没有可失效的自定义目录 —— 不该产生新的状态变更
    const r = resolveReceiveDir(state(null, true), DEFAULT, probe(DEFAULT))
    expect(r.next).toBeNull()
  })
})

describe('chooseDir — 用户在选择器里选定之后', () => {
  it('选了个新目录:记下它,并告知调用方"确实变了"', () => {
    const r = chooseDir(CUSTOM, DEFAULT, state(null))
    expect(r.state).toEqual({ chosen: CUSTOM, notice: false })
    expect(r.changed).toBe(true)
  })

  it('A5 选中的正好是系统下载目录 → 等同恢复默认,不留自定义记录', () => {
    const r = chooseDir(DEFAULT, DEFAULT, state(CUSTOM))
    expect(r.state.chosen).toBeNull()
    expect(r.changed).toBe(true)
  })

  it('A4 选中的就是当前正在用的那个 → 不算变化', () => {
    const r = chooseDir(CUSTOM, DEFAULT, state(CUSTOM))
    expect(r.changed).toBe(false)
  })

  it('A4 当前是默认,又选了默认 → 不算变化', () => {
    const r = chooseDir(DEFAULT, DEFAULT, state(null))
    expect(r.changed).toBe(false)
  })

  it('D4 选定新目录会顺带清掉未读告知(重新选择即等于已处理)', () => {
    const r = chooseDir(CUSTOM, DEFAULT, state(null, true))
    expect(r.state.notice).toBe(false)
  })

  it('D4 即使这次没真的换目录,也清掉告知', () => {
    // 用户看到告知后点「更改…」,却又选了同一个目录 —— 他显然已经读到了那条告知
    const r = chooseDir(DEFAULT, DEFAULT, state(null, true))
    expect(r.changed).toBe(false)
    expect(r.state.notice).toBe(false)
  })
})

// ── 展示用路径(spec F1/F2/F6) ──
// 这一组用**真实文件系统**:符号链接的解析行为正是要验的东西,用替身等于什么也没验。
describe('displayPath — 展示给用户看的路径', () => {
  const dirs: string[] = []
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'transfer-dp-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('F1 符号链接解析成它指向的真实目录(沙盒容器里的 Downloads 就是这个形态)', () => {
    const root = mk()
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    const got = displayPath(link)
    // 不写成 toBe(realpathSync(real)):那是拿实现的同一个调用去算期望值,
    // 等于断言 realpathSync 等于它自己,displayPath 换成任何解析实现都照样绿。
    // 改断两件可观察的事:确实变了,且落在那个真实目录上。
    expect(got).not.toBe(link)
    expect(got.endsWith('/real')).toBe(true)
  })

  it('F5 路径含非 ASCII 字符时照常解析', () => {
    const root = mk()
    const real = join(root, '收件 文件夹')
    const link = join(root, '链接')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(displayPath(link).endsWith('/收件 文件夹')).toBe(true)
  })

  it('F2 普通目录:解析是空操作,路径不变', () => {
    const d = realpathSync(mk())
    expect(displayPath(d)).toBe(d)
  })

  it('F6 路径不存在 → 原样返回,不抛也不给空串', () => {
    const gone = join(mk(), 'nope')
    expect(displayPath(gone)).toBe(gone)
  })

  it('F6 断链的符号链接 → 原样返回', () => {
    const root = mk()
    const link = join(root, 'dangling')
    symlinkSync(join(root, 'never-existed'), link)
    expect(displayPath(link)).toBe(link)
  })
})

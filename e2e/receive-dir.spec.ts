// e2e:接收文件夹(spec receive-dir)。
//
// 这里只守**一条只有渲染层才暴露的接线**:三个操作立即生效——改完不点「保存」也算数。
// 单测看不到它:决策与归一化都在 main 侧,是否落盘取决于渲染端有没有把「保存」当必经之路,
// 而那只有真的点一遍界面才知道。同页的自动接收开关恰恰是相反语义(必须点保存),
// 两者外观上毫无区别,写错了不会有任何东西变红。
//
// 另守一条端到端链路:预置一个不存在的目录 → 启动时的检测应自己退回默认并置告知。
//
// 运行不打扰使用者:每个用例独立 userData + TRANSFER_E2E_QUIET(见 ui-icons.spec.ts 的说明)。
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
  accessSync,
  constants
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'

interface Launched {
  app: ElectronApplication
  userData: string
}

/**
 * seed:写进 settings.json 的初始内容(测失效退回、自选态都靠它构造)。
 * recheckMs:复验间隔。产品默认 5 秒 × 3 次 = 15 秒,每条用例真等 15 秒不现实;
 * 注入小值只压缩节奏,重试次数与判定逻辑不变(见 receive-dir.ts 的 RECHECK_DELAY_MS)。
 */
async function launch(seed?: Record<string, unknown>, recheckMs = 200): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'transfer-recvdir-e2e-'))
  if (seed) writeFileSync(join(userData, 'settings.json'), JSON.stringify(seed))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TRANSFER_E2E_QUIET: '1',
      TRANSFER_USERDATA: userData,
      TRANSFER_RECHECK_MS: String(recheckMs)
    }
  })
  return { app, userData }
}

async function close(l: Launched): Promise<void> {
  await l.app.close()
  rmSync(l.userData, { recursive: true, force: true })
}

/** 直接读盘验证,不经界面回读——界面显示对但没落盘,正是本文件要抓的那种错 */
function settingsOnDisk(userData: string): Record<string, unknown> {
  const f = join(userData, 'settings.json')
  if (!existsSync(f)) return {}
  return JSON.parse(readFileSync(f, 'utf8'))
}

async function openSettings(l: Launched): Promise<void> {
  const page = await l.app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('btn-settings').click()
  await page.getByTestId('btn-open-receive-dir').waitFor()
}

test('「恢复默认」立即落盘,不需要点「保存」', async () => {
  const custom = mkdtempSync(join(tmpdir(), 'my-recv-'))
  const l = await launch({ receiveDir: custom, receiveDirNotice: false })
  try {
    await openSettings(l)
    const page = await l.app.firstWindow()
    // 前置:确认它真的处在自选态,否则下面点的是一个不存在的按钮,断言会因别的原因绿
    expect(settingsOnDisk(l.userData).receiveDir).toBe(custom)

    await page.getByTestId('btn-reset-receive-dir').click()
    await expect(page.getByTestId('btn-reset-receive-dir')).toHaveCount(0) // 已是默认 → 按钮消失

    // **不点保存**,直接读盘
    expect(settingsOnDisk(l.userData).receiveDir).toBeNull()
  } finally {
    await close(l)
    rmSync(custom, { recursive: true, force: true })
  }
})

test('「知道了」立即落盘,不需要点「保存」', async () => {
  const l = await launch({ receiveDir: null, receiveDirNotice: true })
  try {
    await openSettings(l)
    const page = await l.app.firstWindow()
    await expect(page.getByTestId('receive-dir-notice')).toBeVisible()

    await page.getByTestId('btn-dismiss-receive-dir-notice').click()
    await expect(page.getByTestId('receive-dir-notice')).toHaveCount(0)

    expect(settingsOnDisk(l.userData).receiveDirNotice).toBe(false)
  } finally {
    await close(l)
  }
})

test('「更改…」选定后立即落盘,并提示旧文件仍在原处', async () => {
  const picked = mkdtempSync(join(tmpdir(), 'picked-recv-'))
  const l = await launch()
  try {
    // 替掉的是 **Electron 的系统对话框**(外部边界),不是项目自己的模块:
    // 原生模态在自动化里驱动不了,而这条用例要验的是"选定之后发生了什么"。
    await l.app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    }, picked)

    await openSettings(l)
    const page = await l.app.firstWindow()
    await page.getByTestId('btn-change-receive-dir').click()
    await expect(page.getByTestId('btn-reset-receive-dir')).toBeVisible() // 进入自选态
    await expect(page.getByTestId('receive-dir-moved')).toBeVisible() // 旧文件仍在原处的提示

    // 路径经 realpath 存盘(macOS 下 /var → /private/var),故比对末段而非整串
    const saved = settingsOnDisk(l.userData).receiveDir
    expect(typeof saved).toBe('string')
    expect(String(saved).endsWith(picked.split('/').pop() as string)).toBe(true)
  } finally {
    await close(l)
    rmSync(picked, { recursive: true, force: true })
  }
})

test('选中一个符号链接目录 → 存的是它指向的真身(A7)', async () => {
  const real = mkdtempSync(join(tmpdir(), 'real-recv-'))
  const link = join(mkdtempSync(join(tmpdir(), 'link-root-')), 'link')
  symlinkSync(real, link)
  const l = await launch()
  try {
    await l.app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, link)
    await openSettings(l)
    const page = await l.app.firstWindow()
    await page.getByTestId('btn-change-receive-dir').click()
    await expect(page.getByTestId('btn-reset-receive-dir')).toBeVisible()

    // 存真身而不是链接:两者指向同一个地方,但存链接的话链接一旦被删,
    // 目标目录明明还在,却会被判成失效并退回默认。
    const saved = String(settingsOnDisk(l.userData).receiveDir)
    expect(saved.endsWith(real.split('/').pop() as string)).toBe(true)
  } finally {
    await close(l)
    rmSync(real, { recursive: true, force: true })
  }
})

test('告知不点「知道了」就关掉设置页,下次打开仍在(D2)', async () => {
  const l = await launch({ receiveDir: null, receiveDirNotice: true })
  try {
    await openSettings(l)
    const page = await l.app.firstWindow()
    await expect(page.getByTestId('receive-dir-notice')).toBeVisible()

    // 关掉设置页再开。这个弹层靠**点遮罩**关闭,没有 Escape 处理——
    // 用 Escape 的话它不会关,后续点击被遮罩挡住,表现成超时而不是断言失败。
    // 弹层居中,(5,5) 必落在遮罩上。
    await page.mouse.click(5, 5)
    await expect(page.getByTestId('btn-open-receive-dir')).toHaveCount(0) // 确认真的关了
    await page.getByTestId('btn-settings').click()
    await expect(page.getByTestId('receive-dir-notice')).toBeVisible()
    expect(settingsOnDisk(l.userData).receiveDirNotice).toBe(true)
  } finally {
    await close(l)
  }
})

test('选中的正好是系统下载目录 → 等同恢复默认,不留自定义记录(A5)', async () => {
  const l = await launch()
  try {
    // 让选择器返回 app 认定的默认下载目录本身
    await l.app.evaluate(async ({ app, dialog }) => {
      const d = app.getPath('downloads')
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] })
    })
    await openSettings(l)
    const page = await l.app.firstWindow()
    await page.getByTestId('btn-change-receive-dir').click()
    // 记成自定义就会冒出「恢复默认」,而那个按钮在默认态下点了什么也不会发生
    await expect(page.getByTestId('btn-reset-receive-dir')).toHaveCount(0)
    expect(settingsOnDisk(l.userData).receiveDir).toBeNull()
  } finally {
    await close(l)
  }
})

test('取消选择器 → 什么都不变(A1)', async () => {
  const l = await launch()
  try {
    await l.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await openSettings(l)
    const page = await l.app.firstWindow()
    // 断言的对象是"前后没变化"本身,不是某个具体取值:
    // 只断 receiveDir 为 null 的话,一个全新 profile 上它本来就是 null,
    // 那条断言在"取消根本没被处理"时照样绿。
    const before = JSON.stringify(settingsOnDisk(l.userData))
    await page.getByTestId('btn-change-receive-dir').click()
    // 仍是默认态:「恢复默认」不该冒出来,也不该提示"旧文件仍在原处"
    await expect(page.getByTestId('btn-reset-receive-dir')).toHaveCount(0)
    await expect(page.getByTestId('receive-dir-moved')).toHaveCount(0)
    expect(JSON.stringify(settingsOnDisk(l.userData))).toBe(before)
  } finally {
    await close(l)
  }
})

test('启动时目录已不可用 → 经复验后退回默认并给出告知(C1)', async () => {
  // 整条链路:启动检测 → 复验 → 决策 → 写回设置 → 设置页显示告知。
  // 退回**不是立即**发生的(C12:先给瞬时抖动一次恢复的机会),所以这里等复验窗口过去;
  // 设置页要重开一次才看得到——它的状态是打开那一刻拉的,不订阅后续变化。
  const l = await launch({ receiveDir: '/Volumes/NoSuchDisk/收件', receiveDirNotice: false })
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => settingsOnDisk(l.userData).receiveDir, { timeout: 6000 }).toBeNull()

    await openSettings(l)
    await expect(page.getByTestId('receive-dir-notice')).toBeVisible()
    // 已退回默认 → 不该有「恢复默认」
    await expect(page.getByTestId('btn-reset-receive-dir')).toHaveCount(0)

    const s = settingsOnDisk(l.userData)
    expect(s.receiveDir).toBeNull()
    expect(s.receiveDirNotice).toBe(true)
  } finally {
    await close(l)
  }
})

test('「打开文件夹」打开的是**当前**接收文件夹,不是系统下载目录(E4)', async () => {
  const custom = mkdtempSync(join(tmpdir(), 'open-recv-'))
  const l = await launch({ receiveDir: custom, receiveDirNotice: false })
  try {
    // 记录 shell.openPath 收到的路径。替的是 Electron 的外壳 API(系统边界),
    // 且这里要验的恰恰是"传给系统的是哪个路径"——没有别的观察点。
    await l.app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      shell.openPath = async (p: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(p)
        return ''
      }
    })
    await openSettings(l)
    const page = await l.app.firstWindow()
    await page.getByTestId('btn-open-receive-dir').click()
    await page.waitForTimeout(120)

    const opened = await l.app.evaluate(
      () => (globalThis as unknown as { __opened: string[] }).__opened
    )
    expect(opened).toHaveLength(1)
    expect(opened[0]).toBe(custom)
  } finally {
    await close(l)
    rmSync(custom, { recursive: true, force: true })
  }
})

// ── C12:瞬时不可用不该造成不可逆退回 ──
// 一次探测失败就清掉用户的选择,意味着拔一次盘、网络卷抖一下,配置就永久没了
// (「退回即忘」下路径找不回来)。所以探不到时先不下结论,隔一会儿复验,仍失败才退回。

test('C12 探不到时先落默认,连着复验 3 次仍不可用才退回', async () => {
  const RECHECK = 400 // 3 次 = 1200ms 才到阈值
  const l = await launch({ receiveDir: '/Volumes/NoSuchDisk/收件', receiveDirNotice: false }, RECHECK)
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 启动判定刚跑完:这一刻还不该下结论
    expect(settingsOnDisk(l.userData).receiveDir).toBe('/Volumes/NoSuchDisk/收件')

    // 跨过第 1 次复验,仍不该退回 —— 这一条把"重试多次"与"只重试一次"区分开:
    // 若实现只等一轮就下结论,此刻已经是 null 了。
    await page.waitForTimeout(RECHECK * 1.5)
    expect(settingsOnDisk(l.userData).receiveDir).toBe('/Volumes/NoSuchDisk/收件')

    // 三次都探不到之后才退回
    await expect.poll(() => settingsOnDisk(l.userData).receiveDir, { timeout: 8000 }).toBeNull()
    expect(settingsOnDisk(l.userData).receiveDirNotice).toBe(true)
  } finally {
    await close(l)
  }
})

test('C12 探测失败但复验前就恢复了 → 保住用户的选择,不退回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flaky-recv-'))
  // 前置:确认 chmod 000 在本环境下**真的**挡得住写入。root 下挡不住,
  // 那样整条用例会变成一个恒真的绿——宁可显式跳过。
  chmodSync(dir, 0o000)
  let blocked = false
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    blocked = true
  }
  if (!blocked) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
    test.skip(true, '本环境下 chmod 000 挡不住写入(多半以 root 运行),此用例无法成立')
    return
  }

  const RECHECK = 300
  const l = await launch({ receiveDir: dir, receiveDirNotice: false }, RECHECK)
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 模拟"抖了一下就好了":在复验发生之前恢复权限
    chmodSync(dir, 0o755)

    // 等够整个重试窗口(3 次)+ 余量,它**不该**被退回
    await page.waitForTimeout(RECHECK * 5)
    expect(settingsOnDisk(l.userData).receiveDir).toBe(dir)
    expect(settingsOnDisk(l.userData).receiveDirNotice).toBe(false)
  } finally {
    await close(l)
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C12 抖动→恢复→再抖动:计数不跨抖动累积,不会被攒够次数误判', async () => {
  // 反复抖动的网络卷正是 C12 要防的场景。若复验成功时不把计数清零,
  // 几次互不相干的抖动会攒够阈值,把用户的配置误判成失效 —— 而每一次抖动
  // 单独看都在窗口内恢复了,本不该出事。
  const dir = mkdtempSync(join(tmpdir(), 'flap-recv-'))
  chmodSync(dir, 0o000)
  let blocked = false
  try {
    accessSync(dir, constants.W_OK)
  } catch {
    blocked = true
  }
  if (!blocked) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
    test.skip(true, '本环境下 chmod 000 挡不住写入(多半以 root 运行),此用例无法成立')
    return
  }

  const RECHECK = 300
  const l = await launch({ receiveDir: dir, receiveDirNotice: false }, RECHECK)
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // 第一次抖动:让它复验到 1 次失败,然后恢复
    await page.waitForTimeout(RECHECK * 1.5)
    chmodSync(dir, 0o755)
    await page.waitForTimeout(RECHECK * 1.5) // 这一轮复验会看到"可用",计数应清零

    // 第二次抖动。开设置页触发一次取目录,好让复验重新排上
    chmodSync(dir, 0o000)
    await page.getByTestId('btn-settings').click()
    await page.getByTestId('btn-open-receive-dir').waitFor()
    await page.waitForTimeout(RECHECK * 2.5) // 够两次复验,但不够三次

    // 计数若跨抖动累积,此刻已被误判失效
    expect(settingsOnDisk(l.userData).receiveDir).toBe(dir)
    expect(settingsOnDisk(l.userData).receiveDirNotice).toBe(false)
  } finally {
    await close(l)
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

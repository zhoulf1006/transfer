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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'

interface Launched {
  app: ElectronApplication
  userData: string
}

/** seed:写进 settings.json 的初始内容(测失效退回、自选态都靠它构造) */
async function launch(seed?: Record<string, unknown>): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'transfer-recvdir-e2e-'))
  if (seed) writeFileSync(join(userData, 'settings.json'), JSON.stringify(seed))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TRANSFER_E2E_QUIET: '1',
      TRANSFER_USERDATA: userData
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

test('启动时目录已不可用 → 自动退回默认并给出告知(C1)', async () => {
  // 整条链路:启动检测 → 决策 → 写回设置 → 设置页显示告知
  const l = await launch({ receiveDir: '/Volumes/NoSuchDisk/收件', receiveDirNotice: false })
  try {
    await openSettings(l)
    const page = await l.app.firstWindow()
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

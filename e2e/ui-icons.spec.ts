// e2e:界面规范的渲染级验收(ui-design §7 —— typecheck 与单测都读不到"它渲染在哪、盖住了谁")。
//
// 这里守的是两条只在渲染层暴露、且**不报错**的失效:
//   ① 图标按钮用字符当图标 —— 类型检查看不见,单测看不见,只有渲染出来才知道;
//   ② 内联 style 写了 background,把 class 的 :hover 整条压死 —— 浏览器不报错、
//      typecheck 不拦截,表现只是"hover 毫无反应",是最容易长期漏掉的一类。
//
// 运行不打扰使用者:每个用例独立 userData(单实例锁按 userData 分域,不与用户正在跑的实例撞)、
// TRANSFER_E2E_QUIET 让窗口不显示/不注册全局快捷键/不起网络服务。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'

interface Launched {
  app: ElectronApplication
  userData: string
  errors: string[]
}

async function launch(): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'transfer-e2e-'))
  const errors: string[] = []
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // 静音三件事见 src/main/index.ts 的 QUIET 定义
      TRANSFER_E2E_QUIET: '1',
      // userData 双保险:--user-data-dir 由 Chromium 认,TRANSFER_USERDATA 由主进程认。
      // 只给前者时主进程若走 setPath 分支仍会落到真实目录,污染用户数据。
      TRANSFER_USERDATA: userData
    }
  })
  app.process().stderr?.on('data', (b: Buffer) => {
    const t = b.toString()
    if (/Error occurred in handler|UnhandledPromiseRejection|TypeError/.test(t)) errors.push(t.trim())
  })
  return { app, userData, errors }
}

async function close(l: Launched): Promise<void> {
  await l.app.close()
  rmSync(l.userData, { recursive: true, force: true })
}

test('设置页的目录按钮是内联 SVG,不是字符图标', async () => {
  const l = await launch()
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // 开设置弹层(按 title 定位,不依赖 DOM 顺序)
    await page.getByTestId('btn-settings').click()

    const btn = page.getByTestId('btn-open-downloads')
    await expect(btn).toBeVisible()

    // 图标必须是 SVG;按钮里不得出现任何可见文本(字符图标会以文本形式存在)
    await expect(btn.locator('svg')).toHaveCount(1)
    expect((await btn.innerText()).trim()).toBe('')

    // 盒模型:固定尺寸 + 居中(§6:不得靠 font-size/padding 撑尺寸)
    const box = await btn.evaluate((el) => {
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), display: s.display, place: s.placeItems }
    })
    expect(box).toMatchObject({ w: 22, h: 22, display: 'grid' })
    expect(box.place).toContain('center')

    expect(l.errors).toEqual([])
  } finally {
    await close(l)
  }
})

test('每个 .tf-icon-btn 的 hover 底色都真的生效(内联未压死 :hover)', async () => {
  const l = await launch()
  try {
    const page = await l.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    /**
     * 关过渡:`.tf-icon-btn` 有 `transition: background .12s`,强制 hover 后立刻读会量到
     * **过渡途中的中间值**(实测读到 rgba(20,22,26,0.004),约为终值的十分之一),
     * 断言随读取时机漂移。走 app 自己的 reduced-motion 通道(theme.css 里已有
     * `@media (prefers-reduced-motion: reduce)` 把 transition 置 none),而不是注入样式——
     * 这样关掉的是产品自身的机制,不引入测试专用的第二套行为。
     */
    await page.emulateMedia({ reducedMotion: 'reduce' })

    const varHover = (
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--hover').trim()
      )
    ).replace(/\s/g, '')
    expect(varHover, '--hover 必须有定义,否则下面的断言会拿空串对空串').not.toBe('')

    /**
     * 用 CDP 的 CSS.forcePseudoState 而不是 page.hover():QUIET 下窗口从不显示,
     * **真实指针事件进不去**(隐藏窗口的例外,与焦点语义同类),用 hover() 会得到一个
     * 与改动无关的假红。forcePseudoState 让级联在 :hover 下重新求值,正是本条要验的东西
     * ——class 的 :hover 规则有没有被内联 background 压掉。
     *
     * 它**不覆盖**"指针能否真的够到该元素"(遮挡、层叠),那是另一类问题,本用例不声称验了它。
     */
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const doc = (await cdp.send('DOM.getDocument', { depth: -1 })) as { root: { nodeId: number } }

    /**
     * 逐个验,不验一处推断其余:三个按钮的内联 style 各不相同(iconBtn 26x26 / storageIconBtn 22x22),
     * 而"内联是否含 background"正是本条要守的不变量,只能逐个看。
     */
    const checkHover = async (testId: string): Promise<void> => {
      const b = page.getByTestId(testId)
      await expect(b).toBeVisible()

      const inlineProps: string[] = await b.evaluate((el) => Array.from((el as HTMLElement).style))
      expect(inlineProps, `${testId} 的内联 style 不应含 background`).not.toContain('background')

      const found = (await cdp.send('DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: `[data-testid="${testId}"]`
      })) as { nodeIds: number[] }
      expect(found.nodeIds.length, `${testId} 应能在 DOM 中定位到`).toBe(1)
      const nodeId = found.nodeIds[0]!

      const base = await b.evaluate((el) => getComputedStyle(el).backgroundColor)
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
      const hovered = await b.evaluate((el) => getComputedStyle(el).backgroundColor)
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })

      expect(hovered, `${testId}: hover 底色应变化`).not.toBe(base)
      expect(hovered.replace(/\s/g, ''), `${testId}: hover 底色应等于 --hover`).toBe(varHover)
    }

    await checkHover('btn-theme')
    await checkHover('btn-settings')

    // 设置页那个要先开弹层才存在
    await page.getByTestId('btn-settings').click()
    await checkHover('btn-open-downloads')

    expect(l.errors).toEqual([])
  } finally {
    await close(l)
  }
})

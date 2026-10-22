// e2e: copying a chat image from its right-click menu (spec transfer-chat, US-001, REQ-001 to REQ-003).
//
// How a chat gets opened without a peer: quiet instances run no discovery (they would announce on the
// LAN), so the test seeds the message store with image messages from one made-up peer, then sends the
// renderer a device-list update naming that peer — the channel discovery uses in the product. The
// device only opens the chat; nothing here talks to it.
//
// Gaps, with the condition under which each could be closed:
// - The hidden test window takes no real pointer input (see ui-icons.spec.ts), so right-clicks and clicks
//   are dispatched as DOM events; whether a real pointer reaches the thumbnail (nothing covering it) is
//   checked by rendering the app. Closable by a shown window driven with page.mouse, e.g. under xvfb in CI.
// - That a *failed* copy shows nothing either (US-001/AC-03) is not asserted: the failing cases await the
//   copy command directly (see below), so the menu's handling of a failure is not driven. Closable only
//   if the menu's copy gave the test something to wait on.
// - Windows: whether nativeImage ignores the EXIF orientation there is not measured; this file runs on
//   macOS locally and Linux in CI. Closable by a Windows run of this file.
//
// Cost accepted by the user (2026-10-22): run on a developer's machine, this file overwrites the real
// system clipboard.
//
// One app instance for the whole file: every case uses the same seeded chat. Cases that change a file
// own that file, and every clipboard case writes its own sentinel first.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { MessageStore } from '../src/main/db/messages'
import { EVT } from '../src/shared/ipc'
import type { TransferApi } from '../src/preload'
import { injectMetadata, phoneMetadata } from '../src/main/image-orientation.fixture'

const PEER = 'e2e-image-peer-fingerprint'
const ALIAS = 'E2E Image Peer'
const TIP = { zh: '点击查看原图 · 右键复制或保存', en: 'Click to view · Right-click to copy or save' }

let app: ElectronApplication
let page: Page
let userData: string
let files: string

/**
 * A two-colour image encoded by the app's own encoder: left half red, right half blue. With `mark`, a
 * green 30x30 square sits at the stored top-left, so a mirror and a turn can be told apart.
 */
async function encode(kind: 'png' | 'jpeg', width: number, height: number, mark = false): Promise<Buffer> {
  const b64 = await app.evaluate(
    ({ nativeImage }, [k, w, h, m]) => {
      const bmp = Buffer.alloc(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4 // BGRA
          if (m && x < 30 && y < 30) bmp[i + 1] = 255
          else if (x < w / 2) bmp[i + 2] = 255
          else bmp[i] = 255
          bmp[i + 3] = 255
        }
      }
      const img = nativeImage.createFromBitmap(bmp, { width: w, height: h })
      return (k === 'png' ? img.toPNG() : img.toJPEG(95)).toString('base64')
    },
    [kind, width, height, mark] as const
  )
  return Buffer.from(b64, 'base64')
}

interface ClipboardState {
  text: string
  formats: string[]
  width: number
  height: number
  /** dominant colour at the given points: 'red', 'green', 'blue' or 'other' */
  colours: string[]
}

/** Reads the system clipboard in the main process; `points` are pixel positions to sample */
async function readClipboard(points: Array<[number, number]> = []): Promise<ClipboardState> {
  return app.evaluate(({ clipboard }, pts) => {
    const img = clipboard.readImage()
    const { width, height } = img.getSize()
    const bmp = img.isEmpty() ? Buffer.alloc(0) : img.toBitmap()
    const colours = pts.map(([x, y]) => {
      const i = (y * width + x) * 4
      const [b, g, r] = [bmp[i], bmp[i + 1], bmp[i + 2]]
      if (r > 180 && g < 80 && b < 80) return 'red'
      if (g > 180 && r < 80 && b < 80) return 'green'
      if (b > 180 && r < 80 && g < 80) return 'blue'
      return 'other'
    })
    return { text: clipboard.readText(), formats: clipboard.availableFormats(), width, height, colours }
  }, points)
}

async function setSentinel(s: string): Promise<void> {
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), s)
}

/** Lets a scroll finish before a menu opens: the scroll event that closes menus fires a frame later */
async function afterScroll(): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

async function scrollTo(alt: string, block: ScrollLogicalPosition): Promise<void> {
  await page.locator(`img[alt="${alt}"]`).evaluate((el, b) => el.scrollIntoView({ block: b }), block)
  await afterScroll()
}

/** Right-click a thumbnail where a pointer would be, at its centre unless a position is given */
async function rightClick(alt: string, at?: { x: number; y: number }): Promise<void> {
  const thumb = page.locator(`img[alt="${alt}"]`)
  await expect(thumb).toBeVisible()
  const box = (await thumb.boundingBox())!
  const x = at?.x ?? box.x + box.width / 2
  const y = at?.y ?? box.y + box.height / 2
  // Built in the page: Playwright's dispatchEvent('contextmenu') creates a plain Event, without
  // clientX/clientY (checked 2026-10-22), so the menu would open at no position
  await thumb.evaluate(
    (el, p) =>
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: p.x, clientY: p.y })
      ),
    { x, y }
  )
}

const menu = (): ReturnType<Page['getByTestId']> => page.getByTestId('img-menu')

async function closeMenu(): Promise<void> {
  await page.locator('body').dispatchEvent('click') // any click elsewhere closes it
  await expect(menu()).toHaveCount(0)
}

/** Runs the copy command from the page through the preload API and waits for it to finish */
async function copyImage(id: string): Promise<void> {
  await page.evaluate((i) => (window as unknown as { transfer: TransferApi }).transfer.copyImage(i), id)
}

/** Switches the interface language through the public setting, as the Settings dialog does */
async function setLanguage(lang: 'zh' | 'en'): Promise<void> {
  await page.evaluate((l) => (window as unknown as { transfer: TransferApi }).transfer.setLanguage(l), lang)
  await expect(page.locator('img[alt="wide.png"]')).toHaveAttribute('title', TIP[lang])
}

/** The message id the test seeded for a file name */
const ids: Record<string, string> = {}

test.describe.serial('image copy', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'transfer-imgcopy-e2e-'))
    files = join(userData, 'received')
    // zh, so the labels asserted below are the dictionary's Chinese ones (one case switches to en)
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'zh' }))

    const seed: Array<{ name: string; direction: 'recv' | 'sent' }> = [
      { name: 'wide.png', direction: 'recv' },
      { name: 'sent.png', direction: 'sent' },
      { name: 'phone.jpg', direction: 'recv' },
      { name: 'deleted.png', direction: 'recv' },
      { name: 'garbled.png', direction: 'recv' },
      { name: 'replaced.png', direction: 'recv' },
      { name: 'broken.png', direction: 'recv' },
      // the last message: a right-aligned thumbnail that can sit at the bottom of the stream
      { name: 'last-sent.png', direction: 'sent' }
    ]
    const store = new MessageStore(join(userData, 'messages.db'))
    seed.forEach(({ name, direction }, i) => {
      ids[name] = `e2e-img-${i}`
      store.insert({
        id: ids[name],
        type: 'file',
        direction,
        peerFp: PEER,
        peerAlias: ALIAS,
        content: null,
        fileName: name,
        fileSize: 1,
        filePath: join(files, name),
        status: 'done',
        errorReason: null,
        transferId: null,
        createdAt: 1_760_000_000_000 + i * 1000
      })
    })
    store.close()

    app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'production', TRANSFER_E2E_QUIET: '1', TRANSFER_USERDATA: userData }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Fixture files exist before the chat opens, so every thumbnail loads (broken.png never decodes)
    mkdirSync(files, { recursive: true })
    const wide = await encode('png', 120, 80)
    writeFileSync(join(files, 'wide.png'), wide)
    writeFileSync(join(files, 'sent.png'), wide)
    writeFileSync(join(files, 'last-sent.png'), wide)
    writeFileSync(join(files, 'deleted.png'), wide)
    writeFileSync(join(files, 'garbled.png'), wide)
    writeFileSync(join(files, 'replaced.png'), await encode('png', 60, 40))
    writeFileSync(join(files, 'broken.png'), 'not an image')
    // Stored 200x100: red left, blue right, green mark top-left. EXIF 6 = displayed rotated 90°
    // clockwise: red on top, blue at the bottom, the mark at the top-right (orientation 5 would leave it
    // at the top-left)
    writeFileSync(join(files, 'phone.jpg'), injectMetadata(await encode('jpeg', 200, 100, true), phoneMetadata(6)))

    // Stand in for discovery: one online device, the peer of the seeded messages. Sent until the row
    // shows, because a single update sent during start-up was seen to be lost (2026-10-22) — likely sent
    // before the renderer subscribed, or replaced by the renderer's own first, empty device fetch.
    const device = {
      info: { alias: ALIAS, version: '2.1', fingerprint: PEER, deviceType: 'desktop', hasCustomAlias: false },
      address: '127.0.0.1',
      port: 53399,
      protocol: 'https',
      lastSeen: Date.now(),
      status: 'online'
    }
    const row = page.getByText(ALIAS, { exact: true }).first()
    await expect(async () => {
      await app.evaluate(
        ({ BrowserWindow }, [channel, d]) => {
          const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))!
          main.webContents.send(channel, [d])
        },
        [EVT.devicesUpdated, device] as const
      )
      await expect(row).toBeVisible({ timeout: 500 })
    }).toPass({ timeout: 15_000 })
    await row.dispatchEvent('click')
    await expect(page.locator('img[alt="wide.png"]')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    rmSync(userData, { recursive: true, force: true })
  })

  test('the menu of a received and of a sent image lists Copy Image first, and the tooltip says so', async () => {
    for (const alt of ['wide.png', 'sent.png']) {
      await expect(page.locator(`img[alt="${alt}"]`)).toHaveAttribute('title', TIP.zh)
      await rightClick(alt)
      await expect(menu()).toBeVisible()
      expect(await menu().locator(':scope > div').allInnerTexts(), alt).toEqual([
        '复制图片',
        '保存图片',
        '用系统程序打开'
      ])
      await closeMenu()
    }
  })

  test('Copy Image puts the PNG on the clipboard as pixels only, closes the menu and shows nothing else', async () => {
    await setSentinel('sentinel-before-copy')
    const before = await page.evaluate(() => document.body.innerText)
    await rightClick('wide.png')
    await menu().getByText('复制图片', { exact: true }).dispatchEvent('click')
    await expect(menu()).toHaveCount(0)

    await expect.poll(async () => (await readClipboard()).width).toBe(120)
    const c = await readClipboard([[10, 40], [110, 40]])
    expect([c.width, c.height]).toEqual([120, 80])
    expect(c.colours).toEqual(['red', 'blue'])
    expect(c.text, 'no text alongside the image').toBe('')
    expect(c.formats.length).toBeGreaterThan(0)
    expect(c.formats.filter((f) => !f.startsWith('image/')), 'image formats only, no file reference').toEqual([])
    expect(await page.evaluate(() => document.body.innerText), 'no message or toast appeared').toBe(before)
  })

  test('Copy Image works on a sent image too', async () => {
    await setSentinel('sentinel-before-sent')
    await rightClick('sent.png')
    await menu().getByText('复制图片', { exact: true }).dispatchEvent('click')
    await expect.poll(async () => (await readClipboard()).width).toBe(120)
    const c = await readClipboard()
    expect([c.width, c.height]).toEqual([120, 80])
  })

  test('Copy Image turns a JPEG upright by its EXIF orientation', async () => {
    await setSentinel('sentinel-before-jpeg')
    await rightClick('phone.jpg')
    await menu().getByText('复制图片', { exact: true }).dispatchEvent('click')

    await expect.poll(async () => (await readClipboard()).width).toBe(100)
    const c = await readClipboard([[15, 15], [85, 15], [50, 180]])
    expect([c.width, c.height]).toEqual([100, 200])
    expect(c.colours, 'red top-left, the green mark top-right, blue at the bottom').toEqual(['red', 'green', 'blue'])
  })

  test('the thumbnail of a phone photo is upright and as wide as any other thumbnail', async () => {
    const shape = (alt: string): Promise<{ w: number; h: number; colours: string[] }> =>
      page.locator(`img[alt="${alt}"]`).evaluate((img: HTMLImageElement) => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        const at = (x: number, y: number): string => {
          const [r, gr, b] = g.getImageData(x, y, 1, 1).data
          if (r > 180 && gr < 80 && b < 80) return 'red'
          if (gr > 180 && r < 80 && b < 80) return 'green'
          if (b > 180 && r < 80 && gr < 80) return 'blue'
          return 'other'
        }
        const w = c.width
        const h = c.height
        return { w, h, colours: [at(20, 20), at(w - 20, 20), at(w / 2, h - 20)] }
      })
    // Stored 200x100 tagged 6: upright it is 100x200, generated at the usual 180 width -> 180x360, with
    // the mark at the top-right
    expect(await shape('phone.jpg')).toEqual({ w: 180, h: 360, colours: ['red', 'green', 'blue'] })
    // No orientation: unchanged rule, 120x80 generated at 180 width -> 180x120
    const wide = await shape('wide.png')
    expect([wide.w, wide.h]).toEqual([180, 120])
  })

  test('in English, near the bottom-right of the chat the menu opens up and to the left, whole and full width', async () => {
    const box = async (): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> => {
      const r = (await menu().boundingBox())!
      return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, width: r.width, height: r.height }
    }
    // en: its longest label makes the menu wider than its minimum width, so a menu measured where it is
    // narrowed would come out narrower — in zh every label fits inside the minimum width
    await setLanguage('en')
    try {
      await expect(page.locator('img[alt="sent.png"]')).toHaveAttribute('title', TIP.en)
      await scrollTo('wide.png', 'center')
      await rightClick('wide.png')
      await expect(menu()).toBeVisible()
      expect(await menu().locator(':scope > div').allInnerTexts()).toEqual([
        'Copy Image',
        'Save Image',
        'Open with System App'
      ])
      const roomy = await box()
      await closeMenu()

      // A spot a real pointer can reach: the last message, a right-aligned sent thumbnail, at the bottom
      // of the stream
      await scrollTo('last-sent.png', 'end')
      const s = (await page.locator('img[alt="last-sent.png"]').boundingBox())!
      const pointer = { x: Math.round(s.x + s.width - 5), y: Math.round(s.y + s.height - 5) }
      const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      expect(pointer.x + roomy.width, 'precondition: the menu cannot open rightwards here').toBeGreaterThan(view.w - 4)
      expect(pointer.y + roomy.height, 'precondition: the menu cannot open downwards here').toBeGreaterThan(view.h - 4)

      await rightClick('last-sent.png', pointer)
      await expect(menu()).toBeVisible()
      const edge = await box()
      expect(edge.right, 'opens to the left of the pointer').toBeLessThanOrEqual(pointer.x)
      expect(edge.bottom, 'opens above the pointer').toBeLessThanOrEqual(pointer.y)
      expect(edge.left).toBeGreaterThanOrEqual(4)
      expect(edge.top).toBeGreaterThanOrEqual(4)
      expect(edge.right).toBeLessThanOrEqual(view.w - 4)
      expect(edge.bottom).toBeLessThanOrEqual(view.h - 4)
      expect([edge.width, edge.height], 'not narrowed or wrapped at the edge').toEqual([roomy.width, roomy.height])
      await closeMenu()
    } finally {
      await setLanguage('zh')
    }
  })

  test('right-clicking another image replaces the open menu instead of adding a second one', async () => {
    // The second pointer must be inside the window and clear of its edges, or the menu is (rightly)
    // moved away from it; scrolling first, because a scroll closes the menu
    await scrollTo('sent.png', 'center')
    await rightClick('wide.png')
    await expect(menu()).toHaveCount(1)
    const second = (await page.locator('img[alt="sent.png"]').boundingBox())!
    const at = { x: Math.round(second.x + 20), y: Math.round(second.y + 20) } // clientX/Y are whole pixels
    await rightClick('sent.png', at)
    await expect(menu()).toHaveCount(1)
    const box = (await menu().boundingBox())!
    expect([box.x, box.y], 'the remaining menu is the one at the second pointer').toEqual([at.x, at.y])

    // The same image again: closed by the right-click and re-opened by it, at the new pointer
    const again = { x: at.x + 10, y: at.y + 10 }
    await rightClick('sent.png', again)
    await expect(menu()).toHaveCount(1)
    const moved = (await menu().boundingBox())!
    expect([moved.x, moved.y]).toEqual([again.x, again.y])
    await closeMenu()
  })

  test('an image whose file never decoded shows the file row and has no image menu', async () => {
    const name = page.getByText('broken.png', { exact: true })
    // the file row carries a file-type icon; the loading placeholder shows the name without one
    await expect(page.locator('div', { has: name }).locator('svg').first()).toBeVisible()
    await expect(page.locator('img[alt="broken.png"]')).toHaveCount(0)
    await name.evaluate((el) =>
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 50, clientY: 50 }))
    )
    await expect(menu()).toHaveCount(0)
  })

  // The three cases below await the copy command itself, as the user confirmed (2026-10-22): the menu runs
  // it fire-and-forget, so a menu click gives the test nothing to wait on before asserting that nothing
  // changed. The menu's wiring to that command is what the copy cases above prove.
  test('a file deleted after its thumbnail appeared leaves the clipboard untouched', async () => {
    await expect(page.locator('img[alt="deleted.png"]')).toBeVisible()
    unlinkSync(join(files, 'deleted.png'))
    await setSentinel('sentinel-deleted')
    await copyImage(ids['deleted.png'])
    const c = await readClipboard()
    expect(c.text).toBe('sentinel-deleted')
    expect([c.width, c.height]).toEqual([0, 0])
  })

  test('a file replaced by bytes that are not an image leaves the clipboard untouched', async () => {
    await expect(page.locator('img[alt="garbled.png"]')).toBeVisible()
    writeFileSync(join(files, 'garbled.png'), 'not an image')
    await setSentinel('sentinel-garbled')
    await copyImage(ids['garbled.png'])
    const c = await readClipboard()
    expect(c.text).toBe('sentinel-garbled')
    expect([c.width, c.height]).toEqual([0, 0])
  })

  test('a file replaced by another image copies the replacement', async () => {
    await expect(page.locator('img[alt="replaced.png"]')).toBeVisible()
    await copyImage(ids['replaced.png'])
    const first = await readClipboard()
    expect([first.width, first.height]).toEqual([60, 40])

    writeFileSync(join(files, 'replaced.png'), await encode('png', 90, 30))
    await copyImage(ids['replaced.png'])
    const c = await readClipboard()
    expect([c.width, c.height]).toEqual([90, 30])
  })
})

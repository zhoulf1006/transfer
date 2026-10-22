// e2e: copying a chat image from its right-click menu (spec transfer-chat, US-001, REQ-001 to REQ-003).
//
// How a chat gets opened without a peer: quiet instances run no discovery (they would announce on the
// LAN), so the test seeds the message store with image messages from one made-up peer, then sends the
// renderer a device-list update naming that peer — the channel discovery uses in the product. The
// device only opens the chat; nothing here talks to it.
//
// The hidden test window takes no real pointer input (see ui-icons.spec.ts), so right-clicks and clicks
// are dispatched as DOM events. Not covered here: whether a real pointer reaches the thumbnail (nothing
// covering it) — that is checked by rendering the app.
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

let app: ElectronApplication
let page: Page
let userData: string
let files: string

/** A two-colour image encoded by the app's own encoder: left half red, right half blue */
async function encode(kind: 'png' | 'jpeg', width: number, height: number): Promise<Buffer> {
  const b64 = await app.evaluate(
    ({ nativeImage }, [k, w, h]) => {
      const bmp = Buffer.alloc(w * h * 4)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4 // BGRA
          if (x < w / 2) bmp[i + 2] = 255
          else bmp[i] = 255
          bmp[i + 3] = 255
        }
      }
      const img = nativeImage.createFromBitmap(bmp, { width: w, height: h })
      return (k === 'png' ? img.toPNG() : img.toJPEG(95)).toString('base64')
    },
    [kind, width, height] as const
  )
  return Buffer.from(b64, 'base64')
}

interface ClipboardState {
  text: string
  formats: string[]
  width: number
  height: number
  /** dominant colour at the given points: 'red', 'blue' or 'other' */
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
      const [b, , r] = [bmp[i], bmp[i + 1], bmp[i + 2]]
      return r > 180 && b < 80 ? 'red' : b > 180 && r < 80 ? 'blue' : 'other'
    })
    return { text: clipboard.readText(), formats: clipboard.availableFormats(), width, height, colours }
  }, points)
}

async function setSentinel(s: string): Promise<void> {
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), s)
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

/** Runs the copy command from the page through the preload API and waits for it to finish */
async function copyImage(id: string): Promise<void> {
  await page.evaluate((i) => (window as unknown as { transfer: TransferApi }).transfer.copyImage(i), id)
}

/** The message id the test seeded for a file name */
const ids: Record<string, string> = {}

test.describe.serial('image copy', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'transfer-imgcopy-e2e-'))
    files = join(userData, 'received')
    // zh, so the labels asserted below are the dictionary's Chinese ones
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'zh' }))

    const seed: Array<{ name: string; direction: 'recv' | 'sent' }> = [
      { name: 'wide.png', direction: 'recv' },
      { name: 'sent.png', direction: 'sent' },
      { name: 'phone.jpg', direction: 'recv' },
      { name: 'deleted.png', direction: 'recv' },
      { name: 'garbled.png', direction: 'recv' },
      { name: 'replaced.png', direction: 'recv' }
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

    // Fixture files exist before the chat opens, so every thumbnail loads
    mkdirSync(files, { recursive: true })
    const wide = await encode('png', 120, 80)
    writeFileSync(join(files, 'wide.png'), wide)
    writeFileSync(join(files, 'sent.png'), wide)
    writeFileSync(join(files, 'deleted.png'), wide)
    writeFileSync(join(files, 'garbled.png'), wide)
    writeFileSync(join(files, 'replaced.png'), await encode('png', 60, 40))
    // Stored 200x100 (red left, blue right); EXIF 6 = displayed rotated 90° clockwise, red on top
    writeFileSync(join(files, 'phone.jpg'), injectMetadata(await encode('jpeg', 200, 100), phoneMetadata(6)))

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
      await expect(page.locator(`img[alt="${alt}"]`)).toHaveAttribute('title', '点击查看原图 · 右键复制或保存')
      await rightClick(alt)
      await expect(menu()).toBeVisible()
      expect(await menu().locator(':scope > div').allInnerTexts(), alt).toEqual([
        '复制图片',
        '保存图片',
        '用系统程序打开'
      ])
      await page.locator('body').dispatchEvent('click') // any click elsewhere closes it
      await expect(menu()).toHaveCount(0)
    }
  })

  test('Copy Image puts the PNG on the clipboard as pixels only, and closes the menu', async () => {
    await setSentinel('sentinel-before-copy')
    await rightClick('wide.png')
    await menu().getByText('复制图片', { exact: true }).dispatchEvent('click')
    await expect(menu()).toHaveCount(0)

    await expect.poll(async () => (await readClipboard()).width).toBe(120)
    const c = await readClipboard([[10, 40], [110, 40]])
    expect([c.width, c.height]).toEqual([120, 80])
    expect(c.colours).toEqual(['red', 'blue'])
    expect(c.formats.filter((f) => /uri|file|url/i.test(f)), 'no file reference').toEqual([])
  })

  test('Copy Image turns a JPEG upright by its EXIF orientation', async () => {
    await setSentinel('sentinel-before-jpeg')
    await rightClick('phone.jpg')
    await menu().getByText('复制图片', { exact: true }).dispatchEvent('click')

    await expect.poll(async () => (await readClipboard()).width).toBe(100)
    const c = await readClipboard([[50, 20], [50, 180]])
    expect([c.width, c.height]).toEqual([100, 200])
    expect(c.colours, 'red (stored left) on top, blue at the bottom').toEqual(['red', 'blue'])
  })

  test('the thumbnail of a phone photo is upright and as wide as any other thumbnail', async () => {
    const shape = (alt: string): Promise<{ w: number; h: number; top: string; bottom: string }> =>
      page.locator(`img[alt="${alt}"]`).evaluate((img: HTMLImageElement) => {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        const at = (y: number): string => {
          const [r, , b] = g.getImageData(Math.floor(c.width / 2), y, 1, 1).data
          return r > 180 && b < 80 ? 'red' : b > 180 && r < 80 ? 'blue' : 'other'
        }
        return { w: img.naturalWidth, h: img.naturalHeight, top: at(10), bottom: at(c.height - 10) }
      })
    // Stored 200x100 tagged 6: upright it is 100x200, generated at the usual 180 width -> 180x360
    expect(await shape('phone.jpg')).toEqual({ w: 180, h: 360, top: 'red', bottom: 'blue' })
    // No orientation: unchanged rule, 120x80 generated at 180 width -> 180x120
    const wide = await shape('wide.png')
    expect([wide.w, wide.h]).toEqual([180, 120])
  })

  test('near the bottom-right corner the menu opens up and to the left, whole and full width', async () => {
    const box = async (): Promise<{ left: number; top: number; right: number; bottom: number; width: number }> => {
      const r = (await menu().boundingBox())!
      return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, width: r.width }
    }
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))

    await rightClick('wide.png')
    await expect(menu()).toBeVisible()
    const roomy = await box()
    await page.locator('body').dispatchEvent('click')

    const pointer = { x: view.w - 10, y: view.h - 10 }
    await rightClick('wide.png', pointer)
    await expect(menu()).toBeVisible()
    const edge = await box()
    expect(edge.right, 'opens to the left of the pointer').toBeLessThanOrEqual(pointer.x)
    expect(edge.bottom, 'opens above the pointer').toBeLessThanOrEqual(pointer.y)
    expect(edge.left).toBeGreaterThanOrEqual(4)
    expect(edge.top).toBeGreaterThanOrEqual(4)
    expect(edge.width, 'not narrowed or wrapped at the edge').toBe(roomy.width)
    await page.locator('body').dispatchEvent('click')
  })

  test('right-clicking another image replaces the open menu instead of adding a second one', async () => {
    // The second pointer must be inside the window and clear of its edges, or the menu is (rightly)
    // moved away from it; scrolling first, because a scroll closes the menu
    await page.locator('img[alt="sent.png"]').evaluate((el) => el.scrollIntoView({ block: 'center' }))
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
    await page.locator('body').dispatchEvent('click')
  })

  // The three cases below await the copy command itself (the menu runs it fire-and-forget, so a menu
  // click gives the test nothing to wait on before asserting that nothing changed); the menu's wiring
  // to that command is what the two cases above prove.
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
    expect([(await readClipboard()).width, (await readClipboard()).height]).toEqual([60, 40])

    writeFileSync(join(files, 'replaced.png'), await encode('png', 90, 30))
    await copyImage(ids['replaced.png'])
    const c = await readClipboard()
    expect([c.width, c.height]).toEqual([90, 30])
  })
})

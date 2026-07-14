import { join, basename, extname } from 'node:path'
import { copyFile, readFile } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, nativeTheme, protocol } from 'electron'
import {
  CMD,
  EVT,
  SHOT_CMD,
  type SendTextArgs,
  type SendFilesArgs,
  type RespondArgs,
  type ListMessagesArgs,
  type AutoAcceptSettings,
  type IdentityInfo,
  type ThemePref
} from '@shared/ipc'
import { loadOrCreateIdentity, saveAlias } from './device-identity'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import { ScreenshotService } from './screenshot-service'
import { APP_HOST, registerAppProtocol } from './app-protocol'

// env 覆盖(多实例测试,DESIGN §6/M4)
const userDataOverride = process.env['TRANSFER_USERDATA']
if (userDataOverride) app.setPath('userData', userDataOverride)
const portOverride = process.env['TRANSFER_PORT'] ? Number(process.env['TRANSFER_PORT']) : undefined

// 自定义 app:// scheme 注册为 privileged —— **必须在 app ready 之前**(此处模块顶层)调用,否则无效。
// standard:true 让渲染页拿到真正的非 opaque origin(app://bundle),Web Storage 走快路径,
// 根治 file:// 下 localStorage 首访卡数秒的坑(#24441,见 docs/app-scheme-migration.md)。
// dev 走 ELECTRON_RENDERER_URL(http://localhost),不加载 app://,注册也无副作用。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true, // 非 opaque origin —— storage 快路径(核心开关)
      secure: true, // 安全上下文(等价 https)
      supportFetchAPI: true, // 允许 fetch(app://…)(modulepreload 需要)
      codeCache: true // V8 code cache(需 standard:true),二次启动更快
    }
  }
])

// 聊天缩略图宽度(px):够清晰又小(几十KB)
const THUMB_WIDTH = 180

/** 按扩展名给图片 mime(拼原图 dataURL 用) */
function imageMime(path: string): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml'
  }
  return map[ext] ?? 'image/png'
}

// 单实例锁:一次只运行一个实例,第二个实例聚焦已有窗后退出。
// 锁基于 userData 目录(Electron 源码级),故必须排在上面 setPath 之后——
// TRANSFER_USERDATA 测试实例用不同 userData=各自独立锁,不互相争,多实例测试不受影响。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 第二实例:用 app.exit(0) 立即强杀,而非 app.quit()。
  // quit() 在 ready 之前调用可能不干净、且会走 before-quit,可能卡住变僵尸进程;
  // 第二实例什么都没初始化,直接 exit 最安全。
  app.exit(0)
}

let core: AppCore | null = null
let store: MessageStore | null = null
let settings: SettingsStore | null = null
let mainWindow: BrowserWindow | null = null
let screenshot: ScreenshotService | null = null

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

const PRELOAD = join(__dirname, '../preload/index.cjs')

/**
 * 按窗口加载 renderer 入口(§4.1)。
 * dev:主窗用裸 ELECTRON_RENDERER_URL(保持根路由不变),overlay 拼 /overlay.html。
 * prod:走 app://bundle/<entry>.html(自定义 scheme,标准安全 origin;见 docs/app-scheme-migration.md)。
 */
function loadRenderer(win: BrowserWindow, entry: 'index' | 'overlay'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(entry === 'index' ? devUrl : `${devUrl}/${entry}.html`)
  } else {
    win.loadURL(`app://${APP_HOST}/${entry}.html`)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    // 底色跟随系统深浅(与 theme.css 的 --bg 一致):renderer 加载前不露白屏
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191b' : '#f7f8f9',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))
  loadRenderer(mainWindow, 'index')
}

function registerIpc(): void {
  ipcMain.handle(CMD.getIdentity, (): IdentityInfo => {
    const id = loadOrCreateIdentity(app.getPath('userData'))
    return { alias: id.alias, fingerprint: id.fingerprint }
  })
  ipcMain.handle(CMD.setAlias, (_e, alias: string) => {
    saveAlias(app.getPath('userData'), alias)
  })
  ipcMain.handle(CMD.listDevices, () => core?.listDevices() ?? [])
  ipcMain.handle(CMD.pickFiles, async () => {
    if (!mainWindow) return []
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })

  // ── 聊天 ──
  ipcMain.handle(CMD.sendText, async (_e, args: SendTextArgs) => {
    await core?.chat.sendText(args.peerFp, args.text)
  })
  ipcMain.handle(CMD.sendFiles, async (_e, args: SendFilesArgs) => {
    await core?.chat.sendFiles(args.peerFp, args.filePaths)
  })
  ipcMain.handle(CMD.respond, (_e, args: RespondArgs) => {
    core?.chat.respond(args.transferId, args.accept)
  })
  ipcMain.handle(CMD.listMessages, (_e, args?: ListMessagesArgs) => {
    return core?.chat.list(args) ?? []
  })
  ipcMain.handle(CMD.listReceivedFiles, (_e, args?: ListMessagesArgs) => {
    return store?.listReceivedFiles(args) ?? []
  })
  ipcMain.handle(CMD.openFile, (_e, messageId: string) => {
    // ④-B:按 id 精确取(store.get),不受 list 分页上限限制
    const msg = store?.get(messageId)
    if (msg?.filePath) shell.openPath(msg.filePath)
  })
  // 图片缩略图:nativeImage 生成小图 dataURL(仅 PNG/JPEG 可靠;GIF/WEBP/非图片返回 null → UI 回退图标)
  ipcMain.handle(CMD.getThumbnail, (_e, messageId: string): string | null => {
    const msg = store?.get(messageId)
    if (!msg?.filePath) return null
    try {
      const img = nativeImage.createFromPath(msg.filePath)
      if (img.isEmpty()) return null // 不支持的格式/读失败
      return img.resize({ width: THUMB_WIDTH }).toDataURL()
    } catch {
      return null
    }
  })
  // 图片另存为:弹系统对话框,把原图(filePath)复制到用户选定位置。
  ipcMain.handle(CMD.saveImageAs, async (_e, messageId: string): Promise<string | null> => {
    const msg = store?.get(messageId)
    if (!msg?.filePath) return null
    const r = await dialog.showSaveDialog({ defaultPath: basename(msg.filePath) })
    if (r.canceled || !r.filePath) return null
    await copyFile(msg.filePath, r.filePath)
    return r.filePath
  })
  // 取原图 dataURL(app 内居中弹层看大图):fs 读原文件按扩展名拼 mime,支持所有图片格式。
  ipcMain.handle(CMD.getImageDataUrl, async (_e, messageId: string): Promise<string | null> => {
    const msg = store?.get(messageId)
    if (!msg?.filePath) return null
    try {
      const buf = await readFile(msg.filePath)
      return `data:${imageMime(msg.filePath)};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })
  ipcMain.handle(CMD.getAutoAccept, (): AutoAcceptSettings => {
    return settings!.getAutoAccept()
  })
  ipcMain.handle(CMD.setAutoAccept, (_e, s: Partial<AutoAcceptSettings>): AutoAcceptSettings => {
    return settings!.setAutoAccept(s).autoAccept
  })
  // 主题偏好:存 main 侧(避开 file:// 下 localStorage 慢)
  ipcMain.handle(CMD.getTheme, (): ThemePref => settings!.getTheme())
  ipcMain.handle(CMD.setTheme, (_e, t: ThemePref): ThemePref => settings!.setTheme(t))

  // 截图:主窗同步当前聊天对象(决定"发聊天"可用性,§4.3 blocker#1)
  ipcMain.handle(SHOT_CMD.setActivePeer, (_e, peerFp: string | null) => {
    screenshot?.setActivePeer(peerFp)
  })
}

// 第二个实例启动时,聚焦/还原已有主窗(在第一实例里触发,保证 ready 之后)。
if (gotTheLock) {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(async () => {
  // 非首个实例:已 app.quit(),不初始化(whenReady 仍可能触发,这里兜住)。
  if (!gotTheLock) return

  // app:// handler 必须在建窗(loadURL app://…)之前注册。dev 不加载 app://,注册也无害。
  // rendererRoot = out/renderer(__dirname = out/main),与原 loadFile 路径一致。
  registerAppProtocol(join(__dirname, '../renderer'))

  // 先注册 IPC + 建窗:让 renderer 尽早开始加载/绘制外壳,与下面的后端初始化并行,避免白屏。
  // IPC handler 全走 core?./store?. 短路,渲染层早期调用(getIdentity/listDevices)在 store/core
  // 就绪前返回空,就绪后正常;首屏骨架不依赖数据即可显示。
  registerIpc()
  createWindow()

  const identity = loadOrCreateIdentity(app.getPath('userData'))
  const userData = app.getPath('userData')
  store = new MessageStore(join(userData, 'messages.db'))
  settings = new SettingsStore(userData)

  core = new AppCore({
    identity,
    platform: process.platform,
    receiveDir: app.getPath('downloads'),
    httpPort: portOverride,
    store,
    settings,
    events: {
      onDevicesUpdated: (devices) => send(EVT.devicesUpdated, devices),
      onMessageUpserted: (msg) => send(EVT.messageUpserted, msg),
      onProgress: (p) => send(EVT.progress, p)
    }
  })

  // 启动:遗留 pending 消息标 expired(挂起会话已随上次进程消失,DESIGN §11.2.2)
  core.chat.onStartup()

  // 截图服务:注册 F1 + 遮罩窗管理 + 三出口(§4.1)
  screenshot = new ScreenshotService({
    rendererUrl: process.env['ELECTRON_RENDERER_URL'],
    preload: PRELOAD,
    tempDir: join(app.getPath('temp'), 'transfer-shot'),
    // 复用现有聊天发送链路(§3.4:必须走 core.chat.sendFiles 才入库/推 UI/串行化)
    sendFiles: async (peerFp, filePaths) => {
      await core!.chat.sendFiles(peerFp, filePaths)
    }
  })
  screenshot.start()

  // 网络服务(HTTP server + UDP 发现)延迟到窗口显示之后再起:让首帧更早、不被网络初始化阻塞。
  // 代价:启动后极短时间内(窗口已显示到服务就绪之间)可能收不到连接,可接受。
  const startCore = (): void => {
    core?.start().catch((err) => dialog.showErrorBox('启动失败', String(err)))
  }
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.once('show', startCore)
  } else {
    startCore()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ④-C:Electron 不 await before-quit 的 async 回调,必须 preventDefault + 手动 quit,
// 否则 stop()(含挂起 resolver reject/标 expired)和 store.close() 可能来不及执行。
let quitting = false
app.on('before-quit', (e) => {
  if (!gotTheLock) return // 非首个实例:没初始化任何东西,直接放行退出,不走清理
  if (quitting) return // 已在清理,放行第二次 quit
  e.preventDefault()
  quitting = true

  // 兜底:清理最多等 3s,超时也强制退出。
  // 关键——core.stop 里 fastify server.close() 会等所有活动连接关闭,若有挂起连接可能永不 resolve,
  // 导致进程卡死不退(表现为"点关闭后进程还在、反复启动堆积僵尸进程")。用 app.exit(0) 强杀,
  // 比 app.quit() 更硬(quit 本身也可能被 before-quit 再次拦)。
  const forceExit = setTimeout(() => {
    console.warn('[quit] 清理超时,强制退出')
    app.exit(0)
  }, 3000)

  ;(async () => {
    // 先摘引用再清理:退出期间渲染层仍可能发 IPC(sendText/listReceivedFiles 等),
    // 先置 null 让 handler 的 `?.` 直接跳过,避免访问已 close 的 store → "database is not open"。
    const s = store
    const c = core
    store = null
    core = null
    try {
      screenshot?.stop()
      await c?.stop()
      s?.close()
    } catch (err) {
      console.error('[quit] 清理出错', err)
    } finally {
      clearTimeout(forceExit)
      app.quit()
    }
  })()
})

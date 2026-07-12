import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import {
  CMD,
  EVT,
  type SendTextArgs,
  type SendFilesArgs,
  type RespondArgs,
  type ListMessagesArgs,
  type AutoAcceptSettings,
  type IdentityInfo
} from '@shared/ipc'
import { loadOrCreateIdentity, saveAlias } from './device-identity'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'

// env 覆盖(多实例测试,DESIGN §6/M4)
const userDataOverride = process.env['TRANSFER_USERDATA']
if (userDataOverride) app.setPath('userData', userDataOverride)
const portOverride = process.env['TRANSFER_PORT'] ? Number(process.env['TRANSFER_PORT']) : undefined

let core: AppCore | null = null
let store: MessageStore | null = null
let settings: SettingsStore | null = null
let mainWindow: BrowserWindow | null = null

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  ipcMain.handle(CMD.openFile, (_e, messageId: string) => {
    // ④-B:按 id 精确取(store.get),不受 list 分页上限限制
    const msg = store?.get(messageId)
    if (msg?.filePath) shell.openPath(msg.filePath)
  })
  ipcMain.handle(CMD.getAutoAccept, (): AutoAcceptSettings => {
    return settings!.getAutoAccept()
  })
  ipcMain.handle(CMD.setAutoAccept, (_e, s: Partial<AutoAcceptSettings>): AutoAcceptSettings => {
    return settings!.setAutoAccept(s).autoAccept
  })
}

app.whenReady().then(async () => {
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
      onMessageUpserted: (msg) => send(EVT.messageUpserted, msg)
    }
  })

  // 启动:遗留 pending 消息标 expired(挂起会话已随上次进程消失,DESIGN §11.2.2)
  core.chat.onStartup()

  registerIpc()
  createWindow()
  try {
    await core.start()
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err))
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
  if (quitting) return // 已在清理,放行第二次 quit
  e.preventDefault()
  quitting = true
  ;(async () => {
    try {
      await core?.stop()
      store?.close()
    } finally {
      app.quit()
    }
  })()
})

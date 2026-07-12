import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { CMD, EVT, type SendArgs, type IdentityInfo } from '@shared/ipc'
import { loadOrCreateIdentity, saveAlias } from './device-identity'
import { AppCore } from './app-core'
import type { PrepareUploadRequest } from '@shared/types'
import { T_DIALOG_MS } from '@shared/protocol'

// env 覆盖(多实例测试,DESIGN §6/M4)
const userDataOverride = process.env['TRANSFER_USERDATA']
if (userDataOverride) app.setPath('userData', userDataOverride)
const portOverride = process.env['TRANSFER_PORT'] ? Number(process.env['TRANSFER_PORT']) : undefined

let core: AppCore | null = null
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

/** 接收弹框(挂起模型,DESIGN §5.1):返回接受的 fileId 列表或 false */
async function askUser(
  transferId: string,
  req: PrepareUploadRequest,
  _fromIp: string
): Promise<string[] | false> {
  const files = Object.values(req.files)
  send(EVT.transferIncoming, {
    transferId,
    fromAlias: req.info.alias,
    files: files.map((f) => ({ fileName: f.fileName, size: f.size }))
  })

  const fileList = files.map((f) => `• ${f.fileName} (${f.size} B)`).join('\n')
  // 用原生 dialog 做确认;弹框超时(T_DIALOG_MS)由 race 兜底
  const askPromise = dialog
    .showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['拒绝', '接收'],
      defaultId: 1,
      cancelId: 0,
      title: '收到文件',
      message: `来自 ${req.info.alias} 的 ${files.length} 个文件`,
      detail: fileList
    })
    .then((r) => (r.response === 1 ? Object.keys(req.files) : false))

  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), T_DIALOG_MS))
  return Promise.race([askPromise, timeout])
}

function registerIpc(): void {
  ipcMain.handle(CMD.getIdentity, (): IdentityInfo => {
    const id = loadOrCreateIdentity(app.getPath('userData'))
    return { alias: id.alias, fingerprint: id.fingerprint }
  })
  ipcMain.handle(CMD.setAlias, (_e, alias: string) => {
    saveAlias(app.getPath('userData'), alias)
  })
  ipcMain.handle(CMD.getReceiveDir, () => app.getPath('downloads'))
  ipcMain.handle(CMD.listDevices, () => core?.listDevices() ?? [])
  ipcMain.handle(CMD.pickFiles, async () => {
    if (!mainWindow) return []
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })

  ipcMain.handle(CMD.send, async (_e, args: SendArgs) => {
    if (!core) return { ok: false, message: '未就绪' }
    const transferId = core.newTransferId()
    const files = args.filePaths.map((p, i) => ({ id: `${i}-${p}`, path: p }))
    const res = await core.sendTo(args.fingerprint, files, (fileId) =>
      send(EVT.transferProgress, { transferId, direction: 'send', fileName: fileId })
    )
    if (res.ok) send(EVT.transferDone, { transferId, direction: 'send' })
    else send(EVT.transferError, { transferId, message: res.message })
    return res
  })
}

app.whenReady().then(async () => {
  const identity = loadOrCreateIdentity(app.getPath('userData'))
  core = new AppCore({
    identity,
    platform: process.platform,
    receiveDir: app.getPath('downloads'),
    httpPort: portOverride,
    events: {
      onDevicesUpdated: (devices) => send(EVT.devicesUpdated, devices),
      askUser,
      onIncomingFileDone: (fileName) =>
        send(EVT.transferProgress, { transferId: 'recv', direction: 'recv', fileName })
    }
  })

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

app.on('before-quit', async () => {
  await core?.stop()
})

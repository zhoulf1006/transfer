import { join, basename, extname } from 'node:path'
import { copyFile, readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, nativeTheme, protocol } from 'electron'
import {
  CMD,
  EVT,
  SHOT_CMD,
  type SendTextArgs,
  type SendFilesArgs,
  type SendImageArgs,
  type RespondArgs,
  type ListMessagesArgs,
  type AutoAcceptSettings,
  type IdentityInfo,
  type ThemePref,
  type LangPref,
  type LangResult,
  type ReceiveDirInfo,
  type PickReceiveDirResult,
  type SetShortcutResult
} from '@shared/ipc'
import { isValidAccelerator } from '@shared/accelerator'
import { loadOrCreateIdentity, saveAlias } from './device-identity'
import { AppCore } from './app-core'
import { MessageStore } from './db/messages'
import { SettingsStore } from './settings'
import { ScreenshotService, persistAndSend } from './screenshot-service'
import { APP_HOST, registerAppProtocol } from './app-protocol'
import { t, setMainLang, resolveSystemEffective } from './i18n'
import { resolveReceiveDir, chooseDir, displayPath, isDirWritable } from './receive-dir'

// 统一 userData 目录名:dev(未打包)默认读 package.json name='transfer'(小写),
// 打包版读 productName='Transfer'(大写)→ 两者目录名不一致。显式 setName 统一为 'Transfer',
// dev 与打包共用同一 userData。必须在任何 getPath('userData') / override / 单实例锁之前。
// (mac 大小写不敏感,dev 原 'transfer' 数据即同目录,无缝复用,无需迁移。)
app.setName('Transfer')

/**
 * 测试静音(只由 e2e/smoke 注入,产品路径永不设置)。判据不是"测试能不能跑",而是
 * **用户实例正在运行时跑一轮测试,用户或同网的他人能否察觉**——察觉得到的一律关断:
 *   ① 不显示窗口:实测 `dock.hide()` 与 accessory 活动策略都挡不住抢前台,只有不显示才不打扰;
 *      窗口不显示不影响断言 —— 布局、计算样式、CDP 输入都照常工作(焦点语义除外)。
 *   ② 不注册全局快捷键:F1 同一时刻只有一个进程占得住,注册了就把用户实例的截图快捷键抢走,
 *      且 `globalShortcut.register` 静默返回 false —— 用户只发现 F1 突然不好使。
 *   ③ 不起 core(HTTP server + 多播发现)。**真正的危害是多播 announce,不是端口**:
 *      端口有回退(53317→53318→…,见 app-core.ts),两实例本就能并存,不构成干扰;
 *      而测试实例用临时 userData → 每跑一轮就是一个**全新指纹**,在用户的设备列表里
 *      变成一台陌生新设备,退出后按 offlineKeep 默认**滞留一小时**且互不覆盖,
 *      同网的他人也看得见。
 *      HTTP server 本身无害,这里连它一起关只是因为**当前没有需要它的测试**:
 *      收发链路已由 transfer.integration.test.ts 在集成层覆盖(不依赖发现);
 *      将来若要跨进程 e2e 测传输,协议有定向 `POST /register`(ADR-0005)可用,
 *      不必开多播——届时再单独放开 HTTP 即可。
 */
const QUIET = Boolean(process.env['TRANSFER_E2E_QUIET'])

// env 覆盖(多实例测试,DESIGN §6/M4)
const userDataOverride = process.env['TRANSFER_USERDATA']
if (userDataOverride) app.setPath('userData', userDataOverride)
const portOverride = process.env['TRANSFER_PORT'] ? Number(process.env['TRANSFER_PORT']) : undefined

// 自定义 app:// scheme 注册为 privileged —— **必须在 app ready 之前**(此处模块顶层)调用,否则无效。
// standard:true 让渲染页拿到真正的非 opaque origin(app://bundle),Web Storage 走快路径,
// 根治 file:// 下 localStorage 首访卡数秒的坑(#24441,见 docs/adr/0007)。
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

/**
 * 当前持有的沙盒授权释放函数(仅 MAS 版非空)。
 *
 * Electron 文档的硬约束:取得访问权后**必须**在用完时释放,否则泄漏内核资源,
 * 且 app 会**彻底失去访问沙盒外的能力**直到重启。所以这个引用必须是单例——
 * 每次取新的之前先释放旧的,退出时也释放。
 */
let releaseReceiveDirAccess: (() => void) | null = null

/**
 * 取得对用户选定目录的沙盒访问权(spec receive-dir A8)。
 *
 * 非 MAS 构建下整个是空操作:Developer ID 版不受沙盒约束,存路径就够了。
 * 传 null 表示"回到默认目录",只释放不取得。
 */
function acquireReceiveDirAccess(bookmark: string | null): void {
  releaseReceiveDirAccess?.()
  releaseReceiveDirAccess = null
  if (!bookmark || !process.mas) return
  try {
    const stop = app.startAccessingSecurityScopedResource(bookmark)
    releaseReceiveDirAccess = stop as () => void
  } catch {
    // 书签解析失败(目录被删/改名/换机器)。不特殊处理——目录判定那一步会发现
    // 写不进去,照 C 组退回默认并告知,与"目录没了"走同一条路。
  }
}

/**
 * 本次该往哪儿落(spec receive-dir C 组)。
 *
 * **每次取用都重新判定**——目录可能在两次接收之间被删掉、改名,或所在磁盘被拔走。
 * 判定发现失效就地退回默认目录并置告知标记,于是文件不会因为一个失效的配置而收不到。
 */
function currentReceiveDir(): string {
  const defaultDir = app.getPath('downloads')
  const r = resolveReceiveDir(settings!.getReceiveDir(), defaultDir, isDirWritable)
  if (r.next) {
    settings!.setReceiveDir(r.next) // 不传书签 = 一并清掉,那个目录已经用不了了
    acquireReceiveDirAccess(null) // 连同沙盒授权一起释放
  }
  // C10:默认目录自己也可能不在(用户把 ~/Downloads 删了)。建一次试试;
  // **兜底链到此为止**——建不出来就让接收走既有失败路径报错,不静默改落别处。
  if (r.dir === defaultDir && !existsSync(defaultDir)) {
    try {
      mkdirSync(defaultDir, { recursive: true })
    } catch {
      // 交给接收侧按"目录不可写"报错,那里有对用户可见的失败反馈
    }
  }
  return r.dir
}

/** 设置页「存储」分区要的三项。必须在 currentReceiveDir 之后读设置——它可能刚改过状态。 */
function receiveDirInfo(): ReceiveDirInfo {
  const dir = currentReceiveDir()
  const s = settings!.getReceiveDir()
  return { path: displayPath(dir), isDefault: s.chosen === null, notice: s.notice }
}

const PRELOAD = join(__dirname, '../preload/index.cjs')

/**
 * 按窗口加载 renderer 入口(§4.1)。
 * dev:主窗用裸 ELECTRON_RENDERER_URL(保持根路由不变),overlay 拼 /overlay.html。
 * prod:走 app://bundle/<entry>.html(自定义 scheme,标准安全 origin;见 docs/adr/0007)。
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
    // 最小尺寸:侧栏固定 220,给主聊天区留 ~420,再小会挤压侧栏
    minWidth: 640,
    minHeight: 600,
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
  // QUIET 下不显示:测试实例一显示就抢前台(见 QUIET 定义处①)。渲染与布局照常进行。
  mainWindow.on('ready-to-show', () => {
    if (!QUIET) mainWindow?.show()
  })

  // dev 实例的标题加 (dev) 后缀:它与已安装版长得一模一样,同时开着极易对着错的那个操作
  // (改配置、看日志、验行为)。**标题是唯一可辨的地方** —— 进程名做不到:dev 跑的是
  // node_modules 里 Electron.app 的 bundle,进程名由其 CFBundleName 决定,app.setName() 改不动。
  // 必须拦 page-title-updated:窗口标题默认由页面的 <title> 接管,只调 setTitle 会在页面
  // 加载完成时被 index.html 的 "Transfer" 覆盖回去。打包版无此分支,标题不变。
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.on('page-title-updated', (e) => {
      e.preventDefault()
      mainWindow?.setTitle('Transfer (dev)')
    })
    mainWindow.setTitle('Transfer (dev)')
  }
  mainWindow.on('closed', () => (mainWindow = null))
  // 聚焦/失焦:聚焦时停止任务栏闪烁(仅 Windows,mac 未 flash)并告知 renderer(用于"正在看→不计未读")。
  mainWindow.on('focus', () => {
    if (process.platform === 'win32') mainWindow?.flashFrame(false)
    send(EVT.windowFocus, true)
  })
  mainWindow.on('blur', () => send(EVT.windowFocus, false))
  loadRenderer(mainWindow, 'index')
}

function registerIpc(): void {
  ipcMain.handle(CMD.getIdentity, async (): Promise<IdentityInfo> => {
    const id = await loadOrCreateIdentity(app.getPath('userData'))
    return { alias: id.alias, fingerprint: id.fingerprint }
  })
  ipcMain.handle(CMD.setAlias, async (_e, alias: string) => {
    await saveAlias(app.getPath('userData'), alias)
  })
  ipcMain.handle(
    CMD.setRemoteAlias,
    (_e, a: { fingerprint: string; alias: string }): { ok: boolean } =>
      core?.setRemoteAlias(a.fingerprint, a.alias) ?? { ok: false }
  )
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
  // 粘贴/内存图片发送:落盘为持久 png 副本(命名唯一,防撞名)后走 sendFiles 链路(入库/推 UI/串行化)。
  // 复用截图那套 persistAndSend:成功保留原图(缩略图/看大图靠 filePath 读盘)、失败删副本。
  ipcMain.handle(CMD.sendImage, async (_e, args: SendImageArgs) => {
    if (!core) return
    const fileName = `${t('main.file.imagePrefix')}_${Date.now()}_${randomUUID().slice(0, 8)}.png`
    const dir = join(app.getPath('userData'), 'sent-images') // 与截图 sentImagesDir 同源(index.ts 处)
    await persistAndSend(dir, fileName, Buffer.from(args.png), async (p) => {
      await core!.chat.sendFiles(args.peerFp, [p])
    })
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
  // 在文件管理器中定位并高亮该文件(收到的文件"打开所在文件夹")。
  ipcMain.handle(CMD.showInFolder, (_e, messageId: string) => {
    const msg = store?.get(messageId)
    if (msg?.filePath) shell.showItemInFolder(msg.filePath)
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
  // ── 接收文件夹 ──
  // 三个写操作都**立即生效**,不跟随该页的「保存」——与同页的语言、离线设备保留一致
  // (那两个也是选完即生效;跟随保存的只有自动接收开关与大小上限)。
  ipcMain.handle(CMD.getReceiveDir, (): ReceiveDirInfo => receiveDirInfo())

  ipcMain.handle(CMD.openReceiveDir, async (): Promise<void> => {
    await shell.openPath(currentReceiveDir())
  })

  ipcMain.handle(CMD.pickReceiveDir, async (): Promise<PickReceiveDirResult> => {
    const unchanged = (): PickReceiveDirResult => ({ info: receiveDirInfo(), changed: false })
    if (!mainWindow) return unchanged()
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentReceiveDir(),
      // 沙盒版靠它换取对选定目录的持久访问权(A8)。文档标注 darwin,mas 两个平台。
      securityScopedBookmarks: true
    })
    if (r.canceled || !r.filePaths[0]) return unchanged() // A1:取消 → 什么都不变
    // 选中的目录解一次符号链接再存:用户可能选到一个软链,存解析后的真身才与展示一致
    const picked = displayPath(r.filePaths[0])
    // A3:当场拒绝写不进去的目录。用系统消息框而不是设置页里的一行红字——用户此刻
    // 刚从模态选择器返回,注意力在对话框那个位置。
    if (!isDirWritable(picked)) {
      // 不传 buttons,用系统默认的确认按钮
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: t('main.dialog.receiveDirNotWritableTitle'),
        detail: t('main.dialog.receiveDirNotWritableBody', { dir: picked })
      })
      return unchanged()
    }
    // 两边都得是解过符号链接的,否则比不出"选中的就是默认目录"(spec A5)。
    // 沙盒下 getPath('downloads') 返回容器内路径,而用户在选择器里选到的是真实的
    // ~/Downloads —— 只解一边的话这两个字符串永不相等,A5 在 MAS 版就静默失效了。
    const { state, changed } = chooseDir(
      picked,
      displayPath(app.getPath('downloads')),
      settings!.getReceiveDir()
    )
    // 选中的正好是默认目录时 state.chosen 为 null —— 那书签也不该留(normalize 会强制清,
    // 这里显式传 null 只是让读代码的人不必去翻 normalize 才知道结果)。
    const bookmark = state.chosen === null ? null : (r.bookmarks?.[0] ?? null)
    settings!.setReceiveDir(state, bookmark)
    acquireReceiveDirAccess(bookmark)
    return { info: receiveDirInfo(), changed }
  })

  ipcMain.handle(CMD.resetReceiveDir, (): ReceiveDirInfo => {
    settings!.setReceiveDir({ chosen: null, notice: false })
    acquireReceiveDirAccess(null)
    return receiveDirInfo()
  })

  ipcMain.handle(CMD.dismissReceiveDirNotice, (): ReceiveDirInfo => {
    // 只清告知,不动目录也不动授权 —— 故把当前书签原样传回去
    settings!.setReceiveDir(
      { ...settings!.getReceiveDir(), notice: false },
      settings!.getReceiveDirBookmark()
    )
    return receiveDirInfo()
  })
  // 主题偏好:存 main 侧(避开 file:// 下 localStorage 慢)
  ipcMain.handle(CMD.getTheme, (): ThemePref => settings!.getTheme())
  ipcMain.handle(CMD.setTheme, (_e, t: ThemePref): ThemePref => settings!.setTheme(t))
  // 界面语言:pref 存盘,effective 由 main 解析 system(getPreferredSystemLanguages)。
  ipcMain.handle(CMD.getLanguage, (): LangResult => {
    const pref = settings!.getLanguage()
    return { pref, effective: resolveSystemEffective(pref) }
  })
  ipcMain.handle(CMD.setLanguage, (_e, pref: LangPref): LangResult => {
    settings!.setLanguage(pref)
    const effective = resolveSystemEffective(pref)
    setMainLang(effective) // 更新主进程内存态,后续 dialog/文件名用新语言
    // 广播给所有 window(主窗自身 + 常驻 overlay):后者只在首次 F1 mount 时拉过语言,
    // 无此广播则改语言后再截图仍显旧语言。
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVT.languageChanged, effective)
    return { pref, effective }
  })
  // 截图快捷键:取当前值。
  ipcMain.handle(CMD.getShortcut, (): string => settings!.getShortcutCapture())
  // 设新键:先粗校验格式 → 试注册(rebind,失败自动回滚旧键)→ 成功才持久化。
  ipcMain.handle(CMD.setShortcut, (_e, accel: string): SetShortcutResult => {
    if (!isValidAccelerator(accel)) return { ok: false, reason: 'invalid' }
    if (!screenshot!.rebindShortcut(accel)) return { ok: false, reason: 'conflict' }
    settings!.setShortcutCapture(accel)
    return { ok: true, accel }
  })
  // 离线保留时长:取当前分钟值 / 设新值。set 必须走 core(打通 registry + 立即 prune),不能只 settings.set。
  ipcMain.handle(CMD.getOfflineKeep, (): number => settings!.getOfflineKeepMinutes())
  ipcMain.handle(CMD.setOfflineKeep, (_e, minutes: number): number =>
    core?.setOfflineKeepMinutes(minutes) ?? settings!.getOfflineKeepMinutes()
  )
  // 同步总未读数(renderer 算好后传来)→ mac Dock 数字角标(0 隐藏)。
  // Windows setBadgeCount 无效(返 false),无害;Windows 提醒靠 flashFrame。
  ipcMain.handle(CMD.setUnread, (_e, total: number) => {
    app.setBadgeCount(Math.max(0, Math.floor(total)))
  })

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

  const userData = app.getPath('userData')
  // settings + 语言先建:证书失败的 showErrorBox 也需正确语言(它在 identity try 之前触发)。
  settings = new SettingsStore(userData)
  setMainLang(resolveSystemEffective(settings.getLanguage()))

  // 证书/身份(首启生成 EC 自签名证书,几十 ms)。证书是 HTTPS 硬前提,失败即无法起服务:
  // 明确报错并退出,不静默(此处在 startCore 的 catch 之前,自身需兜住 rejection,M1)。
  let identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>
  try {
    identity = await loadOrCreateIdentity(userData)
  } catch (err) {
    dialog.showErrorBox(t('main.dialog.initFailTitle'), t('main.dialog.initFailBody', { err: String(err) }))
    app.quit()
    return
  }
  store = new MessageStore(join(userData, 'messages.db'))

  // 先取回沙盒授权,再判定 —— 顺序不能反:没有授权时那个目录一定探测为不可写,
  // 判定会当场把它退回默认,于是 MAS 版每次重启都丢掉用户的设置。
  acquireReceiveDirAccess(settings.getReceiveDirBookmark())
  // 启动时判定一次(spec receive-dir C1-C4)。只在收文件前判不够——那样用户要等到
  // 下次有人发东西过来才知道自己选的文件夹早已不在,而设置页会一直显示那个失效路径。
  currentReceiveDir()

  core = new AppCore({
    identity,
    platform: process.platform,
    receiveDir: currentReceiveDir,
    httpPort: portOverride,
    store,
    settings,
    events: {
      onDevicesUpdated: (devices) => send(EVT.devicesUpdated, devices),
      onMessageUpserted: (msg) => {
        send(EVT.messageUpserted, msg)
        // 收到的消息且窗口未聚焦 → 闪烁任务栏。**仅 Windows**:mac 上 flashFrame 会让 Dock
        // 图标持续跳动(bounce),与"mac 只用数字角标、不跳"的决策冲突,故 mac 不调。
        // mac 数字角标由 renderer 的 setUnread 驱动(它才知道"是否正在看该会话")。
        if (
          process.platform === 'win32' &&
          msg.direction === 'recv' &&
          mainWindow &&
          !mainWindow.isFocused()
        ) {
          mainWindow.flashFrame(true)
        }
      },
      onProgress: (p) => send(EVT.progress, p)
    }
  })

  // 启动:遗留 pending 消息标 expired(挂起会话已随上次进程消失,DESIGN §11.2.2)
  core.chat.onStartup()

  // 截图服务:注册 F1 + 遮罩窗管理 + 三出口(§4.1)
  screenshot = new ScreenshotService({
    rendererUrl: process.env['ELECTRON_RENDERER_URL'],
    preload: PRELOAD,
    sentImagesDir: join(userData, 'sent-images'),
    getShortcut: () => settings!.getShortcutCapture(),
    // 聊天区截图按钮触发时,截图前隐藏主窗、截完恢复(F1 路径不用,主窗本就可能不在前台)
    getMainWindow: () => mainWindow,
    // 复用现有聊天发送链路(§3.4:必须走 core.chat.sendFiles 才入库/推 UI/串行化)
    sendFiles: async (peerFp, filePaths) => {
      await core!.chat.sendFiles(peerFp, filePaths)
    }
  })
  screenshot.start({ shortcut: !QUIET })

  // 网络服务(HTTP server + UDP 发现)延迟到窗口显示之后再起:让首帧更早、不被网络初始化阻塞。
  // 代价:启动后极短时间内(窗口已显示到服务就绪之间)可能收不到连接,可接受。
  const startCore = (): void => {
    core?.start().catch((err) => dialog.showErrorBox(t('main.dialog.startFailTitle'), String(err)))
    // 屏幕录制授权询问同样要等主窗显示:app 未成为前台应用时,系统不会弹出授权框。
    screenshot?.primeScreenPermission()
  }
  // QUIET 下显式不起:窗口永不显示,若只靠 once('show') 不触发是**偶然**不起——
  // 将来谁在测试里手动 show 一下,网络服务就会连带起来去抢端口、上局域网。写成显式判断。
  if (QUIET) {
    // 测试实例不起 HTTP server 与 UDP 发现(见 QUIET 定义处③)
  } else if (mainWindow && !mainWindow.isVisible()) {
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

// dev 下防僵尸:electron-vite 用 stdio:inherit 启动 electron,vite(Ctrl+C)退出后**不 kill**
// electron → electron 变孤儿留 Dock(mac window-all-closed 不退)、累积僵尸。Electron 吞
// SIGINT/SIGTERM(process.on 不触发,已实测),stdin 监听在后台/重定向启动时会误触发。故用
// **轮询父进程存活**:vite 死 → 父进程(ppid)消失 → 本进程 quit。仅 dev(有 ELECTRON_RENDERER_URL)。
if (process.env['ELECTRON_RENDERER_URL']) {
  const vitedPid = process.ppid // 启动时的父进程 = electron-vite
  const parentWatch = setInterval(() => {
    try {
      process.kill(vitedPid, 0) // 信号0:只探测存活,不真发信号;父在则不抛
    } catch {
      // 父进程(vite)没了 → 我们是孤儿 → 退出,避免留 Dock 变僵尸
      clearInterval(parentWatch)
      app.quit()
    }
  }, 1000)
}

// ④-C:Electron 不 await before-quit 的 async 回调,必须 preventDefault + 手动 quit,
// 否则 stop()(含挂起 resolver reject/标 expired)和 store.close() 可能来不及执行。
let quitting = false
app.on('before-quit', (e) => {
  if (!gotTheLock) return // 非首个实例:没初始化任何东西,直接放行退出,不走清理
  if (quitting) return // 已在清理,放行第二次 quit
  e.preventDefault()
  quitting = true

  // 释放沙盒授权。同步、放在最前:它不依赖任何异步清理,而下面那条 3s 超时的强杀路径
  // 会跳过 async 块里的一切——放进去就等于在卡住时漏释放。
  releaseReceiveDirAccess?.()
  releaseReceiveDirAccess = null

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

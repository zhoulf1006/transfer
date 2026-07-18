import { randomUUID } from 'node:crypto'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  globalShortcut,
  screen,
  ipcMain,
  desktopCapturer,
  systemPreferences,
  shell,
  dialog,
  clipboard,
  nativeImage,
  type Display
} from 'electron'
import { SHOT_CMD, EVT, type ShotSource } from '@shared/ipc'
import { computeRatios } from '@shared/screenshot-geometry'
import { APP_HOST } from './app-protocol'
import { t, getMainLang } from './i18n'

/**
 * 截图会话服务(见 docs/screenshot-feature §4)。
 *
 * 职责:F1 全局快捷键、遮罩窗生命周期、会话状态机。抓屏/裁剪/发送在后续阶段接入。
 *
 * 状态机(§4.2):idle → capturing → selecting → editing → (输出/取消) → idle。
 * 阶段2:mac 权限先查 → 先抓屏(光标屏)拿干净位图 → setBounds → show → 下发 ShotSource。
 * 裁剪/标注/发送在后续阶段接入。
 */
export type ShotState = 'idle' | 'capturing' | 'selecting' | 'editing'

/**
 * F1 是否应启动新会话(§4.2 守卫,纯函数便于单测)。
 * 仅 idle 且无抓屏 in-flight 才启动;其余(capturing/selecting/editing)一律忽略。
 */
export function shouldStartSession(state: ShotState, capturing: boolean): boolean {
  return state === 'idle' && !capturing
}

/**
 * endSession 是否应恢复(showInactive)主窗(§4.5,纯函数便于单测)。
 * 仅当本次会话隐过主窗(mainHidden)、主窗仍存在、且当前处于隐藏态时才恢复——
 * 避免把从未隐过/已被用户/其它路径显示的主窗错误地再 show 一次。
 */
export function shouldRestoreMain(mainHidden: boolean, winExists: boolean, winVisible: boolean): boolean {
  return mainHidden && winExists && !winVisible
}

export interface ScreenshotDeps {
  /** dev 时的 renderer origin(ELECTRON_RENDERER_URL),prod 为 undefined */
  rendererUrl?: string
  /** preload 脚本路径(与主窗共用) */
  preload: string
  /** 读当前截图快捷键(Electron accelerator);注入解耦 SettingsStore。 */
  getShortcut: () => string
  /** 截图"发到聊天"的原图持久目录(userData/sent-images)。
   *  发送端消息 filePath 指向此处的持久副本 —— 发完不删,缩略图/看大图/另存为才可用。 */
  sentImagesDir: string
  /** 发文件到聊天(复用现有链路,注入解耦 AppCore)。fire-and-forget,内部管临时文件清理 */
  sendFiles: (peerFp: string, filePaths: string[]) => Promise<void>
  /** 取主窗引用(聊天区截图按钮触发时,截图前隐藏、截完恢复);无主窗返回 null。 */
  getMainWindow: () => BrowserWindow | null
}

/** hide→抓屏之间等合成器出一帧的毫秒数(§4.5)。hide() 同步返回但窗口异步消失,
 *  同 tick 立刻抓屏会截到残影(macOS 尤甚,走 occlusion 路径),故等一帧。实测 200ms 足够。 */
const HIDE_SETTLE_MS = 200

export class ScreenshotService {
  private overlay: BrowserWindow | null = null
  private state: ShotState = 'idle'
  /** 抓屏 in-flight 抖动位:capturing 期间的第二次 F1 吞掉(§4.2 F1 守卫) */
  private capturing = false
  /** 主窗当前选中的 peerFp(决定"发聊天"可用);由 SHOT_CMD.setActivePeer 同步 */
  private activePeer: string | null = null
  /** 本次会话抓到的背景 + display 信息,供 overlay 经 getShot 拉取 */
  private pending: ShotSource | null = null
  /** overlay 首帧是否加载完(gate shotShow 通知,避免首次发早于 renderer 注册监听) */
  private overlayLoaded = false
  /** 输出对话框(另存为)进行中:此时遮罩失焦是对话框抢焦点,不能触发 blur→endSession */
  private dialogBusy = false
  /** 多屏时给"非光标屏"铺的纯压暗窗(吞点击防误触,§4.5);会话结束销毁 */
  private dimWindows: BrowserWindow[] = []
  /** 当前已注册的截图快捷键(accelerator);rebind/stop 精确注销用,null=未注册 */
  private currentAccel: string | null = null
  /** 本次会话是否为"截图按钮触发"而隐藏了主窗(仅此时 endSession 才 showInactive 恢复) */
  private mainHidden = false

  constructor(private readonly deps: ScreenshotDeps) {}

  /** app ready 后调用一次:注册 F1(幂等)+ 挂 IPC。 */
  start(): void {
    this.registerShortcut()
    this.registerIpc()
  }

  /** app 退出前调用:注销快捷键 + 销毁遮罩窗/压暗窗。 */
  stop(): void {
    globalShortcut.unregisterAll()
    this.currentAccel = null
    for (const w of this.dimWindows) if (!w.isDestroyed()) w.destroy()
    this.dimWindows = []
    this.overlay?.destroy()
    this.overlay = null
  }

  /** 主窗同步当前聊天对象。 */
  setActivePeer(peerFp: string | null): void {
    this.activePeer = peerFp
  }

  // ── 截图快捷键(§4.5:注册绑 app 不绑窗;键来自设置,默认 F1) ──
  private registerShortcut(): void {
    const accel = this.deps.getShortcut()
    // 幂等:重复 start / macOS activate 重入不叠加
    if (this.currentAccel === accel && globalShortcut.isRegistered(accel)) return
    const ok = globalShortcut.register(accel, () => this.onShortcut())
    if (ok) {
      this.currentAccel = accel
    } else {
      // 被其他 app 占用会静默失败,只能靠返回值检测(§3.2)。启动时用户无从改,只 warn。
      console.warn(`[screenshot] 快捷键 ${accel} 注册失败(可能被占用)`)
    }
  }

  /**
   * 重绑截图快捷键(设置页改键时调):注销旧键 → 注册新键。
   * 新键注册失败(被占用)→ **回滚**重注册旧键,保证截图键不丢。
   * @returns 新键是否注册成功。
   */
  rebindShortcut(accel: string): boolean {
    const old = this.currentAccel
    // 先注销旧键(若有),让新键(哪怕等于旧键)能干净注册
    if (old) globalShortcut.unregister(old)
    if (globalShortcut.register(accel, () => this.onShortcut())) {
      this.currentAccel = accel
      return true
    }
    // 新键失败:回滚旧键(尽力而为),currentAccel 保持旧值
    this.currentAccel = null
    if (old && globalShortcut.register(old, () => this.onShortcut())) {
      this.currentAccel = old
    }
    return false
  }

  /** F1 回调:仅 idle 启动;非 idle 一律忽略(§4.2 F1 守卫)。F1 不隐主窗(主窗本就可能不在前台)。 */
  private onShortcut(): void {
    if (!shouldStartSession(this.state, this.capturing)) return
    void this.beginSession(false)
  }

  /** 聊天区截图按钮回调:与 F1 同守卫,但截图前隐藏主窗、截完恢复。 */
  private onButtonCapture(): void {
    if (!shouldStartSession(this.state, this.capturing)) return
    void this.beginSession(true)
  }

  // ── 会话开始(§4.2:先查权限 →[隐主窗]→ 先抓屏 → setBounds → show)──
  private async beginSession(hideMain: boolean): Promise<void> {
    this.capturing = true
    this.state = 'capturing'
    try {
      // ① mac 权限先查:denied → 根本不 show 遮罩,引导系统设置,回 idle(§4.5)。
      if (!this.ensureScreenPermission()) {
        this.endSession()
        return
      }
      // ①.5 截图按钮触发:抓屏前隐藏主窗,等一帧让它真正从屏幕消失(否则截到残影,§4.5)。
      if (hideMain) await this.hideMainWindow()
      // ② 选光标屏 → 先抓屏拿干净位图(此时屏上无本 app 可见窗,防自截,§4.5)。
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const source = await this.capture(display)
      this.pending = source
      // ③ 先置 selecting 再 show(show/focus 触发的 blur 需落在 blur handler 覆盖的态,§4.5)。
      this.state = 'selecting'
      // 其余屏先压暗(showInactive),再 show 光标屏遮罩并 focus,确保焦点落在可交互遮罩上。
      this.dimOtherScreens(display.id)
      this.showOverlay(display.bounds)
      // ④ 通知 overlay 进入会话(它据此 getShot 拉背景 + 复位,§4.3)。
      // 用 notifyShow gate 首帧加载,避免首次发早于 renderer 注册监听(见其注释)。
      this.notifyShow(source.shotId)
    } catch (err) {
      // 任何失败分支都回 idle,否则 state 卡死会让 F1 被永久吞(§4.2)。
      console.error('[screenshot] 会话启动失败', err)
      this.endSession()
    } finally {
      this.capturing = false
    }
  }

  /**
   * 截图前隐藏主窗(§4.5):hide() 同步返回但窗口异步从屏幕消失,故等 HIDE_SETTLE_MS
   * 让合成器出一帧,再由调用方抓屏,避免截到主窗残影。仅当主窗存在且可见时才隐;
   * 置 mainHidden 让 endSession 据此恢复。
   */
  private async hideMainWindow(): Promise<void> {
    const win = this.deps.getMainWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) return
    win.hide()
    this.mainHidden = true
    await new Promise((resolve) => setTimeout(resolve, HIDE_SETTLE_MS))
  }

  /**
   * mac 屏幕录制权限(§4.5)。granted/not-determined 放行(后者首次调用系统会自动弹);
   * denied/restricted → 引导系统设置并返回 false。Windows 恒 granted。
   */
  private ensureScreenPermission(): boolean {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('screen')
    if (status === 'granted' || status === 'not-determined') return true
    void dialog
      .showMessageBox({
        type: 'warning',
        message: t('main.dialog.screenPermTitle'),
        detail: t('main.dialog.screenPermDetail'),
        buttons: [t('main.dialog.screenPermOpen'), t('main.dialog.screenPermCancel')],
        defaultId: 0,
        cancelId: 1
      })
      .then((r) => {
        if (r.response === 0) {
          void shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
          )
        }
      })
    return false
  }

  /**
   * 抓光标屏原生位图(§3.1)。thumbnailSize = 逻辑尺寸 × scaleFactor 取物理像素;
   * 实际返回尺寸系统说了算,故一切换算以 thumbnail.getSize() 实测为准。
   */
  private async capture(display: Display): Promise<ShotSource> {
    const { width: dw, height: dh } = display.size
    const sf = display.scaleFactor
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(dw * sf), height: Math.round(dh * sf) }
    })
    if (sources.length === 0) throw new Error('desktopCapturer 未返回任何屏幕源')
    // 多屏:按 display_id 匹配光标屏;拿不到(空串/无匹配)时退回第一个源(§3.1)。
    const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    const bmp = src.thumbnail
    const { width: bw, height: bh } = bmp.getSize() // 实测物理尺寸
    const ratios = computeRatios({ width: bw, height: bh }, { width: dw, height: dh })
    return {
      shotId: randomUUID(),
      dataUrl: bmp.toDataURL(),
      bitmapW: bw,
      bitmapH: bh,
      displayW: dw,
      displayH: dh,
      ratioX: ratios.x,
      ratioY: ratios.y,
      rotation: display.rotation,
      hasActivePeer: this.activePeer !== null
    }
  }

  /** 结束会话:hide 遮罩窗、销毁压暗窗、清背景、回 idle(§4.2 复位入口)。 */
  private endSession(): void {
    this.state = 'idle'
    this.pending = null // 释放背景 dataURL,防复用累积(§4.7)
    if (this.overlay && !this.overlay.isDestroyed()) {
      // hide 前先通知 overlay 清空状态,否则遮罩窗 hide 复用,下次 show 会先闪上次的选区框(§4.7)。
      this.overlay.webContents.send(EVT.shotHide)
      this.overlay.hide()
    }
    for (const w of this.dimWindows) if (!w.isDestroyed()) w.destroy()
    this.dimWindows = []
    // 截图按钮触发时隐过主窗:统一在此恢复(正常出口/取消/异常/权限失败都经 endSession,
    // 保证隐过的主窗必被恢复,不会永久消失)。showInactive 不抢焦点(§4.5,用户所选)。
    const win = this.deps.getMainWindow()
    const winExists = win !== null && !win.isDestroyed()
    if (shouldRestoreMain(this.mainHidden, winExists, winExists && win!.isVisible())) {
      win!.showInactive()
    }
    this.mainHidden = false
    // 注:F1 路径不隐主窗——从头到尾不碰主窗层叠,它本在哪层就还在哪层,自然"不抢最前"。
    // (macOS 无法精确记录/恢复窗口全局层叠顺序,故不做"回到原位置",只保证不主动扰动。)
  }

  /**
   * 多屏:给非光标屏各铺一个纯压暗窗(吞点击防误触,§4.5)。
   * 用轻量 data: URL 页面,不加载 React,不接收键盘/框选。
   */
  private dimOtherScreens(activeDisplayId: number): void {
    for (const d of screen.getAllDisplays()) {
      if (d.id === activeDisplayId) continue
      const win = new BrowserWindow({
        ...d.bounds,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: false, // 不抢键盘焦点(键盘归光标屏遮罩)
        enableLargerThanScreen: true,
        // 同遮罩窗:不用 panel(避免 Dock 图标消失)
        webPreferences: { contextIsolation: true, nodeIntegration: false }
      })
      // 纯半透明黑,吞点击(窗口接收但页面无任何交互)。
      void win.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            '<body style="margin:0;background:rgba(0,0,0,0.45);height:100vh"></body>'
          )
      )
      win.setBounds(d.bounds)
      win.setAlwaysOnTop(true, 'screen-saver')
      win.showInactive() // 显示但不激活(不抢焦点)
      this.dimWindows.push(win)
    }
  }

  // ── 遮罩窗(§3.2 透明置顶配置 + §4.5 setBounds 必在 show 前)──
  private ensureOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false, // 透明窗不可 resize,否则某些平台失效(§3.2)
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true, // macOS:允许铺满/超出屏
      // 不用 type:'panel':panel 会把 mac app 的 activation policy 降到 accessory
      // (Dock 图标消失),代价是不能浮在别的 app 原生全屏之上(普通截图不受影响)。
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    // 失焦即取消会话,避免僵尸遮罩(§4.5)。
    // 但"另存为对话框抢焦点"导致的失焦不算取消,否则对话框一弹遮罩就被收、对话框随之消失。
    win.on('blur', () => {
      if (this.dialogBusy) return
      if (this.state === 'selecting' || this.state === 'editing') this.endSession()
    })
    // 首帧加载完才允许 send(shotShow),否则首次会话发得比 renderer 注册监听早会丢失。
    win.webContents.once('did-finish-load', () => {
      this.overlayLoaded = true
    })
    this.loadOverlay(win)
    this.overlay = win
    return win
  }

  /** 通知 overlay 进会话:已加载直接发,未加载则等 did-finish-load(避免丢首次事件)。 */
  private notifyShow(shotId: string): void {
    const win = this.overlay
    if (!win || win.isDestroyed()) return
    if (this.overlayLoaded) {
      win.webContents.send(EVT.shotShow, shotId)
    } else {
      win.webContents.once('did-finish-load', () => {
        // 加载完成时会话可能已被取消(state 回 idle),校验后再发。
        if (this.state !== 'idle' && this.pending?.shotId === shotId) {
          win.webContents.send(EVT.shotShow, shotId)
        }
      })
    }
  }

  private loadOverlay(win: BrowserWindow): void {
    // overlay 是全屏视觉焦点:把当前有效语言经 URL query 带过去,首帧即正确(无中文闪现)。
    // 常驻 overlay 只在创建时加载一次;之后的语言变化走 EVT.languageChanged 广播热切换。
    const q = `?lang=${getMainLang()}`
    if (this.deps.rendererUrl) {
      void win.loadURL(`${this.deps.rendererUrl}/overlay.html${q}`)
    } else {
      void win.loadURL(`app://${APP_HOST}/overlay.html${q}`)
    }
  }

  /** setBounds 必在 show 之前(§4.5:避免旧屏闪现);show 后 focus 拿键盘焦点。 */
  private showOverlay(bounds: Electron.Rectangle): void {
    const win = this.ensureOverlay()
    win.setBounds(bounds)
    // screen-saver 级足以盖 Dock/任务栏,且不改 activation policy(降级的是 panel,已去掉)。
    win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    win.focus() // 键盘交互(Esc/方向键/Ctrl+Z)前提(§4.5)
  }

  // ── IPC(overlay → main)──
  private registerIpc(): void {
    ipcMain.handle(SHOT_CMD.cancel, () => this.endSession())
    // 聊天区截图按钮触发:隐主窗再截图(与 F1 同守卫,防重入)。
    ipcMain.handle(SHOT_CMD.beginFromMain, () => this.onButtonCapture())
    // overlay 进会话后拉背景 + display 信息(§4.3)。
    ipcMain.handle(SHOT_CMD.getShot, () => this.pending)

    // ── 三出口(§4.3):都在完成后 endSession 回 idle ──
    // 复制到剪贴板(不落盘)。
    ipcMain.handle(SHOT_CMD.toClipboard, (_e, png: Uint8Array) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)))
      this.endSession()
    })
    // 另存为:直接写到用户选定路径,不经临时文件。返回保存路径或 null(取消)。
    ipcMain.handle(SHOT_CMD.saveAs, async (_e, png: Uint8Array): Promise<string | null> => {
      const win = this.overlay && !this.overlay.isDestroyed() ? this.overlay : null
      // dialogBusy 抑制"对话框抢焦点→遮罩 blur→endSession"(否则对话框一弹遮罩就被收、对话框随之沉底)。
      // 不主动 app.focus 抢前台:对话框依附遮罩窗(screen-saver 置顶)已能呈现,且要保持"不抢最前"
      // 的一致性——若截图前在后台,endSession 里 app.hide 会把焦点交回之前的 app。
      this.dialogBusy = true
      try {
        const opts = {
          defaultPath: `${t('main.file.screenshotPrefix')}_${stamp()}.png`,
          filters: [{ name: t('main.file.pngFilterName'), extensions: ['png'] }]
        }
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (r.canceled || !r.filePath) return null
        await writeFile(r.filePath, Buffer.from(png))
        return r.filePath
      } finally {
        this.dialogBusy = false
        this.endSession()
      }
    })
    // 发到当前聊天:fire-and-forget,peer 从缓存取;写临时文件→sendFiles→finally 清理。
    ipcMain.handle(SHOT_CMD.sendToChat, (_e, png: Uint8Array) => {
      const peer = this.activePeer
      this.endSession() // 立即收起遮罩回 idle,不阻塞(§4.2)
      if (!peer) return // 无对象不该走到这(overlay 已禁用按钮),兜底忽略
      void this.sendToChatBackground(peer, Buffer.from(png))
    })
  }

  /**
   * 后台发送(fire-and-forget,§4.2):写唯一命名的**持久**副本 → sendFiles。
   * 与普通发送一致,发送端消息 filePath 指向本机真实存在的原图,故缩略图/看大图/另存为都可用。
   * **成功保留原图**(不删,否则发送端 getThumbnail 读空文件→回退文件图标,即此前的 bug);
   * **失败才删**这张刚写的副本(消息已入失败态,原图无保留价值,免碎片堆积)。
   */
  private async sendToChatBackground(peer: string, png: Buffer): Promise<void> {
    const fileName = `${t('main.file.screenshotPrefix')}_${stamp()}_${randomUUID().slice(0, 8)}.png`
    await persistAndSend(this.deps.sentImagesDir, fileName, png, (p) =>
      this.deps.sendFiles(peer, [p])
    )
  }
}

/**
 * 把截图 png 写入持久目录并发送(§4.2 的可测核心,抽出便于单测:不碰 electron/类状态)。
 * 成功保留文件(发送端 filePath 指向真实原图→缩略图/看大图可用);失败删副本免碎片。
 * @returns 成功=保留的绝对路径;失败=null(已删)。
 */
export async function persistAndSend(
  dir: string,
  fileName: string,
  png: Buffer,
  send: (path: string) => Promise<void>
): Promise<string | null> {
  const path = join(dir, fileName)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, png)
    await send(path)
    return path
  } catch (err) {
    console.error('[screenshot] 发送失败', err)
    // 失败:删掉刚写的副本(可能 writeFile 已成功但 send 抛),不留碎片。
    await unlink(path).catch(() => {})
    return null
  }
}

/** 时间戳文件名片段 yyyyMMdd_HHmmss(不含随机,唯一性由调用方加后缀保证)。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

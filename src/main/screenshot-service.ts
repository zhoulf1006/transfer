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

export interface ScreenshotDeps {
  /** dev 时的 renderer origin(ELECTRON_RENDERER_URL),prod 为 undefined */
  rendererUrl?: string
  /** prod 时 overlay.html 的磁盘路径 */
  overlayFile: string
  /** preload 脚本路径(与主窗共用) */
  preload: string
  /** 截图临时文件目录(app.getPath('temp')/transfer-shot) */
  tempDir: string
  /** 发文件到聊天(复用现有链路,注入解耦 AppCore)。fire-and-forget,内部管临时文件清理 */
  sendFiles: (peerFp: string, filePaths: string[]) => Promise<void>
}

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
  /** 多屏时给"非光标屏"铺的纯压暗窗(吞点击防误触,§4.5);会话结束销毁 */
  private dimWindows: BrowserWindow[] = []

  constructor(private readonly deps: ScreenshotDeps) {}

  /** app ready 后调用一次:注册 F1(幂等)+ 挂 IPC。 */
  start(): void {
    this.registerShortcut()
    this.registerIpc()
  }

  /** app 退出前调用:注销快捷键 + 销毁遮罩窗/压暗窗。 */
  stop(): void {
    globalShortcut.unregisterAll()
    for (const w of this.dimWindows) if (!w.isDestroyed()) w.destroy()
    this.dimWindows = []
    this.overlay?.destroy()
    this.overlay = null
  }

  /** 主窗同步当前聊天对象。 */
  setActivePeer(peerFp: string | null): void {
    this.activePeer = peerFp
  }

  // ── F1 快捷键(§4.5:幂等注册,绑 app 不绑窗) ──
  private registerShortcut(): void {
    // 幂等:重复 start / macOS activate 重入不叠加
    if (globalShortcut.isRegistered('F1')) return
    const ok = globalShortcut.register('F1', () => this.onShortcut())
    if (!ok) {
      // 被其他 app 占用会静默失败,只能靠返回值检测(§3.2)。
      // TODO(阶段5+):暴露给设置页提示"F1 被占用,请改键"。
      console.warn('[screenshot] F1 注册失败(可能被占用)')
    }
  }

  /** F1 回调:仅 idle 启动;非 idle 一律忽略(§4.2 F1 守卫)。 */
  private onShortcut(): void {
    if (!shouldStartSession(this.state, this.capturing)) return
    void this.beginSession()
  }

  // ── 会话开始(§4.2:先查权限 → 先抓屏 → setBounds → show)──
  private async beginSession(): Promise<void> {
    this.capturing = true
    this.state = 'capturing'
    try {
      // ① mac 权限先查:denied → 根本不 show 遮罩,引导系统设置,回 idle(§4.5)。
      if (!this.ensureScreenPermission()) {
        this.endSession()
        return
      }
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
        message: '需要屏幕录制权限',
        detail: '请在「系统设置 → 隐私与安全性 → 屏幕录制」中允许 Transfer,然后重启应用。',
        buttons: ['打开系统设置', '取消'],
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
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide()
    for (const w of this.dimWindows) if (!w.isDestroyed()) w.destroy()
    this.dimWindows = []
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
        type: process.platform === 'darwin' ? 'panel' : undefined,
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
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }
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
      type: process.platform === 'darwin' ? 'panel' : undefined, // mac 浮在全屏 app 上
      webPreferences: {
        preload: this.deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    // 失焦即取消会话,避免僵尸遮罩(§4.5)。
    win.on('blur', () => {
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
    if (this.deps.rendererUrl) {
      void win.loadURL(`${this.deps.rendererUrl}/overlay.html`)
    } else {
      void win.loadFile(this.deps.overlayFile)
    }
  }

  /** setBounds 必在 show 之前(§4.5:避免旧屏闪现);show 后 focus 拿键盘焦点。 */
  private showOverlay(bounds: Electron.Rectangle): void {
    const win = this.ensureOverlay()
    win.setBounds(bounds)
    if (process.platform === 'darwin') {
      win.setAlwaysOnTop(true, 'screen-saver') // 盖 Dock(§3.2)
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } else {
      win.setAlwaysOnTop(true, 'screen-saver')
    }
    win.show()
    win.focus() // 键盘交互(Esc/方向键/Ctrl+Z)前提(§4.5)
  }

  // ── IPC(overlay → main)──
  private registerIpc(): void {
    ipcMain.handle(SHOT_CMD.cancel, () => this.endSession())
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
      // 必须先收起遮罩:遮罩是 screen-saver 最高层置顶透明窗,不收会盖住保存对话框
      // (且遮罩失焦本就触发 endSession)→ 现象是"点保存直接退出、对话框看不见"。
      this.endSession()
      const r = await dialog.showSaveDialog({
        defaultPath: `截图_${stamp()}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (r.canceled || !r.filePath) return null
      await writeFile(r.filePath, Buffer.from(png))
      return r.filePath
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
   * 后台发送(fire-and-forget,§4.2):写唯一命名临时文件 → sendFiles → finally 清理。
   * sendFiles 内部即使失败也复用现有聊天流展示状态,这里只保证临时文件不泄漏。
   */
  private async sendToChatBackground(peer: string, png: Buffer): Promise<void> {
    const path = join(this.deps.tempDir, `截图_${stamp()}_${randomUUID().slice(0, 8)}.png`)
    try {
      await mkdir(this.deps.tempDir, { recursive: true })
      await writeFile(path, png)
      await this.deps.sendFiles(peer, [path])
    } catch (err) {
      console.error('[screenshot] 发送失败', err)
    } finally {
      // 无论成败,sendFiles 这一 await 结束后一律删临时文件(流式读已完成,§4.5)。
      await unlink(path).catch(() => {})
    }
  }
}

/** 时间戳文件名片段 yyyyMMdd_HHmmss(不含随机,唯一性由调用方加后缀保证)。 */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

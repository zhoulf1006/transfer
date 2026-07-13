import { BrowserWindow, globalShortcut, screen, ipcMain } from 'electron'
import { SHOT_CMD } from '@shared/ipc'

/**
 * 截图会话服务(见 docs/screenshot-feature §4)。
 *
 * 职责:F1 全局快捷键、遮罩窗生命周期、会话状态机。抓屏/裁剪/发送在后续阶段接入。
 *
 * 状态机(§4.2):idle → capturing → selecting → editing → (输出/取消) → idle。
 * 本阶段(骨架)只实现 idle ↔ (show 空遮罩窗) ↔ idle,失败/取消/失焦均回 idle。
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
}

export class ScreenshotService {
  private overlay: BrowserWindow | null = null
  private state: ShotState = 'idle'
  /** 抓屏 in-flight 抖动位:capturing 期间的第二次 F1 吞掉(§4.2 F1 守卫) */
  private capturing = false
  /** 主窗当前选中的 peerFp(决定"发聊天"可用);由 SHOT_CMD.setActivePeer 同步 */
  private activePeer: string | null = null

  /** 当前是否有可发送的聊天对象(阶段2 的 getShot 会带上此标志给 overlay)。 */
  hasActivePeer(): boolean {
    return this.activePeer !== null
  }

  constructor(private readonly deps: ScreenshotDeps) {}

  /** app ready 后调用一次:注册 F1(幂等)+ 挂 IPC。 */
  start(): void {
    this.registerShortcut()
    this.registerIpc()
  }

  /** app 退出前调用:注销快捷键 + 销毁遮罩窗。 */
  stop(): void {
    globalShortcut.unregisterAll()
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
      // TODO(阶段2):mac 权限先查;desktopCapturer 抓光标屏拿干净位图。
      // 本阶段先跳过抓屏,直接铺遮罩窗验证骨架。
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      // 先置 selecting 再 show:确保 show/focus 触发的 blur 落在 blur handler 覆盖的态上,
      // 不会停在 capturing 而漏掉失焦取消(§4.5 失焦)。
      this.state = 'selecting'
      this.showOverlay(display.bounds)
    } catch (err) {
      // 任何失败分支都回 idle,否则 state 卡死会让 F1 被永久吞(§4.2)。
      console.error('[screenshot] 会话启动失败', err)
      this.endSession()
    } finally {
      this.capturing = false
    }
  }

  /** 结束会话:hide 遮罩窗、回 idle(§4.2 复位入口)。 */
  private endSession(): void {
    this.state = 'idle'
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.hide()
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
    this.loadOverlay(win)
    this.overlay = win
    return win
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
    // getShot/toClipboard/saveAs/sendToChat 在阶段2/5 接入。
  }
}

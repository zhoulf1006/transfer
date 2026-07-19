import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  type UiMessage,
  type ProgressPayload,
  type ShotSource,
  type ThemePref,
  type LangPref,
  type LangResult,
  type Lang,
  type StorageDirs,
  type SetShortcutResult
} from '@shared/ipc'
import type { RemoteDevice } from '@shared/types'

const api = {
  getIdentity: (): Promise<IdentityInfo> => ipcRenderer.invoke(CMD.getIdentity),
  setAlias: (alias: string): Promise<void> => ipcRenderer.invoke(CMD.setAlias, alias),
  /** 设置远端设备备注(fingerprint→备注)。空串=删备注恢复默认名。返回 {ok} 供失败反馈。 */
  setRemoteAlias: (fingerprint: string, alias: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CMD.setRemoteAlias, { fingerprint, alias }),
  listDevices: (): Promise<RemoteDevice[]> => ipcRenderer.invoke(CMD.listDevices),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(CMD.pickFiles),
  /**
   * 拖入文件 → 真实路径(§12.4)。必须在 preload 对**原始** File 调 webUtils.getPathForFile;
   * 不能过 IPC/克隆(会丢磁盘背书→空串)。过滤掉空串(拖入非文件/文件夹异常)。
   */
  getDroppedPaths: (files: File[]): string[] =>
    files.map((f) => webUtils.getPathForFile(f)).filter((p) => p.length > 0),

  // 聊天
  sendText: (args: SendTextArgs): Promise<void> => ipcRenderer.invoke(CMD.sendText, args),
  sendFiles: (args: SendFilesArgs): Promise<void> => ipcRenderer.invoke(CMD.sendFiles, args),
  /** 发送剪贴板/内存里的图片(png 字节):main 落盘持久副本后走 sendFiles 链路 */
  sendImage: (args: SendImageArgs): Promise<void> => ipcRenderer.invoke(CMD.sendImage, args),
  respond: (args: RespondArgs): Promise<void> => ipcRenderer.invoke(CMD.respond, args),
  listMessages: (args?: ListMessagesArgs): Promise<UiMessage[]> =>
    ipcRenderer.invoke(CMD.listMessages, args),
  listReceivedFiles: (args?: ListMessagesArgs): Promise<UiMessage[]> =>
    ipcRenderer.invoke(CMD.listReceivedFiles, args),
  openFile: (messageId: string): Promise<void> => ipcRenderer.invoke(CMD.openFile, messageId),
  /** 取图片消息缩略图 dataURL(拿不到返回 null,UI 回退文件图标) */
  getThumbnail: (messageId: string): Promise<string | null> =>
    ipcRenderer.invoke(CMD.getThumbnail, messageId),
  /** 图片另存为(弹对话框复制原图到选定位置),返回保存路径或 null(取消) */
  saveImageAs: (messageId: string): Promise<string | null> =>
    ipcRenderer.invoke(CMD.saveImageAs, messageId),
  /** 取原图 dataURL(居中弹层看大图);拿不到返回 null */
  getImageDataUrl: (messageId: string): Promise<string | null> =>
    ipcRenderer.invoke(CMD.getImageDataUrl, messageId),
  getAutoAccept: (): Promise<AutoAcceptSettings> => ipcRenderer.invoke(CMD.getAutoAccept),
  setAutoAccept: (s: Partial<AutoAcceptSettings>): Promise<AutoAcceptSettings> =>
    ipcRenderer.invoke(CMD.setAutoAccept, s),
  /** 主题偏好读写(存 main 侧,避开 file:// 下 localStorage 慢) */
  getTheme: (): Promise<ThemePref> => ipcRenderer.invoke(CMD.getTheme),
  setTheme: (t: ThemePref): Promise<ThemePref> => ipcRenderer.invoke(CMD.setTheme, t),
  /** 界面语言:读回 {pref,effective};写 pref 后回传新 {pref,effective}(main 解析 system) */
  getLanguage: (): Promise<LangResult> => ipcRenderer.invoke(CMD.getLanguage),
  setLanguage: (pref: LangPref): Promise<LangResult> => ipcRenderer.invoke(CMD.setLanguage, pref),
  /** 截图快捷键:取当前 / 设新(设时 main 试注册,冲突返 ok:false) */
  getShortcut: (): Promise<string> => ipcRenderer.invoke(CMD.getShortcut),
  setShortcut: (accel: string): Promise<SetShortcutResult> =>
    ipcRenderer.invoke(CMD.setShortcut, accel),
  getOfflineKeep: (): Promise<number> => ipcRenderer.invoke(CMD.getOfflineKeep),
  setOfflineKeep: (minutes: number): Promise<number> =>
    ipcRenderer.invoke(CMD.setOfflineKeep, minutes),
  /** 存储目录:取路径展示 + 打开(系统文件管理器) */
  getStorageDirs: (): Promise<StorageDirs> => ipcRenderer.invoke(CMD.getStorageDirs),
  openDownloadsDir: (): Promise<void> => ipcRenderer.invoke(CMD.openDownloadsDir),
  /** 在文件管理器中定位并选中收到的文件 */
  showInFolder: (messageId: string): Promise<void> => ipcRenderer.invoke(CMD.showInFolder, messageId),
  /** 同步总未读数给 main(驱动 mac Dock 数字角标) */
  setUnread: (total: number): Promise<void> => ipcRenderer.invoke(CMD.setUnread, total),

  // 事件订阅(返回取消函数)
  onDevicesUpdated: (cb: (devices: RemoteDevice[]) => void) => subscribe(EVT.devicesUpdated, cb),
  onMessageUpserted: (cb: (msg: UiMessage) => void) => subscribe(EVT.messageUpserted, cb),
  onProgress: (cb: (p: ProgressPayload) => void) => subscribe(EVT.progress, cb),
  /** 主窗聚焦态变化(用于"正在看→不计未读") */
  onWindowFocus: (cb: (focused: boolean) => void) => subscribe(EVT.windowFocus, cb),
  /** 界面语言变化(main 广播 effective):所有 window 热切换,含常驻 overlay */
  onLanguageChanged: (cb: (lang: Lang) => void) => subscribe(EVT.languageChanged, cb),

  // ── 截图(主窗同步 peer;overlay 用 shot 子分组,见 docs/screenshot-feature §4.1)──
  /** 主窗当前聊天对象变化时同步给 main(决定截图"发聊天"可用性) */
  setShotActivePeer: (peerFp: string | null): Promise<void> =>
    ipcRenderer.invoke(SHOT_CMD.setActivePeer, peerFp),

  /** 聊天区截图按钮:触发一次截图会话(main 隐藏主窗再抓屏,与 F1 等效) */
  beginShot: (): Promise<void> => ipcRenderer.invoke(SHOT_CMD.beginFromMain),

  shot: {
    /** overlay 拉背景位图 + display 信息 + 有无 peer(会话未就绪时为 null) */
    getShot: (): Promise<ShotSource | null> => ipcRenderer.invoke(SHOT_CMD.getShot),
    /** 复制到剪贴板(不落盘) */
    toClipboard: (png: Uint8Array): Promise<void> =>
      ipcRenderer.invoke(SHOT_CMD.toClipboard, png),
    /** 另存为(直写选定路径),返回保存路径或 null(取消) */
    saveAs: (png: Uint8Array): Promise<string | null> => ipcRenderer.invoke(SHOT_CMD.saveAs, png),
    /** 发到当前聊天(fire-and-forget,peer 由 main 缓存) */
    sendToChat: (png: Uint8Array): Promise<void> => ipcRenderer.invoke(SHOT_CMD.sendToChat, png),
    /** 结束会话(Esc/取消)→ main hide 遮罩窗 */
    cancel: (): Promise<void> => ipcRenderer.invoke(SHOT_CMD.cancel),
    /** 订阅"进入会话"(main → overlay,带 shotId) */
    onShow: (cb: (shotId: string) => void) => subscribe(EVT.shotShow, cb),
    /** 订阅"会话结束"(main → overlay:清空状态回等待态) */
    onHide: (cb: () => void) => subscribe(EVT.shotHide, cb)
  }
}

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('transfer', api)

export type TransferApi = typeof api

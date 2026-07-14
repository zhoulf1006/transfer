import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  type UiMessage,
  type ProgressPayload,
  type ShotSource,
  type ThemePref
} from '@shared/ipc'
import type { RemoteDevice } from '@shared/types'

const api = {
  getIdentity: (): Promise<IdentityInfo> => ipcRenderer.invoke(CMD.getIdentity),
  setAlias: (alias: string): Promise<void> => ipcRenderer.invoke(CMD.setAlias, alias),
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

  // 事件订阅(返回取消函数)
  onDevicesUpdated: (cb: (devices: RemoteDevice[]) => void) => subscribe(EVT.devicesUpdated, cb),
  onMessageUpserted: (cb: (msg: UiMessage) => void) => subscribe(EVT.messageUpserted, cb),
  onProgress: (cb: (p: ProgressPayload) => void) => subscribe(EVT.progress, cb),

  // ── 截图(主窗同步 peer;overlay 用 shot 子分组,见 docs/screenshot-feature §4.1)──
  /** 主窗当前聊天对象变化时同步给 main(决定截图"发聊天"可用性) */
  setShotActivePeer: (peerFp: string | null): Promise<void> =>
    ipcRenderer.invoke(SHOT_CMD.setActivePeer, peerFp),

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

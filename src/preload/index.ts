import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  CMD,
  EVT,
  type SendTextArgs,
  type SendFilesArgs,
  type RespondArgs,
  type ListMessagesArgs,
  type AutoAcceptSettings,
  type IdentityInfo,
  type UiMessage,
  type ProgressPayload
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
  getAutoAccept: (): Promise<AutoAcceptSettings> => ipcRenderer.invoke(CMD.getAutoAccept),
  setAutoAccept: (s: Partial<AutoAcceptSettings>): Promise<AutoAcceptSettings> =>
    ipcRenderer.invoke(CMD.setAutoAccept, s),

  // 事件订阅(返回取消函数)
  onDevicesUpdated: (cb: (devices: RemoteDevice[]) => void) => subscribe(EVT.devicesUpdated, cb),
  onMessageUpserted: (cb: (msg: UiMessage) => void) => subscribe(EVT.messageUpserted, cb),
  onProgress: (cb: (p: ProgressPayload) => void) => subscribe(EVT.progress, cb)
}

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('transfer', api)

export type TransferApi = typeof api

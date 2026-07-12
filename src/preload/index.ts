import { contextBridge, ipcRenderer } from 'electron'
import { CMD, EVT, type SendArgs, type IdentityInfo } from '@shared/ipc'
import type { RemoteDevice } from '@shared/types'

const api = {
  getIdentity: (): Promise<IdentityInfo> => ipcRenderer.invoke(CMD.getIdentity),
  setAlias: (alias: string): Promise<void> => ipcRenderer.invoke(CMD.setAlias, alias),
  getReceiveDir: (): Promise<string> => ipcRenderer.invoke(CMD.getReceiveDir),
  listDevices: (): Promise<RemoteDevice[]> => ipcRenderer.invoke(CMD.listDevices),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(CMD.pickFiles),
  send: (args: SendArgs): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(CMD.send, args),

  // 事件订阅(返回取消函数)
  onDevicesUpdated: (cb: (devices: RemoteDevice[]) => void) => subscribe(EVT.devicesUpdated, cb),
  onIncoming: (cb: (p: unknown) => void) => subscribe(EVT.transferIncoming, cb),
  onProgress: (cb: (p: unknown) => void) => subscribe(EVT.transferProgress, cb),
  onDone: (cb: (p: unknown) => void) => subscribe(EVT.transferDone, cb),
  onError: (cb: (p: unknown) => void) => subscribe(EVT.transferError, cb)
}

function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('transfer', api)

export type TransferApi = typeof api

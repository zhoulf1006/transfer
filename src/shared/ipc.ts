// IPC 契约(main ↔ renderer,见 docs/DESIGN §8)
// 所有传输相关消息带 transferId(本地,区别于协议 sessionId)。

import type { RemoteDevice, FileMeta } from './types'

// ── 主 → 渲染 事件 channel ──
export const EVT = {
  devicesUpdated: 'devices:updated',
  transferIncoming: 'transfer:incoming',
  transferProgress: 'transfer:progress',
  transferDone: 'transfer:done',
  transferError: 'transfer:error'
} as const

// ── 渲染 → 主 调用 channel ──
export const CMD = {
  respond: 'transfer:respond',
  send: 'transfer:send',
  cancel: 'transfer:cancel',
  getIdentity: 'device:getIdentity',
  setAlias: 'device:setAlias',
  getReceiveDir: 'settings:getReceiveDir',
  listDevices: 'devices:list',
  pickFiles: 'dialog:pickFiles'
} as const

export interface IncomingPayload {
  transferId: string
  fromAlias: string
  files: Pick<FileMeta, 'fileName' | 'size'>[]
}

export interface ProgressPayload {
  transferId: string
  direction: 'send' | 'recv'
  fileName: string
}

export interface DonePayload {
  transferId: string
  direction: 'send' | 'recv'
}

export interface ErrorPayload {
  transferId: string
  message: string
}

export interface RespondArgs {
  transferId: string
  accept: boolean
}

export interface SendArgs {
  fingerprint: string
  filePaths: string[]
}

export interface IdentityInfo {
  alias: string
  fingerprint: string
}

export type { RemoteDevice }

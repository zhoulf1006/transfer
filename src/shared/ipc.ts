// IPC 契约(main ↔ renderer,见 docs/DESIGN §8、§11.5)

import type { RemoteDevice } from './types'

// ── 消息(聊天流)UI 数据模型(与 main/db/messages 的 Message 对齐)──
export type MessageType = 'text' | 'file'
export type Direction = 'sent' | 'recv'
export type MessageStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'sent'
  | 'done'
  | 'failed'
  | 'expired'

export interface UiMessage {
  id: string
  type: MessageType
  direction: Direction
  peerFp: string
  peerAlias: string
  content: string | null
  fileName: string | null
  fileSize: number | null
  filePath: string | null
  status: MessageStatus
  errorReason: string | null
  transferId: string | null
  createdAt: number
}

// ── 主 → 渲染 事件 channel ──
export const EVT = {
  devicesUpdated: 'devices:updated',
  /** 单条消息新增/状态变化(带完整 UiMessage) */
  messageUpserted: 'message:upserted',
  /** 传输进度(不落库,§12.3) */
  progress: 'transfer:progress'
} as const

export interface ProgressPayload {
  messageId: string
  sent: number
  total: number
  direction: 'send' | 'recv'
}

// ── 渲染 → 主 调用 channel ──
export const CMD = {
  getIdentity: 'device:getIdentity',
  setAlias: 'device:setAlias',
  listDevices: 'devices:list',
  pickFiles: 'dialog:pickFiles',
  // 聊天
  sendText: 'message:sendText',
  sendFiles: 'message:sendFiles',
  respond: 'message:respond',
  listMessages: 'message:list',
  listReceivedFiles: 'message:listReceivedFiles',
  openFile: 'message:openFile',
  getAutoAccept: 'settings:getAutoAccept',
  setAutoAccept: 'settings:setAutoAccept'
} as const

export interface IdentityInfo {
  alias: string
  fingerprint: string
}

export interface SendTextArgs {
  peerFp: string
  text: string
}

export interface SendFilesArgs {
  peerFp: string
  filePaths: string[]
}

export interface RespondArgs {
  transferId: string
  accept: boolean
}

export interface ListMessagesArgs {
  limit?: number
  before?: number
}

export interface AutoAcceptSettings {
  enabled: boolean
  maxBytes: number
}

export type { RemoteDevice }

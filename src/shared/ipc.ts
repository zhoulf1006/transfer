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
  progress: 'transfer:progress',
  /** 截图:main → overlay,进入会话(带 shotId),overlay 按复位清单复位并拉背景 */
  shotShow: 'shot:show',
  /** 截图:main → overlay,会话结束,overlay 清空状态(回等待态,防下次 show 闪旧框) */
  shotHide: 'shot:hide'
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
  /** 取图片消息缩略图 dataURL(png/jpg 可生成;拿不到返回 null → UI 回退文件图标) */
  getThumbnail: 'message:getThumbnail',
  getAutoAccept: 'settings:getAutoAccept',
  setAutoAccept: 'settings:setAutoAccept'
} as const

// ── 截图(overlay ↔ main)独立分组,避免 CMD 膨胀(见 docs/screenshot-feature §4.3)──
export const SHOT_CMD = {
  /** 主窗 setPeer 时同步当前 peerFp|null 给 main 缓存(决定"发聊天"可用性) */
  setActivePeer: 'shot:setActivePeer',
  /** overlay 拉背景位图 + display 信息 + 有无当前 peer(返回 ShotSource) */
  getShot: 'shot:getShot',
  /** (pngBuffer) → void;写进系统剪贴板(不落盘) */
  toClipboard: 'shot:toClipboard',
  /** (pngBuffer) → savedPath|null;直接写到用户选定路径(不经临时文件) */
  saveAs: 'shot:saveAs',
  /** (pngBuffer) → void;fire-and-forget,peer 从 main 缓存取,不由 overlay 传 */
  sendToChat: 'shot:sendToChat',
  /** overlay → main:结束会话,hide 遮罩窗回 idle */
  cancel: 'shot:cancel'
} as const

/** 截图背景位图 payload(getShot 返回);坐标换算规则见 docs/screenshot-feature §3.3/§4.5 */
export interface ShotSource {
  /** 本次会话 id(overlay 用作 React key 强制重挂,保证复位) */
  shotId: string
  /** 屏幕快照 PNG(物理像素)dataURL */
  dataUrl: string
  /** 位图物理尺寸(thumbnail.getSize() 实测) */
  bitmapW: number
  bitmapH: number
  /** display.size 逻辑尺寸 */
  displayW: number
  displayH: number
  /** = bitmapW/displayW、bitmapH/displayH(两轴各自算,非等比时不同) */
  ratioX: number
  ratioY: number
  /** display.rotation(0/90/180/270);≠0 时第一版走 scaleFactor 兜底 */
  rotation: number
  /** 有无当前聊天对象 → 决定"发聊天"按钮是否可用 */
  hasActivePeer: boolean
}

/** 按文件名扩展名判断是否图片(决定聊天里是否尝试显示缩略图)。 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'svg'])
export function isImageFile(fileName: string | null): boolean {
  if (!fileName) return false
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext ? IMAGE_EXTS.has(ext) : false
}

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

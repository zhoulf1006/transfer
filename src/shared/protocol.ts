// LocalSend 协议 v2 常量(来源:github.com/localsend/protocol,见 docs/DESIGN §1.1、§4)

export const MULTICAST_ADDR = '224.0.0.167'
export const DEFAULT_PORT = 53317
/** 报文 version 字段值(README 标题 v2.1,但报文内示例为 "2.0",见 DESIGN §1.1) */
export const PROTOCOL_VERSION = '2.0'
export const API_PREFIX = '/api/localsend/v2'

export const EP = {
  register: `${API_PREFIX}/register`,
  info: `${API_PREFIX}/info`,
  prepareUpload: `${API_PREFIX}/prepare-upload`,
  upload: `${API_PREFIX}/upload`,
  cancel: `${API_PREFIX}/cancel`
} as const

/** 超时契约(DESIGN §5.1):T_sender ≥ T_dialog + 余量 */
export const T_DIALOG_MS = 30_000
export const T_SENDER_MS = 45_000
/** 传输空闲超时:任一 upload 有字节即 reset */
export const T_IDLE_MS = 30_000
/** 单个 upload 请求超时(S4:防接收方异常挂起时发送方永挂)。大文件留足余量 */
export const T_UPLOAD_MS = 5 * 60_000

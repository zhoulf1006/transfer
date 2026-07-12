// 协议 DTO(LocalSend v2,见 docs/DESIGN §1.1)

export type DeviceType = 'mobile' | 'desktop' | 'web' | 'headless' | 'server'

/**
 * 设备信息。多播 announce 与 prepare-upload 的 info 里含 port/protocol;
 * /register 响应 与 prepare-download 的 info 里省略(见 DESIGN §1.1)。
 */
export interface DeviceInfo {
  alias: string
  version: string
  deviceModel?: string | null
  deviceType?: DeviceType | null
  fingerprint: string
  port?: number
  protocol?: 'http' | 'https'
  download?: boolean
}

/** 多播报文 = DeviceInfo(含 port/protocol) + announce 标志 */
export interface Announcement extends DeviceInfo {
  port: number
  protocol: 'http' | 'https'
  announce: boolean
}

/** prepare-upload 请求里每个文件的元数据 */
export interface FileMeta {
  id: string
  fileName: string
  size: number
  fileType: string
  sha256?: string
  preview?: string
  metadata?: {
    modified?: string
    accessed?: string
  }
}

export interface PrepareUploadRequest {
  info: DeviceInfo
  /** key = fileId(= 各 FileMeta.id) */
  files: Record<string, FileMeta>
}

export interface PrepareUploadResponse {
  sessionId: string
  /** key = fileId(仅含被**接受**的文件,拒绝的省略,见 DESIGN §1.1 部分接受) */
  files: Record<string, string>
}

/** 发现到的对端设备(在 DeviceInfo 基础上补充连接信息) */
export interface RemoteDevice {
  info: DeviceInfo
  /** 从 UDP 报文来源或 HTTP 连接得到 */
  address: string
  port: number
  protocol: 'http' | 'https'
  /** 最近一次听到该设备的时间戳(ms),用于过期 */
  lastSeen: number
  /** 在线/离线(§12.2):TTL 内为 online,超 TTL 转 offline 灰置底保留,超 keep 才真删 */
  status: 'online' | 'offline'
}

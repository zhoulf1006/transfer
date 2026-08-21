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

/** 超时契约(DESIGN §5.1/§11.2.3):T_sender ≥ 接收方确认窗口 + 余量。
 *  异步确认下用户可能几分钟才点,故发送方 prepare-upload 超时放宽到 6min(> T_ACCEPT_MS 5min)。 */
export const T_DIALOG_MS = 30_000 // 保留常量(旧弹框语义,现已被 T_ACCEPT_MS 取代)
export const T_SENDER_MS = 6 * 60_000
/** 传输空闲超时:任一 upload 有字节即 reset(接收方,由 SessionManager.touch 刷新) */
export const T_IDLE_MS = 30_000
/**
 * 接收方推进会话超时的扫描间隔。会话最迟在 T_IDLE_MS + T_SWEEP_MS 被判空闲,
 * 发送方的空闲阈值要比这个上界大 —— 见 T_UPLOAD_IDLE_MS。
 */
export const T_SWEEP_MS = 5_000
/**
 * 连接级建连超时:只管"TCP+TLS 建连到握手完成"这段,连不上时快速失败(而非干等 T_SENDER_MS 6min)。
 * 主治对端开 VPN(如 F5 full-tunnel)时到局域网 IP 被灌进隧道黑洞导致的静默长挂。
 * ⚠️ 只在 pinnedAgent 建连阶段生效,握手成功后必须清除,否则大文件上传空闲期会被误杀
 * (见 docs/postmortems/send-connect-timeout.md)。
 */
export const T_CONNECT_MS = 10_000
/**
 * 单个 upload 请求的**空闲**超时(S4:防接收方异常挂起时发送方永挂)。
 *
 * 语义是「距上次有字节被传输层接受超过这么久」,**不是总时长**(ADR-0020)。总时长超时会把
 * "文件大"误判成"连接断":5 分钟的总时长上限意味着能传多大取决于带宽,而不是磁盘。
 *
 * 取值必须大于接收方判空闲的上界 `T_IDLE_MS + T_SWEEP_MS`,好让**会话的所有者**(接收方)
 * 先清理、发送方随后拿到一个明确的连接错误;反过来会让发送方先放弃,接收方留着孤儿会话
 * 等自己超时。这条序关系由 protocol.test.ts 锁住。
 */
export const T_UPLOAD_IDLE_MS = 45_000
/**
 * 聊天流内确认超时(DESIGN §11.2.3):用户在聊天流里点接收/拒绝的等待窗口。
 * 同时作为挂起 resolver 超时 + SessionManager pending 超时。比旧的 30s 弹框大得多,
 * 因为聊天流里用户可能几分钟才处理(LocalSend 发送方超时 30 天,容忍慢确认)。
 */
export const T_ACCEPT_MS = 5 * 60_000

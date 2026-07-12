// 应用核心装配:发现层 + 传输层 + 身份(与 Electron 解耦,见 docs/DESIGN §2)
//
// 弹框决策通过注入的 askUser 回调完成 —— 主进程用 Electron dialog 实现,
// 从而核心逻辑不直接依赖 Electron。

import { accessSync, constants } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { DeviceInfo, RemoteDevice } from '@shared/types'
import { DEFAULT_PORT } from '@shared/protocol'
import { buildDeviceInfo, type Identity } from '@shared/identity'
import { MulticastDiscovery } from './discovery/multicast'
import { DeviceRegistry } from './discovery/device-registry'
import { SessionManager } from './transfer/session'
import { createHttpServer } from './transfer/http-server'
import { sendFiles, sendText, type SendTarget } from './transfer/http-client'
import { ChatService } from './chat-service'
import type { MessageStore } from './db/messages'
import type { SettingsStore } from './settings'
import type { Message } from './db/messages'

export interface AppCoreEvents {
  onDevicesUpdated: (devices: RemoteDevice[]) => void
  /** 单条消息新增/状态变化,推给 UI */
  onMessageUpserted: (msg: Message) => void
}

export interface AppCoreOpts {
  identity: Identity
  platform: NodeJS.Platform
  receiveDir: string
  /** 消息持久化(注入,便于测试用 :memory:) */
  store: MessageStore
  /** 设置(自动接收) */
  settings: SettingsStore
  /** HTTP 服务端口(对方连接用)。默认 DEFAULT_PORT。同机多实例须不同(DESIGN §7/M5) */
  httpPort?: number
  /** UDP 多播监听端口。固定 DEFAULT_PORT 才能互相发现;仅测试可覆盖(DESIGN §7/M5) */
  multicastPort?: number
  /** 多播绑定接口:不传=自动选真实局域网接口;''=OS 默认(测试隔离用) */
  interfaceAddr?: string
  events: AppCoreEvents
}

export class AppCore {
  private readonly registry: DeviceRegistry
  private readonly sessions: SessionManager
  private readonly discovery: MulticastDiscovery
  private server: FastifyInstance | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly opts: AppCoreOpts
  /** HTTP 服务端口(= announce.port,对方连接用)。EADDRINUSE 时向上回退,故非 readonly */
  private httpPort: number
  /** 端口回退时的最大尝试次数(53317..53317+N) */
  private readonly maxPortAttempts = 20
  /** UDP 多播端口(固定,同机多实例共享) */
  private readonly multicastPort: number
  readonly chat: ChatService

  constructor(opts: AppCoreOpts) {
    this.opts = opts
    this.httpPort = opts.httpPort ?? DEFAULT_PORT
    this.multicastPort = opts.multicastPort ?? DEFAULT_PORT
    const now = () => Date.now()
    this.registry = new DeviceRegistry({ now })
    this.sessions = new SessionManager({ now })

    // 聊天编排:持久化 + 发送/接收/确认 + 挂起 resolver 表
    this.chat = new ChatService({
      store: opts.store,
      settings: opts.settings,
      sender: {
        sendFiles: (target, files, onProgress) =>
          sendFiles(target, this.selfInfo(), files, onProgress),
        sendText: (target, text) => sendText(target, this.selfInfo(), text)
      },
      resolvePeer: (fp) => this.resolvePeer(fp),
      isReceiveDirWritable: () => this.isReceiveDirWritable(),
      onMessageUpserted: (msg) => opts.events.onMessageUpserted(msg)
    })

    this.discovery = new MulticastDiscovery({
      selfFingerprint: opts.identity.fingerprint,
      buildAnnouncement: (announce) => ({
        ...this.selfInfo(),
        port: this.httpPort,
        protocol: 'http',
        announce
      }),
      onDevice: (info, address) => this.handleDevice(info, address),
      port: this.multicastPort,
      interfaceAddr: opts.interfaceAddr
    })
  }

  private selfInfo(): DeviceInfo {
    // info.port = HTTP 端口(对方要连的),非多播端口
    return buildDeviceInfo(this.opts.identity, this.opts.platform, this.httpPort)
  }

  /** 接收目录是否可写(①-A:自动接收前预检) */
  private isReceiveDirWritable(): boolean {
    try {
      accessSync(this.opts.receiveDir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  /** fingerprint → 连接目标 + alias(离线返回 null) */
  private resolvePeer(fingerprint: string): { target: SendTarget; alias: string } | null {
    const dev = this.registry.list().find((d) => d.info.fingerprint === fingerprint)
    if (!dev) return null
    return {
      target: { address: dev.address, port: dev.port, protocol: dev.protocol },
      alias: dev.info.alias
    }
  }

  private handleDevice(info: DeviceInfo, address: string): void {
    const changed = this.registry.upsert(
      info,
      address,
      info.port ?? DEFAULT_PORT,
      info.protocol ?? 'http'
    )
    if (changed) this.opts.events.onDevicesUpdated(this.registry.list())
  }

  async start(): Promise<void> {
    // S6:任一步失败都回滚已分配的资源(HTTP server / socket / 定时器),不泄漏
    try {
      this.server = createHttpServer({
        sessions: this.sessions,
        selfInfo: () => this.selfInfo(),
        receiveDir: () => this.opts.receiveDir,
        onPrepareAsk: (transferId, req, fromIp) => this.chat.askUser(transferId, req, fromIp),
        onTextMessage: (text, from) => this.chat.handleIncomingText(text, from),
        shouldAutoAcceptFiles: (files) => this.chat.shouldAutoAcceptFiles(files),
        onAutoAccept: (files, from) => this.chat.handleAutoAccept(files, from),
        onRegister: (info, address) => this.handleDevice(info, address),
        onFileDone: (i) => this.chat.handleFileDone(i.fileId, i.path),
        onFileFailed: (fileId, reason) => this.chat.handleFileFailed(fileId, reason)
      })
      // HTTP 端口回退(DESIGN §7):53317 被占(如本机已有 LocalSend / 残留实例)时,
      // 向上试 53318、53319…。多播端口固定不变,announce.port 用实际 HTTP 端口(selfInfo 自动反映)。
      await this.listenWithFallback(this.server)

      // 发现
      await this.discovery.start()

      // 定期 announce(心跳)、过期清理、会话超时推进
      this.pruneTimer = setInterval(() => {
        this.discovery.announce(true)
        const removed = this.registry.prune()
        if (removed.length) this.opts.events.onDevicesUpdated(this.registry.list())
      }, 5_000)
      this.sweepTimer = setInterval(() => this.sessions.sweep(), 5_000)
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  /**
   * 监听 HTTP 端口,EADDRINUSE 时向上回退(53317 → 53318 → …)。
   * 成功后 this.httpPort 更新为实际端口(announce/selfInfo 随之反映)。
   */
  private async listenWithFallback(server: FastifyInstance): Promise<void> {
    const startPort = this.httpPort
    for (let i = 0; i < this.maxPortAttempts; i++) {
      const port = startPort + i
      try {
        await server.listen({ host: '0.0.0.0', port })
        this.httpPort = port
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          continue // 该端口被占,试下一个
        }
        throw err // 其他错误直接抛
      }
    }
    throw new Error(
      `HTTP 端口 ${startPort}..${startPort + this.maxPortAttempts - 1} 全部被占用`
    )
  }

  /** 实际使用的 HTTP 端口(回退后可能非默认) */
  get actualHttpPort(): number {
    return this.httpPort
  }

  listDevices(): RemoteDevice[] {
    return this.registry.list()
  }

  // 发送/接收/确认由 this.chat(ChatService)承载,见 index.ts IPC 接线。

  async stop(): Promise<void> {
    // S6b:幂等 —— 置 null 防重复 stop 时二次 clearInterval / 二次 server.close(会 reject)
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.chat.shutdown() // 挂起 resolver 全部 reject + pending 标 expired(DESIGN §11.2.2)
    this.discovery.stop()
    if (this.server) {
      const server = this.server
      this.server = null
      await server.close()
    }
  }
}

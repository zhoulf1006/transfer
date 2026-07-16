// 应用核心装配:发现层 + 传输层 + 身份(与 Electron 解耦,见 docs/DESIGN §2)
//
// 弹框决策通过注入的 askUser 回调完成 —— 主进程用 Electron dialog 实现,
// 从而核心逻辑不直接依赖 Electron。

import { accessSync, constants, statSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import type { DeviceInfo, RemoteDevice } from '@shared/types'
import { DEFAULT_PORT } from '@shared/protocol'
import { buildDeviceInfo, type Identity } from '@shared/identity'
import { MulticastDiscovery } from './discovery/multicast'
import { DeviceRegistry } from './discovery/device-registry'
import { SessionManager } from './transfer/session'
import { createHttpServer } from './transfer/http-server'
import { sendFiles, sendText, registerTo, type SendTarget } from './transfer/http-client'
import { ChatService } from './chat-service'
import type { MessageStore } from './db/messages'
import type { SettingsStore } from './settings'
import type { Message } from './db/messages'

export interface AppCoreEvents {
  onDevicesUpdated: (devices: RemoteDevice[]) => void
  /** 单条消息新增/状态变化,推给 UI */
  onMessageUpserted: (msg: Message) => void
  /** 传输进度(不落库,§12.3),推给 UI */
  onProgress?: (p: { messageId: string; sent: number; total: number; direction: 'send' | 'recv' }) => void
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
      fileSize: (path) => {
        try {
          return statSync(path).size
        } catch {
          return null
        }
      },
      onMessageUpserted: (msg) => opts.events.onMessageUpserted(msg),
      onProgress: (p) => opts.events.onProgress?.(p)
    })

    this.discovery = new MulticastDiscovery({
      selfFingerprint: opts.identity.fingerprint,
      buildAnnouncement: (announce) => ({
        ...this.selfInfo(),
        port: this.httpPort,
        protocol: 'https',
        announce
      }),
      onDevice: (info, address) => this.handleDevice(info, address),
      // 收到别人主动广播 → HTTP 定向 register 回应,让对方也发现我们(替代 UDP 多播回应)。
      onRespond: (info, address) => this.respondViaRegister(info, address),
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
      // fingerprint = 发现阶段记住的对端证书指纹,连接时用它 pin TLS(§3.4)
      target: {
        address: dev.address,
        port: dev.port,
        protocol: dev.protocol,
        fingerprint: dev.info.fingerprint
      },
      alias: dev.info.alias
    }
  }

  /**
   * 收到对方主动广播时,向对方定向 `POST /register` 回应本机信息(替代 UDP 多播回应),
   * 好让**对方**发现我们(对方的 server 收 /register 会登记我们)。fire-and-forget:失败静默
   * (对方每 5s 还会 announce,天然有重试节奏)。
   *
   * ⚠️ **不用 register 响应体刷新我方登记**:LocalSend 协议规定 /register 响应体**省略 port**
   * (http-server.ts 只回 alias/version/fingerprint…无 port)。若拿它 handleDevice,会用
   * DEFAULT_PORT 覆盖掉我方已从 announce 拿到的对方真实端口 → 连错端口传输失败。
   * 我方对对方的登记已由收到的 announce(onDevice→handleDevice,info 含正确 port)完成,无需再刷。
   */
  private respondViaRegister(info: DeviceInfo, address: string): void {
    const target: SendTarget = {
      address,
      port: info.port ?? DEFAULT_PORT,
      protocol: info.protocol ?? 'https',
      // register 走不 pin 的 discoveryAgent(B1:此刻可能还没登记对方,无指纹可 pin)。
      // fingerprint 仅占位,registerTo 不校验它。
      fingerprint: info.fingerprint
    }
    void registerTo(target, this.selfInfo()) // 只为让对方发现我们;返回值忽略
  }

  private handleDevice(info: DeviceInfo, address: string): void {
    const changed = this.registry.upsert(
      info,
      address,
      info.port ?? DEFAULT_PORT,
      info.protocol ?? 'https'
    )
    if (changed) this.emitDevices()
  }

  async start(): Promise<void> {
    // S6:任一步失败都回滚已分配的资源(HTTP server / socket / 定时器),不泄漏
    try {
      this.server = createHttpServer({
        sessions: this.sessions,
        tls: { key: this.opts.identity.privateKey, cert: this.opts.identity.cert },
        selfInfo: () => this.selfInfo(),
        receiveDir: () => this.opts.receiveDir,
        onPrepareAsk: (transferId, req, fromIp) => this.chat.askUser(transferId, req, fromIp),
        onTextMessage: (text, from) => this.chat.handleIncomingText(text, from),
        shouldAutoAcceptFiles: (files) => this.chat.shouldAutoAcceptFiles(files),
        onAutoAccept: (files, from) => this.chat.handleAutoAccept(files, from),
        onRegister: (info, address) => this.handleDevice(info, address),
        onFileDone: (i) => this.chat.handleFileDone(i.fileId, i.path),
        onFileFailed: (fileId, reason) => this.chat.handleFileFailed(fileId, reason),
        onFileProgress: (fileId, received, total) =>
          this.chat.handleReceiveProgress(fileId, received, total)
      })
      // HTTP 端口回退(DESIGN §7):53317 被占(如本机已有 LocalSend / 残留实例)时,
      // 向上试 53318、53319…。多播端口固定不变,announce.port 用实际 HTTP 端口(selfInfo 自动反映)。
      await this.listenWithFallback(this.server)

      // 发现
      await this.discovery.start()

      // 定期 announce(心跳)、过期清理(online→offline→删)、会话超时推进
      this.pruneTimer = setInterval(() => {
        this.discovery.announce(true)
        const { changed } = this.registry.prune()
        if (changed) this.emitDevices()
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
    return this.applyAliases(this.registry.list())
  }

  /**
   * 把用户自定义备注合并进设备列表(发给 renderer 前)。见 docs/device-alias.md §3.1。
   * 只产出新对象,不写回 registry(registry 恒存对端原始 info)。
   */
  private applyAliases(devices: RemoteDevice[]): RemoteDevice[] {
    const aliases = this.opts.settings.getDeviceAliases()
    return devices.map((d) => {
      const custom = aliases[d.info.fingerprint] // 恒非空或 undefined(SettingsStore normalize 已滤空)
      return {
        ...d,
        info: {
          ...d.info,
          defaultAlias: d.info.alias, // 原名恒保留
          alias: custom || d.info.alias, // 备注优先
          hasCustomAlias: !!custom // 菜单据此判定,不靠字符串比对(Bug#1)
        }
      }
    })
  }

  /** 合并备注后推一次 devices:updated(统一出口,三处发现层变化都走它)。 */
  private emitDevices(): void {
    this.opts.events.onDevicesUpdated(this.applyAliases(this.registry.list()))
  }

  /**
   * 设置远端设备备注 + 立即刷新列表。返回 {ok}(持久化失败为 false,供 renderer 反馈)。
   * 见 docs/device-alias.md §3.2。不校验 fingerprint 是否在线:允许给离线/已删设备写(永久保留)。
   */
  setRemoteAlias(fingerprint: string, alias: string): { ok: boolean } {
    const ok = this.opts.settings.setDeviceAlias(fingerprint, alias)
    if (ok) this.emitDevices() // 不等下次多播,立即可见
    return { ok }
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
      // fastify close() 会等所有活动/keep-alive 连接关闭,有挂起连接时可能久等甚至不 resolve
      // → 拖住退出(僵尸进程根因)。给 1.5s 上限,超时就不等了(进程即将退出,OS 会回收 socket)。
      await Promise.race([
        server.close(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ])
    }
  }
}

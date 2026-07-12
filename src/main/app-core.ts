// 应用核心装配:发现层 + 传输层 + 身份(与 Electron 解耦,见 docs/DESIGN §2)
//
// 弹框决策通过注入的 askUser 回调完成 —— 主进程用 Electron dialog 实现,
// 从而核心逻辑不直接依赖 Electron。

import type { FastifyInstance } from 'fastify'
import type { DeviceInfo, PrepareUploadRequest, RemoteDevice } from '@shared/types'
import { DEFAULT_PORT, T_DIALOG_MS } from '@shared/protocol'
import { buildDeviceInfo, generateSessionId, type Identity } from '@shared/identity'
import { MulticastDiscovery } from './discovery/multicast'
import { DeviceRegistry } from './discovery/device-registry'
import { SessionManager } from './transfer/session'
import { createHttpServer } from './transfer/http-server'
import { sendFiles, cancelSession, type SendFile } from './transfer/http-client'

export interface AppCoreEvents {
  onDevicesUpdated: (devices: RemoteDevice[]) => void
  /** 询问用户是否接收;返回接受的 fileId 列表或 false(拒绝) */
  askUser: (transferId: string, req: PrepareUploadRequest, fromIp: string) => Promise<string[] | false>
  onIncomingFileDone?: (fileName: string, size: number) => void
}

export interface AppCoreOpts {
  identity: Identity
  platform: NodeJS.Platform
  receiveDir: string
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

  constructor(opts: AppCoreOpts) {
    this.opts = opts
    this.httpPort = opts.httpPort ?? DEFAULT_PORT
    this.multicastPort = opts.multicastPort ?? DEFAULT_PORT
    const now = () => Date.now()
    this.registry = new DeviceRegistry({ now })
    this.sessions = new SessionManager({ now })

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
        onPrepareAsk: this.opts.events.askUser,
        onRegister: (info, address) => this.handleDevice(info, address),
        onFileDone: (i) => this.opts.events.onIncomingFileDone?.(i.fileName, i.size)
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
      this.sweepTimer = setInterval(() => this.sessions.sweep(), Math.min(T_DIALOG_MS, 5_000))
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

  /** 用户对接收弹框的响应由主进程 askUser 的 Promise 内部处理,这里不再暴露 respond。 */

  async sendTo(
    fingerprint: string,
    files: SendFile[],
    onProgress?: (fileId: string) => void
  ): Promise<{ ok: boolean; message?: string }> {
    const dev = this.registry.list().find((d) => d.info.fingerprint === fingerprint)
    if (!dev) return { ok: false, message: '设备不在线' }
    const res = await sendFiles(
      { address: dev.address, port: dev.port, protocol: dev.protocol },
      this.selfInfo(),
      files,
      onProgress
    )
    switch (res.kind) {
      case 'done':
        return { ok: true }
      case 'rejected':
        return { ok: false, message: '对方拒绝了传输' }
      case 'busy':
        return { ok: false, message: '对方正忙(已有其他传输)' }
      case 'error':
        return { ok: false, message: res.message }
    }
  }

  async cancelTo(fingerprint: string, sessionId: string): Promise<void> {
    const dev = this.registry.list().find((d) => d.info.fingerprint === fingerprint)
    if (dev) await cancelSession({ address: dev.address, port: dev.port, protocol: dev.protocol }, sessionId)
  }

  newTransferId(): string {
    return generateSessionId()
  }

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
    this.discovery.stop()
    if (this.server) {
      const server = this.server
      this.server = null
      await server.close()
    }
  }
}

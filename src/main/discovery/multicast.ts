// UDP 多播发现(见 docs/DESIGN §1.1、§1.4、§5、docs/discovery-socket-recovery.md)
//
// 事实层(已坐实,DESIGN §1.4):
//  - reuseAddr:true 必需(否则同机第二实例 EADDRINUSE),且两实例都能收到多播
//  - loopback 默认开 → 本机会收到自己的广告 → 必须用 fingerprint 应用层过滤
//  - 必须 bind(53317) + addMembership(224.0.0.167) 才收得到
//
// 运行期健壮性(discovery-socket-recovery.md):socket 可能运行期静默僵死(IGMP 老化 /
// 网络抖动 / VPN 路由变化),表现为双向收发中断但 socket 无 error。故加:
//  - 两层检测:运行期 error 分类(不再吞) + loopback nonce 心跳自检
//  - 安全重建:关旧等 close → 建新 → bind 0.0.0.0 → listening 后 join → 恢复 announce
//  - 状态机 + 幂等锁 + BINDING 看门狗 + 退避,防竞态/风暴/卡死

import { createSocket as dgramCreateSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { MULTICAST_ADDR, DEFAULT_PORT } from '@shared/protocol'
import type { Announcement, DeviceInfo } from '@shared/types'
import { pickMulticastInterface, pickAllLanInterfaces, pickBroadcastTargets } from './pick-interface'

// ── 常量(discovery-socket-recovery.md §5)──────────────────────────────
const HB_INTERVAL_MS = 3_000 // 心跳周期(发探测 + 检查在途)
const HB_DEAD_MS = 9_000 // 在途探测超过此真实时长未回 → 判死(时间维度,非数 tick)
const HB_MAGIC = Buffer.from('HB\0') // 心跳包魔术前缀(JSON 业务包首字节必为 '{',不冲突)
const BIND_WATCHDOG_MS = 8_000 // BINDING 后未 listening 的看门狗超时
const REBUILD_BACKOFF_MS = [500, 1000, 2000, 5000, 10000] // 可恢复错误退避(封顶 10s)
const FATAL_RETRY_MS = 30_000 // 真·致命错误的慢重试周期(非永停)
const FATAL_CODES = new Set(['EACCES', 'EPERM', 'EINVAL']) // EADDRNOTAVAIL 不在此列(瞬态可恢复)

type State = 'IDLE' | 'BINDING' | 'READY' | 'REBUILDING'

/** 注入点(测试用 fake socket / fake clock 确定性驱动;生产用默认) */
export interface MulticastDeps {
  createSocket?: () => Socket
  /** 单调时钟(ms),默认 performance.now;判死用它算真实经过时间,不受系统时间跳变影响 */
  monotonicNow?: () => number
}

export interface MulticastOpts {
  /** 本机 fingerprint,用于过滤自己发的报文 */
  selfFingerprint: string
  /** 本机 announce 内容工厂(alias 可能被用户改,故用工厂动态取) */
  buildAnnouncement: (announce: boolean) => Announcement
  /** 收到别的设备的报文(已过滤自己)。address 为报文来源 IP。 */
  onDevice: (info: DeviceInfo, address: string) => void
  /**
   * 收到别人的**主动广播**(announce=true)时触发,用于定向 HTTP register 回应,
   * 让对方也能发现我们(替代原 UDP 多播回应)。address = 对方 IP。
   * 只对 announce=true 触发(announce=false 是别人的回应,不再回,防无限对回)。
   */
  onRespond?: (info: DeviceInfo, address: string) => void
  /** 端口(默认 53317),测试可覆盖 */
  port?: number
  multicastAddr?: string
  /**
   * 绑定的本机接口 IPv4(多网卡/代理环境必需,否则多播可能走隧道接口)。
   * 不传则自动挑选真实局域网接口;传空串强制用 OS 默认(测试用)。
   */
  interfaceAddr?: string
}

export class MulticastDiscovery {
  private socket: Socket | null = null
  private readonly opts: Required<Pick<MulticastOpts, 'port' | 'multicastAddr'>> & MulticastOpts
  private readonly createSocket: () => Socket
  private readonly now: () => number

  /** 首选出接口地址(undefined = OS 默认) */
  private boundInterface: string | undefined
  /** 加入了多播组的所有接口(空 = 用 OS 默认接口) */
  private joinedInterfaces: string[] = []
  /** 广播兜底目标:{网卡地址, 子网广播地址}(多播之外同发一份,提升发现成功率) */
  private broadcastTargets: { address: string; broadcast: string }[] = []

  // ── 运行期健壮性状态 ──
  private state: State = 'IDLE'
  private rebuilding = false // 重建幂等锁
  private backoffIdx = 0
  private hbTimer: NodeJS.Timeout | null = null
  private rebuildTimer: NodeJS.Timeout | null = null
  private bindWatchdog: NodeJS.Timeout | null = null
  /** 在途心跳探测:{nonce, 发出时刻(单调 ms)};null = 无在途 */
  private pendingNonce: { nonce: Buffer; sentAt: number } | null = null

  constructor(opts: MulticastOpts, deps: MulticastDeps = {}) {
    this.opts = {
      port: DEFAULT_PORT,
      multicastAddr: MULTICAST_ADDR,
      ...opts
    }
    this.createSocket = deps.createSocket ?? (() => dgramCreateSocket({ type: 'udp4', reuseAddr: true }))
    this.now = deps.monotonicNow ?? (() => performance.now())
  }

  /** 本次绑定的接口(调试/日志用) */
  get iface(): string | undefined {
    return this.boundInterface
  }

  /** 启动:build 一次 socket(bind + join + announce)。首次 bind 失败 → reject(S6 回滚保留)。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.buildSocket(resolve, reject)
    })
  }

  /**
   * 建立/重建 socket。onReady/onFail 仅首次 start() 传(用于 resolve/reject promise);
   * 重建时不传(promise 早已 settle)。
   */
  private buildSocket(onReady?: () => void, onFail?: (err: Error) => void): void {
    if (this.state === 'IDLE' && this.rebuilding) {
      // stop() 已发生(重建路径的双保险,§3.3)
      return
    }
    this.state = 'BINDING'
    // m2:复位心跳,防重建后立即误判
    this.pendingNonce = null

    const s = this.createSocket()
    this.socket = s

    // error 始终挂(dgram error 不自动关 socket,且不挂会抛进程级异常);分类处理
    s.on('error', (err) => this.onSocketError(err, onFail))
    s.on('message', (buf, rinfo) => this.onMessage(buf, rinfo.address))

    // B2:BINDING 看门狗——bind 可能既不 listening 也不 error 地挂住
    this.clearBindWatchdog()
    this.bindWatchdog = setTimeout(() => {
      // 仍在 BINDING 且还是这个 socket → 判定 bind 卡死,重建
      if (this.state === 'BINDING' && this.socket === s) {
        try {
          s.close()
        } catch {
          /* ignore */
        }
        this.scheduleRebuild('bind timeout')
      }
    }, BIND_WATCHDOG_MS)

    s.on('listening', () => {
      // #7061:不在 listening 同步栈里做重活/close,defer 到下一 tick
      setImmediate(() => this.onListening(s, onReady, onFail))
    })

    try {
      s.bind(this.opts.port) // 0.0.0.0(不带 address):Linux 下 bind 具体 IP 收不到组播
    } catch (err) {
      // 同步 bind 抛(罕见)→ 当 error 处理
      this.onSocketError(err as Error, onFail)
    }
  }

  /** listening 到达后:setMulticastLoopback + 重算接口 + join + 恢复 announce。 */
  private onListening(s: Socket, onReady?: () => void, onFail?: (err: Error) => void): void {
    // stop / 新一轮重建已发生 → 丢弃这个 socket
    if (this.state !== 'BINDING' || this.socket !== s) {
      try {
        s.close()
      } catch {
        /* ignore */
      }
      return
    }
    this.clearBindWatchdog()

    try {
      s.setMulticastLoopback(true) // 钉死 loopback(默认开,但显式写死防被关→假僵死)
      this.recomputeInterfaces() // m3:保留 interfaceAddr==='' → [] 特判
      if (this.joinedInterfaces.length === 0) {
        s.addMembership(this.opts.multicastAddr)
      } else {
        for (const iface of this.joinedInterfaces) {
          s.addMembership(this.opts.multicastAddr, iface)
        }
        const primary = pickMulticastInterface(networkInterfaces())
        if (primary) s.setMulticastInterface(primary)
        this.boundInterface = primary
      }
      s.setBroadcast(true)
      this.broadcastTargets =
        this.opts.interfaceAddr === '' ? [] : pickBroadcastTargets(networkInterfaces())
    } catch (err) {
      // join/接口配置失败:首次 start → reject 回滚;重建 → 当 error 退避重试
      if (onFail) {
        this.stop()
        onFail(err as Error)
        return
      }
      this.scheduleRebuild(`post-bind: ${(err as NodeJS.ErrnoException).code ?? err}`)
      return
    }

    this.state = 'READY'
    this.backoffIdx = 0
    this.startHeartbeat()
    this.announce(true)
    onReady?.()
  }

  /** 接口重算(§3.3 m3:必须复用 start 三分支,不能简化成一行 pickAll,否则破坏测试隔离)。 */
  private recomputeInterfaces(): void {
    if (this.opts.interfaceAddr === '') {
      this.joinedInterfaces = []
    } else if (this.opts.interfaceAddr) {
      this.joinedInterfaces = [this.opts.interfaceAddr]
    } else {
      this.joinedInterfaces = pickAllLanInterfaces(networkInterfaces())
    }
  }

  /** 运行期 socket error 分类(替换旧的"吞错")。 */
  private onSocketError(err: Error, onFail?: (err: Error) => void): void {
    const code = (err as NodeJS.ErrnoException).code
    // 首次 start 的 bind 前错误 → reject(保留现有 S6 语义)
    if (onFail && this.state === 'BINDING' && !this.rebuilding) {
      this.stop()
      onFail(err)
      return
    }
    if (code && FATAL_CODES.has(code)) {
      // 真·致命(权限类):日志 + 静默慢重试(不永停、不接 UI)
      console.error(`[discovery] fatal socket error ${code}, slow-retry in ${FATAL_RETRY_MS}ms`, err)
      this.scheduleRebuild(`fatal ${code}`, true)
    } else {
      // 可恢复(ENETDOWN/ENETUNREACH/EADDRNOTAVAIL/EADDRINUSE/…)→ 退避重建
      this.scheduleRebuild(`socket error ${code ?? ''}`)
    }
  }

  /**
   * 安全重建:关旧(等 close callback)→ 退避 → 建新。幂等锁防并发重建。
   * @param isFatal 致命错误走 FATAL_RETRY_MS 慢重试,否则走退避表
   */
  private scheduleRebuild(reason: string, isFatal = false): void {
    if (this.rebuilding) return // 幂等
    this.rebuilding = true
    this.state = 'REBUILDING'
    this.stopHeartbeat()
    this.clearBindWatchdog()
    console.error(`[discovery] rebuild: ${reason}`)

    const old = this.socket
    this.socket = null // 先摘引用,晚到 message/error 打不到新逻辑

    const delay = isFatal
      ? FATAL_RETRY_MS
      : REBUILD_BACKOFF_MS[Math.min(this.backoffIdx++, REBUILD_BACKOFF_MS.length - 1)]

    const finish = (): void => {
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null
        this.rebuilding = false
        if (this.state === 'IDLE') return // M3:stop 已发生 → 不再 build
        this.buildSocket()
      }, delay)
    }

    if (old) {
      old.removeAllListeners('message')
      old.removeAllListeners('error')
      old.removeAllListeners('listening')
      try {
        old.close(finish) // 等 'close' callback 再重建(close 异步,防 EADDRINUSE)
      } catch {
        finish()
      }
    } else {
      finish()
    }
  }

  // ── 心跳自检(loopback nonce)──────────────────────────────────────
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pendingNonce = null // m2:干净态开始
    this.hbTimer = setInterval(() => this.heartbeatTick(), HB_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) {
      clearInterval(this.hbTimer)
      this.hbTimer = null
    }
  }

  private heartbeatTick(): void {
    if (this.state !== 'READY' || !this.socket) return
    // 判死:看在途探测"真实过了多久"(B1:时间维度,不数 tick)
    if (this.pendingNonce && this.now() - this.pendingNonce.sentAt >= HB_DEAD_MS) {
      this.scheduleRebuild('heartbeat timeout')
      return
    }
    // 一次只一个在途 nonce(未回不发新的,防繁忙期堆叠)
    if (this.pendingNonce) return
    const nonce = randomBytes(16)
    this.pendingNonce = { nonce, sentAt: this.now() }
    try {
      this.socket.send(Buffer.concat([HB_MAGIC, nonce]), this.opts.port, this.opts.multicastAddr)
    } catch (err) {
      this.scheduleRebuild(`heartbeat send failed ${(err as NodeJS.ErrnoException).code ?? ''}`)
    }
  }

  private clearBindWatchdog(): void {
    if (this.bindWatchdog) {
      clearTimeout(this.bindWatchdog)
      this.bindWatchdog = null
    }
  }

  /** 发送 announce 报文(announce=true 主动广播,false 为响应)。多播 + 子网广播双通道。 */
  announce(announce: boolean): void {
    const socket = this.socket
    if (this.state !== 'READY' || !socket) return // 重建/绑定期跳过(不抛)
    const payload = Buffer.from(JSON.stringify(this.opts.buildAnnouncement(announce)))

    // ① 多播
    if (this.joinedInterfaces.length <= 1) {
      socket.send(payload, this.opts.port, this.opts.multicastAddr)
    } else {
      // 多接口:逐个切换出接口发送,确保每个真实网卡都广播到
      for (const iface of this.joinedInterfaces) {
        try {
          socket.setMulticastInterface(iface)
          socket.send(payload, this.opts.port, this.opts.multicastAddr)
        } catch {
          /* 某接口发送失败不影响其他接口 */
        }
      }
      if (this.boundInterface) {
        try {
          socket.setMulticastInterface(this.boundInterface)
        } catch {
          /* 忽略 */
        }
      }
    }

    // ② 广播兜底:对每个真实网卡的子网广播地址各发一份(多播被过滤时救场)
    for (const t of this.broadcastTargets) {
      try {
        socket.send(payload, this.opts.port, t.broadcast)
      } catch {
        /* 某网卡广播失败不影响其他网卡与多播 */
      }
    }
  }

  private onMessage(buf: Buffer, address: string): void {
    // 心跳包优先识别(魔术前缀 HB\0):自己的 nonce → 健康;任何心跳包都不进业务
    if (buf.length >= HB_MAGIC.length && buf.subarray(0, HB_MAGIC.length).equals(HB_MAGIC)) {
      if (
        this.pendingNonce &&
        buf.subarray(HB_MAGIC.length).equals(this.pendingNonce.nonce)
      ) {
        this.pendingNonce = null // 本轮健康
      }
      return
    }
    this.handleMessage(buf, address)
  }

  private handleMessage(buf: Buffer, address: string): void {
    let msg: Partial<Announcement>
    try {
      msg = JSON.parse(buf.toString('utf8'))
    } catch {
      return // 非法报文,忽略
    }
    if (!msg || typeof msg.fingerprint !== 'string' || typeof msg.alias !== 'string') {
      return // 缺必需字段,忽略
    }
    // 防自发现(loopback 默认开,同机另一实例也会到这里,靠 fingerprint 区分)
    if (msg.fingerprint === this.opts.selfFingerprint) return

    const info: DeviceInfo = {
      alias: msg.alias,
      version: msg.version ?? '',
      deviceModel: msg.deviceModel ?? null,
      deviceType: msg.deviceType ?? null,
      fingerprint: msg.fingerprint,
      port: msg.port,
      protocol: msg.protocol,
      download: msg.download
    }
    this.opts.onDevice(info, address)

    // 收到别人的主动广播 → **HTTP 定向回应**(POST /register 到对方),让对方也能发现我们。
    // 替代原 UDP 多播回应(announce:false):定向 TCP 比多播可靠。announce=false(别人的回应)
    // 不再回,防无限对回。见 docs/discovery-http-register-response.md。
    if (msg.announce === true) {
      this.opts.onRespond?.(info, address)
    }
  }

  stop(): void {
    this.state = 'IDLE'
    this.rebuilding = false
    this.stopHeartbeat()
    this.clearBindWatchdog()
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer) // M3:退避 timer 不清 → delay 到期后建孤儿 socket
      this.rebuildTimer = null
    }
    if (this.socket) {
      try {
        this.socket.close()
      } catch {
        // 已关闭,忽略
      }
      this.socket = null
    }
  }
}

// UDP 多播发现(见 docs/DESIGN §1.1、§1.4、§5)
//
// 事实层(已坐实,DESIGN §1.4):
//  - reuseAddr:true 必需(否则同机第二实例 EADDRINUSE),且两实例都能收到多播
//  - loopback 默认开 → 本机会收到自己的广告 → 必须用 fingerprint 应用层过滤
//  - 必须 bind(53317) + addMembership(224.0.0.167) 才收得到

import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { MULTICAST_ADDR, DEFAULT_PORT } from '@shared/protocol'
import type { Announcement, DeviceInfo } from '@shared/types'
import { pickMulticastInterface, pickAllLanInterfaces } from './pick-interface'

export interface MulticastOpts {
  /** 本机 fingerprint,用于过滤自己发的报文 */
  selfFingerprint: string
  /** 本机 announce 内容工厂(alias 可能被用户改,故用工厂动态取) */
  buildAnnouncement: (announce: boolean) => Announcement
  /** 收到别的设备的报文(已过滤自己)。address 为报文来源 IP。 */
  onDevice: (info: DeviceInfo, address: string) => void
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
  /** 首选出接口地址(undefined = OS 默认) */
  private boundInterface: string | undefined
  /** 加入了多播组的所有接口(空 = 用 OS 默认接口) */
  private joinedInterfaces: string[] = []

  constructor(opts: MulticastOpts) {
    this.opts = {
      port: DEFAULT_PORT,
      multicastAddr: MULTICAST_ADDR,
      ...opts
    }
  }

  /** 本次绑定的接口(调试/日志用) */
  get iface(): string | undefined {
    return this.boundInterface
  }

  /** 启动:bind + 加入多播组,并主动 announce 一次。 */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true })
      this.socket = socket

      socket.on('error', (err) => {
        // bind 前的错误 → reject;运行期错误交给调用方(此处仅关闭)
        reject(err)
      })

      socket.on('message', (buf, rinfo) => this.handleMessage(buf, rinfo.address))

      socket.bind(this.opts.port, () => {
        // 接口策略:
        //  - interfaceAddr === '' → 强制 OS 默认(测试隔离)
        //  - interfaceAddr 非空 → 只用该接口
        //  - 未传 → 在所有真实局域网接口上都加入多播组(排除代理隧道),
        //    避免赌错单一接口(VM/WSL 网卡与真实 WiFi 撞网段)
        if (this.opts.interfaceAddr === '') {
          this.joinedInterfaces = []
        } else if (this.opts.interfaceAddr) {
          this.joinedInterfaces = [this.opts.interfaceAddr]
        } else {
          this.joinedInterfaces = pickAllLanInterfaces(networkInterfaces())
        }

        try {
          if (this.joinedInterfaces.length === 0) {
            // 无合格接口(或强制默认)→ 用 OS 默认接口加组
            socket.addMembership(this.opts.multicastAddr)
          } else {
            // 在每个真实接口上加入多播组
            for (const iface of this.joinedInterfaces) {
              socket.addMembership(this.opts.multicastAddr, iface)
            }
            // 出接口设为首选真实局域网接口(发送默认走它;announce 会遍历全部)
            const primary = pickMulticastInterface(networkInterfaces())
            if (primary) socket.setMulticastInterface(primary)
            this.boundInterface = primary
          }
        } catch (err) {
          // 任一接口加组失败 → 退回 OS 默认接口重试一次
          try {
            this.joinedInterfaces = []
            this.boundInterface = undefined
            socket.addMembership(this.opts.multicastAddr)
          } catch (err2) {
            // S5:失败要关掉已 bind 的 socket,不泄漏端口
            this.stop()
            reject(err2 as Error)
            return
          }
        }
        // bind 成功后,后续 error 不应再 reject(promise 已 settle)
        socket.removeAllListeners('error')
        socket.on('error', () => {})
        this.announce(true)
        resolve()
      })
    })
  }

  /** 发送 announce 报文(announce=true 主动广播,false 为响应)。 */
  announce(announce: boolean): void {
    const socket = this.socket
    if (!socket) return
    const payload = Buffer.from(JSON.stringify(this.opts.buildAnnouncement(announce)))

    if (this.joinedInterfaces.length <= 1) {
      // 单接口或 OS 默认:直接发一次
      socket.send(payload, this.opts.port, this.opts.multicastAddr)
      return
    }
    // 多接口:逐个切换出接口发送,确保每个真实网卡都广播到(多网卡下对端才收得到)
    for (const iface of this.joinedInterfaces) {
      try {
        socket.setMulticastInterface(iface)
        socket.send(payload, this.opts.port, this.opts.multicastAddr)
      } catch {
        // 某接口发送失败不影响其他接口
      }
    }
    // 复位出接口为首选,避免影响后续(如单播回应)
    if (this.boundInterface) {
      try {
        socket.setMulticastInterface(this.boundInterface)
      } catch {
        // 忽略
      }
    }
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

    // 收到别人的主动广播 → 回应一次(announce:false),让对方也能发现我们(DESIGN §1.1)
    if (msg.announce === true) {
      this.announce(false)
    }
  }

  stop(): void {
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

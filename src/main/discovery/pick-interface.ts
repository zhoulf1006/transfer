// 选择用于局域网多播的网络接口(纯函数,见 docs/DESIGN §7 多网卡)
//
// 背景(实测坐实):有代理/VPN 时机器会有隧道接口(如 utun 上的 198.18.x / 100.64.x),
// dgram addMembership 不指定接口时,OS 可能把多播加到隧道接口而非真实 WiFi,导致
// 收发都走隧道、局域网互相发现不了。故必须显式挑一个"真实局域网"接口绑定。

import type { NetworkInterfaceInfo } from 'node:os'

/** CGNAT / benchmark 等常被代理隧道占用的保留段,优先级最低 */
function isTunnelLikely(addr: string): boolean {
  // 198.18.0.0/15 基准测试段(Clash/Surge fake-ip 常用)
  if (addr.startsWith('198.18.') || addr.startsWith('198.19.')) return true
  // 100.64.0.0/10 CGNAT(Tailscale / 运营商 NAT)
  const m = addr.match(/^100\.(\d+)\./)
  if (m) {
    const second = Number(m[1])
    if (second >= 64 && second <= 127) return true
  }
  return false
}

/** 常见家用/办公私有网段,最可能是真实局域网 */
function isCommonLan(addr: string): boolean {
  return (
    addr.startsWith('192.168.') ||
    addr.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr) // 172.16/12
  )
}

/**
 * 从所有接口里挑一个用于多播绑定的 IPv4 地址。
 * 优先级:常见私有局域网段(192.168/10/172.16) > 其他非内部非隧道 > 无(返回 undefined 用默认)。
 * 隧道段(198.18 / 100.64 CGNAT)排到最后,尽量不选。
 *
 * @param ifaces os.networkInterfaces() 的返回
 * @returns 选中的 IPv4 地址;没有合适的返回 undefined(调用方回退到 OS 默认接口)
 */
export function pickMulticastInterface(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): string | undefined {
  const candidates: { addr: string; score: number }[] = []

  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      let score = 0
      if (isCommonLan(a.address)) score += 100
      if (isTunnelLikely(a.address)) score -= 100
      candidates.push({ addr: a.address, score })
    }
  }

  if (candidates.length === 0) return undefined
  candidates.sort((x, y) => y.score - x.score)
  // 最高分若仍是负分(全是隧道),宁可返回 undefined 让 OS 决定
  return candidates[0].score >= 0 ? candidates[0].addr : undefined
}

/**
 * 返回所有"应加入多播组"的接口地址(排除回环和隧道段)。
 * 用于在每个真实网卡上都 addMembership —— 避免赌错单一接口(VM/WSL 网卡与真实
 * WiFi 撞私有网段时,单选可能选错;全加入则一定覆盖到真实网卡)。
 * 返回空数组表示无合格接口,调用方回退到 OS 默认(不指定接口)。
 */
export function pickAllLanInterfaces(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): string[] {
  const result: string[] = []
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (isTunnelLikely(a.address)) continue // 跳过代理隧道段
      result.push(a.address)
    }
  }
  return result
}

/** 从 IPv4 address + netmask 算子网广播地址(broadcast = address | ~netmask)。
 *  netmask 非法(段数不对/非数字/越界)返回 null。*/
export function subnetBroadcast(address: string, netmask: string): string | null {
  const a = address.split('.').map(Number)
  const m = netmask.split('.').map(Number)
  if (a.length !== 4 || m.length !== 4) return null
  if (![...a, ...m].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null
  return a.map((o, i) => o | (~m[i] & 255)).join('.')
}

/**
 * 返回所有真实局域网网卡的**子网广播目标**(排除回环/隧道),用于广播兜底(多播之外同发一份)。
 * 每项 = { address: 网卡自身 IPv4(作发送出接口), broadcast: 该网段广播地址(如 192.168.3.255) }。
 * netmask 缺失/非法的网卡跳过(算不出广播地址)。
 */
export function pickBroadcastTargets(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): { address: string; broadcast: string }[] {
  const result: { address: string; broadcast: string }[] = []
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (isTunnelLikely(a.address)) continue
      const broadcast = subnetBroadcast(a.address, a.netmask)
      if (broadcast) result.push({ address: a.address, broadcast })
    }
  }
  return result
}

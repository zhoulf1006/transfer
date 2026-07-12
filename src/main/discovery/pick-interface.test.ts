import { test, expect, describe } from 'vitest'
import { pickMulticastInterface, pickAllLanInterfaces } from './pick-interface'
import type { NetworkInterfaceInfo } from 'node:os'

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`
  }
}

describe('pickMulticastInterface', () => {
  test('优先选真实局域网(192.168)而非代理隧道(198.18)', () => {
    // 复现用户环境:en0 真实 WiFi + utun4 代理隧道
    const ifaces = {
      en0: [v4('192.168.3.45')],
      utun4: [v4('198.18.0.1')],
      lo0: [v4('127.0.0.1', true)]
    }
    expect(pickMulticastInterface(ifaces)).toBe('192.168.3.45')
  })

  test('跳过 CGNAT(100.64/10 Tailscale)', () => {
    const ifaces = {
      en0: [v4('10.0.0.5')],
      tailscale0: [v4('100.100.100.100')]
    }
    expect(pickMulticastInterface(ifaces)).toBe('10.0.0.5')
  })

  test('忽略 internal(回环)', () => {
    const ifaces = { lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.1.10')] }
    expect(pickMulticastInterface(ifaces)).toBe('192.168.1.10')
  })

  test('全是隧道段 → 返回 undefined(让 OS 决定)', () => {
    const ifaces = { utun0: [v4('198.18.0.1')], utun1: [v4('100.90.0.1')] }
    expect(pickMulticastInterface(ifaces)).toBeUndefined()
  })

  test('无外部接口 → undefined', () => {
    expect(pickMulticastInterface({ lo0: [v4('127.0.0.1', true)] })).toBeUndefined()
    expect(pickMulticastInterface({})).toBeUndefined()
  })

  test('多个真实局域网接口 → 选第一个私有段', () => {
    const ifaces = { en0: [v4('192.168.1.5')], en1: [v4('10.1.1.5')] }
    const picked = pickMulticastInterface(ifaces)
    expect(['192.168.1.5', '10.1.1.5']).toContain(picked)
  })

  test('172.16/12 私有段识别', () => {
    expect(pickMulticastInterface({ en0: [v4('172.16.0.9')] })).toBe('172.16.0.9')
    // 172.15 和 172.32 不在私有段,但作为唯一非隧道接口仍会被选(score 0)
    expect(pickMulticastInterface({ en0: [v4('172.15.0.9')] })).toBe('172.15.0.9')
  })
})

describe('pickAllLanInterfaces', () => {
  test('返回所有真实接口,排除隧道和回环', () => {
    // 复现用户 mac 环境:真实 WiFi + VM 网卡 + 代理隧道 + 回环
    const ifaces = {
      en0: [v4('192.168.3.45')],
      bridge100: [v4('192.168.64.1')],
      utun4: [v4('198.18.0.1')], // 代理隧道,应排除
      lo0: [v4('127.0.0.1', true)]
    }
    const all = pickAllLanInterfaces(ifaces)
    expect(all).toContain('192.168.3.45') // 真实 WiFi 必须在(关键:之前被隧道抢走)
    expect(all).toContain('192.168.64.1') // VM 网卡也加入(不赌哪个是真的)
    expect(all).not.toContain('198.18.0.1') // 隧道排除
    expect(all).not.toContain('127.0.0.1') // 回环排除
  })

  test('全隧道 → 空数组(回退 OS 默认)', () => {
    expect(pickAllLanInterfaces({ utun0: [v4('198.18.0.1')] })).toEqual([])
  })

  test('无接口 → 空数组', () => {
    expect(pickAllLanInterfaces({})).toEqual([])
  })
})

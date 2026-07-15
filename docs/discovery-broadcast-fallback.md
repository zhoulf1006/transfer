# 广播兜底(UDP broadcast,补多播之外的发现通道)

> 状态:**已实现并实测生效**(v0.5.2 发布;test 267/build 绿)。tcpdump 抓到 `udp port 53317` 目标 `192.168.3.255`(子网广播)与 `224.0.0.167`(多播)交替发出,双通道确认工作。
> 落地:`pick-interface.ts`(`subnetBroadcast`+`pickBroadcastTargets`,+10 测)、`multicast.ts`(start setBroadcast + 算 broadcastTargets;announce 发子网广播 + 广播发包测试)。
> **实测坐实**:广播按目标地址路由,无需 setMulticastInterface(已去掉冗余);复用现有多播 socket 零冲突。
> **已知小限制**:broadcastTargets 在 `start()` 时快照,运行中切换网络不更新(与既有 `joinedInterfaces` 同问题,非本次引入)。
> 背景:纯多播发现脆弱(交换机 IGMP、AP 过滤多播、代理隧道抢网卡)。学 Syncthing:**IPv4 用广播比多播更容易通**(广播是网络基础功能,不依赖交换机 IGMP 智能)。
> 目标:多播之外,**同时**发一份 UDP 广播,双通道提升发现成功率。
> 安全前提(用户确认):**只做广播,不做 HTTP 扫网段**。广播是局域网日常行为(DHCP/ARP/SSDP 都在广播),不像端口扫描,基本不触发企业 EDR/安全告警;扫网段像横向扫描、会告警,故不做。

## 1. 事实层(dgram/os API + 现有代码坐实)

- **现有发现**:单个 `udp4` socket,bind 在 53317,`reuseAddr:true`(multicast.ts:61)。已有多接口:`joinedInterfaces` + 逐接口 `setMulticastInterface` 发送(multicast.ts:127-140)。**未调 `setBroadcast`**。
- **`socket.setBroadcast(true)`** 存在(@types/node dgram.d.ts:401)——发广播前必须开;开了不影响多播发送。[确认]
- **`os.networkInterfaces()` 每网卡含 `address`+`netmask`+`cidr`**(os.d.ts:29-33)。→ **可算子网广播地址** `broadcast = address | ~netmask`(已验证:192.168.3.45/255.255.255.0 → 192.168.3.255;各掩码都对)。[确认]
- **`pick-interface.ts`**:`pickAllLanInterfaces(networkInterfaces())` 返回真实局域网**接口地址列表**(排除隧道 198.18/100.64)。但**只返地址,不带 netmask** —— 算广播地址需要 netmask,要么扩展它、要么新写一个带 netmask 的挑选函数。[确认]
- 本机实测:真实网卡 en0 `192.168.3.45/255.255.255.0`;隧道 utun4 `198.18.0.1`(须排除)。

## 2. 关键决策(研究结论)

### 决策1:发**子网定向广播**,不发全局 `255.255.255.255`
- **选子网广播**(每个真实网卡算它自己的广播地址,如 `192.168.3.255`)。
- 理由:① **多网卡下天然正确**——发到"这个网卡所在网段"的广播地址,不含糊;② 比全局 `255.255.255.255` **更不容易被 OS/设备当异常过滤**(全局广播很多栈默认更严);③ 精准,不外溢。
- 全局 `255.255.255.255` 的问题:多网卡下"从哪个网卡发"不明确、更易被过滤。**不用。**

### 决策2:**复用现有多播 socket**,不新建
- 现有 socket bind 在 53317、`reuseAddr:true`,`setBroadcast(true)` 后**同一个 socket 既能发多播也能发广播**(发送目标地址不同而已)。
- 新建 socket 要再 bind 一个端口(和多播冲突,53317 已被占)——复杂且无必要。
- **收广播**:广播包目标端口 53317,会被现有 socket 收到(bind 在 53317),走同一个 `handleMessage`。**收侧零改动。**

### 决策3:广播报文 = 现有 announce 报文,**同格式**
- 广播发的就是 `buildAnnouncement(true)` 那个 JSON(和多播完全一样,对端 `handleMessage` 不区分来源)。
- **对端收到广播 announce=true → 走同一套逻辑**(onDevice 登记 + onRespond HTTP 定向回应)。**无需新报文类型、无需改收侧。**

### 决策4:广播与多播**同时发**(不是"多播失败才广播")
- 每次 `announce(true)` 时,**多播发一份 + 每个真实网卡的子网广播地址各发一份**。
- 理由:"多播失败才广播"要判定"多播是否失败"(难,多播是无回执的),不如双通道都发——成本极低(几百字节 ×N 网卡,5s 一次),哪条通哪条生效。

## 3. 实现方案

### 3.1 挑接口(带 netmask)
新增/扩展:一个函数返回真实局域网网卡的 `{address, broadcast}` 列表。
```ts
// pick-interface.ts 新增
export function pickBroadcastTargets(ifaces): { address: string; broadcast: string }[]
// 逻辑:遍历 networkInterfaces,IPv4 非 internal 非隧道(复用 isTunnelLikely),
//       broadcast = address | ~netmask;返回列表。
```
复用现有 `isTunnelLikely` 排除隧道段,与 `pickAllLanInterfaces` 同源过滤,保证一致。

### 3.2 socket 开广播
`start()` bind 成功后加 `socket.setBroadcast(true)`(在 addMembership 附近)。开广播不影响多播。

### 3.3 announce 同时发广播
`announce(announce)` 里,发完多播后,**对每个广播目标发一份**:
```ts
for (const t of this.broadcastTargets) {
  try {
    socket.setMulticastInterface(t.address) // 出接口设为该网卡(和多播多网卡逻辑一致)
    socket.send(payload, this.opts.port, t.broadcast)
  } catch { /* 某网卡失败不影响其他 */ }
}
```
- `broadcastTargets` 在 start 时算好(networkInterfaces 快照),避免每次 announce 都枚举。
- 注意:回应(HTTP register)不受影响——广播只加在主动 announce 里。

## 4. 边界 / 失败模式(前置纸面)

| 场景 | 处理 |
|---|---|
| 无真实网卡(全是隧道) | broadcastTargets 空 → 不发广播,只多播。不报错 |
| 某网卡 send 广播失败(权限/接口 down) | try/catch 跳过该网卡,不影响其他网卡和多播 |
| 收到自己发的广播(loopback) | fingerprint 过滤已挡(handleMessage:156),和多播同一套 |
| 广播被交换机"广播风暴抑制"丢弃 | 静默不通(不告警),多播那条仍在 —— 双通道意义正在于此 |
| 同机多实例(reuseAddr) | 广播包多实例都收到,fingerprint 过滤 + 端口区分,不乱 |
| netmask 异常(如 /32 或空) | broadcast 计算兜底:非法则跳过该网卡(不发非法地址) |
| interfaceAddr==='' (测试隔离) | 测试模式不算 broadcastTargets(或算 OS 默认),保持测试确定性 |
| 广播 announce 被对端当"重复"(多播也收到同内容) | 对端 upsert 幂等(同 fingerprint),重复无害 |
| IPv6 | 本项目主 IPv4,广播是 IPv4 概念(IPv6 无广播只有多播),不涉及 |
| 安全告警(企业 EDR) | 广播是日常行为,低风险;**不做扫网段**故无横向扫描特征 |

## 5. 影响面 / 改动清单

| 文件 | 改动 |
|---|---|
| `src/main/discovery/pick-interface.ts` | 新增 `pickBroadcastTargets`(带 netmask 算子网广播地址)+ 单测。 |
| `src/main/discovery/multicast.ts` | start 加 `setBroadcast(true)` + 算 broadcastTargets;announce 里逐网卡发子网广播。 |
| `src/main/discovery/multicast.test.ts` | 补测:announce 时对广播地址也发包(可用独立 socket 监听广播验证收到)。 |
| `src/main/discovery/pick-interface.test.ts` | 补测 pickBroadcastTargets:正常算广播、排除隧道、异常 netmask。 |
| `docs/` | 本文;DESIGN §1.1 同步"多播 + 子网广播双通道"。 |

## 6. 成功标准 / 验证

1. typecheck + test + build 绿。
2. pickBroadcastTargets 单测:192.168.x/24→x.255、10.x/16→广播、排除 198.18 隧道、netmask 异常跳过。
3. multicast 单测:announce 后,一个监听广播地址的 socket 能收到 announce 包。
4. dev 双机实测:在"多播被过滤但广播通"的网络里(如某些企业/家用 Wi-Fi),双向发现应比纯多播更稳。回归:纯多播场景不受影响。

## 7. 分步实现(检查点)

1. `pickBroadcastTargets` + 单测 → test 绿。✅广播地址算法 + 隧道排除。
2. multicast setBroadcast + broadcastTargets + announce 发广播 → typecheck。
3. 补 multicast 广播收发测试 → test 绿。
4. dev 双机实测(尤其多播弱的网络)。
5. 回同步 DESIGN §1.1。
6. 全绿后发版(v0.5.2)。

## 8. 诚实的效果预期

- 广播兜底**提升**多播弱网络的发现成功率(广播不依赖交换机 IGMP,常比多播通)。
- **但不是万能**:AP 隔离(客户端隔离)会同时切广播和多播;严格企业网可能开广播抑制;跨网段/VLAN 广播也出不去。这些场景广播也无能为力——那才需要用法B扫网段(已排除)或中心服务器(太重)。
- 定位:**低成本、低风险、提升常见家用/办公 Wi-Fi 场景成功率**的兜底,不是根治所有网络。

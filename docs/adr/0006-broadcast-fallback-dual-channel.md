# ADR-0006: announce 双通道——多播之外同时发子网广播

- 状态: 已接受(v0.5.2 发布,tcpdump 实测双通道生效)

## 背景与问题

ADR-0005 修好了"回应"通道,但主动 announce 仍只走多播,发现的第一跳依旧脆弱。Syncthing 的经验:IPv4 用**广播**比多播更容易通——广播是网络基础功能(DHCP/ARP/SSDP 都在用),不依赖交换机 IGMP 智能。

## 备选项

1. **多播 + 子网定向广播双发**(复用现有多播 socket)
2. 仅多播(维持现状)——否决:发现失败率在企业网/代理环境实测偏高
3. HTTP 扫网段——否决:同 ADR-0005 的安全立场,像横向扫描会触发 EDR;广播是局域网日常行为,不告警
4. 广播另开独立 socket——否决:实测复用现有多播 socket 零冲突,广播按目标地址路由、无需 setMulticastInterface,不必增加 socket 管理面

## 决策

选定**方案 1**:announce 同时发多播(224.0.0.167)与子网定向广播(`subnetBroadcast` 按接口 netmask 计算,如 /24 下的 192.168.3.255),双通道并行。

## 后果

- 正面:发现成功率提升,不触发安全告警。
- 负面/已知限制:broadcastTargets 在 `start()` 时快照,运行中切换网络不更新(与既有 joinedInterfaces 同问题)。

## 来源

[discovery-broadcast-fallback.md](../discovery-broadcast-fallback.md);排查背景见 memory「局域网发现三层坑」。

# ADR-0006: announce 双通道——多播之外同时发子网广播

- 状态: 已接受(v0.5.2 发布,tcpdump 实测双通道生效)

## 背景

ADR-0005 修好了"回应"通道,但主动 announce 仍只走多播,发现的第一跳依旧脆弱。Syncthing 的经验:IPv4 用**广播**比多播更容易通(广播是网络基础功能,不依赖交换机 IGMP 智能;DHCP/ARP/SSDP 都在广播)。

## 决策

announce **同时**发多播(224.0.0.167)与子网广播(x.x.x.255),双通道并行,复用同一 socket。**只做广播,不做 HTTP 扫网段**(与 ADR-0005 同一安全立场)。

## 后果

- 发现成功率提升;广播是局域网日常行为,不触发 EDR 告警。
- 已知限制:broadcastTargets 在 `start()` 时快照,运行中切换网络不更新(与既有 joinedInterfaces 同问题)。

## 来源

[discovery-broadcast-fallback.md](../discovery-broadcast-fallback.md);排查背景见 memory「局域网发现三层坑」。

# 复盘(postmortems)

**踩过的坑与它的因果链**——症状 → 根因 → 做法,以及**走过的死路**。目的只有一个:下次遇到同类问题,直接省掉一轮排查。

按 [ADR-0013](../adr/0013-docs-lifecycle-by-rot-risk.md) 属"复盘/踩坑叙事",持久保留。

## 收录判据(三者满足其一即可)

1. **不知道就会踩**:照直觉写必错,且错误不易被测试发现(如 `flashFrame` 在 mac 是 Dock 持续跳);
2. **排查耗时可复用**:含实测手法或诊断路径,下次能直接照做(如抓包命令、判断僵尸进程的判据);
3. **有走过的死路**:记录被否决的方案与否决理由,避免后人重走(如"再加一条发现通道"对 AP 隔离无效)。

不收:纯决策(→ [ADR](../adr/))、术语与不变量(→ [CONTEXT.md](../../CONTEXT.md))、用户可见行为(→ [features](../features/))、现行操作步骤(→ [ops](../ops/))。

## 维护纪律

- **一坑一文件**:新踩的坑独立成文,不往已有文件里堆——文件名即检索入口。
- **回补是硬要求(防腐烂的关键)**:排查完一个真 bug 后,若它满足上述任一判据,**当次就写进来并在下表追加一行**。事后补写等于不写;`/review-code` 与 `/implement` 的拆解归档步骤都会检查这一条。
- **只追加,不改写**:复盘记录的是"当时如何"。事实变了就新开一篇并在旧篇标注"已被 <新篇> 取代",不就地改写(与 [ops](../ops/) 的就地更新相反——那里记的是现行流程,这里记的是历史)。
- **索引与文件同步**:新增/取代都要改下表。索引腐烂等于这些教训不可检索。

## 索引

| 复盘 | 一句话 |
|---|---|
| [electron-graceful-quit.md](electron-graceful-quit.md) | 退出卡死 → 僵尸进程 → 端口乱跳 → 表现为"丢消息";含判断僵尸的判据与 dev 孤儿进程的两条死路 |
| [send-connect-timeout.md](send-connect-timeout.md) | VPN 全隧道吞 SYN → 用户静默等 6 分钟;含"握手后必须清 connect timeout"的回归红线 |
| [lan-discovery-limits.md](lan-discovery-limits.md) | 发现的实测手法(tcpdump / C 探针秒级复现)、EHOSTUNREACH 的两种成因,以及广播兜底治不了的三种网络(AP 隔离/企业抑制/跨 VLAN) |
| [screenshot-hidpi-canvas.md](screenshot-hidpi-canvas.md) | 底图层套了 dpr scale → Retina 只显示左上 1/4;长度量也要 × ratio |
| [screenshot-sent-images-lifetime.md](screenshot-sent-images-lifetime.md) | 截图发完即删 → 删掉了自己消息的数据源 → 发送端缩略图消失 |
| [screenshot-overlay-behaviors.md](screenshot-overlay-behaviors.md) | 遮罩窗四个反直觉行为:panel 致 Dock 图标消失、自截时序、冒泡清选区、autoFocus 不可靠 |
| [unread-react-pitfalls.md](unread-react-pitfalls.md) | StrictMode 双调致未读翻倍;effect 依赖写"最小集"致呼出后不清零;flashFrame 在 mac 持续跳 |
| [global-shortcut-limits.md](global-shortcut-limits.md) | globalShortcut 只能"注册试错" → 产品只能提示换键;改键失败必须回滚 |
| [screen-permission-preflight-deadlock.md](screen-permission-preflight-deadlock.md) | preflight 检查堵死唯一授权入口 → 新用户永远开不了截图;含 tccutil reset 复现手法与同 bundle id 抢 TCC 的连带坑 |

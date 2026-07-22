# 发现 socket 僵死恢复机制 — 设计文档

> 给 `MulticastDiscovery`(`src/main/discovery/multicast.ts`)加**运行期 socket 僵死检测 + 自动重建**,把"必须重启进程才能恢复发现"降级为"自动重建 socket"。
> 归属:[[lan-discovery-runtime-loss]] 诊断结论的**放大器修复**(不依赖根因实锤——无论根因是 IGMP 老化、网络抖动还是 VPN 路由变化,"僵死后无法自愈"这层都值得修)。
> 走七步流程第 1-2 步(调研+方案),实现前需用户 review。

---

## 0. 决策速览(已与用户确认)

| 维度 | 决策 |
|------|------|
| **检测机制** | **两层都做**:①运行期 socket `error` 不再吞 → 分类触发重建;②loopback nonce 心跳自检 → 覆盖无 error 的静默失效(IGMP 老化那种) |
| **恢复动作** | 安全重建整个 socket(关旧等 close → 建新 → bind 0.0.0.0 → listening 后 join → 恢复 announce) |
| **不做** | **周期性 rejoin(dropMembership+addMembership 刷新 IGMP)**——有瞬时离组丢包窗口,且重建已覆盖 IGMP 成员失效;留待抓包实锤根因后单独决策 |
| **范围** | 只改 `multicast.ts`(+ 可能少量 app-core 事件转发);不动 registry/传输/HTTPS |

---

## 1. 现状缺陷(亲自核对,file:line)

| # | 位置 | 缺陷 |
|---|------|------|
| C1 | `multicast.ts:125-126` | bind 后 `removeAllListeners('error')` + `on('error', () => {})` —— **运行期 socket 错误被完全吞掉**,程序无感 |
| C2 | 整个类 | socket 只建一次,`joinedInterfaces`/`broadcastTargets` 启动算一次,**永不重建/刷新**;无健康自检 |
| C3 | `announce()` 146-171 | send 错误全被 try/catch 吞 → socket 僵死后 send 变 no-op,静默 |

三者叠加 = 僵死后**无感、无自愈、无日志,只能重启进程**。完全匹配用户现象(双向丢失、无提示、必须两台都重启)。

> **C1-C3 不是 HTTPS 改造引入的**,是发现层既有脆弱点。本次修复独立于 HTTPS。

---

## 2. 调研结论(Node dgram 事实,已坐实)

来源:nodejs.org/api/dgram.html(v26)、`lib/dgram.js` 源码、nodejs/node #1690/#7061/#1692、OS multicast 文档。**每条都直接约束实现,照错会踩坑:**

1. **close 是异步的**:`close([cb])` 返回后 fd 未必释放;完成信号 = `'close'` 事件/callback。→ **必须等 close 完成再重建**,别靠 `reuseAddr` 硬顶(重叠期"only one socket can receive",反而可能新 socket 收不到)。
2. **⚠️ dgram `'error'` 后 socket 不自动关闭**(与 net/tls 流不同;文档从无 "socket is closed after this" 措辞,源码 `onError` 只 emit 不 close)。→ 恢复逻辑**必须自己显式 close 再重建**;且**必须始终挂 `'error'` 监听**,否则 error 抛成进程级未捕获异常。
3. **心跳 nonce 自探测可靠、但有两个误报源**(★核心):
   - loopback(`IP_MULTICAST_LOOP`)默认开 → 本机 send 到组的包,本机已 join 该组的 socket 会收到。可作"发送+接收+IGMP成员"三合一端到端探针。
   - ⚠️ **误报源1**:若 loopback 被关 → 永远收不到自己 → 假僵死。**重建后必须显式 `setMulticastLoopback(true)` 钉死**(Node 无 `getMulticastLoopback`,不能读默认,只能写死)。
   - ⚠️ **误报源2**:loopback 副本投给**本机所有**加入该组的 socket → 同机另一实例的探测包你也收得到 → 仅凭"收到某包"判活会**假活**。**必须用 nonce 精确匹配自己的包**(魔术前缀 `HB\0` + 每轮新 nonce)。
4. **重建期竞态**:对已关/半初始化 socket 调 `send` 会 `throw ERR_SOCKET_DGRAM_NOT_RUNNING`。→ 状态机 + send 前判 READY + 重建幂等锁 + 先摘引用再 close(呼应 [[electron-sqlite-quit-race]] "先摘引用再 close")。
5. **addMembership**:同 socket 重复 join 同组会 `EADDRINUSE`;但**重建的新 socket** join 是干净的(旧 socket close 时内核自动 dropMembership)。→ 重建不需手动 drop。
6. **bind 0.0.0.0**(不 bind 具体网卡 IP,否则 Linux 收不到组播,#1690);网卡选择靠 `addMembership(group, iface)` 第二参。
7. **listening 后再 join**:bind 完成信号 = `'listening'`/callback;之后才能 addMembership/setMulticastLoopback/announce。⚠️ **不在 listening 同步栈里 close/重活**(#7061 会崩)→ `setImmediate` 里做。

---

## 3. 方案设计

### 3.1 状态机

```
      start()                listening+join ok
IDLE ─────────► BINDING ───────────────────► READY
  ▲                │ bind/join 失败              │
  │                └──────────┐                  │ error(可恢复) / 心跳超时
  │  stop()                   ▼                  ▼
  └───────────────────── REBUILDING ◄───────────┘
              (关旧 socket→等 close→退避→建新→BINDING)
                             │ error(真·致命 EACCES/EPERM…)
                             ▼
                     FATAL_RETRY(慢重试,非永停,见 B3)
```

- **心跳/announce 定时器里 `socket.send` 前必判 `state===READY && socket`**,非 READY 跳过本次(不抛、不重建)。
- **重建幂等锁** `rebuilding`:重建中,后续 error/心跳超时不叠加触发。
- **先摘引用**:`scheduleRebuild` 里 `this.socket = null` 同步执行,再异步 close 旧的 → 晚到的 message/error 不误伤新逻辑。
- ⚠️ **BINDING 看门狗(B2,关键)**:`BINDING → READY` 只靠 `'listening'` 回调,但 dgram `bind()` 可能**既不 listening 也不 error 地挂住**(网卡 up/down 抖动瞬间 bind)→ 永久卡 BINDING,而心跳只在 READY 跑、error 也没触发 → **两层探测双双失效,换个状态继续僵死**。**必须加看门狗**:进入 BINDING 时起一个 `BIND_WATCHDOG_MS`(如 8s)定时器,到点仍未 READY → close 半初始化 socket + scheduleRebuild。这是独立于 error/心跳的**第三条恢复触发**。listening 成功要 clear 这个看门狗。

### 3.2 检测层

**层1:error 分类(替换 C1 的吞错)**
```
运行期 socket.on('error', err):
  ├─ 真·致命(EACCES/EPERM/EINVAL)→ onFatal 上报 + 转 FATAL_RETRY 慢重试(非永停)
  └─ 可恢复(ENETDOWN/ENETUNREACH/EHOSTUNREACH/EHOSTDOWN/EADDRINUSE/EADDRNOTAVAIL/其他)→ scheduleRebuild
```

⚠️ **EADDRNOTAVAIL 不是致命(B3,实锤)**:它("cannot assign requested address")在 dgram 场景**最常见于网卡刚失去/未拿到 IP 的瞬间**——WiFi 漫游、休眠唤醒、VPN 起停时 `addMembership(group, iface)` 用的具体 iface 地址短暂消失就触发。这是**典型可恢复瞬态**(等几秒 DHCP 完成就好),原设计误列致命 → **一次网络切换就永久停掉发现、只能重启**,恰好重新引入本设计要消灭的病症。→ 降为可恢复,走退避重试。

⚠️ **致命 ≠ 永停(B3)**:即便真致命(EACCES/EPERM 权限类),也不永久停——转 **FATAL_RETRY**:**只 `console.error` 落日志 + 静默慢重试**(`FATAL_RETRY_MS=30_000`,每 30s 探一次),**不接 UI/IPC**(已与用户确认:日志 + 静默重试)。否则"降级为自动重建"的目标在致命分支被推翻回"只能重启"。网络/权限恢复后仍能自愈。

**层2:loopback nonce 心跳(覆盖无 error 静默失效)**

⚠️ **判活用时间维度,不数 tick(B1,关键)**:原设计"每个 tick 上轮没回就 miss++"会**把主线程繁忙误判成 socket 僵死**——收大文件/announce 风暴/GC stall 阻塞事件循环 > 3s 时,loopback 回环包在内核 buffer 排队、message 回调被推迟,同时 setInterval 补偿性连发多个 tick → missCount 瞬间累积判死。而这恰是**最不该重建**的时刻(重建期 announce 停 → 对端 TTL 过期真丢设备)。改用**真实经过时间**判定,吸收 timer 抖动。

```
状态:pendingNonce(当前在途探测) = { nonce, sentAt(单调时钟 ms) } | null

每 HB_INTERVAL(3s) tick:
  若 state!==READY → skip
  # 判死:看在途探测"实际过了多久",不数 tick 次数
  若 pendingNonce 非空 且 (monotonicNow - pendingNonce.sentAt) >= HB_DEAD_MS(9000):
     scheduleRebuild('heartbeat timeout')  →  return
  # 只在没有在途探测时才发新的(避免繁忙期堆叠多个在途 nonce)
  若 pendingNonce 为空:
     nonce=randomBytes(16); pendingNonce={nonce, sentAt: monotonicNow}
     send( Buffer.concat([Buffer.from('HB\0'), nonce]) , PORT, GROUP )  // 靠 loopback 回环收

message 事件:
  若 payload 前3字节==='HB\0':
     若 pendingNonce 且 后段===pendingNonce.nonce → pendingNonce=null(本轮健康)
     return  # 心跳包(自己的或别人的)都不进业务
  handleMessage(...)  # 业务 announce 包
```
- **HB_DEAD_MS=9000**(3×周期):从"探测发出时刻"算起真实过了 9s 还没回才判死。事件循环卡顿只是推迟 message 处理,`sentAt` 也随之推迟发出,时间差不虚增 → **繁忙不误报**。
- 9s 判死 < registry 15s TTL,能在对端把本机过期前恢复(重建总时长另见 §4 M1)。
- 用**单调时钟**(`performance.now()` 或注入的 `monotonicNow`),不用 `Date.now()`(避免系统时间跳变干扰;也便于测试注入)。
- **一次只一个在途 nonce**:未回不发新的,防繁忙期堆叠。
- 每轮换新 nonce,防上轮回环残留假活。

**message 分派顺序(钉死)**:同一个 `on('message')` 回调里,**先判魔术前缀 `HB\0`**:
```
onMessage(buf, rinfo):
  if buf 前3字节 === 'HB\0':                 # 是某台机器的心跳探测包
     if pendingNonce 且 buf 后段 === pendingNonce.nonce: pendingNonce=null   # 我自己本轮的 → 健康
     return                                  # 无论是不是自己的,心跳包都不进业务逻辑
  handleMessage(buf, rinfo.address)          # 业务 announce 包
```

> **跨机交互(自洽性)**:loopback 只回环到**本机**,但心跳包发到组播地址,**对端也会收到**。对端 onMessage:前缀是 `HB\0` → 进心跳分支 → nonce 不等于对端自己的 expectNonce → 不清零、**直接 return 丢弃**。即:对端正确忽略我的心跳包,不当业务、不判自己活。互不干扰 ✓。代价:发现层多一条 ~3s 的小组播流量(几十字节),对端多一次前缀比较,可忽略。
>
> **为何不复用业务 announce 当心跳**:announce 包会被对端当真设备处理;且"收到自己的 announce"受 fingerprint 自过滤(`multicast.ts:186`)——自过滤会 return,但那是在 handleMessage 里,拿它做心跳信号要绕过自过滤,耦合乱。独立的 `HB\0` 探测包更干净,且 nonce 精确到"本轮",announce 做不到。

### 3.3 恢复层(安全重建)

```
scheduleRebuild(reason, isFatal=false):
  if rebuilding: return                    # 幂等
  rebuilding=true; state=REBUILDING
  stopHeartbeat(); clearBindWatchdog()
  log('rebuild:', reason)                  # M4:重建可观测
  old=this.socket; this.socket=null        # 先摘引用
  delay = isFatal ? FATAL_RETRY_MS(30s) : backoff[min(idx++, len-1)]  # 退避/慢重试
  finish():
     this.rebuildTimer=null; rebuilding=false
     if state===IDLE: return               # M3:stop 已发生 → 不再 build
     build()
  关旧:old.removeAllListeners('message'|'error')
       old ? old.close(()=> this.rebuildTimer=setTimeout(finish, delay))  # 等 close callback
           : this.rebuildTimer=setTimeout(finish, delay)

build():                                   # = 现有 start() 的 socket 建立部分抽出复用
  if state===IDLE: return                  # M3 双保险:stop 后不建
  state=BINDING
  pendingNonce=null                        # m2:复位心跳在途探测,防重建后立即误判
  s=createSocket({udp4, reuseAddr})
  s.on('error', 分类)                       # 始终挂,防进程级异常
  s.on('message', 心跳识别 + handleMessage)
  bindWatchdog=setTimeout(()=>{ s.close(); scheduleRebuild('bind timeout') }, BIND_WATCHDOG_MS(8s))  # B2
  s.bind(PORT)                             # 0.0.0.0,不带 address
  s.on('listening', () => setImmediate(() => {   # #7061:defer
     if state!==BINDING or this.socket!==s: { s.close(); return }  # stop/新一轮重建已发生 → 丢弃
     clearBindWatchdog()                   # B2:listening 到了,撤看门狗
     s.setMulticastLoopback(true)          # 钉死 loopback,防假僵死
     重算接口(复用 start 的三分支,见下)     # m3:保留 interfaceAddr==='' 特判
     每个 iface: s.addMembership(GROUP, iface)   # (joinedInterfaces 为空则 addMembership(GROUP) 用 OS 默认)
     setMulticastInterface(primary); 重算 broadcastTargets
     state=READY; backoffIdx=0; startHeartbeat(); announce(true)
     log('rebuild done')                   # M4
  }))
  this.socket=s

# m3:接口重算必须复用 start() 的三分支,不能简化成一行 pickAll
重算接口():
  if interfaceAddr==='':  joinedInterfaces=[]; broadcastTargets=[]     # 测试隔离,保持空
  elif interfaceAddr:     joinedInterfaces=[interfaceAddr]
  else:                   joinedInterfaces=pickAllLanInterfaces()
```

- **退避**:可恢复错误连续失败(网络真断)→ 0.5→1→2→5→10s 封顶;致命走 FATAL_RETRY_MS(30s)慢重试(B3)。成功后 backoffIdx 归零。
- **重建时重算接口**:覆盖"接口真的变了"的情况,但**必须保留 `interfaceAddr===''→[]` 特判**(m3:否则破坏测试隔离,与 §4 承诺矛盾)。
- **退避 timer 句柄** `this.rebuildTimer` 显式持有,`stop()` 要 clearTimeout(M3)。

### 3.4 与现有代码的关系

- `start()` 的 socket 建立部分抽成 `build()` 复用(start 首次调 build + resolve promise;重建也调 build)。**首次 start 失败仍 reject promise**(现有 S6 回滚不变);重建失败走退避不 reject(promise 早已 settle)。
- `stop()` 增加:置 `state=IDLE` + `rebuilding=false` + **clearTimeout 全部 timer(hbTimer、rebuildTimer、bindWatchdog)**(M3:退避 setTimeout 句柄不清 → delay 到期后 build 建孤儿 socket,呼应 [[electron-graceful-quit]] 僵尸教训)+ close socket。
- `announce()` 增加 `if (state!==READY) return` 门控(现有 `if(!socket) return` 升级)。**注意**:app-core:197 pruneTimer 里 announce 被门控 return 后,`registry.prune()` 仍照跑(对端 TTL 清理独立于本机 announce,正确,M4)。
- **依赖注入(实现新增)**:构造函数加第二参 `MulticastDeps { createSocket?, monotonicNow? }`,默认 `dgram.createSocket` / `performance.now`。测试注入 fake socket + fake clock 确定性驱动心跳判死/看门狗/重建(不起真 dgram);生产用默认。现有集成测(真 socket)不传 deps,行为不变。

---

## 4. 边界 / 失败模式

| 场景 | 处理 |
|------|------|
| **主线程繁忙误报僵死(B1)** | 心跳判死用**真实经过时间**(sentAt→单调时钟),不数 tick;繁忙推迟发出则 sentAt 同步推迟,时间差不虚增 → 不误报(§3.2) |
| **bind 挂住卡 BINDING(B2)** | 进 BINDING 起 BIND_WATCHDOG_MS(8s)看门狗,超时未 listening → close + 重建;第三条恢复触发,独立于 error/心跳(§3.1/§3.3) |
| **EADDRNOTAVAIL(网卡瞬时无 IP)** | **归可恢复**退避重试,非致命(B3):网络切换/唤醒的典型瞬态,几秒后自愈 |
| **真·致命(EACCES/EPERM/EINVAL)** | onFatal 上报 + **FATAL_RETRY_MS(30s)慢重试**,非永停(B3);权限/网络恢复后仍自愈 |
| **重建总时长 > 15s TTL(M1)** | 退避到 5s/10s 档时,重建期 announce 停 > TTL → 对端可能短暂删本机。**可接受**:重建后 `announce(true)` 到达对端 → 对端 onRespond→register 重新建立(闭环)。退避封顶 10s,权衡:压更低会更快重连但网络真断时更耗 CPU |
| **重建期 announce/心跳触发 send** | state!==READY 跳过(§3.1),不抛不重建 |
| **close 未完成就 bind 新的 → EADDRINUSE** | 等 old.close callback 再 build(§2.1);偶发 EADDRINUSE 归可恢复退避;**持久被占**(别的进程占 53317)→ 无限退避但每 N 次 onFatal 上报一次,不静默(m4) |
| **重建中 AppCore.stop()(M3)** | stop 置 state=IDLE + rebuilding=false + **clearTimeout(hbTimer/rebuildTimer/bindWatchdog)**;finish/build 入口判 `state===IDLE` 早退;listening 回调判 `state===BINDING && socket===s`,不满足则 close 丢弃 |
| **重建后立即误判(m2)** | build 里复位 `pendingNonce=null`,重建后心跳从干净态开始(无在途探测,不会立刻判死) |
| **重建风暴(error 连发)** | 幂等锁 rebuilding + 退避 |
| **loopback 被关 → 假僵死** | 重建后显式 setMulticastLoopback(true) 钉死;不读默认 |
| **多实例串扰 → 假活** | nonce 精确匹配自己的包,别人的探测包忽略(§2.3 误报源2) |
| **心跳多接口覆盖盲区(M2)** | 心跳 send 走 primary 出接口,loopback 只端到端验证 **primary 接口**的组成员健康;其他接口的组失效**心跳测不到**——接受此盲区(primary 是主用网卡,失效即影响主路径;其他接口失效由 error/对端超时兜底)。不为覆盖全接口让心跳遍历(复杂度高、收益低) |
| **测试隔离模式(interfaceAddr==='')** | 保持现有语义:joinedInterfaces=[]、broadcastTargets=[];**重建路径接口重算保留 `''→[]` 特判**(m3,不能简化成一行 pickAll,否则重建后变非空破坏隔离);心跳靠 OS 默认接口 loopback 自探测;可注入 fake clock/socket 驱动 |
| **心跳包被对端收到** | 对端 onMessage 用魔术前缀早退丢弃(§3.2);不产生垃圾设备、不触发 register |
| **UDP 单次丢包误判** | 9s 判死窗口容忍多次丢包;9s < 15s TTL |
| **旧 socket 晚到 message/error** | 先摘引用 + removeAllListeners,晚到事件打不到新逻辑 |

**明确不做**:周期 rejoin(§0);修改 registry TTL;根因层修复(IGMP querier 属网络侧,非应用能改)。

---

## 5. 常量

```ts
const HB_INTERVAL_MS = 3_000      // 心跳周期(发探测 + 检查在途)
const HB_DEAD_MS = 9_000          // 在途探测超过此真实时长未回 → 判死(B1:时间维度,非数 tick)
const HB_MAGIC = 'HB\0'           // 心跳包魔术前缀(区分业务包;JSON 业务包首字节必为 '{')
const BIND_WATCHDOG_MS = 8_000    // BINDING 后未 listening 的看门狗超时(B2)
const REBUILD_BACKOFF_MS = [500, 1000, 2000, 5000, 10000]  // 可恢复错误退避(封顶 10s)
const FATAL_RETRY_MS = 30_000     // 真·致命错误的慢重试周期(B3:非永停)
const FATAL_CODES = ['EACCES', 'EPERM', 'EINVAL']  // EADDRNOTAVAIL 不在此列(B3:瞬态可恢复)
```
- 单调时钟:`performance.now()`(或注入 `monotonicNow` 供测试)。判死看 `monotonicNow - pendingNonce.sentAt >= HB_DEAD_MS`。

---

## 6. 测试策略(可单测)

注入 fake socket 工厂 + fake clock + 注入 monotonicNow(现有 multicast 已用注入 now 思路),驱动:
1. **心跳健康**:发探测→回自己 nonce→pendingNonce 清空,不重建。
2. **心跳判死(时间维度,B1)**:发探测后推进 monotonicNow 到 ≥9s 仍不回 → 触发重建。**关键回归**:模拟"事件循环繁忙"——多个 tick 快速补偿触发但 monotonicNow 只推进 <9s → **不判死**(证明 B1 修复:不数 tick)。
3. **nonce 防假活**:喂一个"别人的" nonce(不匹配)→ pendingNonce 不清 → 到 9s 仍判死。
4. **心跳包不污染业务**:业务 announce 包正常进 handleMessage;HB\0 包不进 handleMessage(m1)。
5. **error 分类**:可恢复(ENETDOWN)→重建;**EADDRNOTAVAIL→重建**(B3,不致命);真致命(EACCES)→onFatal + FATAL_RETRY 慢重试(非永停,B3)。
6. **BINDING 看门狗(B2)**:build 后 listening 永不触发 + 推进时钟到 8s → close + 重建。
7. **重建原子性**:关旧等 close callback 再建;重建中 announce 被 state 门控跳过。
8. **退避**:连续重建失败 → 间隔按 REBUILD_BACKOFF_MS 递增;成功后归零。
9. **幂等**:重建中再来 error/心跳超时 → 不叠加建多个 socket。
10. **stop 竞态(M3)**:重建 delay 期间 stop → clearTimeout 退避 timer + bindWatchdog,delay 到期后 **build 不执行**(state===IDLE 早退);listening 回调不 join;不泄漏 socket。
11. **重建后复位(m2)**:判死重建(pendingNonce 非空)→ 重建成功后 pendingNonce 已复位,不立即再判死。
12. **测试隔离模式(m3)**:interfaceAddr==='' 下**重建后** joinedInterfaces 仍为 []、broadcastTargets 仍为 [](证明重算保留了特判)。

---

## 7. 与 DESIGN.md 的关系

- DESIGN §7 "应用退出/资源清理"不变量保留:stop 幂等、清 timer、置 null。
- 本机制是发现层健壮性增强,不改协议/registry/传输;实现后在 DESIGN §7 边界表补一行"socket 运行期僵死 → 自动重建"。

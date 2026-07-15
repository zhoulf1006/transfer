# 发现回应改为 HTTP 定向 register(替代 UDP 多播回应)

> 状态:**已实现**(typecheck/test 257/build 绿,待 dev 双机实测)。
> 落地:`http-client.ts`(`registerTo`)、`multicast.ts`(deps.onRespond,去 UDP 回应)、`app-core.ts`(respondViaRegister)、测试(multicast onRespond + integration registerTo 成功/不可达)。
> **实测/e2e 抓到的坑**:register 响应体省略 port,不能拿它刷新登记(见 §2.2 ⚠️)。
> 背景:见复盘——纯多播发现脆弱,双向发现的"回应"跳走 UDP 多播,单向丢包/多播被过滤时对方发现不了我们。
> 决策(用户确认):**只做 LocalSend 协议"用法 A"**——收到多播 announce 后,改用 `POST /register` **定向 TCP** 回应对方;**不扫网段、不广播**。去掉原 UDP 多播回应。

## 1. 事实层(坐实,file:line)

- **现在的回应**:`multicast.ts:170-173` 收到 `announce===true` → `this.announce(false)`(UDP 多播回一发)。脆弱:多播单向不通则对方发现不了我们。
- **收包已有对方地址**:`handleMessage(buf, address)`,`address` = 对方 IP;`info.port` = 对方 HTTP 端口(announce 里带,app-core.ts:96)。→ **定向 register 的目标信息齐全**,无需扫网段。
- **server 端 `/register` 已实现**:`http-server.ts:59-63` `POST /register` → `onRegister(info, req.ip)` → `handleDevice`(app-core.ts:152)→ 登记表。**收 register 半边已通。**
- **client 端无主动 register**:`http-client.ts` 只有 sendFiles/sendText(:60/:143)。**要补 `registerTo`。**
- **协议依据**(LocalSend README 坐实):用法 A = "收到 announce → `POST /register` 到 origin,对方在 **HTTP 响应体同步回**自己的信息"。用法 B(扫全网段)本次**不做**。

## 2. 方案

### 2.1 client 加 `registerTo`
`http-client.ts` 新增:
```ts
registerTo(target: {address, port}, selfAnnouncement): Promise<DeviceInfo | null>
```
- `POST http://{address}:{port}/api/localsend/v2/register`,body = 本机 announcement(alias/version/fingerprint/port/protocol…,announce 字段无所谓,server 不看)。
- **带超时**(如 2s,AbortController):对方没起 HTTP / 网络问题不能挂住。
- **失败静默返 null**(fire-and-forget 语义):register 失败绝不能影响发现主流程。
- 成功则解析响应体 = 对方 DeviceInfo,返回(供调用方顺带刷新登记,双保险)。

### 2.2 回应链路:去 UDP 多播回应,改注入回调
- `MulticastDiscovery` 的 deps 加 `onRespond?: (info, address) => void`。
- `handleMessage` 收到 `announce===true` 时:**不再 `this.announce(false)`**,改调 `this.opts.onRespond?.(info, address)`。
- `app-core` 注入 `onRespond`:调 `registerTo({address, port: info.port}, selfInfo())`。

> ⚠️ **踩坑修复(register 响应体省略 port → 覆盖真实端口)**:**不能**用 registerTo 返回的对方 info 去 `handleDevice` 刷新登记。LocalSend 协议规定 `/register` 响应体**省略 port/protocol**(http-server.ts 只回 alias/fingerprint…)。若拿它 handleDevice,`registry.upsert` 会用 `DEFAULT_PORT` 覆盖掉我方已从 announce 拿到的对方**真实 HTTP 端口** → 之后连错端口、传输失败/超时(e2e 测试抓到:文件 ENOENT、文本 timeout)。我方对对方的登记由收到的 **announce**(含正确 port)完成,register 回应只为"让对方发现我们",返回值忽略。

## 3. 边界 / 失败模式(前置纸面 —— 按"回应"这个动作的所有路径穷举)

| 场景 | 处理 |
|---|---|
| 收到 announce=true,对方 HTTP 正常 | registerTo 成功 → 对方 server 收到 → 对方发现我们。✅ 主路径 |
| 收到 announce=true,对方 HTTP 未起/端口错 | registerTo 超时/连接失败 → 静默返 null，不影响我方已把对方登记上线 |
| 收到 announce=**false**(别人的回应包) | **不回应**(否则 A→B 回应、B→A 再回应…无限对回)。只 `onDevice`,不 `onRespond` |
| 自己的包(fingerprint===self) | :156 已 return，不到回应逻辑 |
| info.port 缺失/非法 | registerTo 里校验，无效直接返 null 不发 |
| register 请求体/响应体解析失败 | try/catch 静默返 null |
| 对方 IP 是 IPv6/link-local | 用收包 address 原样拼 URL；失败则静默(本项目主 IPv4) |
| 高频:对方每 5s announce → 我每 5s register 对方一次 | 可接受(5s 一次定向请求,轻);对方 server 幂等 upsert |
| **回应风暴**:N 台机器互相 announce | 每台只对"收到的 announce=true"回应一次,不广播,N×5s 定向请求，线性可控 |
| registerTo 抛异常(非超时) | 包 try/catch,绝不冒泡到 handleMessage(否则一条坏包中断收包循环) |
| 多网卡:收包 address 是哪个网卡 | 用实际收包源地址(dgram 给的 rinfo.address),就是对方可达的那个,天然正确 |
| 去掉 UDP 回应后,"多播通但反向 TCP 不通"的罕见网络 | 对方发现不了我们(已知取舍,用户接受;此场景罕见,TCP 定向整体更可靠) |

## 4. 影响面 / 改动清单

| 文件 | 改动 |
|---|---|
| `src/main/transfer/http-client.ts` | 新增 `registerTo(target, announcement)`:定向 POST /register + 超时 + 静默失败。 |
| `src/main/discovery/multicast.ts` | deps 加 `onRespond`;`handleMessage` 收 announce=true 改调 onRespond(去 `announce(false)`)。 |
| `src/main/app-core.ts` | 注入 `onRespond` → registerTo + 刷新;构造 announcement 复用现有 buildAnnouncement。 |
| `src/main/discovery/multicast.test.ts` | 补测:announce=true 触发 onRespond、announce=false 不触发、坏包不中断。 |
| `docs/` | 本文;DESIGN §1.1 同步"回应改 HTTP 定向"。 |

## 5. 成功标准 / 验证

1. typecheck + test + build 绿。
2. multicast 单测:收 announce=true → onRespond 被调(带正确 info/address);收 announce=false → onRespond 不被调;`onDevice` 两种都调。
3. registerTo:目标不可达 → 超时返 null 不抛。
4. dev 双机实测:A 广播 → B 收到并 registerTo A → **A 也发现 B**(双向)。之前偶发单向失败应改善。
5. 回归:多播主发现、传输、未读等不变。

## 6. 分步实现(检查点)

1. `registerTo` + 超时/静默失败 → typecheck。
2. multicast onRespond 注入 + 去 UDP 回应 + app-core 接线 → typecheck。
3. 补测 → test 绿。✅announce=true/false 分支。
4. dev 双机实测双向发现。
5. 回同步 DESIGN §1.1。
6. 全绿后发版(v0.5.1)。

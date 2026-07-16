# HTTPS 改造 — 设计文档

> 把局域网传输从 **HTTP 明文** 升级为 **HTTPS + 自签名证书 + 指纹 TOFU pinning**。
> 归属:[DESIGN.md](./DESIGN.md) §10 迭代路线第 4 项("HTTPS + fingerprint TOFU 校验")。
> 本文档走七步流程的**第 1 步(调研)+ 第 2 步(方案)**;实现前需用户 review。

---

## 0. 决策速览(已与用户确认)

| 维度 | 决策 | 备注 |
|------|------|------|
| **互通目标** | **不追求与官方 LocalSend App 互通**,只求自家两端(Transfer↔Transfer)安全 | 简化实现:用 Node 原生 `fingerprint256` 做 pinning,不比对 SPKI 公钥 |
| **信任模型** | **TOFU,每次重新信任,不告警**(同官方 App) | 无跨会话持久化 pin、无"证书变更"告警;局域网即插即用优先 |
| **HTTP 明文** | **全切 HTTPS,移除 HTTP server/client 代码路径** | 保留 `protocol` 字段(恒填 `'https'`),便于识别对端与未来扩展;移除的是代码路径不是字段 |
| **密钥类型** | **EC P-256** | 生成快(几十 ms)、握手快、体积小;不互通故无需迁就官方 RSA-2048 |
| **证书存储** | `userData/identity.json` 新增 `cert` / `privateKey`(PEM);首启惰性生成一次 | 与现有 `alias`/`fingerprint` 同文件 |
| **fingerprint 语义** | 从"随机串"改为 **`cert.fingerprint256`(SHA-256 of DER 整证书,冒号分隔大写 hex)** | 同时用于:①自发现去重(现有用途)②TLS 指纹 pinning(新用途) |
| **client 实现** | 从 `fetch` 改为 **`node:https` + 自定义 `Agent.createConnection` 指纹 pin** | `fetch`/undici 做指纹 pin 别扭;Electron `net` 打自签名静默失败,主进程用 Node https 绕开。⚠️ **不用 `checkServerIdentity`**(实测:`rejectUnauthorized:false` 下它不被调用,见 §3.6) |
| **依赖新增** | **仅 `selfsigned` ^5.5**(纯 JS,零原生编译,支持 EC) | 指纹/哈希/TLS/X509 全用 Node 内置。⚠️ 5.x 是 **async-only**(`await generate()`) |

---

## 1. 需求调研结论(带来源,区分「确认」与「推断」)

三方向并行调研:①LocalSend 协议规范 ②官方 App 真实源码 ③Node/Electron HTTPS 能力。

### 1.1 LocalSend 协议规范(来源:github.com/localsend/protocol main,标题 v2.1)

- **确认**:`protocol` 字段取值 `"http" | "https"`,出现在 announce/register/info 报文。
- **确认(逐字)**:"When encryption is on (HTTPS), then the fingerprint is the SHA-256 hash of the certificate. When encryption is off (HTTP), then the fingerprint is a random generated string." 用途:"avoid self-discovery and to remember devices."
- **确认**:**所有 endpoint 路径/请求体/响应体在 http 与 https 下完全相同**,差异只是 scheme + TLS 层,REST 语义不变。→ **本改造只加 TLS,应用层协议零改动。**
- **确认**:Web 分享(Download API)强制 HTTP,原文 "browsers reject self-signed certificates"。→ 本项目无浏览器下载功能,不涉及。
- **规范未定(实现方自决)**:fingerprint 的确切算法(DER 整证书?SPKI?输出编码?)、TOFU/pinning 流程(规范零描述)、默认 http/https。→ 由 §1.2 官方源码坐实。

### 1.2 官方 App 真实实现(来源:github.com/localsend/localsend main @b43b795,2026-07-14)

- **证书生成(源码坐实)**:`security_helper.dart` `generateSecurityContext()` 用 `basic_utils`,**RSA-2048、CN=`LocalSend User`、无 SAN、有效期 3650 天(10年)**。首启惰性生成一次,存 SharedPreferences(`ls_security_context`:privateKey PKCS#1 + publicKey SPKI + certificate PEM + certificateHash)。
- **fingerprint 计算(源码坐实)**:`calculateHashOfCertificate()` = PEM 去头尾行 → base64 decode 得 **DER 整证书** → `SHA-256`。即 `fingerprint = SHA-256(DER(整证书))`,**不是**公钥/TBS。
- **⚠️ 关键纠正(源码坐实)**:官方 TLS 校验比对的是**公钥(SPKI 逐字节)**,**不是** fingerprint。`verify_cert_from_der(cert, public_key)` 检查:①时间有效 ②证书 SPKI == 期望公钥(逐字节) ③自签名签名有效。**fingerprint 仅用于自发现去重 + UI 显示。** 二者一一对应(同证书),但代码路径不同。
- **TOFU 两阶段(源码坐实)**:`register` 阶段 `public_key=None` → **不比对,提取并记住对端公钥**;后续 `prepare-upload`/`upload` 都带该公钥比对,不匹配 → 请求**直接失败**(非告警)。
- **无持久化 pin、无变更告警(源码坐实无该逻辑)**:对端重装/换机 → 证书变 → 下次静默重新 TOFU。
- **加密总开关**:`ls_https` 默认 `true`(HTTPS)。

> **本项目取舍(与官方的差异,已确认)**:官方比对**公钥 SPKI**;我们**不互通**,故改用 Node 原生更易拿的 **`cert.fingerprint256`(整证书 SHA-256)** 做 pinning——比对指纹 ⊃ 比对公钥的安全性(整证书含公钥,证书变则指纹必变),对"防被动窃听 + 会话内一致性"这个威胁模型足够。代价:与官方 App 不互通(官方比公钥,我们比整证书指纹,同一设备两者算法不同 → 无法互认)。**这是有意选择,不是遗漏。**

### 1.3 Node/Electron HTTPS 能力(来源:Node 22 / Electron 35 官方文档)

- **确认**:`node:crypto` **无法**生成自签名证书(`X509Certificate` 只读、`generateKeyPair` 只出密钥对)→ 必须库。**`selfsigned`(纯 JS,零原生编译,Electron 打包无坑)**。默认 sha1+1024 → **必须覆盖 `algorithm:'sha256'` + EC P-256**。
- **确认**:Fastify HTTPS = `Fastify({ https: { key, cert } })`,透传 Node tls;**PEM 字符串可直接传,免写盘**。
- **调研原结论(部分错误,实测纠正)**:调研给的"`rejectUnauthorized:false` + `checkServerIdentity` 比对指纹"写法**不成立**——实测 `rejectUnauthorized:false` 下 Node **不调用** `checkServerIdentity`(它仅在证书通过链校验后才调),指纹校验被完全跳过。**正解:自定义 `Agent.createConnection` + `tls.connect(rejectUnauthorized:false)`,在连接回调里 `socket.getPeerCertificate().fingerprint256` 比对**(详见 §3.6 实现纠正)。
- **确认**:拿对端证书 `res.socket.getPeerCertificate(true)` → `.fingerprint256`(**冒号分隔大写 hex**,可直接比对)/ `.raw`(DER Buffer)。
- **⚠️ 确认(踩坑规避)**:Node 内置 **`fetch`(undici)不直接吃 `rejectUnauthorized`**(要 `dispatcher: new Agent({connect:{rejectUnauthorized:false}})`),做指纹 pin 别扭 → **client 从 `fetch` 改回 `node:https`**。Electron **`net` 模块打自签名 HTTPS 静默失败无法 catch**(electron#8656)→ 主进程用 Node `https` 绕开,**不用 net**。
- **确认**:证书首启生成一次(EC 最快);loopback/内网小文件 TLS 握手开销个位到几十 ms,`https.Agent` keepAlive 复用连接后握手近乎消失。

---

## 2. 现有代码接入点(亲自核对,带 file:line)

**好消息:类型层早已预留 https 口子**,`DeviceInfo.protocol` / `RemoteDevice.protocol` / `SendTarget.protocol` 均为 `'http' | 'https'` 联合类型,只是当前值全硬编码 `'http'`。

| 位置 | 现状 | 改造 |
|------|------|------|
| `shared/identity.ts:20` `generateFingerprint()` | 随机 32 字节 hex | **废弃随机串**;fingerprint 改由证书算(§3.2) |
| `shared/identity.ts:51` `buildDeviceInfo()` | 硬编码 `protocol:'http'` | 改 `'https'` |
| `shared/types.ts` `DeviceInfo`/`RemoteDevice`/`SendTarget` | `protocol?: 'http'\|'https'` | 保留;`SendTarget` **新增 `fingerprint`**(§3.4) |
| `main/device-identity.ts:21` `loadOrCreateIdentity()` | 存 `alias`+`fingerprint` | **新增生成/加载 `cert`+`privateKey`**,fingerprint 由 cert 派生(§3.3) |
| `main/transfer/http-server.ts:51` `Fastify({bodyLimit})` | 纯 HTTP | `Fastify({ https:{key,cert}, bodyLimit })`(§3.5) |
| `main/app-core.ts:208` `server.listen()` | Fastify http | 传入证书(装配层注入,§3.5) |
| `main/app-core.ts:97` `buildAnnouncement` `protocol:'http'` | 硬编码 | `'https'` |
| `main/app-core.ts:124` `resolvePeer()` → `SendTarget` | 无 fingerprint | **带上 registry 里对端 fingerprint**(§3.4) |
| `main/app-core.ts:147/157` `handleRegister`/`handleDevice` `protocol ?? 'http'` | 兜底 http | `?? 'https'` |
| `main/transfer/http-client.ts` 全文 | `fetch` × 4(prepare/upload/cancel/register) | **改 `node:https` + 指纹 pinning agent**(§3.6) |
| `main/discovery/multicast.ts:186` 自发现比对 | `msg.fingerprint === selfFingerprint` | 无需改(fingerprint 语义变了但比对逻辑不变) |

---

## 3. 方案设计

### 3.1 总体思路

```
首启: 生成 EC P-256 自签名证书 → 存 identity.json → fingerprint = cert.fingerprint256
         │
         ├─ Server: Fastify({ https:{key:privateKey, cert} }) 起 HTTPS
         │
         └─ 发现: announce 报文带 protocol:'https' + fingerprint(=证书指纹)
                    │
         对端收到 announce → registry 记住 { address, port, protocol:'https', fingerprint }
                    │
         发送: resolvePeer(fp) → SendTarget{ ...,  fingerprint }
                    │
         Client(node:https): rejectUnauthorized:false（接受自签名）
                             + createConnection 回调: 比对 cert.fingerprint256 === target.fingerprint
                               不符 → Error → 请求失败（TOFU pinning）
```

**核心不变量**:发现阶段拿到的 `fingerprint` 就是连接时 pin 的期望值。二者是**同一个字段**(证书 SHA-256),发现层已在传输,无需新增交换通道。

### 3.2 fingerprint 计算(shared/identity.ts)

```ts
import { X509Certificate } from 'node:crypto'

/** 证书指纹 = SHA-256(DER 整证书),冒号分隔大写 hex(= Node fingerprint256 格式) */
export function certFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256  // 'AB:CD:...'
}
```

- `generateFingerprint()`(随机串)**已移除**(改造后无用途,避免误用;其单测一并移除)。
- 格式统一用 `fingerprint256`(冒号分隔大写),client 比对时两边都是这个格式,不自己 `createHash` 插冒号(避免格式不一致)。

### 3.3 证书生成与持久化(main/device-identity.ts)

```ts
import selfsigned from 'selfsigned'  // ^5.5：async-only，支持 keyType:'ec'（已坐实）

interface Identity {
  alias: string
  fingerprint: string   // = certFingerprint(cert)
  cert: string          // PEM
  privateKey: string    // PEM
}

// ⚠️ selfsigned 5.x 是 async-only：generate() 返回 Promise
// ⚠️ 有效期字段是 notBeforeDate/notAfterDate(Date),不是 days(已坐实 index.d.ts)
// ⚠️ pems.fingerprint 是 SHA-1,不用它;fingerprint 用 X509Certificate(cert).fingerprint256 自算
async function generateCert(): Promise<{ cert: string; privateKey: string }> {
  const notBefore = new Date()
  const notAfter = new Date(notBefore.getTime() + 3650 * 24 * 60 * 60 * 1000) // 10 年
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Transfer' }],
    { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: notBefore, notAfterDate: notAfter }
  )
  return { cert: pems.cert, privateKey: pems.private }
}
```

> ⚠️ **async 连带影响(M1,连带面比想象大)**:`generate()` 异步 → `loadOrCreateIdentity` 变 async。**统一 async,不做同步/异步混合签名**(混合签名是类型灾难)。需 await 的完整链路:
> - `index.ts:283` `loadOrCreateIdentity` 及其后**同步依赖 identity** 的 `new MessageStore`/`new SettingsStore`/`new AppCore`/`core.chat.onStartup()`/`new ScreenshotService`/`screenshot.start()` —— 全部移入 `await` 之后重排(现都在 `whenReady().then(...)` 里)。
> - `saveAlias`(`device-identity.ts:39`)内部也调 `loadOrCreateIdentity` → 一并 async;其调用点 `device:setAlias` IPC(`index.ts:141`)handler 需 await。
> - **失败落点**:证书生成在 `startCore` catch(`index.ts:336`)**之前**、无 catch → 未捕获 rejection 会静默。需在 identity 生成处包 try/catch → `dialog.showErrorBox` 明确报错(HTTPS 是硬前提,不可降级 http)。
>
> **首启仅一次几十 ms 证书生成延迟**,之后文件已有 cert 直接读。

**加载逻辑(含老用户迁移)**:
```
读 identity.json:
  ├─ 有 cert + privateKey + fingerprint → 直接用
  ├─ 有 alias/fingerprint 但无 cert(老用户 HTTP 版）
  │     → 生成证书 → fingerprint 改为 certFingerprint(cert) → 覆写 identity.json
  │       (fingerprint 变化 → 老历史会话可见性分列，见 §4 M2；非"无副作用")
  └─ 全无（首启）→ 生成 alias + 证书 → fingerprint = certFingerprint(cert) → 写盘
```

> ⚠️ **迁移点**:老用户 `fingerprint` 从随机串变证书指纹。对端 registry 旧记录随超时自然清理,新 announce 带新 fingerprint 重新发现(**发现层**升级无感)。但**历史消息层不无感**——见 §4 M2:老聊天记录因 `peer_fp` 变化在 UI 分列。这是有意接受的 MVP 取舍,不是遗漏。

### 3.4 SendTarget 带 fingerprint(pinning 期望值的数据流)

现有 `SendTarget` 无 fingerprint,TOFU 无期望值可比 → **必须补**:

```ts
// shared 或 http-client.ts
export interface SendTarget {
  address: string
  port: number
  protocol: 'http' | 'https'
  fingerprint: string   // 新增(必需):发现阶段记住的对端证书指纹,用于 TLS pinning
}
```

> ⚠️ **这是 breaking 的类型变更(review B3)**:`fingerprint` 设为**必需**(不是可选)。设为可选会让 pin 期望值悄悄 `undefined`,退化成静默失效。**全部构造点必须补齐**:
>
> | 构造点 | 填法 |
> |---|---|
> | `app-core.ts:128` `resolvePeer` | `dev.info.fingerprint`(registry 现成,来自 announce) |
> | `app-core.ts:144` `respondViaRegister` | **register 专用,不 pin**(见 §3.6 register 例外);字段填 `info.fingerprint`(对端 announce 带的)或空串占位,但该路径 agent 不校验 |
> | `transfer.integration.test.ts:22/78/347/356`、`chat-service.test.ts:76/319` 等测试 | 补测试证书的 fingerprint(字段必需 → 不补则编译失败,这是**有意的编译期护栏**) |
>
> - registry 里 `RemoteDevice` 已存 `info.fingerprint`(来自 announce),`resolvePeer` 数据现成。
> - **fail-closed(review B3)**:pin 回调里除了判 `cert.fingerprint256` 为空,**还要判 `target.fingerprint` 为空** → 空则 `socket.destroy`(响亮失败),杜绝"忘填 → 静默放行"。见 §3.6 代码 + 集成测试"空指纹 → fail-closed"。

### 3.5 Server 侧(http-server.ts + app-core.ts)

```ts
// http-server.ts：createHttpServer 增加 tls 参数
export interface HttpServerDeps {
  ...
  tls: { key: string; cert: string }   // 新增
}
export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const app = Fastify({
    https: { key: deps.tls.key, cert: deps.tls.cert },  // PEM 字符串直传
    bodyLimit: 1024 * 1024 * 1024
  })
  ...
}
```

- `app-core.ts:165` 装配时把 `identity.cert`/`identity.privateKey` 注入。
- `listenWithFallback`(端口回退)逻辑不变,Fastify 起的是 https server,`server.listen` 用法一致。

### 3.6 Client 侧(http-client.ts:从 fetch 改 node:https)

**这是改动最大的模块**。四个请求(prepare-upload / upload / cancel / register)全从 `fetch` 改为 `node:https.request`,统一走一个带指纹 pinning 的 Agent 工厂:

> ⚠️⚠️ **实现纠正(实测坐实,照旧写法会重现 bug)**:原设计用 `rejectUnauthorized:false` + `checkServerIdentity` 做指纹校验。**实测:设 `rejectUnauthorized:false` 后 Node 根本不调用 `checkServerIdentity`**(它仅在证书通过链校验后才调)→ 指纹校验形同虚设,**所有连接(含冒充者)全部放行**,pinning 静默失效。这个 bug 是靠"指纹不匹配→必须失败"测试抓出来的。**正解:自定义 `Agent.createConnection`,用 `tls.connect(rejectUnauthorized:false)` 建连,在连接回调里同步比对握手实际证书的 `fingerprint256`,不符即 `socket.destroy`。**

```ts
import https from 'node:https'
import tls from 'node:tls'

/** 指纹 pinning agent(TOFU:接受自签名，但 pin 证书指纹)。按 fingerprint 缓存复用(m2)。 */
const agentCache = new Map<string, https.Agent>()
function pinnedAgent(target: SendTarget): https.Agent {
  const cached = agentCache.get(target.fingerprint)
  if (cached) return cached
  const agent = new https.Agent({ keepAlive: true, maxCachedSessions: 100 })
  // 覆盖 createConnection:tls.connect 建连 + 回调里同步 pin(运行时 Agent 支持,官方文档)
  type CreateConn = (
    opts: tls.ConnectionOptions,
    cb: (err: Error | null, sock?: tls.TLSSocket) => void
  ) => tls.TLSSocket
  ;(agent as unknown as { createConnection: CreateConn }).createConnection = (opts, cb) => {
    const socket = tls.connect({ ...opts, rejectUnauthorized: false }, () => {
      if (!target.fingerprint) { socket.destroy(new Error('no pinned fingerprint')); return } // fail-closed(B3)
      const cert = socket.getPeerCertificate() // 握手实际叶子证书(M4:整证书 SHA-256)
      if (!cert || !cert.fingerprint256) { socket.destroy(new Error('no peer certificate')); return }
      if (cert.fingerprint256 !== target.fingerprint) {
        socket.destroy(new Error(`fingerprint mismatch: ${cert.fingerprint256} != ${target.fingerprint}`))
        return
      }
      cb(null, socket) // 通过
    })
    socket.on('error', (err) => cb(err))
    return socket
  }
  agentCache.set(target.fingerprint, agent)
  return agent
}
```

- 各请求把 `agent: pinnedAgent(target)` 传入 `https.request` options。
- **⚠️ 证书唯一可信来源(M4)**:pin 判定用**连接回调里 `socket.getPeerCertificate()`** 拿本次握手叶子证书(此刻握手刚完成、连接尚未交给上层,时序正确)。~~原写法说的"checkServerIdentity 回调 cert"不可用(该回调根本不被调,见上纠正)~~。
- **upload 流式 body(M3,进度语义必须等价)**:现有 `fetch` 版计数发生在传输层**拉取** chunk 时(背压驱动)= 真实已发送字节(DESIGN §12.1)。改 node:https 后**必须**用 `readStream.pipe(counter).pipe(req)`,计数放中间 `Transform` 的 `_transform`,由 `req` 的 write 背压驱动。**不可用 `readStream.on('data')` 累加**——那计的是"从磁盘读出"字节,快盘慢网时进度瞬间冲 100% 失真。
- **⚠️ 必设 `Content-Length`(M3)**:node:https pipe 流且不设 header 会退化成 chunked → 接收方 `http-server.ts:158` `Number(req.headers['content-length'])` 取不到 → total=0 → 接收进度失真。必须显式 `headers['content-length'] = String(total)`(等价现有 `http-client.ts:115`)。
- **⚠️ 超时用总时长语义(M3)**:现有 `AbortSignal.timeout(T_UPLOAD_MS)` 是**总时长**硬超时(S4 本意:防接收方挂起导致永挂)。`req.setTimeout` 是**空闲超时**,大文件持续传输永不触发 → 不等价。改法:起一个 `T_UPLOAD_MS` 的总 deadline timer,到点 `req.destroy(new Error('upload timeout'))`;成功/失败都 clearTimeout。
- **prepare-upload / register**:JSON body,`req.write(JSON.stringify(...))`;响应 `res` 累积 body 后 `JSON.parse`。
- pinning 失败 → `socket.destroy(err)` → `createConnection` 的 `cb(err)` → `req` 的 `'error'` 事件 → 归到现有错误路径(prepare 失败/upload 失败)→ `chat-service` 标 `failed(network)`,**不卡发送队列**(enqueue 链尾 settle 清 key,pinning 失败是一次性 reject)。

> **register 是 pinning 例外(B1,关键)**:`registerTo`/`respondViaRegister` 是双向发现的**唯一回应机制**(DESIGN §1.1"选方式 2 HTTP 定向 register")。此时本机 registry 里**可能还没有该 peer**(register 正是"我回应你、让你发现我"的反向敲门),**无 fingerprint 可 pin**。若强套 pinning agent → `target.fingerprint` 空 → fail-closed → **每次 register 都失败 → 对方永远发现不了我方 → 双向发现塌一半**。
> **修法**:register **单独用一个 `discoveryAgent = new https.Agent({ rejectUnauthorized:false })`**(接受任意自签名,不覆盖 createConnection、不 pin)。安全上无损——register body 只有本机公开 DeviceInfo,不传输敏感数据,本就"失败静默"。**prepare-upload / upload / cancel 走 pinnedAgent(pin),register 走 discoveryAgent(不 pin)。**

> **实现提示**:封装 `httpsJson(agent, target, path, method, body?)` 和 `httpsUpload(agent, target, url, stream, total, onProgress)` 两个 helper,把 node:https 回调式 API 包成 Promise。传入的 agent 决定 pin 与否(prepare/upload/cancel 传 pinnedAgent,register 传 discoveryAgent)。返回值形状与现有 `SendResult`/`SendTextResult` 一致,上层 chat-service 零改动。

### 3.7 发现层(multicast.ts / app-core.ts)

- `buildAnnouncement`(`app-core.ts:94`):`protocol:'http'` → `'https'`。
- 自发现比对(`multicast.ts:186` `msg.fingerprint === selfFingerprint`)**逻辑不变**——fingerprint 语义从随机串变证书指纹,但"等于自己就跳过"的逻辑照旧,自动生效。
- `respondViaRegister` / `registerTo`:走 §3.6 的 https client,但**用不 pin 的 discoveryAgent**(B1:register 阶段无 fingerprint 可 pin,强 pin 会断双向发现)。

---

## 4. 边界 / 失败模式(前置到纸面)

| 场景 | 处理 |
|------|------|
| **老用户升级(identity.json 无 cert)** | 加载时检测无 cert → 生成 → fingerprint 改证书指纹 → 覆写。无告警(§3.3)。⚠️ **副作用见下条(M2:历史会话断裂),非"无副作用"** |
| **⚠️ 老用户历史会话断裂(M2)** | 迁移后本机 + 对端 fingerprint 都变(随机串→证书指纹)。`messages` 表 `peer_fp`(DESIGN §11.3)、`App.tsx` setPeer/unread map 都靠 fingerprint 索引 → **同一物理对端的旧历史挂旧 fp、新消息挂新 fp,UI 里分裂成两个联系人,老聊天记录"看不见"**(数据在库里未丢,只是 key 变了)。MVP 决策:**接受"升级后老会话历史与新会话分列、不自动合并"**(不做 fp 迁移映射,复杂度高)。验收补一条:确认数据不丢、仅可见性分列。自发现过滤(`multicast.ts:186`)取的是**迁移后**的 `selfFingerprint`,不会自己给自己发 ✅ |
| **证书生成失败** | selfsigned 抛错 → 启动失败,明确报错(证书是 HTTPS 前提,不可降级 http,因已移除 http 路径)。需 try/catch + 用户可见错误 |
| **对端指纹不匹配(证书变/中间人)** | pin 回调 `socket.destroy` → 请求失败 → 归现有 failed 路径。**不告警、不持久化**(TOFU,§0)。对端重装属正常场景:其 announce 带新 fingerprint,registry 更新后新 SendTarget 带新指纹,下次连接通过 |
| **registry 里 fingerprint 与实际证书不符(过期缓存)** | pinning 失败 → 请求 error。对端仍在线会持续 announce 刷新 registry,下轮修正。发送方本地队列(§11.2.3)不因此死循环:失败即标 failed |
| **对端 announce 说 https 但实际起的 http(异常/攻击)** | https client 连 http 端口 → TLS 握手失败 → 请求 error → failed。不静默 |
| **`protocol ?? 'https'` 兜底语义(m1)** | `handleDevice`/`respondViaRegister` 的 `info.protocol ?? 'https'`:仅在对端字段缺失时生效。自家两端已全 https,兜底改 'https' 无害;真·http 老客户端(理论已不存在)会被误当 https 连→握手失败→failed。可接受 |
| **端口回退(EADDRINUSE)** | 不变:`listenWithFallback`(`app-core.ts:203`)不关心 TLS,https server 同样支持 listen 回退。回退后 **announce.port = 实际 https 端口**(`selfInfo()` 反映 httpPort),对端按此连接+pin(m3) |
| **loopback 自连(同机多实例测试)** | 各实例不同证书 → 不同 fingerprint → 自发现过滤;互连时各 pin 对方证书,正常 |
| **大文件 upload 流式** | node:https `createReadStream.pipe(req)` 流式,内存不涨(替代 fetch Web stream) |
| **TLS 握手延迟** | https.Agent keepAlive 复用连接;首连几十 ms,内网可忽略(§1.3) |
| **Electron net / 渲染进程访问后端** | 不涉及:所有 HTTP client 在**主进程**用 node:https;渲染进程只走 IPC,不直连 HTTPS 后端 |
| **证书私钥泄露风险** | 私钥存 userData/identity.json(明文 PEM),与官方 App 存 SharedPreferences 同级别。本地文件权限依赖 OS;MVP 不加密私钥(与官方一致) |
| **fingerprint256 格式一致性** | 两边统一用 Node `X509Certificate.fingerprint256` / `getPeerCertificate().fingerprint256`(冒号分隔大写),不手写 createHash,避免格式不符误判 |

### 4.1 ⚠️ 真实威胁模型(B2,必须诚实,勿在 README 夸大)

本改造的安全边界有一个**由发现机制决定的固有上限**,必须写清,否则回同步进 DESIGN/README 会给用户**虚假安全感**:

- **fingerprint 经明文 UDP 广播传播**(`multicast.ts:137` 明文 `JSON.stringify` announcement)。TOFU 的"首次信任锚点"本身走**不可信信道**。
- **后果:同网段主动攻击者可零成本冒充任意对端**——广播一份 announcement,`alias` 抄成"Loong's Mac"、`fingerprint` 填**攻击者自己证书的指纹**、`address` 指向攻击者。发送方 registry 就 upsert 出"以攻击者指纹为期望值"的记录 → 用户选它发送 → pin 到攻击者证书 → **TLS 校验完美通过**(指纹确实=攻击者证书)→ 明文进攻击者手里。**连"中间人"都不用当,直接冒充端点。**
- **IP 绑定不缓解此洞(纠正原设计错误归因)**:DESIGN §5.1 的 IP 绑定是**接收方**在 upload 阶段校验来源 IP,保护的是"接收会话不被换 IP 劫持",**完全不保护发送方 pin 到谁**。发送方按 registry 里攻击者给的 address 直连攻击者,IP 绑定在这条链路不参与。

**本改造的真实收益(精确表述)**:
- ✅ **防被动嗅探已建立的 Transfer↔Transfer 会话内容**:对两个都诚实广播的端,纯窃听者(不发包)拿不到明文(相比 HTTP 明文是实质提升)。
- ❌ **对主动攻击者(会广播/冒充)无实质提升**:与官方 LocalSend App 同级局限(官方也是 TOFU-over-untrusted-discovery)。
- **弹框确认(DESIGN §5)是此场景唯一人肉防线**:HTTPS 后它承担了比 HTTP 时更重的安全职责(用户看到陌生 alias 可拒),但仍能被"抄 alias"绕过。

> README/DESIGN 回同步时,安全表述应为**"HTTPS 加密传输,防被动窃听;不防同网段主动冒充,请在可信局域网使用"**,**不可**简写成"HTTPS 加密 + 指纹 pinning(安全)"。

**明确不做(表态,不沉默)**:
- **持久化 pin + 证书变更告警**:同官方,不做(§0 决策 2)。**注意这不改变上面的主动冒充洞**——持久化 pin 只在"对端首次诚实、之后被冒充"时有用;首次即被冒充则 pin 住的就是攻击者。真正堵洞需带外验证指纹(如手动核对),超出 MVP。
- **mTLS(双向证书)**:官方新 Rust 版做了,我们不做——对本威胁模型无实质提升(攻击者同样能生成自己的客户端证书),增复杂度无收益。
- **与官方 LocalSend App 互通**:§0 决策 1,有意放弃。
- **HTTP 明文回退**:§0 决策 3,移除。

---

## 5. 实现步骤(按可测拆分,每步实现后立即测)

对应七步流程第 4 步。持久化 tasklist,每步测通再下一步。

1. **证书 & 身份层**(纯逻辑,可单测)
   - 加 `selfsigned` 依赖;`certFingerprint()`(identity.ts);`generateCert()` + 迁移逻辑(device-identity.ts)。
   - 测:生成的证书能被 `X509Certificate` 解析、fingerprint256 稳定、老 identity.json 迁移正确、EC P-256 参数生效。
2. **Server HTTPS**(http-server.ts + app-core.ts 装配)
   - `createHttpServer` 加 tls 参数;装配注入证书;announce/buildDeviceInfo 改 https。
   - 测:https server 起得来、GET /info 走 https 能通(自签名,测试 client 用 rejectUnauthorized:false)。
3. **SendTarget + resolvePeer 带 fingerprint**
   - 类型加字段;resolvePeer 带上;handleDevice/registry 保持。
   - 测:resolvePeer 返回的 target 含正确 fingerprint。
4. **Client 改 node:https + pinning**(改动最大)
   - `pinnedAgent`(pin,缓存复用)+ `discoveryAgent`(register 不 pin,B1)+ `httpsJson`/`httpsUpload` helper;四处调用点替换(prepare/upload/cancel 用 pinnedAgent,register 用 discoveryAgent);流式 upload 用 `pipe(counter).pipe(req)` 计数 + 显式 Content-Length + 总时长 deadline 超时(M3)。
   - 测:prepare/upload/cancel 走 pin 的 https、指纹匹配通过/不匹配失败/**空 fingerprint fail-closed**(B3);register 走不 pin 的 agent 能通(B1 回归:双向发现不断);流式大文件字节一致;**进度按已发送字节(非磁盘读出)**;Content-Length 正确接收方 total≠0;总时长超时触发 destroy。
5. **端到端集成测 + 现有测试改造(m5)**
   - ⚠️ **现有 `transfer.integration.test.ts` 全程 `fetch(http://...)` 直连(:187/228/346)+ SendTarget 无 fingerprint**,全切 https 后**会全红**——需同步改造:测试 client 改 https(rejectUnauthorized:false)、URL 改 https scheme、SendTarget 补测试证书 fingerprint。受影响清单:`transfer.integration.test.ts`、`chat-service.test.ts`(SendTarget 构造 :76/319)。
   - 起两个实例(不同证书/fingerprint),走完整收发,断言落盘字节一致 + TLS 生效 + 指纹 pin 生效(篡改期望指纹 → 失败)+ **双向发现(register)在 https 下仍通**(B1 端到端回归)。
6. **回归 + 回同步 design**
   - 跑全量测试;把实现偏离回写本文档 + DESIGN.md §10(标记该项完成)+ 更新 DESIGN §1.1/§6 的 http 表述 + README 安全提醒(HTTP 明文 → HTTPS)。

---

## 6. 与 DESIGN.md 的关系

- DESIGN §10 第 4 项"HTTPS + fingerprint TOFU 校验"= 本文档,实现后标记完成。
- DESIGN §1.1 / §6 多处"HTTP 明文""fingerprint = 随机串"的表述,实现后需回同步为 https 版本。
- DESIGN §5.1 挂起超时模型、§7 IP 绑定等**不变量全部保留**,HTTPS 只在传输层加 TLS,不动会话状态机/挂起模型/单会话 409。
- README/DESIGN "HTTP 明文"安全提醒 → 改为 **§4.1 的诚实表述**("HTTPS 加密防被动窃听;不防同网段主动冒充,请在可信局域网使用"),**不可**简写成"HTTPS 加密 + 指纹 pinning(安全)"给虚假安全感(B2)。

---

## 附:调研来源

- **协议规范**:github.com/localsend/protocol(main,v2.1)
- **官方 App 源码**:github.com/localsend/localsend(main @b43b795,2026-07-14)—— security_helper.dart、persistence_provider.dart、server_provider.dart、packages/core/src/crypto/cert.rs、packages/core/src/http/client/mod.rs 等
- **Node/Electron**:nodejs.org/api/{tls,https,crypto}.html、Fastify HTTPS 文档、electron.org session docs、electron#8656
- **selfsigned**:github.com/jfromaniello/selfsigned

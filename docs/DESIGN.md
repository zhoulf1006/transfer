# Transfer — 设计文档

> 跨平台(macOS / Windows)的局域网工具:文件传送 + 截屏标注 + 笔记,三者打通。
> 技术栈:Electron + TypeScript。局域网直连,无服务器、无账号。

---

## 0. 决策速览(已与用户确认)

| 维度 | 决策 | 备注 |
|------|------|------|
| 平台 | macOS + Windows | Electron 跨平台 |
| 技术栈 | Electron + TypeScript + pnpm | |
| 连接 | 局域网直连 | 无服务器/账号 |
| **发现机制** | **UDP 多播,严格照 LocalSend 协议 v2** | `224.0.0.167:53317`,未来可与 LocalSend App 互通 |
| **传输加密** | **先 HTTP**(明文) | LocalSend 支持 http 模式;HTTPS 留待后续 |
| **接收确认** | **弹框确认** | 收到 prepare-upload 时本机弹框,用户点了才收 |
| 笔记存储 | 本地 Markdown 文件 | |
| 截屏 | 区域/全屏/窗口 + 标注;滚动长图后续 | 需自实现选区、裁剪、拼接 |
| **MVP** | **文件传送优先** | 两台设备互相发现 + 传文件/文本 |

---

## 1. 需求调研结论(带来源,区分「确认」与「推断」)

### 1.1 LocalSend 协议 v2(来源:github.com/localsend/protocol,main 分支 README)

**发现机制(确认):**
- UDP **多播**,地址 `224.0.0.167`,端口 `53317`(UDP 多播端口 = TCP 服务端口,同值)。
- 多播 announcement 报文(JSON):
  ```json
  {
    "alias": "Nice Orange", "version": "2.0", "deviceModel": "Windows",
    "deviceType": "desktop", "fingerprint": "random string",
    "port": 53317, "protocol": "http", "download": true, "announce": true
  }
  ```
- `announce: true` = 主动广播;收到后对方应回应,回应方式二选一:
  1. 回一个 `announce: false` 的 UDP 报文(同字段),或
  2. 向对方 `POST /api/localsend/v2/register`。
- Fallback:多播不可用时,HTTP POST `/api/localsend/v2/register` 到局域网各 IP。

**传输握手(确认),端点前缀 `/api/localsend/v2/`:**
1. `POST prepare-upload` — body = `{ info, files }`。`files` 是 `fileId -> 文件元数据` 的 map。
   - 响应 200(**推断**:协议 README 未显式声明 200,只列了 204/4xx/5xx,成功码属隐含):`{ sessionId, files: { fileId -> token } }`
   - 状态码语义:204 无需传 / 400 body 非法 / 401 PIN required or Invalid PIN / **403 Rejected(用户拒绝)** / 409 已有会话占用 / 429 频繁 / 500 未知错误。
   - **协议未规定超时/连接生命周期(确认)**:README 对 prepare-upload 的响应是否同步、server 可挂起多久、sender 等多久,**只字未提**。见 §5.1 超时契约。
2. `POST upload?sessionId=&fileId=&token=` — body = **文件原始二进制(确认原文:"Request: Binary data")**,**不是 multipart/form-data**,参数走 query。**此端点协议明确"可并行调用"(确认原文:"This route can be called in parallel")**,发送方可对不同 fileId 同时发起多个 upload。
   - 403 = **"Invalid token or IP address"(确认原文)** —— 协议要求 upload 同时校验 token **和来源 IP**。
3. `POST cancel?sessionId=` — 取消会话。发送方可中途调用。

**部分接受(确认,原文 "accepted, partially accepted or rejected"):** 接收方对 `prepare-upload` 可**部分接受**——响应 `files` map **只放被接受文件的 token**,省略的文件即视为拒绝。因此接收方的"待收 fileId 集合" = **响应里返回了 token 的那批**,而非请求 `files` 里的全集(见 §5 状态机)。MVP 弹框可先做"全接受/全拒绝",但状态机与校验必须按"接受集合"实现,为部分接受留出正确语义。

**设备信息字段(确认):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `alias` | string | 显示名 |
| `version` | string | 协议版本,报文里填 `"2.0"` |
| `deviceModel` | string?/null | 如 "Windows"/"macOS" |
| `deviceType` | enum? | mobile\|desktop\|web\|headless\|server |
| `fingerprint` | string | HTTP 模式下为**随机串**(防自发现);HTTPS 下为证书 SHA-256 |
| `port` | number | 默认 53317 |
| `protocol` | string | "http" \| "https" |
| `download` | bool? | 是否支持反向下载 |
| `announce` | bool | 仅 UDP 报文:true=广播,false=响应 |

- 注意:`/register` 响应体 与 `/prepare-download` 的 info 里**省略** `port`/`protocol`(已从连接得知);多播 announce 与 `prepare-upload` 的 info 里**包含**。
- 文件元数据字段:`id, fileName, size, fileType`(必需);`sha256, preview, metadata.modified/accessed`(可选,接收方须容忍缺失)。

**版本歧义(确认+推断):** README 标题为 v2.1,但报文 `version` 字段示例值均为 `"2.0"`。实现时报文 `version` 填 `"2.0"`。

### 1.2 Electron 能力(来源:electronjs.org 官方文档,基准 Electron v43)

**截屏(确认):**
- `desktopCapturer.getSources({ types:['screen','window'] })` 返回屏幕/窗口源。**Electron 17+ 只能在主进程调用**。
- thumbnail 默认 150×150,实际尺寸不保证等于 thumbnailSize(受 scaleFactor 影响)。
- 拿全分辨率(推断/社区经验):把 `screen.getPrimaryDisplay().size` 作为 `thumbnailSize`,高 DPI 需 `size × scaleFactor` 取物理像素。
- **区域截图(推断):** Electron 无原生 API。做法:全屏截图 → `nativeImage.crop()` 裁剪;选区 UI 用透明全屏窗口自实现。
- **滚动长截图(确认):** Electron 不支持,必须自实现(自动滚动 + 逐帧 + 拼接)。
- **macOS 屏幕录制权限(确认):** 需用户授权;`systemPreferences.getMediaAccessStatus('screen')` 检测;**不能弹窗请求**,只能引导去系统设置手动开,授权后常需重启 App。已知 bug:授权后状态有时不刷新。
- **Windows(推断):** 截屏无特殊系统权限。

**全局快捷键(确认):** 用 `CommandOrControl`(跨平台);`register()` 静默失败,**必须检查返回值**;macOS 可能需 Accessibility 权限;`app.whenReady()` 后注册,退出前 `unregisterAll()`。

### 1.3 库选型(来源:npm registry)

| 用途 | 选型 | 版本 | 理由 |
|---|---|---|---|
| UDP 多播 | **Node 内置 `dgram`** | — | LocalSend 是原生 UDP 多播,非 mDNS。自己写(不复杂),不引 mDNS 库 |
| HTTP server | **Fastify**(裸流,不用 multipart) | 最新 | `upload` 是裸二进制,用 `addContentTypeParser` 交出 `request.raw` pipe 落盘 |
| HTTP client | Node 内置 `http` / `fetch` | — | 发文件用 |

> **重要修正 1(发现层):** 调研初期考虑过 `bonjour-service`(mDNS),但 LocalSend 用的是**原生 UDP 多播**,不是 mDNS/DNS-SD。既然选了「严格照 LocalSend 协议」,发现层用 `dgram` 自己实现,**不引入 mDNS 库**。
>
> **重要修正 2(传输层,四层 review 事实层发现):** 原设计写用 `@fastify/multipart` 接收文件是**错的**——`upload` body 是**裸二进制**(`application/octet-stream`,确认),不是 multipart/form-data。正确姿势(Fastify 官方确认):对该 content-type 注册一个 `done()` 不解析的 `addContentTypeParser`,把 `request.raw`(Node 可读流)直接 `pipe` 到 `.part` 写流,避免整文件入内存。**不使用 @fastify/multipart。**

### 1.4 运行层事实(四层 review 坐实,均文档确认)

| 事实 | 结论 | 对实现的影响 |
|---|---|---|
| 多播 loopback | `IP_MULTICAST_LOOP` **默认开启**,本机(含同机另一实例)会收到自己的广告 | 防自发现**必须做**,用**应用层 fingerprint 过滤**(`setMulticastLoopback(false)` 只管本 socket,防不住同机另一进程) |
| 双实例监听 53317 | 必须 `dgram.createSocket({type:'udp4', reuseAddr:true})`,否则第二实例 `EADDRINUSE`;加了之后**两实例都能收到多播** | §9 双实例验收依赖此项;接收 socket 固定开 `reuseAddr` |
| `fs.rename` 跨盘 | 跨挂载点/盘符 rename 抛 **`EXDEV`** | `.part` **必须与最终文件同目录**(同盘),写完同目录内 rename(原子);**不可**放系统 temp 再 rename 到用户目录 |
| Fastify `bodyLimit` | 默认 **1 MiB**,超限 `FST_ERR_CTP_BODY_TOO_LARGE` | 走 `request.raw` pipe 天然绕过;仍在该路由显式设大 `bodyLimit` 兜底 |
| 多播接收 | 必须 `bind(53317)` + `addMembership('224.0.0.167'[, iface])` 才收得到 | 缺一收不到发现包 |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                     Electron App                          │
│                                                           │
│  ┌──────────────────┐        IPC        ┌──────────────┐ │
│  │   Main Process   │◄─────────────────►│   Renderer   │ │
│  │                  │                   │  (UI, React?) │ │
│  │  ┌────────────┐  │                   │              │ │
│  │  │ Discovery  │  │  UDP 多播          └──────────────┘ │
│  │  │ (dgram)    │◄─┼──── 224.0.0.167:53317 ──► 局域网  │
│  │  └────────────┘  │                                    │
│  │  ┌────────────┐  │  HTTP :53317                       │
│  │  │ HTTP Server│◄─┼──── prepare-upload/upload ──► 局域网│
│  │  │ (Fastify)  │  │                                    │
│  │  └────────────┘  │                                    │
│  │  ┌────────────┐  │                                    │
│  │  │ HTTP Client│──┼──── 发文件给对端 ──────────► 局域网 │
│  │  └────────────┘  │                                    │
│  └──────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

**进程职责:**
- **主进程**:所有网络能力(UDP 发现、HTTP server/client)、文件读写、系统能力(截屏、快捷键、权限)。这些都需要 Node/系统权限,必须在主进程。
- **渲染进程**:UI —— 设备列表、传输进度、接收弹框、笔记、截屏标注。通过 IPC 与主进程通信。
- **preload**:用 `contextBridge` 暴露受限 IPC API(`contextIsolation: true`,不开 `nodeIntegration`)。

---

## 3. 模块划分(MVP 聚焦文件传送)

> 实际落地结构(与初版设计略有调整:`types.ts`/`ipc.ts` 归入 `shared/` 供三端共用;
> 新增 `app-core.ts` 装配层与 `receive-file.ts` 落盘模块)。

```
src/
  main/
    index.ts              # Electron 生命周期 + IPC 注册 + dialog 弹框 + env 覆盖
    app-core.ts           # 装配:发现层+传输层+身份(与 Electron 解耦,可 e2e 测)
    device-identity.ts    # 本机 alias/fingerprint 持久化(userData/identity.json)
    discovery/
      multicast.ts        # UDP 多播:announce / 监听 / 响应 / fingerprint 防自发现
      device-registry.ts  # 已发现设备的内存表(带过期,注入 now)
    transfer/
      http-server.ts      # Fastify:/register /prepare-upload /upload /cancel /info
                          #   upload 用 addContentTypeParser(done()) + pipe request.raw,不用 multipart
      http-client.ts      # 主动发送:prepare-upload -> 并行 upload(裸二进制 body)
      session.ts          # 会话状态机(见 §5,注入 now,可单测)
      receive-file.ts     # 落盘:O_EXCL 原子占位去重 + 同目录 .part→rename + sha256
  preload/
    index.ts              # contextBridge 暴露 API(输出 CJS index.cjs)
  renderer/
    src/                  # React UI:身份/设备列表/选文件/发送/活动日志
  shared/                 # 三端共用
    protocol.ts           # 协议常量(端口、多播地址、版本、端点、超时)
    types.ts              # 协议 DTO(DeviceInfo, FileMeta, ...)
    ipc.ts                # IPC channel 常量 + payload 类型
    identity.ts           # 身份/token/sessionId 生成 + platformToModel + buildDeviceInfo
    safe-name.ts          # sanitizeFileName(路径逃逸防护)
```

---

## 4. 协议常量(shared/protocol.ts)

```ts
export const MULTICAST_ADDR = '224.0.0.167'
export const DEFAULT_PORT = 53317
export const PROTOCOL_VERSION = '2.0'          // 报文 version 字段
export const API_PREFIX = '/api/localsend/v2'
export const EP = {
  register:       `${API_PREFIX}/register`,
  info:           `${API_PREFIX}/info`,
  prepareUpload:  `${API_PREFIX}/prepare-upload`,
  upload:         `${API_PREFIX}/upload`,
  cancel:         `${API_PREFIX}/cancel`,
}

// 超时常量(见 §5.1 契约:T_SENDER ≥ T_DIALOG + 余量)
export const T_DIALOG_MS = 30_000        // 接收方弹框超时
export const T_SENDER_MS = 45_000        // 发送方 prepare-upload 超时
export const T_IDLE_MS   = 30_000        // 传输空闲超时(任一 upload 有字节即 reset)
export const T_UPLOAD_MS = 5 * 60_000    // 单个 upload 超时(S4:防接收方挂起)
```

---

## 5. 会话状态机(接收方,transfer/session.ts)

接收方在 `prepare-upload` 到达时创建会话。因为选了**弹框确认**,流程为:

```
                 prepare-upload 到达 (记录 sender IP + fingerprint)
                        │
                        ▼
        ┌────────────────────────────────────────┐
   已有会话? ── 是 ──► 同 IP+同 fingerprint?
        │                   │           │
        │ 否            是(重试,H3)   否(别的设备)
        │                   │           │
        │                   ▼           ▼
        │          丢弃旧 PENDING     返回 409 Blocked
        │          关旧弹框，用新的
        │                   │
        ▼                   ▼
     创建 PENDING 会话,弹框问用户
                        │
        ┌───────────────┼───────────────┐
   用户拒绝           用户接受          超时(弹框超时 T_dialog)
        │           (可部分接受)         │
        ▼               ▼               ▼
   返回 403      为**接受的文件**生成    返回 403 + 清理
   清理          token,登记为待收集合
                (拒绝的文件不返回 token)
                生成 sessionId,进入 ACTIVE
                返回 200 {sessionId, files:接受集合}
                        │
                        ▼  (ACTIVE:接受 upload,可并行)
              upload(校验 sessionId+fileId+token+来源IP)
              每成功一个 → 从待收集合移除 + reset 空闲计时器
                        │
        ┌───────────────┼───────────────┬──────────────┐
   待收集合清空     收到 cancel      空闲超时        upload 失败
        │               │               │           (落盘错误)
        ▼               ▼               ▼               ▼
   完成,清理    停止+删.part+清会话  清理+删.part  500+删该.part
                  +通知UI(S3)        +通知UI     +清会话(S1,onUploadFailed)
```

**落盘中文件与 cancel 的竞态(S3,实现坐实):** upload 落盘是 `await`,期间可能被 cancel 清掉会话。落盘完成后调 `markReceived` 会校验 sessionId,会话已不在则返回 `stillActive:false`,**不再触发 `onFileDone`**(避免 cancel 后误报完成)。但**已 `rename` 落盘的文件 cancel 无法删除**(不在 `.part` 之列)——此为已知限制,完整"cancel 删除已完成文件"留待后续。

### 5.1 超时契约(B1,必须遵守)

协议**未规定** prepare-upload 的超时/连接生命周期。本设计用「挂起 HTTP 响应等弹框」模型,其正确性**依赖**:

> **发送方 HTTP client 对 prepare-upload 的超时 `T_sender` ≥ 接收方弹框超时 `T_dialog` + 余量。**
> MVP 取 `T_dialog = 30s`,`T_sender = 45s`(常量 `T_DIALOG_MS` / `T_SENDER_MS`,`protocol.ts`)。
> upload 阶段另有独立超时 `T_UPLOAD_MS`(5min,S4:防接收方异常挂起时发送方 `Promise.all` 永挂)。

- 因为 MVP 是**自己发自己收**,两端超时都由我们控制,契约可满足。
- **与第三方真实 LocalSend App 互通时此模型不成立**:真实 App(Flutter/dio)默认秒级超时,会在用户点弹框前就断开,表现为"发不过去"。故 §0 "未来可与 LocalSend App 互通"的承诺,**在挂起模型下不成立**,需在 §10 用「先返回占位 + 异步确认」方案替代。已移入 §10。
- **用户点接受但 `T_sender` 已到、socket 已断的清理(P1,实现坐实)**:此时不能靠"resolve 200 写入已断 socket 会失败"来捕获——**实测:向已关闭连接 `reply.send` 是 no-op,不抛错**。正确做法是在 `respond` 推进 ACTIVE 后、send 之前**主动预检连接是否已断**,已断则 `onCancel` 回滚会话、不 send。
  - **可靠判据(均实测坐实,`http-server.ts`)**:断开信号是 `req.raw.socket.destroyed`(或 `req.raw.aborted`)。
  - **不可用的判据(会误判)**:`req.raw.destroyed`——请求 body 读完后正常也为 true;`reply.raw.writable`——客户端 abort 后它**仍为 true**,是误导信号。

**关键不变量:**
- **单会话**:同一时刻只允许一个 PENDING/ACTIVE 会话;不同设备的第二个 `prepare-upload` 返回 409;**同 IP+同 fingerprint 的重试则覆盖旧 PENDING**(H3,避免发送方被自己的 409 卡到弹框超时)。
- **待收集合 = 接受集合**(①-b/③-a):待收 fileId 集合 = prepare-upload 响应里**返回了 token 的那批**(接受的),**非请求 files 全集**。对被拒绝(未返回 token)的 fileId 发来的 upload → 403。
- **upload 可并行**(协议确认):"完成"判据 = **待收 fileId 集合清空**,不假设串行;任一 upload 有字节进来即 reset 空闲计时器。
- **IP 绑定**(B3,协议 403 明确含 IP):upload 的 `remoteAddress` 必须等于创建会话时 prepare-upload 的来源 IP,否则 403。
- **状态门控**(H1):合法 upload 只在 **ACTIVE** 状态被接受;PENDING(尚未生成 token)期间到达的任何 upload → 403。
- upload 必须校验 `sessionId + fileId + token + 来源IP` 全部匹配,且 fileId ∈ 本会话**接受集合**,否则 403;重复 upload 同一已收 fileId → 幂等忽略或 409(MVP:忽略,不重复落盘)。
- 所有会话均有超时(弹框 `T_dialog`、传输空闲 `T_idle`),到期清理并删除 `.part`,防泄漏。

---

## 6. 本机身份(device-identity.ts)

- 首次启动生成并持久化(userData 目录):
  - `alias`:默认取机器名或随机生成(如 "Loong's Mac"),用户可改。
  - `fingerprint`:HTTP 模式下为**随机字符串**(如 UUID/32字节 hex),持久化保持稳定。
  - `deviceType`:固定 `"desktop"`。
  - `deviceModel`:`process.platform` 映射("darwin"→"macOS","win32"→"Windows")。
- fingerprint 用于**防止发现到自己**:收到多播 announce **或** `/register` 请求时,若对端 fingerprint == 本机,忽略(H4:两条发现入口都要做此比对,不只多播)。
- **为何同机也必需(②-a 事实层):** 多播 `IP_MULTICAST_LOOP` **默认开启**,本机会收到自己发的广告,同机另一实例也会收到——所以防自发现必须在应用层用 fingerprint 过滤;`setMulticastLoopback(false)` 只关本 socket 的回环,防不住同机另一进程,不能替代 fingerprint 过滤。
- **多实例同机测试注意(M4)**:fingerprint 持久化在 userData,同机两实例默认共享 userData → 同 fingerprint → 互判为"自己"而互相隐藏。测试多实例时必须用**不同 userData 目录 / 不同 fingerprint**(通过 env 覆盖,见 §9 验收前置)。

---

## 7. 边界情况与失败模式(前置到纸面)

| 场景 | 处理 |
|------|------|
| 收到自己的多播广播 **或 /register** | 用 fingerprint 比对,等于本机则忽略(两条入口都做,H4) |
| 多播不可用(路由器屏蔽多播) | 保留 `/register` HTTP fallback;MVP 至少保证多播路径,fallback 可迭代 |
| 端口 53317 被占用(TCP) | **已实现**:`listenWithFallback` 捕获 EADDRINUSE,HTTP 端口向上回退 53317→53318→…(最多 20 次),`actualHttpPort` 记录实际端口;**UDP 多播仍固定监听 53317**(否则收不到别人广播),`announce.port`/`selfInfo.port` 取实际 HTTP 端口 —— 两者可不同(M5)。常见触发:本机已有真正的 LocalSend App(同用 53317)或残留 Transfer 实例。**已用 Fastify 实测坐实:listen 失败后同 server 实例可复用再 listen** |
| `AppCore.start()` 中途失败 | try/catch 回滚已 listen 的 HTTP server + socket + 定时器(S6);`stop()` 幂等(置 null 防重复 close)|
| 多网卡 / 代理隧道(已修复) | **真实 bug**:有代理软件(Clash/Surge)时机器有隧道接口(utun 上 198.18.x / CGNAT 100.64.x),dgram `addMembership` 不指定接口时 OS 可能把多播加到隧道接口,导致局域网互相发现不了(用户实测:mac 有 utun4 198.18.0.1 抢走了多播)。**修复**:`pickAllLanInterfaces` 挑出所有真实局域网接口(排除隧道段),在**每个**接口上 `addMembership`,`announce` 也遍历每个接口发送(不赌单一接口,兼容 VM/WSL 网卡与真实 WiFi 撞私有网段)。任一接口失败退回 OS 默认。`pick-interface.ts` + 10 个单元测覆盖 |
| 同机双实例收多播(②-b) | 接收 socket 必须 `reuseAddr:true` 否则第二实例 EADDRINUSE;开了之后两实例都收到,再靠 fingerprint 各自过滤自己 |
| `.part` rename 跨盘(②-c) | `.part` **必须与最终文件同目录**(同盘),同目录内 rename(原子);不可放系统 temp 再跨盘 rename(EXDEV) |
| 大文件超 Fastify bodyLimit(②-d) | upload 路由用 `addContentTypeParser(done())` + pipe `request.raw` 天然绕过 1MiB 默认;并显式设大 bodyLimit 兜底 |
| prepare-upload 弹框未响应 | 弹框超时 `T_dialog=30s` 自动返回 403,清理 pending 会话(见 §5.1 超时契约) |
| 用户接受但发送方已超时断开(B1/P1) | respond 后 send 前**预检 `req.raw.socket.destroyed`**,已断则 `onCancel` 回滚会话不 send。**注意:send 到已断 socket 是 no-op 不抛错,不能靠捕获失败**(见 §5.1) |
| 弹框期间又来一个 prepare-upload | 别的设备→409;**同 IP+fingerprint 的重试→覆盖旧 PENDING**(H3) |
| PENDING 期间收到 upload(H1) | 尚无有效 token → 403 |
| upload token / IP / fileId 不匹配 | 返回 403(IP 校验来自协议 403 "Invalid token or IP address") |
| upload 可并行(多文件同时到) | 按 fileId 集合独立处理,各写各的 .part,完成才计入待收集合(B2) |
| 重复 upload 同一已收 fileId | 幂等忽略,不重复落盘 |
| 发送方中途 `POST cancel` | 停止接收、删除该会话 .part、清 session、通知本地 UI(H2)。**已 `rename` 落盘的文件删不掉**(S3 已知限制,留后续) |
| upload 中途连接断开 | 会话空闲超时 `T_idle` 清理;部分文件写 `.part` 临时名,完成才 rename |
| **磁盘写满 / 写入 ENOSPC**(H2) | 落盘失败 → `cleanup` 删 .part+占位、upload 返回 500、`onUploadFailed` 清会话;**聊天层(③-C)`onFileFailed(fileId, reason)` 把对应 recv 消息按 fileId 精确转 `failed`**(sha256 不符归 sha256,其余归 enospc),不留"已接收"假象。其他文件不受影响。**已实现** |
| **接收目录不存在/无写权限**(H2) | 设计意图:prepare-upload 阶段预检目录可写。**⚠️ MVP 未实现**——接收目录固定为 Downloads(几乎总可写),且落盘失败有 500+cleanup 兜底。预检留待后续(接收目录可配后再做) |
| 大文件内存 | pipe `request.raw` 流式落盘(不用 multipart、不整块读入内存) |
| 文件名注入(../、绝对路径) | 接收时 sanitize fileName,只取 basename,落到指定接收目录内 |
| 重名文件 | **`O_EXCL(wx)` 原子占位**去重(name (1).png…);**不可用 existsSync 判重**——并发同名会 TOCTOU 覆盖丢数据(S2) |
| 发送方对端拒绝(403) | 客户端向用户报告"对方拒绝" |
| macOS 首次多播 | 可能触发 Local Network 权限弹窗(需真机验证) |
| 应用退出 | 关闭 dgram socket、HTTP server,清理所有会话与临时 .part 文件;**遍历挂起 resolver Map 全部 reject(→403)+ 清 timer,DB 里 pending 消息标 expired**(否则发送方等 30 天超时,§11.2.2);关闭 SQLite。**④-C:Electron 不 await `before-quit` 的 async 回调,故 `preventDefault()`+ 完成清理后手动 `app.quit()`,保证清理真执行** |

**MVP 明确不做(但表态,不沉默):**
- **token 重放**:同 token 二次 upload 已收 fileId → 幂等忽略(见上);跨会话 token 因 sessionId+IP 绑定而失效。不额外做一次性 token。
- **多播报文伪造 / 放大攻击**:发现层 DoS,MVP 不处理。
- **IPv6**:`224.0.0.167` 为 IPv4 多播,**MVP 仅 IPv4**;IPv6 留待后续。

**安全提醒(MVP HTTP 明文):** 局域网明文传输,任何同网设备可发现并尝试发送。弹框确认是第一道防线。后续可加 PIN / HTTPS。

---

## 8. IPC 接口(MVP)

> 所有传输相关事件/调用都带 `transferId`(本地生成,区别于协议 sessionId),以精确关联挂起模型下的 incoming/progress/done(M2)。

主 → 渲染(事件,**均已实现**):
- `devices:updated` — 设备列表变化(发现/过期)
- `transfer:incoming` — `{ transferId, fromAlias, files[] }`,请求用户确认(**仅用于 UI 展示日志**;实际确认走主进程原生 dialog,见下)
- `transfer:progress` — `{ transferId, direction: 'send'|'recv', fileName }`(带 direction,UI 才能区分方向)
- `transfer:done` / `transfer:error` — `{ transferId, ... }`

渲染 → 主(调用):
- `transfer:send`(`SendArgs`)— 发送文件到某设备 → 返回 `{ok, message?}`。**已实现**
- `device:getIdentity` / `device:setAlias` — **已实现**
- `settings:getReceiveDir` — **已实现**(返回 Downloads)
- `devices:list` — 拉取当前设备列表。**已实现**
- `dialog:pickFiles` — 打开文件选择框返回路径列表。**已实现**(实现新增,原 §8 未列)

**实现与原设计的偏离(如实记录):**
- **接收确认改为主进程原生 `dialog.showMessageBox`**,不经渲染层。故 `transfer:respond` 定义在 `CMD` 里但**未注册**——`askUser` 在主进程内直接弹 dialog + `Promise.race` 超时(`index.ts`)。原 §8 的"渲染层 respond 回应弹框"未采用。
- **`transfer:cancel` 定义了但 MVP 未实现**(用户主动中止 UI 未接线);发送方 cancel 能力在 `AppCore.cancelTo` / `http-client.cancelSession` 已具备,只是没接到 UI。留后续。
- **`settings:setReceiveDir` 未实现**(接收目录固定 Downloads;可配留后续)。

---

## 9. MVP 验收标准(可验证)

**前置(M4):** 多实例测试用不同 userData / 不同 fingerprint(env 覆盖);两实例不同 TCP 端口时,断言对方**按 announce 的 port** 连接。

1. 两个实例(不同 userData/fingerprint/端口)启动后,**互相出现在对方设备列表**;各自不出现在自己列表(fingerprint 防自发现)。
2. A 选一个文件发给 B,B **弹框**显示"来自 A 的 X 文件,是否接收"。
3. B 点接受 → 文件**完整落盘**,进度条走完;**发送方主动计算并携带 sha256,接收方校验一致**(M3:不留"若提供"空分支,完整性必须被覆盖)。
4. **多文件(≥2)**一次发送,**并行 upload**,全部完整落盘(B2 并发路径)。
5. B 点拒绝 → A 收到"对方拒绝"(403),B 不产生文件(含 .part)。
6. **传输中途 cancel**:发送方或接收方触发 cancel → 停止、删除 .part、两端 UI 收到通知(H2)。
7. **并发会话**:A 传输中,C 再发 prepare-upload → C 收到 **409**;A 的传输不受影响(单会话不变量)。
8. **IP 绑定**:伪造/换 IP 的 upload(带正确 token 但来源 IP 不符)→ 403(B3)。
9. 文件名含 `../` 等被 sanitize,不逃逸接收目录。
10. 退出 App 后无残留 socket / .part 临时文件。

**测试方式:** 单元测(协议编解码、fileName sanitize、会话状态机含并行/IP/PENDING门控、fingerprint 防自发现、sha256 校验)+ 集成测(起两个实例走完整收发,断言落盘字节一致;覆盖多文件并发、cancel、409、超时契约)。

---

## 10. 迭代路线(MVP 之后)

1. **与真实 LocalSend App 互通(B1 替代方案)**:挂起 prepare-upload 等弹框的模型对第三方 App 秒级超时不成立。互通需改为「prepare-upload **立即返回**占位/待定,用户确认异步进行」的方案(或参考 LocalSend App 实际的默认接受/快速拒绝行为)。在实现互通前,§0 的互通承诺仅在自家两端(可控超时)成立。
2. 文本/剪贴板传送(prepare-upload 里 fileType=text 或专门端点)
3. `/register` HTTP fallback 发现 + IPv6 支持
4. HTTPS + fingerprint TOFU 校验
5. 截屏(区域 → 全屏/窗口 → 标注 → 滚动长图)
6. 笔记(Markdown 本地文件 + 搜索)
7. 打通:截屏 → 标注 → 一键发送到某设备 / 存入笔记
8. PIN 保护(401 语义)、传输历史、断点续传

---

## 11. 聊天 UI(混合聊天流 + 本地历史 + 异步确认)

> 第二阶段功能。把文件传送升级为"聊天窗口"式:文本+文件统一为消息气泡流,本地持久化历史,接收改为异步(不阻塞 prepare-upload)。

### 11.0 决策(已与用户确认)

| 维度 | 决策 |
|------|------|
| UI 形式 | 混合聊天流:文本 + 文件都是气泡,`deviceId===本机` 靠右、否则靠左 |
| 文本传送 | fileType=text 的"文件",正文放 `preview` 字段,**只走 prepare-upload,不走 upload**(LocalSend 源码确认) |
| 持久化 | **node:sqlite**(Electron 35 内置,Node 22.16,零原生依赖;Electron 33=Node20 无此模块,故升级到 35) |
| 接收模型 | 可配置自动接收:开关 + 大小阈值。默认**关**(全部弹确认);开启后 `size ≤ 阈值` 自动收,消息类**永不自动接收**(LocalSend 同) |
| 确认方式 | 流内确认:文件作为消息气泡带"接收/拒绝"按钮;不阻塞——见 §11.2 |
| 文件落地 | 自动存下载目录,聊天里点开(shell.openPath) |

### 11.1 事实层(真实源码坐实,来源见调研)

LocalSend `github.com/localsend/localsend` main 分支源码确认:
- **发送方超时 = 30 天**(`http_provider.dart`:`longLiving = Duration(days:30)`)。故意为容忍慢确认 → "聊天流内异步确认、用户过很久才点"**协议兼容**,无需真挂起,只要最终按状态码回应。
- **prepare-upload 需确认时同步挂起**(`receive_controller.dart` L345 `await streamController.stream.first`),accept→200+token map,decline→403,空选/消息已读→204。
- **文本消息**:`selected_sending_files_provider.dart` 造 `name=uuid.txt, fileType=text, size=utf8 长度`;`send_provider.dart` L85 `preview = utf8.decode(bytes)`(正文进 preview);接收方识别 `files.length==1 && fileType==text` → 取 preview 为正文,accept 时 `acceptFileRequest({})` 空 map → 返回 **204,不发起 upload**。
- **quickSave 默认 false**,消息类永不 quickSave(`receive_controller.dart` L262 `quickSave && session.message==null`)。
- **单会话 409**:一次只允许一个活跃 session,第二个 prepare-upload→409;真 LocalSend 发送方收 409 会放弃(`recipientBusy`)。排队等确认放应用层。

### 11.2 传输模型改造:异步确认(替代原挂起弹框)

原模型(§5.1):prepare-upload 挂起 Promise 等 dialog,30s 超时。**问题**:聊天流里用户可能几分钟才点,30s 太短。

**新模型**:
- prepare-upload 到达 → 建 PENDING 会话 → **发 IPC `transfer:incoming` 让聊天流插入一条"待确认"文件消息气泡** → **仍挂起 HTTP 响应**(Promise),但超时放宽到 `T_ACCEPT_MS`(5 分钟)。
- **自动接收**:若开启且 `size ≤ 阈值` 且非消息类 → 不插确认气泡,直接 respond accept。
- 用户在聊天流点"接收"→ IPC → resolve accept(200+token);点"拒绝"→ resolve reject(403);超时→ 403 + 气泡标记"已过期"。

#### 11.2.1 三态 respond(P0-1/P0-2 修复,与现有 session.ts 冲突)

现有 `session.ts:respond` 把"空接受集合"当 `rejected`(→403)。但协议有**三种**语义,必须区分:

| 语义 | 响应 | session 处理 |
|------|------|------|
| 拒绝(`accept=false`) | 403 | clear 会话 |
| **接受但无文件要传**(文本消息 / 接受但选 0 文件) | **204** | **立即 clear,不进 active** |
| 接受且有文件要传 | 200 + token map | 进 active,等 upload |

改造:`RespondResult` 增加 `{ kind: 'accepted-empty' }`。`respond` 逻辑:
- `accept===false` → `rejected`(403)
- `accept===true` 但 `valid.length===0`(文本/空选)→ `accepted-empty`(204),**立即 clear()**
- `accept===true` 且 `valid.length>0` → `accepted`(200),进 active
http-server:`if (result.kind==='accepted-empty') return reply.code(204).send()`。

**文本会话生命周期(P0-2)**:文本消息 accept → `accepted-empty` → respond 内**立即 clear**,**不进 active、不建 pending 集合、不占单会话锁**。杜绝"空集合会话永挂到 idle 超时"。

#### 11.2.2 挂起 resolver 表的生命周期(P0-3)

resolve 来源从 dialog 改为 IPC `message:respond`,需一个 `Map<transferId, {resolve, timer}>`(主进程模块级):
- **建**:`onPrepareAsk` 创建 resolver + `T_ACCEPT_MS` 定时器,存入 Map,发 `transfer:incoming` IPC。
- **清**:resolve / reject / 超时**三条路径都删 key + clearTimeout**(防泄漏)。
- **重复 respond**:key 已删 → **静默忽略**(no-op),不抛错(用户连点两次接收)。
- **App 退出**:退出前遍历 Map **全部 reject(→403)+ 清 timer**,并把 DB 里对应 pending 消息标 expired(否则发送方等到 30 天超时)。补入 §7"应用退出"。

#### 11.2.3 超时统一 + 单会话 409 的流内表达(P0-4)

- **超时归属(实现坐实,②-A)**:pending 超时由 **ChatService 自管 timer**(`setTimer(T_ACCEPT_MS)`)负责——到点 `finishPending('expired')` → `resolve(false)` → http-server `respond(false)` → 会话 `clear()` + 消息标 expired。`SessionManager.sweep` 的 `dialogTimeoutMs` 默认也是 `T_ACCEPT_MS`,是**冗余的第二道兜底**(不接 ChatService,只兜底清会话);两者都存在无害(单会话下先触发者收尾,后者遇 `session===null` no-op)。**注意:实现未把 sweep 的返回值桥接到 ChatService**,闭环靠 ChatService 自管 timer 完成,不靠 sweep。
- **单会话锁最长被占 5min**(单会话不变量 ⇒ 全局至多 1 个挂起连接,资源天然可控)。但撞 409 概率因此大增:A 发文件①未确认时发文件② → B 返回 409。
- **发送方本地串行化(已实现,纯发送方本地,不动协议)**:同一 peer 的发送在 A 侧 `enqueue` **排队**(`prev.then(fn,fn)`,前一条成败都接着发)——避免自己发的第二条撞自己造成的 409。链尾 settle 后清理队列 key(④-A 防泄漏)。
- 若仍撞 409(如对方被别的设备占用):sent 消息标 `failed(busy)`,气泡显示"对方正忙"。
- **挂起 socket 中途断开**:复用 §5.1 的 `req.raw.socket.destroyed` 预检回收僵死连接。

> **保留 §5.1 的挂起机制与全部不变量**(P1 断开检测、单会话 409、IP 绑定),只改:超时 30s→`T_ACCEPT_MS`;resolve 来源 dialog→IPC;新增 `accepted-empty` 三态。

### 11.3 消息数据模型(SQLite 表 `messages`)

```
id           TEXT PRIMARY KEY   -- 本地生成
type         TEXT               -- 'text' | 'file'
direction    TEXT               -- 'sent' | 'recv'(本地记录,不靠现算——对端 fingerprint 可能变)
peer_fp      TEXT               -- 对端 fingerprint
peer_alias   TEXT               -- 对端显示名(冗余存"当时"的名字,历史不回填新 alias)
content      TEXT               -- text: 正文;file: null
file_name    TEXT               -- file: 文件名
file_size    INTEGER            -- file: 字节
file_path    TEXT               -- file: 落盘绝对路径(收到并接收后填)
status       TEXT               -- 见下方流转表
error_reason TEXT               -- failed 时的原因:'busy'|'enospc'|'sha256'|'network'|'no-file'...
transfer_id  TEXT               -- 关联挂起会话(pending 时)
created_at   INTEGER            -- ms 时间戳
```
索引:`CREATE INDEX idx_messages_created_at ON messages(created_at)`(避免全表扫描+排序)。

**direction × status 流转表(P1,钉死每条路径)**:

| direction/type | 流转 |
|---|---|
| sent / file | `pending`(发送前入库)→ prepare-upload 200 → upload 完成 `done` / 对方 403 `rejected` / 409 `failed(busy)` / 网络失败 `failed(network)` / 本地文件消失 `failed(no-file)` |
| sent / text | `pending` → prepare-upload 204 → `done`(无 upload) |
| recv / file(手动) | `pending`(收到待确认)→ 用户接受 `accepted` → 落盘成功 `done` / 失败 `failed(③-C)` / 拒绝 `rejected` / 超时 `expired` |
| recv / file(自动接收) | 入库即 `accepted`(跳过 pending,不询问)→ 落盘成功 `done` / 失败 `failed`。目录不可写则退回手动(①-A) |
| recv / text | **入库即 `done`,正文立即可见**(正文在 preview,无需等确认);向发送方回 204 让其收尾(可自动回,不阻塞正文显示) |

- **direction/status 入库时机**:sent 消息**发送前**以 `pending` 入库(崩溃也有记录),再异步更新;recv 文本入库即 `done`。
- **progress 不落库**(P1):进度高频,只走 IPC `transfer:progress` 实时推 UI,DB 只存最终 status。§11.7"进度条"指运行时 UI 状态。
- **node:sqlite 同步阻塞(P0/事实)**:全同步 API 跑在主进程事件循环。控制:①`created_at` 索引;②`message:list` 硬上限 `limit ≤ 200` + 分页;③禁止无分页全量查询。单条 insert/update 微秒级可接受,**MVP 不上 worker 线程**(单进程同步写 ⇒ 无并发写竞争,是优点)。
- **recv 文本"接收"语义澄清(P1,消除口径不一致)**:文本正文在 preview 里,入库即显示,**不需要用户点接收才可见**。"自动接收关"时对文本的唯一影响是:是否**自动回 204**(标记已读让发送方安心)——默认可自动回,文本不进"待确认"队列。**自动接收开关只约束文件,不约束文本正文的显示**。

### 11.4 模块划分(新增)

```
src/main/
  db/
    messages.ts        # node:sqlite 封装:建表、insert/update/list(纯逻辑,注入 db 路径,可用 :memory: 测)
  transfer/
    text-message.ts    # 文本↔fileType=text/preview 的编解码(纯函数,可测)
  (改)transfer/session.ts   # 超时常量 T_ACCEPT_MS;识别消息类
  (改)transfer/http-server.ts # prepare-upload 识别文本/自动接收;异步确认
  (改)index.ts         # IPC 扩展:发文本、接收/拒绝、拉历史、设置自动接收
settings.ts            # 自动接收开关+阈值(持久化,复用 identity.json 或独立)
```

### 11.5 IPC 扩展

主→渲染:`message:upserted`(某条消息状态变/新增,带完整 UiMessage;实现 channel 名,非 `messages:updated`)。另有 `devices:updated`。
渲染→主:
- `message:sendText { peerFp, text }` — 发文本
- `message:sendFiles { peerFp, filePaths }` — 发文件(替代旧 transfer:send)
- `message:respond { transferId, accept }` — 聊天流内接收/拒绝
- `message:list { limit, before }` — 拉历史(分页)
- `message:openFile { messageId }` — shell 打开已落盘文件
- `settings:getAutoAccept` / `settings:setAutoAccept { enabled, maxBytes }`

### 11.6 边界/失败(新增)

| 场景 | 处理 |
|------|------|
| 发送方文本正文过大 | MVP 文本 > 32KB 时改当普通文件传(走 upload) |
| **接收方 preview 超大**(恶意/异常发送方不遵守 32KB) | 接收方也对 preview 长度设上限(如 64KB),超限截断或拒绝,防 DB 塞巨串 + UI 卡死 |
| 自动接收阈值边界 | `size ≤ maxBytes` 自动收;**只约束文件**,文本正文永远入流显示(见 §11.3 语义澄清) |
| 收到消息类但 fileType=text 却多文件 | 不识别为消息,按普通文件处理 |
| **接收下载目录不可写**(自动接收放大此洞) | **已实现(①-A)**:自动接收前 `isReceiveDirWritable()`(`accessSync(dir, W_OK)`)预检,不可写则 `shouldAutoAcceptFiles` 返 false → **退回用户确认**(不静默自动收失败)。手动接收路径落盘失败仍有 ③-C 兜底 |
| **同一文件重复接收** | MVP **允许重复**(`O_EXCL` 各存各的 `name (1).png`),各一条气泡。不按 sha256 去重 |
| 历史 DB 损坏 | 捕获,**坏文件改名备份** `messages.db.corrupt.<ts>` 再建新库(留恢复余地,不直接覆盖) |
| pending 消息在 App 重启后 | transfer_id 失效,重启时把所有 pending 标为 expired(挂起会话已随进程消失) |
| **运行中 recv 挂起超时** | **ChatService 自管 timer**(T_ACCEPT_MS)到点 → `finishPending('expired')` → reject resolver(→403)+ 消息标 `expired` + 发 `message:upserted`(②-A:不靠 sweep) |
| 同一对端并发 prepare-upload | 保留单会话 409;**发送方本地串行化**排队(§11.2.3),撞 409 则标 `failed(busy)` 气泡显示"对方正忙" |
| 发送方本地文件 upload 前被删/改 | **⚠️ MVP 未单独实现**:读文件失败在 http-client 归到 catch-all → `failed(network)`(不区分 no-file)。消息仍会标 failed,只是 error_reason 不精确。`no-file` 枚举保留待后续细化 |
| 对端 alias 变化 | 历史气泡显示**当时**的 alias(冗余存,不回填);设备列表显示**最新** alias |

### 11.7 验收标准(聊天 UI)

1. A 发文本 → A 流里出现靠右气泡;B 流里出现靠左气泡(默认关自动接收时,B 需在流里"接收")。
2. A 发文件 → B 流里出现文件气泡带"接收/拒绝";B 点接收 → 文件落盘 + 气泡变"可打开";点拒绝 → A 气泡标"被拒绝"。
3. 开启自动接收(阈值 100MB)→ 发 5MB 文件 → B 不弹确认,直接落盘入流。
4. 关 App 重开 → 历史消息仍在(SQLite 持久化),pending 的变 expired。
5. 文本消息只走 prepare-upload(不产生 upload 请求),接收方返回 204。
6. 点文件气泡"打开" → 系统打开该文件。

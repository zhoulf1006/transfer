# 发送连接短超时 + 明确报错(Send Connect Timeout & Clear Errors)

> 方案演进:最初设计为"发送前独立预探测(GET /info)",review 时发现**不该每条消息都探测**
> (正常场景白白多一次往返,且没治病根)。改为**给发送路径的建连本身加短超时 + 错误分类**——
> 更聚焦病根、正常发送零额外开销。下文为最终方案。

## 背景 / 动机

发消息走 HTTPS 直连对端 LAN IP(`http-client.ts` `pinnedAgent` 的 `tls.connect({host: target.address})`)。
当对端开了 **F5 BIG-IP Edge Client(Full Tunnel VPN)** 时,到局域网 IP 的流量被
灌进隧道虚拟网卡(`route get 对端IP` → `interface: utun5`),SYN 黑洞。

现状病灶(调研坐实):
- `pinnedAgent` 的 `tls.connect`(http-client.ts:63)**无连接超时**,socket 未 setTimeout。
- 唯一超时是请求级 `T_SENDER_MS = 6min`(http-client.ts:131)。
- 于是用户点发送后,连不上要**静默等 6 分钟**才显示"失败"。
- UI 只有 `busy`/else 两分支(App.tsx:1067-1068),所有网络失败都显示笼统"失败";
  http-client 返回的 `{kind:'error', message}` 里的原始错误串被 ChatService 丢弃
  (只取 `res.kind` 映射,chat-service.ts:301/344)。

**目标**:给发送建连加短超时,连不上时**快速失败(几秒)+ 明确文案**,区分超时/拒连/指纹不符。

**非目标**:本改动**不"防"F5 劫持**(路由抢占在对端内核层,用户态无解)。只改善失败体验。

## 方案(最终)

### 核心:给 `pinnedAgent` 的建连加连接级短超时

在自定义 `createConnection`(http-client.ts:62-85)里:
- 新增 `T_CONNECT_MS = 10000`(protocol.ts)。
- `tls.connect` 后立即 `socket.setTimeout(T_CONNECT_MS)`,监听 `'timeout'` →
  `socket.destroy(err)` 并回 `cb(errWithCode('ETIMEDOUT'))`。
- **成功握手 + 指纹校验通过后(cb(null,socket) 之前),`socket.setTimeout(0)` 清掉超时**。
  ⚠️ **回归红线**:不清掉的话,大文件上传的空闲期会被 10s 超时误杀。connect timeout
  只管"建连到握手完成"这段,握手后交还给请求级 T_UPLOAD_MS / T_SENDER_MS。

### 错误分类:让 SendResult 带 reason

现有 `SendResult`/`SendTextResult` 的 `error` 分支只有 `{kind:'error', message}`。
在建连失败时给 error 附一个可判别的 `code`,让 ChatService 能映射到细分 errorReason。

做法(最小侵入):不改 SendResult 结构,而是在 `pinnedAgent` destroy 时抛**带 `code` 的 Error**:
- 连接超时 → `err.code = 'ETIMEDOUT'`
- 指纹不符 / 无 peer cert / 无指纹 → `err.code = 'ECERT'`(自定义)
- ECONNREFUSED 由 Node 原生带 `err.code = 'ECONNREFUSED'`

ChatService 侧新增 `classifyError(message): ErrorReason`:按错误串/关键字匹配
(error 冒泡到 ChatService 时只剩 `message: string`,故用**字符串包含**匹配 code 关键词):

| 错误特征(message 含) | errorReason(新增) | UI 文案 |
|---|---|---|
| `ETIMEDOUT` / `timeout` | `timeout` | 连接超时。对方可能开了 VPN,局域网连接被隧道拦截 |
| `ECONNREFUSED` | `refused` | 对方未在监听(应用未开?) |
| `ECERT` / `fingerprint` / `certificate` | `cert-mismatch` | 证书不匹配,可能不是同一设备 |
| 其他 | `network`(现有) | 网络错误 |

> 关键:http-client 的 error message 已经带这些关键词
> (`request timeout`、`fingerprint mismatch: ...`、Node 的 `connect ECONNREFUSED ...`、
> `ETIMEDOUT`),ChatService 用字符串匹配即可,无需改 SendResult 结构。

### 需扩展的 ErrorReason 枚举

`db/messages.ts` `ErrorReason` 现为 `busy|enospc|sha256|network|no-file|unknown`。
新增:`timeout | refused | cert-mismatch`。

## 改动清单

1. **`src/shared/protocol.ts`**:新增 `T_CONNECT_MS = 10000`。
2. **`src/main/transfer/http-client.ts`** `pinnedAgent`(L53-88):
   - `tls.connect` 后 `socket.setTimeout(T_CONNECT_MS)` + `'timeout'` handler → destroy + cb(ETIMEDOUT err)。
   - 指纹校验失败的 destroy err 附 `code='ECERT'`(或 message 含 `fingerprint`,已有)。
   - **握手成功、cb(null,socket) 前 `socket.setTimeout(0)`**(清 connect 超时,回归红线)。
3. **`src/main/db/messages.ts`**:`ErrorReason` 加 `timeout | refused | cert-mismatch`。
4. **`src/main/chat-service.ts`**:
   - 新增 `classifyError(message: string): ErrorReason`(字符串匹配)。
   - `applySendResult`(L372):error 分支从写死 `network` 改为 `classifyError(res.message)`。
     → 需 `applySendResult` 收到原始 message(现在只传 `res.kind`,要改为传整个 res 或 message)。
   - sendFiles 映射(L343):`error` 分支同样用 `classifyError(res.message)`。
5. **`src/renderer/src/App.tsx`** `statusLabel`(L1067):为 `timeout/refused/cert-mismatch` 加文案 case。

## 边界 / 失败模式

- **回归红线(最重要)**:connect timeout 必须在握手成功后清除(setTimeout(0)),否则
  大文件上传空闲期被误杀。必须有测试覆盖"大文件慢传不被 connect timeout 打断"。
- **keepAlive 复用**:第二条消息复用已存活连接,不走 createConnection,自然无 connect timeout
  开销 —— 正是我们想要的(正常发送零额外开销)。
- **connect timeout vs 请求 timeout 语义**:connect(10s)只管建连;建连后大文件传输仍用
  T_UPLOAD_MS(5min)/T_SENDER_MS(6min)。两者不冲突。
- **classifyError 字符串匹配脆弱性**:依赖 error message 含特定关键词。Node 的
  ECONNREFUSED/ETIMEDOUT message 稳定含 code;自定义 destroy err 我们自己控制 message。
  测试要覆盖各关键词命中。
- **探测成功但真正传输时对端下线**:仍走原 error 路径,映射 network/timeout,可接受。

## 测试计划

- http-client `pinnedAgent`:
  - 连不可达 IP → 10s 内(而非 6min)以 ETIMEDOUT 失败。
  - **大文件慢传不被 connect timeout 误杀**(回归红线,关键测试:模拟握手后 >10s 的慢传输仍成功)。
  - 指纹不符 → err 含 fingerprint/ECERT。
- chat-service `classifyError`:ETIMEDOUT→timeout、ECONNREFUSED→refused、
  fingerprint→cert-mismatch、其他→network,各一测。
- chat-service:sendText/sendFiles error 结果 → 正确细分 errorReason(不再一律 network)。
- chat-service:done/rejected/busy 路径回归(原有测试应仍绿)。
- App.tsx statusLabel:新 errorReason → 正确文案。

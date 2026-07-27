# ADR-0004: 传输走 HTTPS 自签证书 + 指纹 TOFU pinning

- 状态: 已接受

## 背景与问题

局域网传输最初为 HTTP 明文,同网段被动嗅探可直接拿到内容。无服务器架构(ADR-0001)下没有域名,公共 CA 无法签发证书。如何加密传输并建立设备间信任?

## 备选项

**架构层:**

1. **HTTPS 自签证书 + 指纹 TOFU pinning**(首次遇见记住指纹,之后校验一致)
2. 保持 HTTP 明文/保留明文回退——否决:全切 HTTPS,**移除** HTTP server/client 代码路径(只保留 `protocol` 字段恒填 `'https'` 便于识别对端)
3. CA 链校验——不可行:无域名无 CA;私有 CA 需要分发根证书,违背零配置

**实现层(踩坑后否决,均有实测依据):**

- `fetch`/undici 做指纹 pin——别扭(`rejectUnauthorized` 要经 dispatcher/Agent 层层传),否决,client 用 `node:https` + 自定义 `Agent.createConnection` 指纹 pin
- Electron `net` 模块——打自签名 HTTPS **静默失败无法 catch**(electron#8656),否决
- `checkServerIdentity` 做校验——实测 `rejectUnauthorized:false` 下**不被调用**,否决

## 决策

选定**方案 1**:每台设备自签证书,`pinnedAgent` 校验对端证书指纹 = `target.fingerprint`,不走 CA 链。

## 后果

- 正面:防被动嗅探(相比明文的实质提升);指纹兼任设备标识(ADR-0002),一物两用。
- 负面(留档明确承认):TOFU 首次信任锚点经**明文 UDP announcement** 传播,同网段主动攻击者可广播伪造 announcement 冒充端点(alias 抄真名 + fingerprint 填自己的),TLS 校验会"完美通过"——防的是被动窃听,不防主动冒充;换证书需重新信任。
- 私钥明文 PEM 存 userData(与 LocalSend 官方同级别,MVP 不加密)。

## 来源

[https-migration.md](../https-migration.md) §0 决策表、§3.6 实测、安全边界章节。

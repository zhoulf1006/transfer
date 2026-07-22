# ADR-0004: 传输走 HTTPS 自签证书 + 指纹 TOFU pinning

- 状态: 已接受

## 背景

局域网传输最初为 HTTP 明文。无服务器架构(ADR-0001)下没有 CA 可签发证书,但明文传输不可接受。

## 决策

升级为 **HTTPS + 自签名证书 + 指纹 TOFU pinning**:每台设备自签证书,首次遇见记住指纹(Trust On First Use),之后连接校验指纹一致(`pinnedAgent`),不走 CA 链校验。

## 后果

- 传输加密;证书指纹同时充当设备唯一标识(ADR-0002),一物两用。
- 首次连接无法防主动中间人(TOFU 固有限制),换证书需重新信任。

## 来源

[https-migration.md](../https-migration.md)。

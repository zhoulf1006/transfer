# ADR-0002: 证书 SHA-256 fingerprint 作为设备唯一标识

- 状态: 已接受

## 背景与问题

设备注册表、备注、消息归属都需要一个跨重启稳定的唯一键来引用设备。候选键必须在设备的网络位置和显示名变化后仍然不变。

## 备选项

1. **证书 SHA-256 fingerprint**(来源:本机自签名证书,证书存 identity.json,跨重启稳定)
2. IP/端口——会变(DHCP、换网),不可用
3. 默认名 alias——对端可改名,且可重名,不可用
4. 自造持久 UUID——(未留档)需额外持久化一份身份,且与 TLS 信任体系脱钩;fingerprint 已因 TOFU pinning(ADR-0004)存在,一物两用更省

## 决策

选定 **fingerprint**:`DeviceInfo.fingerprint` = 证书 SHA-256,全 app 引用设备一律用它(`DeviceRegistry` 即 `Map<fingerprint, RemoteDevice>`)。

## 后果

- 正面:备注、消息、pinning 按 fingerprint 稳定关联,设备离线/重现自动恢复;标识与信任锚点统一。
- 负面:用户删 identity.json 重生成证书 → 新 fingerprint,旧关联(如备注)成为孤儿数据(可接受,不做清理)。

## 来源

[device-alias.md](../device-alias.md) §1.1;[https-migration.md](../https-migration.md)。

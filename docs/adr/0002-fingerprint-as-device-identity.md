# ADR-0002: 证书 SHA-256 fingerprint 作为设备唯一标识

- 状态: 已接受

## 背景

设备的 IP/端口会变,默认名(alias)也可能变,需要一个跨重启稳定的唯一键来引用设备(注册表、备注、消息归属)。

## 决策

设备唯一标识 = 本机自签名证书的 SHA-256(`DeviceInfo.fingerprint`),存 identity.json,跨重启稳定。全 app 引用设备一律用 fingerprint(`DeviceRegistry` 即 `Map<fingerprint, RemoteDevice>`)。

## 后果

- 备注、消息、pinning 都能按 fingerprint 稳定关联,设备离线/重现自动恢复。
- 用户删 identity.json 重生成证书 → 新 fingerprint,旧关联(如备注)成为孤儿数据(可接受,不做清理)。

## 来源

[device-alias.md](../device-alias.md) §1.1;[https-migration.md](../https-migration.md)。

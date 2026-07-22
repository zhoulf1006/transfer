# ADR 索引

一决策一文件,只追加不改写;决策变更新开条目并标记旧条「已被 ADR-XXXX 取代」。规范见 [ADR-0013](0013-docs-lifecycle-by-rot-risk.md)。

| # | 决策 |
|---|------|
| [0001](0001-lan-direct-no-server.md) | 局域网直连,无服务器、无账号 |
| [0002](0002-fingerprint-as-device-identity.md) | 证书 SHA-256 fingerprint 作为设备唯一标识 |
| [0003](0003-chat-persistence-node-sqlite.md) | 聊天持久化用 node:sqlite(升级 Electron 35) |
| [0004](0004-https-self-signed-tofu.md) | HTTPS 自签证书 + 指纹 TOFU pinning |
| [0005](0005-discovery-respond-via-http-register.md) | 发现回应改 HTTP 定向 register,不扫网段 |
| [0006](0006-broadcast-fallback-dual-channel.md) | announce 双通道:多播 + 子网广播 |
| [0007](0007-app-scheme-replaces-file.md) | 生产环境 app:// 替代 file:// |
| [0008](0008-screenshot-scope.md) | 截图范围:三出口,不做钉图/OCR/滚动/录屏 |
| [0009](0009-overlay-persistent-not-recreated.md) | overlay 常驻复用,不重建 |
| [0010](0010-mac-three-arch-plus-locale-prune.md) | mac 三架构全打 + locale 裁剪 |
| [0011](0011-remove-gitee-mirror.md) | 移除 Gitee,下载源 R2 主 + GitHub 兜底 |
| [0012](0012-notarization-gate-fail-closed.md) | 正式版公证门禁 fail-closed |
| [0013](0013-docs-lifecycle-by-rot-risk.md) | 文档体系按腐烂速度分类(本体系的元决策) |

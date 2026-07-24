# ADR 索引

一决策一文件,只追加不改写;决策变更新开条目并标记旧条「已被 ADR-XXXX 取代」。

**格式约定:MADR minimal 五段体**——背景与问题 / 备选项(**必填**,含否决理由;无留档须标注,不得编造)/ 决策 / 后果 / 来源,另加状态行。何时该写 ADR:难逆转 + 无上下文会令人费解 + 真实 trade-off 的产物,三者同时满足。只收录**本项目**的架构决策,工作流/流程类约定不入 ADR。

状态列与条目内状态行**同步维护**:提议升级、被取代时两处一起改。

| # | 决策 | 状态 |
|---|------|------|
| [0001](0001-lan-direct-no-server.md) | 局域网直连,无服务器、无账号 | 已接受 |
| [0002](0002-fingerprint-as-device-identity.md) | 证书 SHA-256 fingerprint 作为设备唯一标识 | 已接受 |
| [0003](0003-chat-persistence-node-sqlite.md) | 聊天持久化用 node:sqlite(升级 Electron 35) | 已接受 |
| [0004](0004-https-self-signed-tofu.md) | HTTPS 自签证书 + 指纹 TOFU pinning | 已接受 |
| [0005](0005-discovery-respond-via-http-register.md) | 发现回应改 HTTP 定向 register,不扫网段 | 已接受 |
| [0006](0006-broadcast-fallback-dual-channel.md) | announce 双通道:多播 + 子网定向广播 | 已接受 |
| [0007](0007-app-scheme-replaces-file.md) | 生产环境 app:// 替代 file:// | 已接受 |
| [0008](0008-screenshot-scope.md) | 截图范围:三出口,不做钉图/OCR/滚动/录屏 | 已接受 |
| [0009](0009-overlay-persistent-not-recreated.md) | overlay 常驻复用,不重建 | 已接受 |
| [0010](0010-mac-three-arch-plus-locale-prune.md) | mac 三架构全打 + locale 裁剪 | 已接受 |
| [0011](0011-remove-gitee-mirror.md) | 移除 Gitee,下载源 R2 主 + GitHub 兜底 | 已接受 |
| [0012](0012-notarization-gate-fail-closed.md) | 正式版公证门禁 fail-closed | 已接受 |
| [0013](0013-docs-lifecycle-by-rot-risk.md) | 文档体系按腐烂速度分类(本体系的元决策) | 已接受 |

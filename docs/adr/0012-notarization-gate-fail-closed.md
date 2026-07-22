# ADR-0012: 正式版 macOS 发布公证门禁 fail-closed;预发布只签名

- 状态: 已接受(v0.9.1 落地)

## 背景

macOS 分发需要 Apple 公证,但公证耗时且依赖凭据;预发布(beta/rc)频繁,全量公证成本高。需要划清哪些 tag 必须公证、失败如何处置。

## 决策

- **正式版干净 tag**(如 `v0.9.1`):Developer ID 签名 + 三个 DMG 分别**公证 + staple + Gatekeeper 验证**,发布 GitHub Latest 并同步 R2。
- **预发布 tag**(`-beta`/`-rc`/`-alpha`/`-dev`):只签名不公证,只发 GitHub Pre-release,**不同步 R2**。
- **fail-closed**:正式版缺凭据或任一架构验证失败 → 不发布任何 macOS DMG。

## 后果

- 用户拿到的正式版 DMG 保证过 Gatekeeper;预发布节省公证时间。
- 正式发版对 Apple 服务可用性有依赖,失败需重跑。

## 来源

[dmg-notarization-pipeline.md](../dmg-notarization-pipeline.md);[mac-signing.md](../mac-signing.md)。

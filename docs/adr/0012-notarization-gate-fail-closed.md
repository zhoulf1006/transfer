# ADR-0012: 正式版 macOS 发布公证门禁 fail-closed;预发布只签名

- 状态: 已接受(v0.9.1 落地)

## 背景与问题

macOS 分发需要 Apple 公证才能双击即开,但公证要等 Apple 审核(2–30 分钟),且三架构(ADR-0010)意味着每版公证 ×3;预发布(beta/rc)迭代频繁。哪些 tag 必须公证?公证/验证失败时如何处置?

## 备选项

1. **按 tag 形态分级 + fail-closed**(见决策)
2. 全量公证(含预发布)——否决:每次迭代多等 3 次 Apple 审核,快速迭代被拖死
3. 全不公证——否决:正式版用户双击被 Gatekeeper 拦,体验不可接受
4. fail-open(部分架构验证失败仍发布其余)——否决:会让未验证/不完整的产物流向用户,宁可整版不发

## 决策

选定**方案 1**:

- 正式版干净 tag(如 `v0.9.1`):Developer ID 签名 + 三个 DMG 分别**公证 + staple + Gatekeeper 验证**,发 GitHub Latest 并同步 R2。
- 预发布 tag(`-beta`/`-rc`/`-alpha`/`-dev`):只签名不公证,只发 GitHub Pre-release,不同步 R2(用户侧用 `xattr` 去隔离)。
- **fail-closed**:正式版缺凭据或任一架构验证失败 → 不发布任何 macOS DMG。

## 后果

- 正面:正式版 DMG 保证过 Gatekeeper;预发布迭代不受公证等待拖累。
- 负面:正式发版依赖 Apple 服务可用性,失败需重跑;正式版 CI 时长随架构数线性增长。

## 来源

[dmg-notarization-pipeline.md](../dmg-notarization-pipeline.md);[mac-signing.md](../mac-signing.md)。

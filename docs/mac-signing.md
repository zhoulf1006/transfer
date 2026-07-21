# macOS 签名、公证与发布

> - 正式版干净 tag（如 `v0.9.1`）：内部 App 使用 Developer ID 签名，最终三个 DMG 分别公证并 staple，发布到 GitHub Latest 和 Cloudflare R2。
> - 预发布 tag（`-beta`、`-rc`、`-alpha`、`-dev`）：只签名、不公证，只发布到 GitHub Pre-release，不同步 R2。
> - 手动运行 workflow：生成 Actions artifact，不创建 GitHub Release，也不同步 R2。
> - 正式版缺凭据或任一架构验证失败时 fail-closed，不发布任何 macOS DMG。

详细设计和失败路径见 [dmg-notarization-pipeline.md](./dmg-notarization-pipeline.md)。

## 签名、公证与 staple

- **签名**：用 `Developer ID Application` 标识开发者并保护 App 与最外层 DMG 的完整性；Electron App 同时启用 Hardened Runtime 和所需 entitlements。
- **公证**：把最终交付物提交 Apple 扫描。本项目直接分发 DMG，因此只公证最外层 DMG，不再提前单独公证 `.app`。
- **staple**：把 Apple ticket 装订到 DMG，使 Gatekeeper 无法访问 Apple 服务时仍能验证公证结果。

顺序固定为：

```text
签名 Transfer.app
→ 生成 arm64 / x64 / universal DMG
→ 使用 Developer ID Application 签名每个 DMG
→ 提交每个 DMG 给 notarytool 并等待 Accepted
→ staple DMG
→ 验证最终 DMG 和内部 App
→ 上传 GitHub Release
→ 正式版同步 R2
```

任何签名或公证都必须发生在最终上传之前；staple 后不能再修改 DMG 字节。

## GitHub Actions 分档

`.github/workflows/build.yml` 的 macOS job 使用以下状态：

- `HAS_CSC`：是否有 `CSC_LINK`。
- `HAS_APPLE`：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 是否全部存在。
- `IS_PRERELEASE`：tag 是否以 `-beta`、`-rc`、`-alpha` 或 `-dev` 结尾。
- `IS_RELEASE`：是否为干净正式版 tag。

正式版先验证 `HAS_CSC` 和 `HAS_APPLE`；缺任一项直接失败，不能落入仅签名或未签名分支。预发布和手动运行保留有证书时签名、无证书时生成未签名 artifact 的既有行为。

公证步骤位于 DMG 打包与 `actions/upload-artifact` 之间，因此公证、staple、Gatekeeper 或内部 App 验证失败都会阻止 GitHub Release 上传。R2 `sync` job 依赖两个平台构建成功，并且只对干净正式版 tag 运行。

## GitHub Secrets

| Secret | 用途 |
|---|---|
| `CSC_LINK` | Developer ID 证书 `.p12` 的 base64 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID，例如 `RHQ28XS7D9` |

空的 `CSC_LINK` 会被 electron-builder 当作证书路径，因此无证书分支不能设置该变量。Secrets 不直接出现在 step `if` 中，而是先转成 job env 布尔值。

一次性导出证书并生成 `CSC_LINK`：

```bash
security export -t identities -f pkcs12 -o /tmp/cert.p12
base64 -i /tmp/cert.p12 | pbcopy
rm /tmp/cert.p12
```

导出密码保存为 `CSC_KEY_PASSWORD`。证书私钥和 Apple 凭据只放 GitHub Secrets；Apple 登录使用 App 专用密码，不使用主密码。

## 发布用法

```bash
# 正式版：GitHub Latest + R2，macOS DMG 必须通过完整公证门禁
git tag v0.9.1
git push origin v0.9.1

# 预发布：只到 GitHub Pre-release，不同步 R2
git tag v0.9.1-beta
git push origin v0.9.1-beta
```

## 本地构建

前置条件：

1. 登录钥匙串中存在 `Developer ID Application` 身份：

   ```bash
   security find-identity -v -p codesigning
   ```

2. Xcode Command Line Tools 提供 `notarytool`：

   ```bash
   xcrun --find notarytool
   ```

3. 在不会提交的 `.env.local` 中配置三项 Apple 凭据：

   ```text
   APPLE_ID=你的Apple ID邮箱
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=RHQ28XS7D9
   ```

本地生成正式版等价产物：

```bash
set -a; source .env.local; set +a
pnpm run dist:mac:sign
```

该命令等价于：

```bash
pnpm run dist:mac:package-signed
pnpm run notarize:mac:dmgs
```

`dist:mac:package-signed` 显式设置 `mac.notarize=false`，避免 electron-builder 在 DMG 创建前公证内部 App；`dmg.sign=true` 使用同一 Developer ID Application 身份签名最终 DMG；`notarize:mac:dmgs` 对这三个已签名 DMG 执行完整门禁。

## 每个 DMG 的验证门禁

`build/notarize-dmgs.cjs` 严格要求同一产品版本的 arm64、x64、universal 三个 DMG。每个文件依次执行：

```bash
hdiutil verify "$DMG"

xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait \
  --output-format json

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
hdiutil verify "$DMG"

spctl --assess \
  --type open \
  --context context:primary-signature \
  --verbose=4 \
  "$DMG"
```

随后只读挂载 DMG，并对其中的 App 执行：

```bash
codesign --verify --deep --strict --verbose=2 "/挂载点/Transfer.app"
```

脚本只接受 `notarytool` JSON 中的 `status: Accepted`，同时要求有效 submission ID。Apple 返回 `Invalid` 时会尽力读取该 submission 的日志，但日志查询失败不会覆盖原始公证错误。

## 产物与发布

三个文件名分别为：

```text
Transfer-<version>-mac-arm64.dmg
Transfer-<version>-mac-x64.dmg
Transfer-<version>-mac-universal.dmg
```

- arm64：Apple Silicon 原生版本。
- x64：Intel 版本；Apple Silicon 可通过 Rosetta 运行。
- universal：同时包含 arm64 和 x64，供无法确定架构的用户使用。

正式版同步顺序是安装包先上传到 `releases/v<version>/`，最后才覆盖 R2 根目录的 `latest.json`。预发布不会启动 `sync` job，因此不会污染 R2 的正式版下载指针。

## 验证边界

单元测试通过 fake command runner 验证命令顺序、失败传播和卸载清理，不会假装访问过 Apple。真实端到端结果以正式版 tag 的 macOS GitHub Actions 为准；CI 中三个 DMG 都出现 `Accepted`、`stapler validate` 成功和 `spctl ... accepted` 后，才算线上公证验证完成。

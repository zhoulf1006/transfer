# macOS 签名、公证与发布

> - Formal tag (e.g. `v0.9.1`) and prerelease tag (`-beta`, `-rc`, `-alpha`, `-dev`): identical packaging — each `.app` and each DMG is signed with Developer ID, notarized and stapled, and passes the full gate. A formal tag publishes to GitHub Latest and syncs R2; a prerelease publishes to GitHub Pre-release only.
> - Manual workflow run: with `verify_formal_macos=true` it runs the release packaging and gate; without it, local packaging (signed, not notarized). Neither creates a GitHub Release or touches R2.
> - No Developer ID certificate → every packaging command and every CI tier fails; there is no unsigned macOS build. A release missing an Apple credential, or any architecture failing the gate, publishes nothing (fail-closed).
> - The commands each environment runs are declared in `capabilities.toml` (`macos-distribution.profiles`); the requirements and boundaries are in [specs/mac-distribution.md](../specs/mac-distribution.md), the decision in ADR-0023.

详细设计和失败路径见 [dmg-notarization-pipeline.md](./dmg-notarization-pipeline.md)。

> **本文只讲 Developer ID(DMG)这条线。** Mac App Store 那条几乎没有共用步骤——
> 签名身份、描述文件、沙盒、架构数量都不同,且**不公证**。见 [mas-submission.md](./mas-submission.md)。

## 签名、公证与 staple

- **签名**:用 `Developer ID Application` 标识开发者并保护 App 与最外层 DMG 的完整性;Electron App 同时启用 Hardened Runtime 和所需 entitlements。
- **公证**:把交付物提交 Apple 扫描。**`.app` 与最外层 DMG 都要公证**,两次提交缺一不可(原因见下)。
- **staple**:把 Apple ticket 装订到交付物,使 Gatekeeper 在无法访问 Apple 服务时仍能验证公证结果。

**为什么两处都要钉**:ticket 按被装订的那个文件走。只钉 DMG 的话,用户把 App 拖进「应用程序」之后 DMG 连同票据一起被丢掉,App 身上没有票据 → 首次启动 Gatekeeper 只能联网查,断网即判「无法验证是否包含恶意软件」。只钉 App 的话,DMG 自身没票据 → 双击打开 DMG 时 `spctl --type open` 判 rejected。**App 的票据管「拖出来之后」,DMG 的票据管「打开 DMG 时」。**

The release order is fixed. Each packaging is one electron-builder call (`build/mac-packaging.cjs`); the release call adds the same script as the builder's afterSign hook, and the DMG gate runs after the build:

- `dist:mac:local` = `node build/mac-packaging.cjs local`: certificate check → one build of every configured arch's `.app` and DMG, signed, notarization off → signature checks on every app and DMG.
- `dist:mac:release` = `node build/mac-packaging.cjs release` → `node build/mac-packaging.cjs notarize-dmg` (the per-DMG gate below). The release build also checks the three Apple credentials first, and its afterSign hook notarizes each `.app` as the builder signs it: zip (`ditto --keepParent`), submit, check the Accepted log, keep it as `Transfer-<v>-mac-<arch>.app.notary-log.json`, staple, validate. After the build every app must carry its stapled ticket.

```text
build and sign Transfer.app (each arch)
→ afterSign hook: notarize and staple that .app   ← before its DMG exists (release only)
→ build and sign its DMG from that .app (same builder call, not re-signed)
→ notarize, staple and gate each DMG, including the app inside it (release only)
→ upload to GitHub Release
→ formal release only: sync R2
```

Staying on the builder's ordinary single-call path keeps what it does only inside one build — it writes `Contents/Resources/app-update.yml` into each app only when the same call also builds a DMG or zip. Transfer has no auto-updater, so nothing reads that file today.

The architecture set (`arm64`, `x64`, `universal`) is read from `mac.target` in `electron-builder.yml`. Packaging locates each built app by its binary's architectures, not by directory name: x64 builds into `release/<v>/mac/`, the others into `mac-<arch>/`. This build's earlier output (`mac*/` directories, DMGs, logs) is cleared before the build, so a leftover never reaches Apple; a missing or extra app or DMG fails the packaging.

`build/mac-packaging.cjs` and its tests `build/mac-packaging.test.cjs` are the electron-scaffold skill's asset (`assets/` in zhoulf1006/skillshed), copied here unchanged; `pnpm test` runs the tests with `node --test`. Do not edit the copies: change the asset, then copy both files again. The script requires `dmg.artifactName: ${productName}-${version}-mac-${arch}.dmg` in `electron-builder.yml` and checks it on every run.

任何签名或公证都必须发生在最终上传之前;staple 后不能再修改 DMG 字节。

## GitHub Actions 分档

The macOS job in `.github/workflows/build.yml` uses three job-level values:

- `HAS_CSC`: whether `CSC_LINK` is set.
- `HAS_APPLE`: whether `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are all set.
- `MAC_PROFILE`: `release` for any tag push and for a manual run with `verify_formal_macos=true`; `local` for a manual run without it.

| Trigger | Packaging | Published |
|---|---|---|
| clean `v*` tag | `dist:mac:release` | GitHub Latest + R2 |
| prerelease `v*` tag | `dist:mac:release` | GitHub Pre-release |
| manual, `verify_formal_macos=true` | `dist:mac:release` | Actions artifact only |
| manual, without it | `dist:mac:local` | Actions artifact only |

A missing `CSC_LINK` fails the job in every tier before packaging; a `release` run missing an Apple credential fails before packaging too. The local step is given no Apple credential. Packaging (including every notarization and gate) runs before `actions/upload-artifact`, so any failure blocks the upload and the Release. Publishing is decided by the tag event on the publish steps, never by `MAC_PROFILE`; the R2 `sync` job needs both platform jobs and runs only on a clean tag.

## GitHub Secrets

| Secret | 用途 |
|---|---|
| `CSC_LINK` | Developer ID 证书 `.p12` 的 base64 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple ID App 专用密码 |
| `APPLE_TEAM_ID` | Apple Developer Team ID,例如 `RHQ28XS7D9` |

空的 `CSC_LINK` 会被 electron-builder 当作证书路径,因此无证书分支不能设置该变量。Secrets 不直接出现在 step `if` 中,而是先转成 job env 布尔值。

一次性导出证书并生成 `CSC_LINK`:

```bash
security export -t identities -f pkcs12 -o /tmp/cert.p12
base64 -i /tmp/cert.p12 | pbcopy
rm /tmp/cert.p12
```

导出密码保存为 `CSC_KEY_PASSWORD`。证书私钥和 Apple 凭据只放 GitHub Secrets;Apple 登录使用 App 专用密码,不使用主密码。

## 发布用法

```bash
# 正式版:GitHub Latest + R2,macOS DMG 必须通过完整公证门禁
git tag v0.9.1
git push origin v0.9.1

# 预发布:只到 GitHub Pre-release,不同步 R2
git tag v0.9.1-beta
git push origin v0.9.1-beta
```

## 本地构建

前置条件:

1. 登录钥匙串中存在 `Developer ID Application` 身份:

   ```bash
   security find-identity -v
   ```

   **不要加 `-p codesigning`**:那样只列**有效**身份,会把 `CSSMERR_TP_NOT_TRUSTED` 的证书整条藏掉(典型成因是缺 WWDR 中间证书),排查时会误以为证书根本没装。见 [screen-permission-preflight-deadlock.md](../postmortems/screen-permission-preflight-deadlock.md)。

2. Xcode Command Line Tools 提供 `notarytool`:

   ```bash
   xcrun --find notarytool
   ```

3. 在不会提交的 `.env.local` 中配置三项 Apple 凭据:

   ```text
   APPLE_ID=你的Apple ID邮箱
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=RHQ28XS7D9
   ```

Local packaging (signed with Developer ID, never submitted to Apple — only prerequisite 1 is needed):

```bash
pnpm run dist:mac:local
```

Release packaging on this machine, the same artifacts as the CI release path (all three prerequisites):

```bash
set -a; source .env.local; set +a
pnpm run dist:mac:release
```

Built-in notarization is off in `electron-builder.yml` (`mac.notarize: false`) and every builder call also passes `-c.mac.notarize=false`, so loaded Apple credentials never make a local packaging submit anything. Without credentials, `dist:mac:release` stops before building, with the missing names. Rebuilding removes the notarization logs left by an earlier run, so a local DMG never sits next to a log claiming it was notarized.

## 每个 DMG 的验证门禁

The DMG gate (`node build/mac-packaging.cjs notarize-dmg`) requires exactly one DMG per configured architecture (arm64, x64, universal), named `Transfer-<version>-mac-<arch>.dmg` for the current version; a missing DMG, or any other `.dmg` in the version directory, fails before anything is submitted. Each file then goes through:

```bash
hdiutil verify "$DMG"

codesign --verify --verbose=4 "$DMG"
codesign --display --verbose=4 "$DMG"
# 自动断言 Developer ID Application、APPLE_TEAM_ID 与安全 Timestamp

xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait \
  --output-format json

xcrun notarytool log "$SUBMISSION_ID" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --output-format json
# 自动断言 jobId、Accepted 状态和零 error,并留档为 *.notary-log.json

xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
hdiutil verify "$DMG"

spctl --assess \
  --type open \
  --context context:primary-signature \
  --verbose=4 \
  "$DMG"
```

随后只读挂载 DMG,并对其中的 App 执行:

```bash
codesign --verify --deep --strict --verbose=2 "/挂载点/Transfer.app"
xcrun stapler validate "/挂载点/Transfer.app"
```

第二条是**票据装订**的验收点:`spctl --assess` 联网时会通过在线查票而成功,`codesign` 只验签名,两者都分辨不出票据有没有装订到 App 上。装不上就意味着用户拖出 App 后首次启动必须联网、断网被拦(v1.0.0 实测踩过)。

脚本只接受 `notarytool` JSON 中的 `status: Accepted`,同时要求有效 submission ID。Accepted 后必须成功读取对应日志,确认 submission、状态和零 error,再将日志随 Actions artifact 留档。Apple 返回 `Invalid` 时会尽力读取日志,但诊断日志查询失败不会覆盖原始拒绝错误。

## 产物与发布

三个文件名分别为:

```text
Transfer-<version>-mac-arm64.dmg
Transfer-<version>-mac-x64.dmg
Transfer-<version>-mac-universal.dmg
```

- arm64:Apple Silicon 原生版本。
- x64:Intel 版本;Apple Silicon 可通过 Rosetta 运行。
- universal:同时包含 arm64 和 x64,供无法确定架构的用户使用。

正式版同步顺序是安装包先上传到 `releases/v<version>/`,最后才覆盖 R2 根目录的 `latest.json`。预发布不会启动 `sync` job,因此不会污染 R2 的正式版下载指针。

## 验证边界

Unit tests use a fake command runner: they check command order, failure propagation and cleanup, and never contact Apple. A real end-to-end result comes only from a `v*` tag (formal or prerelease), a manual run with `verify_formal_macos=true`, or a local `dist:mac:release`; notarization counts as verified only once every app and DMG has passed signature identity and timestamp, the Accepted log, stapled tickets and Gatekeeper.

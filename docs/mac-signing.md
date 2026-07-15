# macOS 签名 + 公证

> 两条路径并存:
> - **CI 签名(不公证)**:每次 push tag → CI 自动出**已签名**dmg(有开发者身份,但用户仍需右键打开)。见 §CI 签名。
> - **本地签名 + 公证**:`pnpm dist:mac:sign` 出**已签名已公证**dmg(用户**双击即开**)。见 §本地公证。
> 状态:两条都跑通实测(CI:codesign 有效 + `Unnotarized Developer ID`;本地:`Notarized Developer ID accepted`,quarantine 下仍 accepted)。

## 签名 vs 公证(关键区别,决定用哪条)

- **签名**:app 嵌开发者身份(`Developer ID: Longfei Zhou`),可追溯、防篡改。**但不解决"双击即开"**。
- **公证**:上传 Apple 审核盖章。**只有公证后**,从网络下载(带 quarantine)的 app 才双击即开。
- macOS 10.15+ Gatekeeper 对下载的 app **只认公证**:没公证 = 拦,不管签没签名。所以"只签名不公证"用户体验 ≈ 不签名(都要右键)——签名带来的是内在身份,不是打开体验。

## CI 签名(不公证)

CI 的 mac job 用 GitHub Secrets 里的证书签名(electron-builder 自动导入 base64 证书)。**不公证**(公证要上传 Apple、耗时不可控 2min~30min,拖慢 CI)。

**GitHub Secrets**(仓库 Settings → Secrets and variables → Actions):
| Secret | 值 |
|---|---|
| `CSC_LINK` | Developer ID 证书 `.p12` 的 base64 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设的密码 |

**导出证书生成 base64**(一次性):
```bash
security export -t identities -f pkcs12 -o /tmp/cert.p12   # 设导出密码 → 存 CSC_KEY_PASSWORD
base64 -i /tmp/cert.p12 | pbcopy                            # → 存 CSC_LINK
rm /tmp/cert.p12                                           # 用完删私钥!
```

**workflow 关键坑(build.yml)**:空 `CSC_LINK=""`(fork PR/未建 secret)会被当"空路径证书"→ **构建失败**(实测)。故分**两个互斥 step**(job env `HAS_CSC` 判断):有 secret 走 signed step;无则走 unsigned step(`CSC_IDENTITY_AUTO_DISCOVERY: false`),根本不设 CSC_LINK。

**安全**:证书私钥(base64)上了 GitHub Secrets(加密,fork PR 读不到)。用个人 Apple ID 的**专用密码**非主密码,风险可控。要更安全可用专用 Apple ID。

## 本地公证

## 前置(一次性)

1. **证书**:`Developer ID Application: Longfei Zhou (RHQ28XS7D9)` 已在登录钥匙串(`security find-identity -v -p codesigning` 可见)。
2. **App 专用密码**:https://account.apple.com → 登录与安全 → App 专用密码 → 生成(`xxxx-xxxx-xxxx-xxxx`)。
3. **凭据写进 `.env.local`**(项目根,已被 `.gitignore` 忽略,**绝不提交**):
   ```
   APPLE_ID=你的Apple ID邮箱
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=RHQ28XS7D9
   ```
4. **Xcode Command Line Tools**(notarytool):`xcrun --find notarytool` 可用。

## 配置(已就位,无需重配)

- `build/entitlements.mac.plist`:Electron/V8 加固运行时必需(allow-jit / allow-unsigned-executable-memory / disable-library-validation)+ 局域网 client/server。
- `electron-builder.yml` mac 段:`hardenedRuntime: true` + `gatekeeperAssess: false` + `entitlements`/`entitlementsInherit`。**`notarize` 不写在 yml**(防 CI 误触发),只在 `dist:mac:sign` 脚本用 `-c.mac.notarize=true` 开启。
- `package.json` 脚本:`dist:mac`(不公证)/ **`dist:mac:sign`(签名+公证)**。

## 打包步骤

```bash
# 1)(可选)先验凭据能登录 Apple
set -a; source .env.local; set +a
xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"
# "No submission history" = 凭据 OK

# 2) 签名 + 公证打包(公证要上传 Apple 并等审核,5–15 分钟)
set -a; source .env.local; set +a
pnpm dist:mac:sign
```
产物:`release/<version>/Transfer-<version>.dmg`(内含已签名已公证的 Transfer.app)。

## 验证(每次打完可跑一遍)

```bash
APP="release/<version>/mac-arm64/Transfer.app"
codesign --verify --deep --strict --verbose=2 "$APP"        # valid on disk
codesign -dv --verbose=4 "$APP" 2>&1 | grep Authority        # Developer ID: Longfei Zhou
spctl --assess --type execute --verbose "$APP"               # accepted / Notarized Developer ID ← 最关键
xcrun stapler validate "$APP"                                # The validate action worked!
```
终极验证(模拟"从网络下载"):
```bash
cp -R "$APP" /tmp/t.app
xattr -w com.apple.quarantine "0181;0;Safari;" /tmp/t.app
spctl --assess --type execute --verbose /tmp/t.app           # 仍 accepted = 别人下载也双击即开
rm -rf /tmp/t.app
```

## 已知/注意

- **dmg 外壳本身未装订公证票据**(`stapler validate <dmg>` 会 rejected),这**正常**:公证的是里面的 `.app`。用户拖 app 到 Applications 双击即可,Gatekeeper 检查 app 不检查 dmg。若要 dmg 也装订,可加 `afterAllArtifactBuild` staple 步骤(非必需)。
- **每个版本都要单独公证**(Apple 盖章绑定该版本二进制),没有"一次公证全版本通用"。
- 公证偶尔慢(Apple 侧排队),`dist:mac:sign` 会等到 `notarization successful` 才继续。
- 只出 arm64(Apple Silicon)。需 Intel 用户则 mac.target 加 x64,分别签名公证。

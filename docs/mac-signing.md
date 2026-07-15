# macOS 签名 + 公证(本地打包)

> 目的:mac 用户**双击即开**(无 Gatekeeper 警告、无需右键/xattr)。签名+公证在**本地** `pnpm dist:mac:sign` 做,证书私钥不上云。
> 状态:已跑通(v0.5.3 实测:codesign/spctl/stapler 全绿,quarantine 下仍 accepted)。

## 为什么本地签、CI 不签

- **本地签**:证书私钥只在你 mac 钥匙串,不导出、不上 GitHub Secrets,最安全。
- **CI 不签**:CI 的 mac job 保持 `CSC_IDENTITY_AUTO_DISCOVERY: false` → electron-builder 检测不到签名身份 → **优雅跳过签名与公证**,仍出未签名 dmg(供快速迭代/内部用)。**已实测:签名配置不破坏 CI 构建**。
- 分工:平时快速迭代走 CI(未签名,右键打开);要给外部用户的**正式版**本地 `dist:mac:sign`(签名+公证,双击即开)。

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

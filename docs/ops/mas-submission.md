# Mac App Store 打包与提交

> 这条线与 DMG 那条**几乎没有共用步骤**,不要拿 [mac-signing.md](./mac-signing.md) 的流程套用。
> 差异见下表——尤其"不公证"和"本地跑不起来"这两条,照 DMG 的直觉做会白费很多时间。

| | Developer ID(DMG) | Mac App Store |
|---|---|---|
| App 签名身份 | `Developer ID Application` | `Apple Distribution` |
| 安装包签名 | 无(DMG 用 App 同一身份签) | `3rd Party Mac Developer Installer` 签 `.pkg` |
| 描述文件 | 不需要 | **必须**内嵌 `embedded.provisionprofile` |
| 沙盒 | 不启用 | **必须**启用 |
| 加固运行时 | 启用(公证的前提) | **不启用** |
| 公证 | **必须**,`.app` 与每个 DMG 各一次 | **不做**——Apple 在审核流程里自己处理 |
| 架构 | 三个产物(arm64/x64/universal)让用户自选 | **只能 universal**,商店一个 app 只收一份二进制 |
| 装到本机跑 | 可以 | **不可以**(见「为什么正式包跑不起来」) |
| bundle id | `com.loong.transfer` | `com.aloongplanet.transfer`(见 ADR-0016) |

## 凭据清单

三样缺一不可,都在本机钥匙串/仓库里:

| 凭据 | 用途 | 怎么确认它在 |
|---|---|---|
| `Apple Distribution: <名字> (RHQ28XS7D9)` | 签 `.app` | `security find-identity -v \| grep "Apple Distribution"` |
| `3rd Party Mac Developer Installer: <名字> (RHQ28XS7D9)` | 签 `.pkg` | 同上,grep `3rd Party` |
| `build/embedded.provisionprofile` | 内嵌进 `.app` | 见下方"看清描述文件是哪一种" |

另有 `build/development.provisionprofile`,那是**给 `mas-dev` 用的**,两者不能混:
用 development profile 打出来的包传不上 App Store,用 distribution profile 打出来的包在本机跑不起来。

### 看清描述文件是哪一种

```bash
security cms -D -i build/embedded.provisionprofile > /tmp/pp.plist
/usr/libexec/PlistBuddy -c 'Print :Name' /tmp/pp.plist
/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' /tmp/pp.plist
# 判据是这个键在不在:
#   打印出设备列表 = development(只能装在登记过的设备上)
#   报 "Does Not Exist" 并以非 0 退出 = distribution(App Store 分发用)
# 那个报错**就是答案**,不是命令用错了
/usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' /tmp/pp.plist
```

## 打包

```bash
pnpm dist:mas    # → release/<version>/mas-universal/Transfer.app
pnpm pkg:mas     # → release/<version>/Transfer-<version>-mas-universal.pkg
```

`dist:mas` 走 `--universal`,会**额外下载一份 x64 的 Electron**,首次跑明显慢。

`pkg:mas` 不用 electron-builder 出 pkg 而是调 Apple 原生 `productbuild`,原因写在
`build/make-mas-pkg.cjs` 的文件头:electron-builder 的 `mas` 目标只签 `.app` 不产 pkg,
而加 `pkg` 目标会让它去包 **Developer ID 那份构建**——产出的 pkg 里装的是
`com.loong.transfer`、无沙盒、无内嵌 profile,传上去必被拒。

## 产物验收(六项,逐条跑)

```bash
APP="release/<version>/mas-universal/Transfer.app"
PKG="release/<version>/Transfer-<version>-mas-universal.pkg"

# ① 架构必须是 universal —— arm64-only 会把 Intel 机器排除在商店之外
lipo -archs "$APP/Contents/MacOS/Transfer"          # 期望: x86_64 arm64

# ② bundle id 必须是 MAS 专用的那个,不是 DMG 线的
codesign -dv "$APP" 2>&1 | grep Identifier=          # 期望: com.aloongplanet.transfer

# ③ 签名身份 —— 必须 -dvv,**-dv 拿不到 Authority**(只有 Identifier/TeamIdentifier)
codesign -dvv "$APP" 2>&1 | grep Authority
# 期望三行: Apple Distribution → Apple Worldwide Developer Relations → Apple Root CA

# ③b 签名有效性。比读 Authority 更有力:它真的去校验每个嵌套组件
codesign --verify --deep --strict --verbose=2 "$APP"
# 期望结尾两行: valid on disk / satisfies its Designated Requirement"

# ④ 沙盒与权限
codesign -d --entitlements - --xml "$APP" | plutil -convert xml1 -o - - \
  | grep -A1 "app-sandbox\|files.downloads\|files.user-selected\|network"

# ⑤ 描述文件已内嵌 —— 沙盒 Electron 没它根本起不来
ls "$APP/Contents/embedded.provisionprofile"

# ⑥ .pkg 的签名链
pkgutil --check-signature "$PKG"                     # 期望: 3rd Party Mac Developer Installer
```

**再加一条与本次改动相关的自查**:确认包里装的确实是你以为的那份代码。
`app.asar` 是二进制归档,普通 `grep` 找不到,要用文本模式:

```bash
grep -ac "<某个本次新增的标识符>" "$APP/Contents/Resources/app.asar"
```

这条不是多余的——`release/` 下按版本号分目录,`ls release/*/mas-*/` 之类的通配会按字典序
把**旧版本**排在前面,照着它验就验了个几个月前的包(实际踩过)。

## 上传

**本机当前没有可用的上传工具**,三条路都断着:

| 工具 | 状态 |
|---|---|
| `altool` | Xcode 15+ 已移除 |
| `iTMSTransporter` | 随**完整版 Xcode** 提供;本机只有 Command Line Tools(`xcode-select -p` → `/Library/Developer/CommandLineTools`) |
| `Transporter.app` | 未安装(Mac App Store 免费) |

推荐装 **Transporter.app**:拖入 `.pkg` → 先 **Verify** 再 **Deliver**。Verify 是格式校验,
几分钟出结果,能在提审前挡掉结构性问题(缺 entitlement、架构不对、版本号撞车之类),
比等一轮审核快得多。

> **未实测**:本文档写作时本机没装 Transporter,上传的具体交互步骤与失败提示的判读**没有走过一遍**。
> 下一个真正上传的人请把实际步骤与遇到的报错补进本节,并删掉这条注记。

### ⚠️ 不要为了测试去安装这个 .pkg

`make-mas-pkg.cjs` 把安装位置定为 `/Applications`,装进去的名字是 `Transfer.app` ——
**与 DMG 版路径完全相同**(bundle id 不同故 TCC 授权分开,但文件会被覆盖)。
而且覆盖完也跑不起来(见下节),等于白搭进去一个能用的 app。

### 出口合规(Export Compliance)

上传后 ASC 会问加密相关问题,**没回答的 build 会卡在那里进不了 TestFlight**。
可以在 `electron-builder.yml` 的 `extendInfo` 里加 `ITSAppUsesNonExemptEncryption`
让它不再每次都问。

> **本项目当前没有配置这个键**,也就是每次上传都要在网页上手填一次。
> 要不要配、配成什么值,是**合规判断而非技术判断**:这个 app 用 TLS 保护传输、
> 自签证书并做指纹 pinning,是否落在 Apple 的豁免类别里需要发布者自己确认。
> 本手册不给结论。

### 版本号

App Store Connect 不接受重复的 version + build 组合。上传前先到 ASC 看上一次提交用的是什么版本,
撞了就得先升 `package.json` 的 version。

> 注意:master 配了分支保护,版本号变更也要走 PR(见 [github-ops 的发版流程](../../CLAUDE.md))。

## 为什么正式包跑不起来,以及沙盒行为该怎么验

distribution 描述文件**没有 `ProvisionedDevices`** —— 它授权的是"从 App Store 安装的副本",
不是某台开发机。所以 `pnpm dist:mas` 出来的 `.app` 双击不会启动,这是**设计如此,不是打包出错**。

实测过(2026-08-23),`open` 它会得到:

```text
The application cannot be opened for an unexpected reason,
error=Error Domain=RBSRequestErrorDomain Code=5 "Launch failed."
NSUnderlyingError=... NSPOSIXErrorDomain Code=163 "Launchd job spawn failed"
```

**看到 `Code=163` 就是预期结果**,不必回头怀疑签名或打包步骤 —— 这一条写在这里,
就是为了让下一个人不去排查一个根本不存在的问题。

于是"在正式包上验一遍沙盒行为"这个要求是**不可执行的**。真要验沙盒相关的行为,只有两条路:

1. **`pnpm dist:mas:dev`** —— 同样开沙盒、同样的容器,但用 development 签名与 profile,
   可以本机运行。**日常验沙盒行为都走这条**。
   启动必须用 `open`:直接执行 `Contents/MacOS/Transfer` 会绕过沙盒容器,测出来的是假绿。
2. **TestFlight** —— 唯一能验到 distribution 签名下真实行为的途径,且**不需要过正式审核**。
   流程见下节。

两者的差别不只是签名:development profile 会登记设备、entitlement 的实际授予也可能不同,
所以 `mas-dev` 上的绿**不能直接外推**到正式包。涉及权限边界的结论要在 TestFlight 上复核。

## 用 TestFlight 测正式版

**没有"上传到 TestFlight"这个动作**:build 传到 App Store Connect 之后,自动出现在
该 app 的 TestFlight 标签页里。

| 测试类型 | 人数 | 要不要审核 |
|---|---|---|
| **内部**(Internal) | 100 | **不需要**。build 处理完就能装 |
| 外部(External) | 10000 | 需要 Beta App Review(比正式审核轻,但仍是一道) |

内部测试员**必须先在 ASC 的 Users and Access 里是团队成员**。
发布者本人天然满足,所以自测不用拉任何人进来。

步骤:

1. Transporter 上传 `.pkg`(先 Verify 再 Deliver)
2. 等 ASC 处理(几分钟到几十分钟)
3. 回答出口合规(见上节;不答会卡住)
4. TestFlight 标签页 → 加内部测试员
5. 测试机装 **TestFlight.app**(Mac App Store,需 macOS 12+)
6. 从 TestFlight.app 里安装 Transfer

build 有效期 **90 天**。

> **未实测**:以上是公开流程,本手册写作时没有走过一遍。第一个真正走通的人请补上
> 每步的实际耗时、卡点与报错文案,并删掉这条注记。

## 已知的坑

- **`mas-dev` 包没有 QUIET 开关**,一启动就往局域网多播 announce,会在同网设备的列表里
  留下一个用新指纹的陌生条目(默认滞留 60 分钟,见 CONTEXT.md 的 offlineKeep)。
  验完记得退出:`osascript -e 'tell application id "com.aloongplanet.transfer" to quit'`。
  按 **bundle id** 退,别按进程名——DMG 版进程同名,会误杀正在用的那个。
- **两个版本可以并存**(bundle id 不同 → userData 与单实例锁都分开),但正因为同名,
  操作时要靠 bundle id 区分。
- **`release/` 按版本号分目录**,通配取包容易拿到旧版本,见上面验收那节的第七条。

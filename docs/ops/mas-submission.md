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

**实测走通(2026-08-23)**:拖入 `.pkg` → Deliver,几分钟后界面显示

```text
✅ DELIVERED ON AUG 23, 2026 AT 21:54
🕐 THE APP HAS FINISHED PROCESSING.
```

两行都出现才算完;只有 DELIVERED 说明还在 ASC 侧处理,TestFlight 标签页里还看不到这个 build。

> 仍未实测:**Verify** 按钮的行为(那次直接 Deliver 了)。它是上传前的格式校验,
> 理论上能提前挡掉版本号撞车、架构不对之类的问题。下一个用它的人补上实际表现。

### 版本号与 build 号

ASC 不接受重复的 **version + build** 组合。

electron-builder 默认让 `buildVersion` 等于 `version`,所以上传的 build 显示成
`1.2.1 (1.2.1)` —— 括号里那个是 build 号。**同一个 version 要重传(比如验出问题改了代码),
version 可以不变,但 build 号必须递增**,否则 ASC 拒收。

本项目当前没有独立的 `buildVersion` 配置,要重传就得在 `electron-builder.yml` 里加,
或用 CLI 覆盖(`-c.buildVersion=…`)。**这一条尚未实测**,第一个遇到重传的人补。

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

> 升 `package.json` 的 version 时注意:master 配了分支保护,版本号变更也要走 PR。

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

| 测试类型 | 人数 | 要不要审核 | 谁能当 |
|---|---|---|---|
| **内部**(Internal) | 100 | **不需要**,build 处理完就能装 | **只能是 App Store Connect 团队成员** |
| 外部(External) | 10000 | 需要 Beta App Review | 任何人 |

**这张表里最容易踩的是最后一列。** 把一个非团队成员加进 Internal 组时,ASC 只报
"An error has occurred. Try again later." —— 不说真正的原因。

### 关键前提:你要用哪个 Apple ID 测

TestFlight 用的是本机**「媒体与购买项目」**登录的 Apple ID(不是 iCloud 账号,两者可能不同;
用 `open -a "App Store"` 看左下角)。**这个账号必须是 ASC 的团队成员**,否则:

- 加进 Internal 组会报上面那个错
- 只能作为外部测试员,而外部要等 Beta App Review 通过才能装

如果本机登的账号不在团队里(常见情形:开发者账号用邮箱 A 注册,而这台机器登的是邮箱 B),
**不要去折腾切换系统账号,把 B 加进团队更省事**:

1. 先去 TestFlight → All Testers,**删掉** B 已有的测试员记录
   (同一邮箱既是外部测试员又要变团队成员会冲突,那个 "An error has occurred" 多半来自这里)
2. https://appstoreconnect.apple.com/access/users → `+` 邀请 B
   - Role 选 **Developer**(能做内部测试员的最小角色)
   - Apps 勾上本 app
   - ⚠️ 这个页面是**账号级**的,不在任何单个 app 里面 —— 在 app 页面里找不到它
3. 去 B 的邮箱收 **App Store Connect 团队邀请**并接受(与 TestFlight 邀请是两封不同的邮件)
4. 回 TestFlight → Internal Testing → 组 → 这时才加得进去

### 步骤

1. Transporter 上传 `.pkg`(先 Verify 再 Deliver)
2. 等 ASC 处理(几分钟到几十分钟),状态变 `THE APP HAS FINISHED PROCESSING`
3. 回答出口合规(见上节)。**没答的 build 显示 `Missing Compliance`,进不了测试**
4. 确认测试账号是团队成员(见上)
5. TestFlight 标签页 → 建 Internal 组 → 加测试员 → **把 build 加到该组**
   (只建组、只加人而不加 build,TestFlight 里照样是空的)
6. 测试员状态会变 `Invited` —— **邀请要接受**,不是自动生效:
   去邮箱点 "View in TestFlight",或直接用同一 Apple ID 登录 TestFlight
7. 测试机装 **TestFlight.app**(Mac App Store,需 macOS 12+),安装本 app

build 有效期 **90 天**。

### 别让 build 误入审核队列

内部测试**不需要任何审核**。若 build 页面右上角出现 **Remove from Review**、
或状态是 `Waiting for Review`,说明它被提交进了 **Beta App Review**(外部测试的流程),
正占着审核队列。内部测试用不到它,点 **Remove from Review** 撤回即可。

**Beta App Review 与正式 App Review 是两回事**:前者只看"能不能跑、有无明显违规",
**不会检查 2.4.5(i) 那类具体条款**。想验证某条驳回是否修好,只能自己装上看,
等 Beta 审核通过对那个目的没有帮助。

### 装之前:挪开 DMG 版

TestFlight 装的 app 同样叫 `Transfer.app`、同样进 `/Applications`,**与 DMG 版同路径**。

```bash
mv /Applications/Transfer.app ~/Desktop/Transfer-DMG备份.app
```

两者 bundle id 不同(TCC 授权分开),测完挪回来不影响原有权限。

## 提交审核

入口在 **Distribution** 标签页,不是 TestFlight。两者是不同的流程,TestFlight 通过
与审核通过没有关系(见上节)。

### 版本号必须与 build 的 CFBundleShortVersionString 相等

**这是最容易卡住的一条**:ASC 的 Build 区只列出 `CFBundleShortVersionString` 等于
该版本记录版本号的 build。版本记录写着 1.0.0 而 build 是 1.2.1 时,Build 区里
**根本看不到那个 build**,而 ASC 不会解释为什么。

### 被拒的版本:没有"新建版本"入口,直接改版本号

一个版本被 Rejected 之后,左侧只有 `Add Platform`(那是加 iOS/tvOS 等新平台),
**没有"加版本"的按钮** —— ASC 不允许同时存在两个未发布版本。

做法是**在那个被拒的版本记录上改版本号**:版本页面往下滚找 Version 字段,
改成新 build 的版本号,Save 之后 Build 区就能选到了。

### 提交前的清单

| 项 | 位置 | 备注 |
|---|---|---|
| Version 改成 build 的版本号 | 版本页面的 Version 字段 | 不改就选不到 build |
| What's New | 版本页面 | 必填,面向用户的更新说明 |
| Build | Build 区的 `+` | 版本号对上了才出现 |
| **App Review Information → Notes** | 版本页面靠下,**或**左侧 General → App Review | 见下 |
| Sign-in required | 同上 | 本 app **没有账号系统,不要勾** —— 勾了会要求提供测试账号,而审核员照着找不到登录界面 |
| 出口合规 | 提交流程中 | 见上文的出口合规一节 |

**左侧 App Review 那一项带红色感叹号 = 有必填项没填完**,不清掉提交按钮多半是灰的。

### Notes 写什么

如果本次是**针对某条驳回的重新提交**,Notes 里直接回应那一条,能省一轮来回。
有效的写法是**先陈述事实层,再说改了什么**,而不是只说"已修复":

- 审核意见基于审核员看到的现象,而现象与根因常常不是一回事
  (本项目的 2.4.5(i):文件其实一直落在用户的下载目录,容器里那个是符号链接,
  被判"存进容器"的其实是**展示的路径字符串**)
- 附一句"How to verify",指出打开哪个界面、看哪一行 —— 审核员照着看一眼就能确认

### 本项目的驳回记录

| 版本 | 结果 | 条款 |
|---|---|---|
| 1.0.0 | Rejected | `2.4.5 Performance: Hardware Compatibility (macOS)`(即 2.4.5(i),两条意见) |

两条意见与回应:

| 意见 | 事实层 | 回应 |
|---|---|---|
| 用户数据存进了 app 容器 | 沙盒下 `app.getPath('downloads')` 返回容器内路径,但容器里的 `Downloads` 是指向 `~/Downloads` 的符号链接,文件一直落在用户的下载目录 | 设置页展示的路径过一次 `realpath`,显示 `/Users/<me>/Downloads`;落盘路径不变 |
| `files.downloads.read-write` 没有对应功能 | 审核侧没看出该权限的用途 | 接收文件夹改为可由用户选定(`files.user-selected.read-write` + security-scoped bookmark),`files.downloads.read-write` 是默认目录的依据 |

决策与边界见 [ADR-0022](../adr/0022-receive-dir-user-selectable.md) 与 [receive-dir spec](../specs/receive-dir.md)。

> **未实测**:改版本号后 Build 区是否真的能选到、`Update Review` 提交后的行为,
> 本文档写作时尚未走完。下一个提交的人补上实际表现与遇到的报错。

## 已知的坑

- **`mas-dev` 包没有 QUIET 开关**,一启动就往局域网多播 announce,会在同网设备的列表里
  留下一个用新指纹的陌生条目(默认滞留 60 分钟,见 CONTEXT.md 的 offlineKeep)。
  验完记得退出:`osascript -e 'tell application id "com.aloongplanet.transfer" to quit'`。
  按 **bundle id** 退,别按进程名——DMG 版进程同名,会误杀正在用的那个。
- **两个版本可以并存**(bundle id 不同 → userData 与单实例锁都分开),但正因为同名,
  操作时要靠 bundle id 区分。
- **`release/` 按版本号分目录**,通配取包容易拿到旧版本,见上面验收那节的第七条。

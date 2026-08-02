# 公证票据钉错了对象:只钉 DMG,用户拖出来的 App 身上没有

## 症状

从官网下载 Cursor、Claude 这类 app,拖进「应用程序」直接就能用,不弹任何框。
Transfer 的 DMG 版**签名、公证、staple、Gatekeeper 四项验证全绿**,用户却仍会被拦一道。

## 定位手法(三条命令就能分辨)

拿装在同一台机器上的其它 app 对照,比读代码快:

```bash
for A in /Applications/Claude.app /Applications/Cursor.app /Applications/Transfer.app; do
  xcrun stapler validate "$A" >/dev/null 2>&1 && echo "$A 有票据" || echo "$A 无票据"
done
```

结果:Claude 与 Cursor **有**,Transfer **无**。三者的 `codesign` 与 `spctl` 输出没有任何差别,
全是 `Developer ID Application` + hardened runtime + `Notarized Developer ID`。

隔离属性的 flag 位可以佐证"用户被拦过":

```bash
xattr -p com.apple.quarantine /Applications/Transfer.app
# 03c1;...;Chrome;...   ← 0x40 = QTN_FLAG_USER_APPROVED,用户点过"打开"
xattr -p com.apple.quarantine /Applications/Claude.app
# 0381;...;Chrome;...   ← 没有 0x40,从没弹过框
```

## 根因

公证结果是一张 ticket,`xcrun stapler staple` **只把它装订到你指定的那一个文件上**。
流水线当时只对最终 DMG 做了 staple:

- 用户双击 DMG → Gatekeeper 查 DMG 的票据 → 通过;
- 用户把 App 拖进「应用程序」→ **DMG 连同票据一起被丢掉**,App 身上什么都没有;
- App 首次启动 → Gatekeeper 只能联网向 Apple 查 → 断网直接判「无法验证是否包含恶意软件」。

DMG 是只读挂载的,公证脚本挂载后也没法给里面的 App 补钉——**唯一的时机是打 DMG 之前**。

## 为什么之前没被发现:两次修复各堵一头

这不是一开始就漏,而是修另一个问题时把这头关掉了:

| 版本 | 内置 App 公证 | DMG 公证 | 后果 |
|---|---|---|---|
| 0.9.0 | 开 | 关 | App 有票据;**DMG 没有** → 双击 DMG `spctl --type open` 判 rejected |
| 1.0.0 | **关** | 开 | DMG 有票据;**拖出来的 App 没有** → 首次启动被拦 |

`electron-builder.yml` 当时的注释写着「内置流程发生在 DMG 创建前,正式版改由脚本公证最终 DMG」——
把"发生在 DMG 创建前"当成了缺点。它恰恰是**必要条件**:只有在打包成 DMG 之前钉,拖出来的那份才带票据。

**正解是两处都钉**:App 的票据管「拖出来之后」,DMG 的票据管「打开 DMG 时」。代价是正式版每个架构
多一次公证提交(3 → 6 次)。

## 验证手段的缺陷(这才是真正该记的)

发版清单第 6 步用的是:

```bash
spctl --assess --type execute --verbose <app>   # → accepted / Notarized Developer ID
```

**这条命令在联网时会通过在线查票而成功,分辨不出票据有没有装订上。** 当时三个 DMG 全绿,
"已公证"的结论没错,但漏掉了致命细节。同理 `codesign --verify --deep` 只验签名,与票据无关。

能分辨的只有一条:

```bash
xcrun stapler validate <app>
```

已把它加进 `build/notarize-dmgs.cjs`——挂载 DMG 后对内部 `Transfer.app` 断言,
以及 github-ops 的发版验收清单。

## 一个会让修复静默失效的坑

`electron-builder` 的内置公证跑在**打包步骤内**(`macPackager.js` 的 `sign()` → `notarizeIfProvided`),
凭据缺失时它**只 warn 后静默跳过,不报错**:

```js
const options = MacTargetHelper.getNotarizeOptions(appPath)
if (!options) { log.warn(...); return }     // ← CI 照样绿,产出的 app 没票据
```

所以 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 必须注入到**打包那一步**,
只给后面的公证步骤是不够的。上面那条 `stapler validate` 断言就是这条静默路径的兜底。

## 对已发布用户的影响

1.0.0 的用户装的就是没票据的那份。升级到修复版后恢复正常;不升级也不会再被打扰——
他们已经点过一次"打开",`QTN_FLAG_USER_APPROVED` 已置位。

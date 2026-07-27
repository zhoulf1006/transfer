# 屏幕录制权限的 preflight 死锁(检查本身堵死了唯一的授权入口)

> 领域:macOS TCC 权限 · Electron API 实际行为 vs 文档假设

## 症状

用户第一次按 F1 截图,弹出"需要屏幕录制权限,请在系统设置里允许 Transfer,然后重启应用"。
照做去「系统设置 → 隐私与安全性 → 屏幕录制」——**列表里根本没有 Transfer**,无从勾选。
重启、重装、再按 F1,同一个框再来一遍。用户没有任何出路。

## 根因:一个被标成「确认」的错误前提

`docs/DESIGN.md` 曾写着(已修正):

> macOS 屏幕录制权限(**确认**):…**不能弹窗请求**,只能引导去系统设置手动开。

实现照此写成 preflight 拦截:

```ts
const status = systemPreferences.getMediaAccessStatus('screen')
if (status === 'granted' || status === 'not-determined') return true
// 否则弹引导框,直接 return false —— 永不调用 desktopCapturer
```

两个事实同时不成立,叠加成死锁:

1. **`getMediaAccessStatus('screen')` 对"从未询问过"的 app 返回 `'denied'` 而非
   `'not-determined'`**。它底层是 `CGPreflightScreenCaptureAccess()` 的布尔,**没有第三态**。
   于是那条 `not-determined` 分支在 macOS 上是死代码,全新用户一律落进 denied。
2. **macOS 只在 app 真的尝试采集时,才把它登记进「屏幕录制」列表**。
   `getMediaAccessStatus` 是纯查询,不触发登记。

合起来:

```
判定 denied → 不调 desktopCapturer → 系统不登记 app → 列表里没有它
           → 引导用户去列表里找 → 找不到 → 永远无法授权 → 永远 denied
```

**检查本身把唯一的授权入口堵死了。** 老机器不暴露,是因为早年通过别的路径授过权。

## 做法

未授权时**先探测**——真调一次 `desktopCapturer.getSources()`(1x1 缩略图即可,不需要真实画面),
那是让 macOS 弹授权框并登记 app 的唯一途径;探测后复查 status,仍未授权才弹引导框
(此时用户在列表里**找得到**本 app 了)。

决策抽成纯函数 `decideScreenPermission(platform, status, probed)`,三态返回
`proceed | probe | guide`。**关键是不按 status 细分**:非 granted 一律先探测。旧实现给
`denied` / `restricted` 写专门分支,正是 bug 的一部分。

探测**必须有界**(`probeScreenAccess(probe, timeoutMs)`):它发生在 `beginSession` 置
`capturing = true` 之后的 await 里。TCC 弹框后 `getSources` 是否挂起等用户回应未实测确认;
若挂起且用户不理,promise 永不 settle —— 走不到 catch/finally,会从「任何失败分支都回
idle,否则 state 卡死会让 F1 被永久吞」那条保护下面绕过去。加超时后这个问题的答案不再
影响正确性。

## 诊断手法(可复用)

复现"全新机器"的状态,不需要真的换机器:

```bash
tccutil reset ScreenCapture <bundleId>   # 清空该 bundle id 的全部授权记录
# 然后启动打包版按 F1
```

**判据不是"能不能截图",而是"app 有没有出现在屏幕录制列表里"** —— 修复前不会出现,
这正是死锁所在;修复后系统授权框会直接弹出来。

注意 `security find-identity -v -p codesigning` 只列**有效**身份,会把
`CSSMERR_TP_NOT_TRUSTED` 的证书整条藏掉;排查签名相关问题要用不带 `-p` 的版本。

## 走过的死路

- **只在系统设置里手动 `+` 添加 app**:能解一时,但这是用户想不到的操作,且不解决根因。
- **重启 app 以刷新状态**:`getMediaAccessStatus` 的进程内缓存确实要重启才更新
  (electron#36722),但那是**授权之后**的问题;授权之前重启多少次都没用。
- **手工把 `com.apple.application-identifier` 写进 entitlements**(排查沙盒版时):
  AMFI 会直接拒绝加载二进制,进程 7ms 静默退出、main.js 都不执行 —— 比不加更难排查。

## 一个连带的坑:同 bundle id 的两个 app 抢 TCC

调试期同时存在 DMG 版(Developer ID 签名)与 mas-dev 版(Apple Development 签名),
**bundle id 相同**。TCC 按 bundle id 记账、每条记录只绑定一份代码签名要求,于是
**两者无法同时持有屏幕录制授权**:给后者授权,前者就失效,且因为上面那个死锁,失效方
自己修不好。表现为"明明加过权限却还是弹框"。

这不只是调试期的麻烦——App Store 版与 DMG 版若共用 bundle id,**任何同时装了两者的
用户都会撞上**。相关决策见 ADR。

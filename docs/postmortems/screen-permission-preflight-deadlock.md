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

## 做法:把"询问"和"使用"在时间上分开

**启动时**(主窗显示之后)调一次 `desktopCapturer.getSources()`(1x1 缩略图即可,不需要
真实画面)。那是让 macOS 弹授权框并登记 app 的唯一途径。**按快捷键时只做检查与引导**,
不再触发询问——此时 app 已在列表里,引导才有意义。

决策收敛成一个纯函数 `needsScreenPermission(platform, status)`,只回答"够不够用"。
**关键是不按 status 细分**:非 granted 一律同等对待。旧实现给 `denied` / `restricted`
写专门分支,正是 bug 的一部分。

### 为什么不能在按快捷键时触发询问(走过的死路,实测两轮)

第一版把探测放在 F1 路径里,探测后复查 status、仍未授权就弹引导框。结果**两个框同时出现**,
用户点了我们的、系统那个被晾着没答复,**TCC 不落记录,app 照样进不了列表**——死锁绕回原点。
这不只是难看,是功能性阻断。

第二版试图用"探测是否超时"推断系统框在不在:超时=系统正在等用户,就闭嘴。**这个判据从根上
不成立**——`CGRequestScreenCaptureAccess`(以及 `getSources`)**在任何情况下都立即返回**,
从不阻塞等待用户;授权框由另一个进程异步绘制,你的 app 退出了它还挂在屏幕上。所以那个
`timeout` 分支是死代码,实测仍然弹两个框。

结论:**同一次调用里没有任何时机能安全地叠自家对话框**。只能靠把询问提前到启动来错开。

### 调用时机:必须等主窗显示之后

挂在 `start()` 里(窗口显示之前)调,**静默无框**——授权框由另一进程绘制,app 尚未成为
前台应用时 macOS 不会弹。故与网络服务一样挂在主窗 show 之后。

### 被否掉的方案:引入 `mac-screen-capture-permissions`

社区包提供 `hasPromptedForPermission()`,看似是"系统还会不会问"的准确信号。读源码后否决:
它就是**在 userData 写一个点文件、然后 `existsSync` 查它**,并非原生能力;唯一真正原生的
`hasPermissions()` 走 `CGPreflightScreenCaptureAccess`,而 Electron 的
`getMediaAccessStatus('screen')` 已经提供了同一个东西。代价却是引入首个随包分发的原生模块
(预编译产物停留在 Electron 18–21 一代、无 x64 预编译、2023-09 后无维护)加三个运行时依赖。
**严格劣于自己实现,不是权衡问题。**

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
用户都会撞上**:其中一个的截图功能会莫名失效。处置办法是给不同分发渠道用不同的
bundle id(该决策另行落 ADR,与本次修复不在同一批改动里)。

# 隐私列表里出现两个同名 app,开错那个等于没开

## 症状

安装 DMG 版 1.0.0 后按 F1,系统弹出屏幕录制授权提示,跳转到「系统设置 → 隐私与安全性 → 屏幕录制」,
列表里**已经有一个 Transfer 图标**。打开它的开关:

- 没有出现"需要重新打开 App 才能生效"的提示,开关直接变绿;
- app 没有重启,按 F1 仍然弹自己的权限引导框——**等于没开**。

退出 app 再启动,又弹一次系统权限提示;这次跳转过去,列表里**出现了第二个 Transfer**。
打开第二个的开关,系统这才提示重启,重启后截图正常。

## 为什么会有两条

TCC 按 **(bundle id + 代码签名要求)** 记账,但列表里**只显示 app 的显示名**。
两份显示名相同、身份不同的 app 会并排出现,肉眼无法分辨哪条对应哪一份。

已知会造出第二条记录的三种情况:

1. **分渠道用了不同 bundle id**(本项目的现状,见 ADR-0016):DMG 版 `com.loong.transfer`、
   App Store 版 `com.aloongplanet.transfer`。两条独立记录是这个决策的**直接后果,不是异常**——
   同时装了两个渠道版本的用户一定会看到两个 Transfer。
2. **同 bundle id、不同签名**:调试期 DMG 版(Developer ID)与 mas-dev 版(Apple Development)
   共用 id 时,两者**无法同时持有授权**,给后者授权前者就失效。这条已记在
   [screen-permission-preflight-deadlock.md](screen-permission-preflight-deadlock.md) 末节。
3. **App Translocation**:从**挂载的 DMG 里直接运行**(没有先拖进「应用程序」),Gatekeeper 会把
   app 搬到一个随机只读路径执行,构成又一个 TCC 身份。处置是先拖进 `/Applications` 再运行。

**本次没有当场核实那两条分别属于哪个身份**,所以上面哪一条是真凶没有坐实。记录下来是为了下次
遇到时不用重新推导,以及知道该怎么当场验。

## 下次怎么当场判别

隐私列表不显示 bundle id,靠肉眼分不出来。用"清空后看谁重新出现"来定位:

```bash
tccutil reset ScreenCapture <bundleId>   # 只清这一个 bundle id 的记录
# 然后启动目标 app 并触发一次采集(按 F1)
```

清空后重新出现的那条,就是这个 bundle id 对应的记录;列表里剩下的旧条目属于别的身份。
逐个 bundle id 做一遍就能把列表和身份对上号。

判据是**"该 app 有没有出现/重新出现在列表里"**,不是"能不能截图"——后者受
[preflight 死锁](screen-permission-preflight-deadlock.md)与进程内状态缓存(electron#36722)干扰,
不能用来判断授权记录的归属。

## 给用户的处置

- 装 DMG 版:**先把 app 拖进「应用程序」再打开**,不要从挂载的 DMG 窗口里直接双击运行。
- 隐私列表里若有多个同名 Transfer:把它们**全部移除**,然后只启动要用的那一份,让它自己重新申请。
  这比猜哪条是哪条可靠。

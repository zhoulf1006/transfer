# 新消息提醒(Dock/任务栏 + app 内未读)

> 状态:**已实现**(typecheck/test 254/build 绿,待 dev 双实例实测)。
> 落地:`shared/unread.ts`(`shouldCountUnread`+8 测)、`shared/ipc.ts`(EVT.windowFocus/CMD.setUnread)、`index.ts`(focus/blur+flashFrame+setBadgeCount)、`preload`、`App.tsx`(unread state+refs+累加/清零/同步+DeviceRow 角标)。
> **实现坐实的坑**:mac `setBadgeCount` 需通知权限才生效(见 §4 表)——app 内角标不受限,Dock 角标待实测。
> 需求:①收到新消息时 Dock(mac 跳/数字角标)/任务栏(Windows 闪烁)提示 ②app 内类似微信的未读提示(谁发的、多少条,点进会话清空)

## 1. 事实层(调研坐实,file:line)

**消息接收链路**:三个 recv "首次入库" handler 都在 chat-service.ts —— `handleIncomingText`(:104-120)、`handleAutoAccept`(:123-142)、`askUser`(:159-190),均 `direction:'recv'` + `upsert`(:94-99 收口)→ `onMessageUpserted` → app-core.ts:88 → index.ts:274 `send(EVT.messageUpserted, msg)` → renderer。`handleFileDone`(:226)也走 recv 但是**状态更新**(非新消息)。

**窗口可见性**:`mainWindow`(index.ts:85);现有仅 `isMinimized`(:239)/`isVisible`(:300);**无 `isFocused`、无 focus/blur 监听**——都要新增。

**renderer 消息状态**:`messages`(全量,App.tsx:52)、`peer`(当前会话 fp,:51)、`view`('chat'|'downloads',:55);切会话 `setPeer` 在 `onPick`(:120)。消息订阅 `onMessageUpserted`(:67-85),**effect 依赖数组为空(:98)→ 闭包捕获初始 peer=null**(真坑)。

**会话列表 UI**:`Sidebar`(:164-242),每项 `DeviceRow`(:181-200),alias 在 :194,`d.info.fingerprint` 是 peer 标识,点击 `onPick(fp)`(:188)。

**IPC 模式**:EVT(:34-44)/CMD(:54-86);main 发事件 `send`(:88);preload `invoke`(:22-65)/`subscribe`(:96-100)。

**现无任何未读/badge/通知代码**(grep 零命中)。

**UiMessage**:`direction 'sent'|'recv'`、`peerFp`、`peerAlias`、`createdAt`(ipc.ts:17-31)。收到消息 = `direction==='recv'`。

### Electron 提醒 API 能力边界(electron.d.ts 坐实)

- `app.setBadgeCount(n)` —— **仅 mac/Linux**(:1578),Windows 无效。mac 显示 Dock 数字角标。
- `app.dock.bounce('critical')` —— **仅 mac**(:7628),**app 未聚焦时才有效**(聚焦返 -1,:7625)。
- `win.flashFrame(true/false)` —— **跨平台**(:5183):Windows 闪烁任务栏;**mac 上会让 Dock 图标持续跳动(bounce)**,直到 focus 或 flashFrame(false)。⚠️ 这点易被误认为"仅 Windows 有效"——实测 mac 也生效且表现为跳动。
- 结论(与用户确认一致):**mac = 只数字角标(setBadgeCount),不跳** → 故 `flashFrame` **只在 `process.platform==='win32'` 调用**;mac 不调,避免 Dock 跳动。**Windows = flashFrame 闪烁**(无数字角标,setBadgeCount 在 Windows 无效)。

## 2. 决策(已与用户确认)

- **Dock/任务栏**:mac 只显示**数字角标**(总未读数);Windows **闪烁任务栏**(无数字,API 不支持)。
- **清空时机**:**点进该 peer 的会话才清零**该 peer 未读;其他 peer 未读保留。
- **提醒门控**:**正在看该会话(view==='chat' && peer===该fp)且窗口聚焦 → 不提醒、不计未读**;其余情况(窗口后台/最小化/在看别的会话/在 downloads 视图)都计未读 + 提醒。

## 3. 方案

### 3.1 状态归属:renderer 为准,同步给 main

未读增减逻辑放 **renderer**(它才知道"当前在看哪个会话"、窗口聚焦由 main 告知)。renderer 维护 `unread: Record<peerFp, number>`,算出总未读,经 IPC 把**总未读数**同步给 main;main 据此驱动 badge/flash。

- renderer 掌握:每个 peer 未读数(app 内角标)、总未读数。
- main 掌握:窗口是否聚焦(`isFocused`)、平台差异的 badge/flash 调用。
- **窗口聚焦态**:main 通过新事件 `EVT.windowFocus`(focus/blur 时 send bool)告诉 renderer,renderer 据此决定"新消息算不算未读"。

### 3.2 未读累加逻辑(renderer)

> ⚠️ **踩坑修复(发 1 条显示 2)**:未读累加**必须放在 `setMessages` updater 之外**。React state updater 必须是纯函数,StrictMode 会**双调**它;若在 updater 里 `setUnread`,累加执行两次 → 未读翻倍。**修法**:在 `onMessageUpserted` 回调体里用 `seenIdsRef`(Set)幂等判定"是否首次见到该 id",只在首见时 `setUnread` 一次,`setMessages` 只管消息列表。初始 `listMessages` 的历史 id 也登记进 seenIds,避免同 id 再 upsert 被误判为新。

在 `onMessageUpserted` 里,对每条到达的 msg:
```
isNew = !seenIdsRef.has(m.id)          // 幂等,不受 updater 调用次数影响
若 isNew:
  seenIdsRef.add(m.id)
  若 shouldCountUnread(recv && isNew && !正在看该会话):
    unread[msg.peerFp] += 1
setMessages(...)                        // updater 内只做列表更新,无副作用
```
- **只对新消息**(append 分支,非 update)累加——避免状态更新(如文件 done)误加。调研已确认 upsert 不分 insert/update,但 renderer 侧 `findIndex(x.id)`(:75)天然能区分:找不到=新消息。
- **闭包陷阱修复**:`peer`/`view`/`windowFocused` 用 **ref**(`useRef`)存最新值,effect 内读 ref.current;或把订阅重构为依赖 `[peer, view, windowFocused]`。选 **ref 方案**(不重订阅、开销小)。

### 3.3 清零(renderer)

"正在看某会话"时清该 peer 未读。语义:`view==='chat' && peer && 窗口聚焦 && 该peer未读>0` → 置 0。

> ⚠️ **踩坑修复(呼出后不清零)**:清零 effect 依赖**不能只是 `[peer, view]`**。场景:窗口后台时你已停在 peer A 会话,A 来消息累加未读;点 Dock 呼出窗口 → **peer/view 都没变**(本来就选中 A)→ `[peer,view]` effect 不触发 → 角标清不掉,再点该人/会话仍无反应(依赖仍不变)。
> **修法**:依赖改为 `[peer, view, focused, peerUnread]`(`peerUnread` = 当前 peer 的未读数)。这样覆盖三种情形:①切进会话(peer/view 变)②聚焦回来(focused false→true)③已在会话上又来新未读(peerUnread 变)。`focused` 必须是 **state**(驱动 effect),同时镜像到 `focusedRef`(供消息回调闭包读)。

### 3.4 同步给 main + 平台提醒

- 新 `CMD.setUnread(total: number)`:renderer 每次 unread 变化后调用,把总未读传给 main。
- main handler:
  - `app.setBadgeCount(total)` —— mac 显示/隐藏(0=隐藏)数字角标。Windows 上此调用无害(返回 false,不报错)。
  - Windows 闪烁:**不由 setUnread 驱动**(那是持续状态),而在**新消息到达且窗口未聚焦**时于 main 侧触发 `mainWindow.flashFrame(true)`;窗口 focus 时 `flashFrame(false)`。**必须 `process.platform==='win32'` 门控**——否则 mac 上 flashFrame 会让 Dock 跳动(违反"mac 不跳"),这是实测踩到的坑。
- **mac 不 bounce**:用户明确"mac 只数字角标、不跳"。故 mac 既不调 bounce 也不调 flashFrame。

### 3.5 main 侧新消息提醒触发

在 index.ts `onMessageUpserted` 回调内(main 侧),对 **`process.platform==='win32'` &&** `msg.direction==='recv'` && `!mainWindow.isFocused()` 时:
- Windows:`mainWindow.flashFrame(true)`。
- **mac 不进此分支**(平台门控):否则 flashFrame 会让 Dock 跳动。mac 的角标由 renderer 的 setUnread 驱动,不在此处。
- **注意**:index.ts:274 对状态更新也触发,需过滤——只在"新 recv 消息"提醒。但 main 侧难区分 insert/update(upsert 不分)。**取舍**:main 侧的 flashFrame 用 `direction==='recv'` + `!isFocused` 触发即可,状态更新(如 handleFileDone)偶尔多闪一次可接受(flashFrame 幂等,窗口 focus 即停);要严格则在 chat-service 三个 recv handler 里加注入回调,较重。**先用 index.ts:274 + direction 过滤的轻方案**。

### 3.6 窗口 focus/blur(main)

新增(index.ts createWindow 内):
```
mainWindow.on('focus', () => { mainWindow.flashFrame(false); send(EVT.windowFocus, true) })
mainWindow.on('blur', () => send(EVT.windowFocus, false))
```
renderer 订阅 `onWindowFocus` 更新 `windowFocused` ref。

### 3.7 app 内未读角标 UI

- `Sidebar` 加 `unread: Record<fp,number>` prop(App 下传)。
- `DeviceRow`(App.tsx:181-200)名字行加红点角标:未读>0 显示数字(>99 显示 99+),仿 `S.dot`(:821)加 `S.unreadBadge` 样式(红底白字圆角)。

## 4. 边界 / 失败模式(前置纸面)

| 场景 | 处理 |
|---|---|
| 窗口聚焦 + 正看该会话,来新消息 | 不计未读、不闪/不角标(门控) |
| 窗口聚焦但在看别的会话/downloads | 计未读 + 角标;Windows 不闪(已聚焦,flashFrame 聚焦时无效)。mac 角标更新 |
| 窗口后台/最小化,来新消息 | 计未读 + mac 角标 + Windows 闪 |
| 同一 peer 连来多条 | 未读累加,角标显累计数 |
| 点进会话 | 清该 peer 未读 → 总未读减 → setUnread → mac 角标更新;Windows 已 focus 自动停闪 |
| 发送态/状态更新(sent/done/progress) | `direction!=='recv'` 或非 append → 不计未读 |
| 文件 done 状态更新(recv 但非新消息) | renderer:findIndex 找到=update 分支,不计;main:可能多闪一次(可接受,focus 即停) |
| 闭包捕获旧 peer/view | **用 ref 存最新值**(核心坑,必修) |
| Windows setBadgeCount 无效 | 调用无害返 false;Windows 未读体现在 app 内角标 + 任务栏闪 |
| 总未读=0 | `setBadgeCount(0)` 隐藏 mac 角标 |
| 多实例测试 | 各自窗口独立,badge/flash 互不干扰 |
| **mac badge 需通知权限**(实现阶段坐实,electron.d.ts:1575) | `app.setBadgeCount` 在 mac 上"需 app 有显示通知的权限才生效"。本 app 未请求通知权限 → **Dock 数字角标可能不显示**。`setBadgeCount` 返 boolean 可检测但未处理。**dev 实测确认**:若角标不出,需后续加 `Notification` 权限请求或改用其它角标方案。app 内未读角标不受此限,始终可见。 |
| app 启动时遗留 pending(onStartup 标 expired) | 那是启动清理,不产生 recv 新消息事件,不误触发 |

## 5. 影响面 / 改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/ipc.ts` | `EVT.windowFocus`;`CMD.setUnread`。 |
| `src/main/index.ts` | createWindow 加 focus/blur 监听(flashFrame(false)+send windowFocus);`onMessageUpserted`(:274)加 recv+!isFocused→flashFrame(true);`ipcMain.handle(CMD.setUnread)`→app.setBadgeCount。 |
| `src/preload/index.ts` | `onWindowFocus` subscribe;`setUnread` invoke。 |
| `src/renderer/src/App.tsx` | `unread` state + `windowFocused`/`peer`/`view` ref;onMessageUpserted 累加;useEffect 清零;setUnread 同步;Sidebar 传 unread。 |
| `src/renderer/src/App.tsx`(Sidebar/DeviceRow) | 未读角标 UI + 样式。 |
| `docs/` | 本文;DESIGN 若涉及则同步。 |

## 6. 成功标准 / 验证

1. typecheck + test + build 绿。
2. 纯逻辑可单测的抽出:未读累加判定(是否计未读:入参 direction/isNew/focused/view/peer/msgPeer → bool),单测覆盖门控矩阵。
3. dev 实测(需两实例/两机):窗口后台收消息 → mac 角标出现数字 + Windows 任务栏闪;点进会话 → 角标清、停闪;在看该会话时收消息 → 无提醒;在看别的会话收消息 → 该 peer 角标+总角标。
4. 回归:消息收发、进度、现有设置不变。

## 7. 分步实现(带检查点)

1. 抽未读判定纯函数 `shouldCountUnread(...)` + 单测 → test 绿。✅门控矩阵。
2. shared: EVT.windowFocus + CMD.setUnread → typecheck。
3. main: focus/blur + flashFrame + setBadgeCount handler → typecheck。
4. preload: onWindowFocus + setUnread → typecheck。
5. renderer: unread state + refs + 累加/清零 + setUnread 同步 → build。✅闭包用 ref。
6. UI: Sidebar/DeviceRow 未读角标 → build。
7. dev 实测(角标/闪烁/清零/门控)。
8. 回同步 DESIGN。
9. 全绿后发版(v0.5.0,较大功能走 minor)。

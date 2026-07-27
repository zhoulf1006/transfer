# 实现踩坑集(截图 / renderer / 全局快捷键)

从旧设计文档(screenshot-feature、unread-notification、custom-shortcut)抽出的**踩坑因果链**——它们不是决策(不进 ADR)、不是术语(不进 CONTEXT.md)、也不是用户可见行为(不进 features),但都属于"不知道就会踩、且测试不易触发"的类型。原设计文档已删,本文是这些教训的唯一留存。

按 ADR-0013 属"复盘/踩坑叙事",持久保留。

---

## 一、截图与 Canvas

### 高 DPI:两类 canvas 不能用同一套 dpr 惯例

**症状**:Retina 上底图放大 2 倍、只显示左上 1/4 且发糊。

**根因**:双层 canvas 里两层性质不同——
- **标注层**画的是矢量元素、存逻辑坐标,要按 dpr 惯例:`canvas.width = cssW × dpr` + `style.width = cssW` + `ctx.scale(dpr,dpr)`;
- **底图层**内容本身就是**物理像素位图**,**绝不能套 dpr scale**:`canvas.width = bitmapW`、`style.width = bitmapW/dpr`、`drawImage` 源=目标 1:1。套了就等于把物理位图再放大一次。

**连带的坑**:导出到物理位图时,不只坐标要换算,**长度量**(线宽、字号、箭头头长、序号圆半径)也必须 × ratio,否则 Retina 下线只有一半粗、字只有一半小。等比时用 ratio;非等比时线宽/字号取 `Math.min(ratioX, ratioY)` 避免各向异性。

**另一处**:实测 ratio 要用两轴分别算,不能直接用 `scaleFactor`。

### 截图副本必须落持久目录,发送成功后不删

**症状**:发送端的图片消息不显示缩略图,回退成文件图标。

**根因**:早期把截图写进 `temp/`,`sendFiles` 一 resolve 就 `unlink`。但发送方消息的 `filePath` 指向的正是这个文件,UI 的缩略图/看大图/另存为全部按 `filePath` 读盘 → 读到已删文件 → `nativeImage.isEmpty()` → 回退图标。

**做法**:落 `userData/sent-images/`(持久),**成功保留、失败才删**(失败消息无保留价值)。已知 tradeoff:副本随发送累积,清理策略未做。

### 先抓屏再显示遮罩,否则自截

**根因**:遮罩显示后再抓屏,抓到的是遮罩自己。顺序必须是"抓干净位图 → 再 show 遮罩"。聊天区按钮触发的截图还需先 hide 主窗,并留 `HIDE_SETTLE_MS` 200ms 等窗口真正消失。

### mac 上 `type:'panel'` 会让 Dock 图标消失

**根因**:panel 会把 app 的 activation policy 降到 accessory。原方案用 panel 是为了浮在别的 app 全屏之上,代价是 Dock 图标没了。

**做法**:不用 panel,改 `setAlwaysOnTop(true, 'screen-saver')`(level ≥ `pop-up-menu` 才盖 Dock/任务栏)且不改 activation policy。代价:不能在别的 app 原生全屏上截图,普通截图不受影响。连带去掉 `setVisibleOnAllWorkspaces`(那是配合 panel 的)。

### 遮罩上的可点 UI 必须 stopPropagation

**根因**:工具条等浮层若不阻止冒泡,点击会被根容器当作"框选空白"而清空选区。

### textarea 聚焦不能靠 autoFocus

**根因**:Electron 下 autoFocus 不可靠;且连续开框时 boolean 依赖不翻转 → effect 不重跑,第二次开框聚焦失效。

**做法**:rAF 里手动 focus,并用**自增 key**(而非 boolean)驱动每次开框。

### 撤销栈存对象快照,不存位图

存 `structuredClone` 的元素数组;存位图快照内存会爆。导出用**独立离屏 canvas 按原图物理尺寸重绘**,别拿显示 canvas 直导(会缩放失真)。

---

## 二、renderer 状态(未读计数)

### StrictMode 双调致未读翻倍

**症状**:对方发 1 条,未读显示 2。

**根因**:`setUnread` 被放在 `setMessages` 的 updater 内部,React StrictMode 下 updater 会被调用两次。

**做法**:用 `seenIdsRef` 判"首见"做幂等,不依赖 updater 只跑一次。

### 清零 effect 的依赖不能只写"最小集"

**症状**:app 在后台收到消息后,点 Dock 呼出窗口,角标不清零。

**根因**:清零 effect 依赖只写了 `[peer, view]`,而"后台 → 呼出"这个路径里 peer 和 view 都没变,effect 不重跑。

**做法**:依赖须为 `[peer, view, focused, peerUnread]`,且 `focused` 必须是 state(不能只有 ref)才能驱动重渲染。教训与 memory 的「effect 依赖由场景推导,不由『最小』推导」同源。

### `flashFrame` 在 mac 会让 Dock 持续跳

**根因**:名字看起来是"闪一下任务栏",mac 上的实际行为是 Dock 图标持续弹跳。

**做法**:`platform === 'win32'` 门控。

---

## 三、全局快捷键

### `globalShortcut` 的能力边界(决定了产品只能"提示换键")

- `register()` 被别的 app 占用时**静默返回 false**,没有异常;
- `isRegistered()` **只反映本 app**,探测不到别的 app 占用;
- OS **禁止互抢**,无法覆盖别 app 已注册的快捷键。

**推论**:冲突检测只能"注册试错",无法预知、无法强占——所以 UI 只能提示用户换一个键。

### 改键失败必须回滚旧键

**根因**:`rebindShortcut` 是"注销旧 → 注册新",新键注册失败时若不回滚,用户不但没改成,连原来的截图键也没了。

### 异步结果被同步清理覆盖

**症状**:改键冲突时,红字提示一闪而过看不见。

**根因**:录制 UI 的 `onBlur` 无条件清 hint,而冲突提示是异步返回后才写进去的,正好被这个同步清理覆盖。

**做法**:仅在 `recording` 态才因失焦清提示。这是"异步结果被同步清理覆盖"的通用模式,别处也会遇到。

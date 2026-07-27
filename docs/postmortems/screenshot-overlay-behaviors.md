# 截图遮罩窗的四个反直觉行为

> 领域:截图遮罩(overlay)· Electron 窗口 / 事件 / 焦点

四条各自独立、但都属于"照直觉写就会错"的遮罩窗行为。

## 一、mac 上 `type:'panel'` 会让 Dock 图标消失

**根因**:panel 会把 app 的 activation policy 降到 accessory。原方案用 panel 是为了让遮罩浮在别的 app 的原生全屏之上,代价是 **Dock 图标没了**。

**做法**:不用 panel,改 `setAlwaysOnTop(true, 'screen-saver')`(level 须 ≥ `pop-up-menu` 才盖得住 Dock/任务栏),且**不改 activation policy**。

**代价(已接受)**:不能在别的 app 原生全屏上截图;普通截图不受影响。连带去掉 `setVisibleOnAllWorkspaces`——那是配合 panel 用的。

## 二、必须先抓屏再显示遮罩,否则自截

**根因**:遮罩显示后再抓屏,抓到的是遮罩自己。

**做法**:顺序恒定为"抓干净位图 → 再 show 遮罩"。从聊天区按钮触发截图时还需先 hide 主窗,并留 `HIDE_SETTLE_MS`(200ms)等窗口真正消失,否则主窗会被拍进图里。

## 三、遮罩上的可点 UI 必须 stopPropagation

**根因**:工具条等浮层若不阻止冒泡,点击会冒到根容器、被当作"框选空白"而**清空当前选区**。

## 四、textarea 聚焦不能靠 autoFocus

**根因**:两个叠加原因——Electron 下 `autoFocus` 本就不可靠;且连续开框时若用 boolean 作 effect 依赖,第二次开框依赖值不翻转 → effect 不重跑 → 聚焦失效。

**做法**:在 `requestAnimationFrame` 里手动 `focus()`,并用**自增 key**(而非 boolean)驱动每次开框。

## 附:撤销栈存对象快照,不存位图

存 `structuredClone` 的元素数组;存位图快照内存会爆。导出用**独立离屏 canvas 按原图物理尺寸重绘**,别拿显示 canvas 直导(会缩放失真)。

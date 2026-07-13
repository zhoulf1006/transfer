# 截屏功能 — 需求与进度

> 归属:Transfer(局域网传输 + 聊天)。截屏定位为**「截图 → 直接发给对方」**的轻量工具,与传输/聊天场景强绑定,不做成通用桌面截图软件。
> 本文档跟踪需求与七步流程进度。设计细节最终并入 [DESIGN.md](./DESIGN.md)。

---

## 七步流程进度

| 步骤 | 阶段 | 状态 | 完成度 | 备注 |
|------|------|------|:---:|------|
| 1 | 需求调研 | ✅ 完成 | 100% | 调研 Snipaste 官方 wiki(两 agent 交叉验证);功能清单 + 范围决策已定,见 §1/§2 |
| 2 | 出方案(设计文档) | ✅ 完成 | 100% | 技术前置调研 §3 + 完整设计方案 §4(架构/状态机/IPC 契约/标注数据结构/边界失败模式/实现顺序) |
| 3 | review 方案 | ✅ 完成 | 100% | 5 Opus/max agent 对抗式审 + 交叉汇总,6 blocker+19 major 已逐条修进 §3/§4/§4.7;3 个产品决策已定 |
| 4 | 实现 | ⏳ 就绪 | 0% | 方案已补全,可开工。按 §4.6 七阶段推进 |
| 5 | review 代码 | ⬜ 未开始 | 0% | |
| 6 | review 测试 | ⬜ 未开始 | 0% | |
| 7 | 回同步 design | ⬜ 未开始 | 0% | |

**当前所处**:第 3 步(review 方案)已完成,方案补全,准备进入第 4 步(实现)。

**第 3 步产品决策(已确认)**:① 发聊天=没选对象则按钮禁用(仍可复制/保存);② editing 中按 F1=忽略;③ 多屏其余屏也压暗+吞点击。

图例:✅ 完成 · ⏳ 进行中/就绪 · ⬜ 未开始

---

## Story 追踪清单

功能点(story)级别的进度。两个维度分开标:
- **需求**:该 story 的需求是否已确认(✅ 已确认 / ❓ 待确认)。
- **实现**:⬜ 未开始 · 🔨 进行中 · ✅ 已完成 · ⏸️ 暂缓(P2)。**完成度**指实现完成度。

优先级:**P0** 第一版必做 · **P1** 第一版应做 · **P2** 后续增强。

### 模块 A — 触发 & 会话
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| A1 | 全局快捷键 `F1` 触发截图会话 | P0 | ✅ | ⬜ | 0% |
| A2 | 抓取光标所在屏画面 | P0 | ✅ | ⬜ | 0% |
| A3 | 全屏遮罩层(未框选压暗) | P0 | ✅ | ⬜ | 0% |
| A4 | `Esc` 取消会话 | P0 | ✅ | ⬜ | 0% |

### 模块 B — 区域选取
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| B1 | 手动拖拽框选矩形 | P0 | ✅ | ⬜ | 0% |
| B2 | 选区内亮 / 外压暗 | P0 | ✅ | ⬜ | 0% |
| B3 | 实时 W×H 尺寸标签 | P0 | ✅ | ⬜ | 0% |
| B4 | 拖锚点(四边四角)调大小 | P0 | ✅ | ⬜ | 0% |
| B5 | 拖选区整块移位 | P0 | ✅ | ⬜ | 0% |
| B6 | 方向键像素级微调(移动/Ctrl 扩/Shift 缩) | P1 | ✅ | ⬜ | 0% |
| B7 | 全屏快捷键 / 右键重新框选 | P1 | ✅ | ⬜ | 0% |
| B8 | 选区过小时锚点自动隐藏 | P1 | ✅ | ⬜ | 0% |

### 模块 C — 取色放大镜
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| C1 | 像素级放大镜 + 中心十字 | P1 | ✅ | ⬜ | 0% |
| C2 | 显示坐标 (x,y) + 颜色值(RGB/HEX) | P1 | ✅ | ⬜ | 0% |
| C3 | 滚轮调放大倍率 | P1 | ✅ | ⬜ | 0% |
| C4 | 快捷键复制颜色值 / 切换 RGB↔HEX | P1 | ✅ | ⬜ | 0% |

### 模块 D — 标注工具(对齐 Snipaste)
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| D1 | 矩形 | P0 | ✅ | ⬜ | 0% |
| D2 | 椭圆 | P1 | ✅ | ⬜ | 0% |
| D3 | 直线 | P1 | ✅ | ⬜ | 0% |
| D4 | 箭头 | P0 | ✅ | ⬜ | 0% |
| D5 | 画笔(自由绘) | P0 | ✅ | ⬜ | 0% |
| D6 | 马克笔 / 荧光笔 | P1 | ✅ | ⬜ | 0% |
| D7 | 马赛克 | P1 | ✅ | ⬜ | 0% |
| D8 | 高斯模糊 | P1 | ✅ | ⬜ | 0% |
| D9 | 文字 | P0 | ✅ | ⬜ | 0% |
| D10 | 序号步骤标注 | P1 | ✅ | ⬜ | 0% |
| D11 | 可调项:颜色 / 透明度 / 粗细 | P0 | ✅ | ⬜ | 0% |
| D12 | 撤销 / 重做 / 清空 | P0 | ✅ | ⬜ | 0% |

### 模块 E — 输出去向
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| E1 | 发到当前聊天(核心) | P0 | ✅ | ⬜ | 0% |
| E2 | 复制到剪贴板 | P0 | ✅ | ⬜ | 0% |
| E3 | 保存为文件 | P1 | ✅ | ⬜ | 0% |

### 模块 F — 后续增强(P2,暂缓)
| ID | Story | 优先级 | 需求 | 实现 | 完成度 |
|----|-------|:---:|:---:|:---:|:---:|
| F1 | 滚轮 UI 元素层级检测(外框→内框) | P2 | ✅ | ⏸️ | 0% |
| F2 | 自动窗口/控件高亮检测 | P2 | ✅ | ⏸️ | 0% |
| F3 | 多屏跨屏拖选 | P2 | ✅ | ⏸️ | 0% |

> 明确排除(直接不做):**延时截图**、钉图、OCR、滚动长截图、录屏/GIF。

**汇总**:P0 共 15 个 story,P1 共 13 个,P2 共 3 个(暂缓)。当前全部处于「需求已确认、实现未开始」——因方案(第 2 步)尚未开始。

---

## 1. 需求范围(已与用户确认)

### 1.1 核心目标
截图 → 直接发给对方。轻量,与传输场景强绑定。**不做**通用桌面截图工具(不对标 Snipaste 全集)。

### 1.2 输出去向(三个)
1. **发到当前聊天**(核心场景)
2. **复制到剪贴板**
3. **保存为文件**

> 不做:钉图(贴到屏幕)。

### 1.3 标注工具
尽量全,对齐 Snipaste:矩形、椭圆、直线、箭头、画笔、马克笔/荧光笔、马赛克、高斯模糊、文字、序号步骤。
可调项:颜色、透明度、画笔粗细。(详细行为待 §2 方案展开。)

### 1.4 明确不做
钉图、OCR、滚动/长截图、录屏/GIF。

---

## 2. 截屏核心功能定稿(第一版)

### 2.1 触发 & 环境
- **快捷键**:全局 `F1`。
- **多屏**:第一版只截**光标所在屏**。多屏跨屏 → P2。

### 2.2 会话流程
触发 → 抓光标所在屏画面 → 全屏遮罩层(未框选时压暗 + 放大镜)→ 手动框选 → 选区内亮/外压暗 + W×H 尺寸标签 + 工具条 → 标注 → 输出(发聊天 / 复制 / 存文件)或 `Esc` 取消。

### 2.3 区域选取(第一版 · 纯手动)
| 能力 | 行为 |
|------|------|
| 手动框选 | 按住左键拖拽画矩形 |
| 拖锚点调大小 | 四边四角 8 锚点;选区过小时隐藏 |
| 拖整块移位 | 选区内部拖动,不改大小 |
| 像素微调 | 方向键移选区;**跟手方向**:Ctrl+方向键把该方向那条边界外扩 1px、Shift+方向键内收 1px(如 Ctrl+↑=上边外扩、Ctrl+↓=下边外扩) |
| 实时尺寸 | 选区旁显示 W×H |
| 全屏 / 重选 | 全选快捷键;右键重新框选 |

### 2.4 取色放大镜
- 像素级放大镜 + 中心十字。
- 显示坐标 (x,y) + 颜色值(RGB / HEX,可切换)。
- **滚轮调放大倍率**(不是缩放选区)。
- 快捷键复制颜色值。

### 2.5 第一版不做(降级 P2 / 后续)
- ❌ **滚轮 UI 元素层级检测**(外框→内框逐层)—— 见 §3 技术前提未坐实,风险高。
- ❌ **自动窗口/控件高亮检测** —— 与层级检测同源(都依赖 OS 控件树),一并 P2。
- ❌ 多屏跨屏拖选(先只截光标所在屏)。
- ❌ 延时截图、钉图、OCR、滚动长截图、录屏。

---

## 3. 技术前置调研结论(第 2 步 · 已坐实)

三个独立 agent 调研,证据来自本机 `node_modules/electron/electron.d.ts`(v35.7.5,标 d.ts:行)、Electron 35 官方文档(verbatim)、本项目源码(file:line)。三份结论互不冲突。**电量环境:Electron 35.7.5**。

### 3.1 抓屏 & 高 DPI 坐标对齐(框选最大坑)
- **抓光标屏原生位图**:`getCursorScreenPoint()` → `getDisplayNearestPoint()` → `desktopCapturer.getSources({types:['screen'], thumbnailSize: size × scaleFactor})`。thumbnail 是 `NativeImage`,`toPNG()`/`crop()` 齐全。[d.ts:7219, 7238, 11201, 9285]
- ⚠️ **实际返回尺寸不保证等于传入的 thumbnailSize**(系统缩放决定),**必须以 `thumbnail.getSize()` 实测为准**。[d.ts:7252-7258]
- ⚠️ **DPI 对齐**:遮罩窗口铺在 `display.bounds`(**DIP 逻辑像素**),用户框选是逻辑坐标;位图是**物理像素**。裁剪换算:`物理 = Math.round(逻辑 × scaleFactor)`,再 `thumbnail.crop()`。稳妥用**实测 ratio** `getSize().width / display.size.width` 代替裸 scaleFactor,吸收系统偏差。常见错:忘 ×scaleFactor(Retina 只截 1/4)、1.5 倍不取整累积漂移。[d.ts:7539, 11000]
- **多屏对应**:`source.display_id === String(display.id)`;`display_id` 可能空串要兜底(name 的 index ≠ 数组下标)。[d.ts:7238]
- **时序**:getSources 异步、有几十~几百 ms 开销。理论上"先弹遮罩、并行抓屏"可降感知延迟,**但会自截(遮罩窗自己被拍进快照)**,故方案最终改为「**先抓屏拿干净位图 → 再 show 遮罩**」(见 §4.2,自截优先于延迟)。感知延迟改由"show 时背景先占位、位图到达再换"缓解。[d.ts:7219, 21896]

### 3.2 全屏遮罩窗 & 快捷键 & 剪贴板
- **透明遮罩窗**:`transparent:true`(Win 必须 `frame:false`)+ `resizable:false`(透明窗不可 resize,否则某些平台失效)+ `skipTaskbar` + `type:'panel'`(mac 浮在全屏 app 上)+ `enableLargerThanScreen`。铺满用 `setBounds(display.bounds)`,**不能用 maximize()**(透明窗禁用)。[Electron custom-window-styles / base-window-options,verbatim]
- ⚠️ **盖 macOS Dock**:`setAlwaysOnTop(true, 'screen-saver')`(level 须 ≥ `pop-up-menu` 才在 Dock 之上)+ `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})`。**盖顶部菜单栏部分 mac 版本不稳 → 实现时实测**。不用 kiosk/simpleFullscreen。[browser-window,verbatim + GitHub issue]
- **F1 全局快捷键**:app ready 后 `globalShortcut.register('F1', cb)`,**返回 false = 被占用静默失败**,`will-quit` 时 `unregisterAll()`。⚠️ 需**提供可改键 + 返回值兜底**(F1 在 Win 常被前台 app 当帮助键)。[global-shortcut,verbatim]
- **剪贴板写图**:`nativeImage.createFromDataURL(canvas.toDataURL())` → `clipboard.writeImage(img)`。微信/QQ/浏览器应能正常粘贴(需实测)。[clipboard / native-image]
- **遮罩窗生命周期**:hide 复用而非 close(避免重建渲染进程);每次 show 前重设 bounds(光标可能换屏)+ 重设 alwaysOnTop/清上次框选。

### 3.3 Canvas 标注编辑器
- **架构**:**retained-mode 对象数组(scene graph)+ 双层 canvas**(底图一层几乎不重绘 / 标注 overlay 一层每次 clear+全量重绘)。每个标注 = `{id, type, 几何, style}` 对象 → 直接支撑撤销重做/二次编辑/马赛克模糊重算。[MDN Canvas API]
- **各标注画法**:矩形 `strokeRect`、椭圆 `ellipse`、直线 `moveTo/lineTo`、箭头(直线+终点两条回退线 `atan2` 算角)、画笔(点数组 `lineTo` + round join/cap)、马克笔(半透明+粗)、**马赛克**(区域缩小再 `imageSmoothingEnabled=false` 放大回去)、**高斯模糊**(`ctx.filter='blur(Npx)'`,Chromium 可用)、**文字**(编辑态叠加 `<textarea>`、提交转对象用 `fillText`)、序号(计数器 + `arc`+`fillText`)。模糊/马赛克用 `clip()` 限定区域。[MDN 各 API]
- **撤销/重做**:存**对象数组快照**(`structuredClone`),不存位图快照(内存爆)。undo/redo 只动 elements 数组 + 重绘。
- **导出**:用**独立离屏 canvas 按原图物理尺寸重绘**(别用显示 canvas 直导,会缩放失真);`toBlob('image/png')` 优于 `toDataURL`(免 base64 膨胀)。
- **高 DPI(区分两类 canvas,blocker#5)**:
  - **标注 overlay 层**(画矢量元素,存逻辑坐标):显示时用 dpr 惯例 `canvas.width = cssW × dpr` + `style.width = cssW` + `ctx.scale(dpr,dpr)` 让线条清晰。
  - **底图层**(内容=物理像素位图):**不套 dpr scale**!`canvas.width = bitmapW`、`style.width = bitmapW/dpr`、`drawImage(img,0,0)` 源=目标=物理像素 1:1 贴;或直接用一张 `<img>` 铺背景不进 canvas。⚠️ 若把 dpr 惯例套到底图层 → 物理位图被 `ctx.scale(2,2)` 再放大一次 → 底图放大 2 倍只显示左上 1/4 且糊(Retina 双层 canvas 最易踩的坑)。
  - 显示层按 dpr、导出层按原图物理尺寸,两套坐标别混。[MDN devicePixelRatio]
- **尺寸量也要 × ratio(major)**:导出到物理位图时,不只坐标(x/y/w/h/points),**长度量**(`style.width` 线宽、`text.fontSize` 字号、箭头头长、badge 半径)也必须换算,否则 Retina 下线只有一半粗、字只有一半大。等比时 =ratio;非等比时线宽/字号用 `Math.min(ratioX,ratioY)`(避免各向异性)。lineWidth/font 在离屏导出 ctx 上都要换算后再设。

### 3.4 ⚠️ 接入现有发送链路(关键约束,读项目源码坐实)
- **消息类型**:截图归 **`type:'file'` 消息**,不需新消息类型(`MessageType = 'text'|'file'`)。[src/shared/ipc.ts:6]
- ⚠️ **发送方只接受磁盘路径,无 buffer 入口**:`ChatService.sendFiles(peerFp, filePaths: string[])` [chat-service.ts:306] → http-client 全程用路径:`statSync(path).size` [http-client.ts:46/91]、`readFile(path)` 算 sha256 [http-client.ts:38]、`createReadStream(path)` 流式上传 [http-client.ts:102]。
- **最小改动接入方案**:canvas 导 PNG buffer → **新增 `saveTempImage(buffer)` IPC 在 main 写临时文件**(`app.getPath('temp')`,命名如 `截图_yyyyMMdd_HHmmss.png`,接收端显示名来自 `basename(path)` [http-client.ts:45])→ 拿路径调现有 `sendFiles`。发送/接收/入库/进度/sha256/去重全部原样复用。
- ⚠️ **临时文件清理必须等 `sendFiles` 的 Promise resolve 之后**(流式 `createReadStream` 读,删早了读到一半失败)。

### 3.5 层级检测可行性(P2 前提,尚未调研)
依赖 OS 无障碍/UIAutomation 拿控件树;跨进程、网页内部(Chromium DOM)很可能穿透不到,**能否 1:1 复刻 Snipaste 未坐实**。平台优先级(Win UIAutomation 更成熟且不需授权)待此调研后定。**第一版不做,故不阻塞**。

---

## 4. 设计方案

基于 §3 调研结论。第一版目标:F1 → 截光标屏 → 遮罩层框选 → canvas 标注 → 发聊天/复制/存文件。

### 4.1 架构 & 进程职责

新增一个**独立的全屏遮罩 renderer 入口**(不与主聊天窗混),main 进程管系统能力,两者经 IPC 通信。

```
┌─ main 进程 ────────────────────────────────────────────┐
│ ScreenshotService(新增)                                 │
│  · globalShortcut F1 注册/兜底                           │
│  · getCursorScreenPoint → getDisplayNearestPoint(选屏)  │
│  · desktopCapturer 抓光标屏原生位图(并行,见时序)         │
│  · 创建/复用透明遮罩 BrowserWindow(铺 display.bounds)    │
│  · mac 屏幕录制权限检测/引导                              │
│  · saveTempImage(buffer)→ 临时文件路径                   │
│  · 复制到剪贴板(clipboard.writeImage)                    │
│  · 转发"发聊天"到现有 ChatService.sendFiles              │
└────────────────────────────────────────────────────────┘
        ▲  IPC(新增 CMD.shot* / EVT.shot*)  ▼
┌─ 遮罩 renderer(新入口 overlay.html)───────────────────┐
│ OverlayApp(React,全屏透明)                              │
│  · 背景 = main 抓到的屏幕快照(所见即所截)                │
│  · 选区层:框选/锚点/移位/像素微调/放大镜取色             │
│  · 标注层:canvas 编辑器(retained-mode 对象数组)         │
│  · 工具条 + 输出(发聊天/复制/保存/取消)                  │
└────────────────────────────────────────────────────────┘
```

**为什么独立入口**:遮罩是临时全屏透明窗,与主窗口(900×640 聊天)生命周期、样式、preload 能力都不同。electron-vite 支持多入口。

**electron-vite 多入口**(现为单入口 `src/renderer/index.html`):新增 `src/renderer/overlay.html` + `src/renderer/src/overlay.tsx`;`renderer.build.rollupOptions.input` 显式列 `{ index, overlay }`。加载抽成 `loadRenderer(win, entry:'index'|'overlay')`:
- **dev**:`index` → `loadURL(ELECTRON_RENDERER_URL)`(**裸 origin 不拼文件名,保持主窗现状**);`overlay` → `loadURL(\`${ELECTRON_RENDERER_URL}/overlay.html\`)`。
- **prod**:`loadFile(join(__dirname, \`../renderer/${entry}.html\`))`。
- ⚠️ **主窗加载保持原样,只有遮罩窗拼 `/overlay.html`**,别把主窗 dev 改成拼 `/index.html`(会破坏根路由)。现有加载逻辑在 **index.ts:47-51**(方案早期误写 57-61)。

**遮罩窗 webPreferences(必须与主窗一致,blocker#6)**:`preload: index.cjs`(复用同一 preload,见下)、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:false`(desktopCapturer 在 main,但 preload 共用故一致)。

**preload 共用扩展(blocker#6)**:不新建第二套 contextBridge,**扩展现有 `src/preload/index.ts`** 增加 `shot` 分组,按 `window.transfer.shot.*` 暴露(getShot/saveTemp/toClipboard/saveAs/sendToChat/cancel + onShow 订阅)。抓屏全在 main,overlay 只收 dataURL,不直接碰 desktopCapturer。

**overlay.html CSP(blocker#6)**:主窗 index.html 是 `default-src 'self'`(index.html:8),会挡掉 `<img src=data:...>` 背景和部分 blob: 用法。overlay.html **单独放开** `img-src 'self' data: blob:`(其余仍收紧),与主窗严格 CSP 分开维护。否则背景快照黑屏。

### 4.2 会话状态机(经 review 修订)

⚠️ **关键顺序修正(blocker#3/#5,major:自截/时序)**:先查权限、**先抓屏拿到干净位图、再 setBounds、再 show 遮罩窗**(抓屏时屏上不能有本 app 可见窗口,否则自截;show 前 bounds 必须就位,否则旧屏闪现)。放弃早期"立即 show 冻结视觉"写法。

```
idle ──F1(仅idle)──▶ capturing ──抓屏done──▶ selecting ──框选完成──▶ editing
  ▲                      │                       │  ▲                    │
  │                 权限/抓屏失败              Esc/右键重选            │ 输出
  │                      │                       ▼  └── 框选完成 ──────┘
  │                      ▼                    (回 selecting)            │
  └──── hide 遮罩窗 ◀── 失败:hide+回idle ◀──── Esc/失焦 ◀──────────────┘
                                                              发聊天=fire-and-forget(见下)
```

- **F1 守卫(blocker#3)**:F1 回调**第一行判 `state===idle` 才启动,其余态直接 return**(editing 中按 F1 = 忽略,已确认)。另加 in-flight 抖动位:capturing 期间第二次 F1 吞掉,防抓屏并发。**前提**:所有失败分支必须能回 idle(否则 state 卡死 → F1 被永久吞)。
- **idle**:遮罩窗 hidden(预创建复用)。
- **capturing**:F1 → ① mac 先 `getMediaAccessStatus('screen')`,`denied` → **根本不 show 遮罩窗**,弹引导,**回 idle**;② 抓屏(desktopCapturer);③ **抓屏 reject/超时 → hide(若已 show)+ 回 idle**;④ 成功 → 每块屏 setBounds 后 show,进 selecting。
- **selecting**:光标屏遮罩可框选;**其余屏各铺一个纯压暗、吞点击的遮罩窗(已确认)**。**就绪门控(major)**:背景位图未到达前,选区/放大镜/输出全禁用(loading 占位),`onload` 后解锁。放大镜取色。
- **editing**:选区内标注;工具条选工具、调色/粗细;撤销重做(键位见 §4.7)。
- **失焦(major)**:selecting/editing 态遮罩窗 blur → **自动取消会话、hide 回 idle**(最安全,Snipaste 类做法),避免僵尸遮罩。会话期注册全局 Esc 兜底、退出即注销。
- **输出**:
  - **复制 / 保存**:本地同步 → 执行后 hide 窗回 idle。
  - **发聊天(blocker#1/#2,fire-and-forget)**:**仅当有活跃 peer 时按钮可用**(无则禁用,仍可复制/保存,已确认)。点击 → main 写临时文件拿 path → **立即 hide overlay 回 idle** → sendFiles 的 Promise 交 ScreenshotService 后台持有,复用主窗聊天流(upsert→EVT.messageUpserted)展示 sent/pending/进度/失败。**不 await 阻塞遮罩窗**。
  - **取消**:Esc / 右键(非编辑态)→ hide 回 idle。
- **复位(blocker#4)**:每次进会话(shotShow)按 §4.7 显式复位清单重置,或用 shotId 作 React key 强制重挂销毁重建。

### 4.3 IPC 契约(新增,风格对齐现有 CMD/EVT)

```ts
// src/shared/ipc.ts 追加(键名可去 shot 前缀或另起 SHOT_CMD 分组,值保持 'shot:xxx')
export const CMD = {
  ...,
  shotSetActivePeer:'shot:setActivePeer', // 主窗 setPeer 时同步当前 peerFp|null 给 main 缓存(blocker#1)
  shotGetShot:   'shot:getShot',    // overlay 拉背景位图 + display 信息 + 当前 peer(见 ShotSource)
  shotToClipboard:'shot:toClipboard',// (pngBuffer) → void;clipboard.writeImage(不落盘)
  shotSaveAs:    'shot:saveAs',     // (pngBuffer) → savedPath|null;直接 fs.writeFile 到选定路径(不经临时文件)
  shotSendToChat:'shot:sendToChat', // (pngBuffer) → void;fire-and-forget,peer 从 main 缓存取,不由 overlay 传
  shotCancel:    'shot:cancel',     // overlay → main:hide 遮罩窗回 idle
} as const

export const EVT = {
  ...,
  shotShow: 'shot:show',  // main → overlay:进入会话(带 shotId),overlay 按复位清单复位并拉取背景
}

// 背景位图 payload(shotGetShot 返回)
export interface ShotSource {
  shotId: string         // 本次会话 id(作 React key 强制重挂,blocker#4)
  dataUrl: string        // 屏幕快照 PNG(物理像素)
  bitmapW: number; bitmapH: number   // 位图物理尺寸(thumbnail.getSize() 实测)
  displayW: number; displayH: number // display.size 逻辑尺寸
  ratioX: number; ratioY: number     // = bitmapW/displayW、bitmapH/displayH(两轴各自算,major)
  rotation: number       // display.rotation(0/90/180/270);≠0 时第一版策略见 §4.5
  hasActivePeer: boolean // 有无当前聊天对象 → 决定"发聊天"按钮是否可用(blocker#1)
}
```

**peerFp 数据流(blocker#1)**:主窗 `setPeer` 时经 `shotSetActivePeer` 把当前 peerFp(或 null)同步给 main 缓存;overlay **不持有 peer**,发聊天时 main 用缓存的 peer。`hasActivePeer=false` 时"发聊天"按钮禁用(仍可复制/保存)。

**shotSendToChat 必须走 `ChatService.sendFiles`(major,不能旁路)**:main 侧实现 = 写临时文件 → 调 `core.chat.sendFiles(peerFp, [tmpPath])`(与 `CMD.sendFiles` handler [index.ts:75] 同一函数)。这样发送方入库(chat-service.ts:311)、`EVT.messageUpserted` 推 UI、enqueue 串行化、进度、失败态全部自动复用。**不得**调 http-client 底层 sendFiles 绕开入库。

**裁剪归属**:框选在遮罩(逻辑坐标)完成 → 渲染层换算成物理像素(`x/w × ratioX`、`y/h × ratioY`,**角点取整+末端 clamp**,见 §4.5)→ 离屏 canvas 按物理尺寸裁背景+合成标注 → 导出 PNG buffer。裁剪放**渲染层**,main 只负责"buffer→临时文件/剪贴板/发送"。所有逻辑↔物理换算**统一以 ShotSource.ratioX/Y 为唯一真源**,渲染层**不得用 `window.devicePixelRatio` 参与几何/采样**(dpr 仅用于标注层线条锐化)。

### 4.4 标注数据结构(retained-mode)

```ts
type ShotTool = 'rect'|'ellipse'|'line'|'arrow'|'pen'|'marker'|'mosaic'|'blur'|'text'|'badge'
interface ShotStyle { color: string; width: number; alpha: number }  // alpha 给马克笔/半透明
type ShotElement =
  | { id:string; type:'rect'|'ellipse'|'mosaic'|'blur'; x:number;y:number;w:number;h:number; style:ShotStyle }
  | { id:string; type:'line'|'arrow'; x1:number;y1:number;x2:number;y2:number; style:ShotStyle }
  | { id:string; type:'pen'|'marker'; points:Array<[number,number]>; style:ShotStyle }
  | { id:string; type:'text'; x:number;y:number; text:string; fontSize:number; style:ShotStyle }
  | { id:string; type:'badge'; cx:number;cy:number; n:number; style:ShotStyle }

interface ShotSceneState {
  elements: ShotElement[]
  undoStack: ShotElement[][]   // 每次 commit 前 structuredClone 快照;封顶(见下)
  redoStack: ShotElement[][]
  badgeCounter: number         // 序号自增
}
```

坐标一律存**遮罩逻辑坐标**;导出时坐标 × ratioX/Y、长度量 × min(ratioX,ratioY)(见 §3.3)。双层 canvas:底图层(背景快照,几乎不重绘,**不套 dpr**)+ overlay 层(按 elements 全量重绘)。马赛克/模糊基于底图区域重算,用 `clip()` 限定。

⚠️ **撤销栈封顶(major)**:pen/marker 的 `points` 可上千点,全量快照 O(M×N) 内存膨胀可 OOM。`undoStack` **保留最近 30~50 步,超出丢最老**(常量 `UNDO_LIMIT`)。

### 4.5 边界 / 失败模式(前置到纸面)

| 场景 | 处理 |
|------|------|
| mac 屏幕录制未授权 | **先查后 show**:进会话前 `getMediaAccessStatus('screen')`;`denied` → **根本不 show 遮罩**,引导去系统设置(`x-apple.systempreferences:...ScreenCapture`),回 idle;`not-determined` → 首次系统自动弹,提示授权后重启 app 生效 |
| F1 注册失败(被占用) | `register` 返回 false → 提示"F1 被占用,请改键";提供设置项改键。注册幂等(register 前查 isRegistered),绑 app 不绑遮罩窗,防多次 ready 重复注册 |
| F1 重入 | 非 idle 态一律忽略(已确认);capturing in-flight 第二次 F1 吞掉防抓屏并发 |
| 抓屏失败(reject/超时) | hide(若已 show)+ 回 idle,让 F1 能再启动 |
| `thumbnailSize` 实际尺寸 ≠ 传入 | 以 `thumbnail.getSize()` 实测;ratioX=bitmapW/displayW、**ratioY=bitmapH/displayH 两轴各算**,不假设 = scaleFactor |
| 高 DPI 裁剪贴边越界 | **角点取整+作差**:sx=round(x·ratioX)、ex=round((x+w)·ratioX)、sw=ex-sx(y 同理),再 clamp `sw=min(sw,bitmapW-sx)`,保证不越界;裁剪原点 floor、右下 ceil 确保完整包含选区。列为可单测纯函数 |
| 单一缩放真源 | 所有逻辑↔物理换算只认 ShotSource.ratioX/Y;渲染层**不用 `window.devicePixelRatio` 做几何/采样**(仅标注层线条锐化用);每次 shotShow 以本次 ShotSource 重建 canvas 尺寸,不留旧屏 dpr |
| 屏幕旋转 rotation≠0 | ShotSource 透传 rotation;第一版检测到旋转走 scaleFactor 兜底或明确提示不支持,别用单 ratio 掩盖 |
| 自截(拍到本 app 窗) | **先抓屏拿干净位图、再 show 遮罩**;主聊天窗在会话期是否隐藏一并处理(抓屏瞬间屏上无本 app 可见窗) |
| 选区为空/过小 | w 或 h < 有效阈值 → 不出工具条/不导出;锚点隐藏阈值独立(短边<40px 隐角锚、<20px 全隐但保留整块拖动),隐藏后仍可键盘微调 |
| 临时文件命名撞名 | **randomUUID/自增序号后缀 或 mkdtemp 独立目录**,绝不用秒级时间戳做唯一键(防同秒连拍覆盖) |
| 临时文件清理 | **fire-and-forget 的 Promise 上挂 `finally` 清理**:`try{ await sendFiles }finally{ unlink(path).catch(()=>{}) }`,覆盖 done/error/busy/rejected/throw 全分支(sendFiles 失败也 resolve,不能只 `.then`) |
| 临时文件崩溃残留 | saveTemp 写专用子目录 `temp/transfer-shot/`;app ready 时扫描删残留(或 will-quit best-effort 清) |
| saveAs / copy 不落临时文件 | saveAs 直接 `fs.writeFile` 到选定路径;copy 用 `nativeImage.createFromBuffer` 直接进剪贴板;都不经临时文件 |
| 大 PNG buffer 过 IPC | 传 Uint8Array/ArrayBuffer 二进制(structured clone 高效),非 base64/number[];评估最大图瞬时内存 |
| 遮罩窗失焦 | selecting/editing blur → 自动取消 hide 回 idle;会话期注册全局 Esc 兜底、退出注销 |
| 遮罩窗键盘焦点 | show 后立即 `focus()`(A4/B6/C4/D12 键盘交互前提);与 `type:'panel'` non-activating 的取舍实测,冲突则文字编辑时临时提权 |
| 多屏其余屏 | 每块屏各铺遮罩窗:光标屏可框选,其余纯压暗+吞点击(已确认);show/setBounds:**setBounds 必在 show 前**,避免旧屏闪现 |
| 遮罩盖不住 mac 菜单栏 | `screen-saver` level + `type:'panel'`;实现时实测,不达标再调 |
| 文字标注 IME(中文) | panel/高层级窗 IME 候选框可能错位/无焦点;实测中文输入,冲突则文字编辑临时换普通窗;第一版可先英文验证不阻塞骨架 |
| transparent 窗开 DevTools 失透明 | 已知,仅调试;不影响生产 |
| 发送时对方离线/不接受 | 复用现有 file 发送的 failed 路径;fire-and-forget 后台持有的 Promise reject 也触发 finally 清理;进程退出 core.stop→chat.shutdown reject 挂起也要能清 |

### 4.7 会话复位清单 & 键位/焦点分派(review 补)

**复位清单(blocker#4)**——每次 shotShow 必须全部重置(或用 `shotId` 作 React key 强制重挂销毁重建,更省心):
`{ elements:[], undoStack:[], redoStack:[], badgeCounter:0, 选区=null, 当前工具=默认, 放大镜倍率=默认, 颜色格式=默认 }`;clearRect 两层 canvas;**释放上一张底图位图**(`ImageBitmap.close()`/置空);事件监听退出会话时成对解绑(或 `AbortController` 统一 abort)。

**editing 态键位/焦点分派表(major D12)**:
| 键 | 焦点在 textarea | 有标注选中 | 无标注选中(选区态) |
|----|----|----|----|
| `Ctrl+Z` / `Ctrl+Y`,`Ctrl+Shift+Z` | 交给输入框 | 撤销/重做/清空 | 撤销/重做/清空 |
| 方向键 | 移动光标 | 移动选中标注 | 微调选区(Ctrl 扩/Shift 缩,B6) |
| `Delete` | 删字符 | 删选中标注 | — |
| `Esc` | 关 textarea | 取消选中标注 | 退会话回 idle |
分派前提:show 后 `focus()` 拿到键盘焦点(见 §4.5)。

**放大镜生命周期 & 指针冲突(minor C1/C3)**:selecting 未拖拽时放大镜跟指针;开始拖框选时吸附到拖动角(或隐藏);进 editing 消失(取色仅在框选前)。滚轮**仅放大镜可见时**改倍率,其余时机忽略。

**工具条/尺寸标签避让(minor)**:工具条默认贴选区下外侧,下方不足翻上方,再不足浮选区内右下;W×H 贴左上外侧、贴顶移内侧。三者(工具条/放大镜/标签)避让优先级明确。

### 4.6 实现顺序(按 story 拆,每步可测)

分阶段落地,每阶段跑通再下一步(对应 §Story 清单 ID):

1. **骨架**:多入口构建(overlay.html + 共用 preload shot 分组 + overlay CSP)+ ScreenshotService + F1 幂等注册/守卫 + 空遮罩窗(setBounds→show→focus)/Esc/失焦关闭 + 状态机骨架(含失败回 idle)。→ A1,A3,A4
2. **抓屏+背景**:mac 权限先查 + **先抓屏(光标屏)拿干净位图再 show** + 底图层(不套 dpr)背景渲染 + 就绪门控。→ A2
3. **框选**:手动框选 + 内亮外暗 + W×H + 锚点调大小/隐藏阈值 + 拖整块 + 像素微调 + 右键重选 + 多屏其余屏压暗吞点击。→ B1–B8
4. **放大镜取色**:像素放大镜(单一 ratio 采样)+ 坐标/颜色 + 滚轮倍率 + 复制/切格式 + 生命周期避让。→ C1–C4
5. **导出+三出口**:离屏 canvas 裁剪合成(角点取整+clamp、两轴 ratio、尺寸量×ratio;无标注先跑通)+ 复制(不落盘)/保存(直写选定路径)/**发聊天(fire-and-forget:临时文件唯一命名→走 core.chat.sendFiles→finally 清理→peer 缺失禁用)**。→ E1–E3
6. **标注编辑器**:双层 canvas + 对象模型 + 撤销重做(封顶)+ 键位分派 + 各工具(先矩形/箭头/画笔/文字 P0,再椭圆/直线/马克笔/马赛克/模糊/序号 P1)+ 调色/粗细。→ D1–D12
7. **回归 & 同步 design**:测试 + 把方案落地差异回写本文档 + 主 DESIGN.md。

**E3 保存默认值**:文件名 `截图_yyyyMMdd_HHmmss.png`、默认目录=系统图片目录或记忆上次、格式第一版仅 PNG。

> 测试策略:纯逻辑(坐标换算 ratioX/Y、裁剪矩形角点取整+clamp、状态机转移与守卫、撤销栈封顶、临时文件唯一命名/finally 清理时机)抽成可单测纯函数(node 环境,契合现有 vitest 约定);canvas 绘制/遮罩窗/IME 等 UI 层手动验证 + 关键纯函数覆盖。坐标换算单测须含:1.5x/2x、贴边/非贴边、奇偶坐标、非等比 ratio 各一例。

---

## 附:调研来源

**需求调研(第 1 步)**:Snipaste 官方 wiki(`Snipaste/feedback`,即 docs.snipaste.com 同源)。两 agent 交叉验证。关键事实:序号标注、OCR 均为 Snipaste **PRO 独占**;滚动截图、录屏官方**未提供**;默认保存格式/文件名模板官方文档未明写(存疑)。

**技术调研(第 2 步)**:三 agent,证据来自 `electron.d.ts`(v35.7.5)、Electron 35 官方文档、本项目源码 file:line。详见 §3。

# 截屏功能 — 需求与进度

> 归属:Transfer(局域网传输 + 聊天)。截屏定位为**「截图 → 直接发给对方」**的轻量工具,与传输/聊天场景强绑定,不做成通用桌面截图软件。
> 本文档跟踪需求与七步流程进度。设计细节最终并入 [DESIGN.md](./DESIGN.md)。

---

## 七步流程进度

| 步骤 | 阶段 | 状态 | 完成度 | 备注 |
|------|------|------|:---:|------|
| 1 | 需求调研 | ✅ 完成 | 100% | 调研 Snipaste 官方 wiki(两 agent 交叉验证);功能清单 + 范围决策已定,见 §1/§2 |
| 2 | 出方案(设计文档) | ✅ 完成 | 100% | 技术前置调研 §3 + 完整设计方案 §4(架构/状态机/IPC 契约/标注数据结构/边界失败模式/实现顺序) |
| 3 | review 方案 | ⏳ 就绪 | 0% | 待审设计层:逻辑漏洞、考虑欠缺处 |
| 4 | 实现 | ⬜ 未开始 | 0% | |
| 5 | review 代码 | ⬜ 未开始 | 0% | |
| 6 | review 测试 | ⬜ 未开始 | 0% | |
| 7 | 回同步 design | ⬜ 未开始 | 0% | |

**当前所处**:第 2 步(出方案)已完成,准备进入第 3 步(review 方案)。

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
| 像素微调 | 方向键移选区;Ctrl+方向键扩、Shift+方向键缩(各 1px) |
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
- **时序**:先弹遮罩、**并行**抓屏(getSources 异步、有几十~几百 ms 开销),把位图作为遮罩背景快照 → "所见即所截",避免感知延迟。[d.ts:7219, 21896]

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
- **高 DPI**:`canvas.width = cssW × dpr` + `canvas.style.width = cssW` + `ctx.scale(dpr,dpr)`;显示层按 dpr、导出层按原图物理尺寸,两套坐标别混。[MDN devicePixelRatio]

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

**electron-vite 多入口**(现为单入口 `src/renderer/index.html`):新增 `src/renderer/overlay.html` + `src/renderer/src/overlay.tsx`;`renderer.build.rollupOptions.input` 显式列 `{ index, overlay }`。main 加载:dev 用 `${ELECTRON_RENDERER_URL}/overlay.html`,prod 用 `loadFile('../renderer/overlay.html')`(现有单入口约定 [index.ts:57-61] 要扩展成按窗口选文件)。

### 4.2 会话状态机

```
idle ──F1──▶ capturing ──抓屏done──▶ selecting ──框选完成──▶ editing ──输出/取消──▶ idle
                │                        │                      │
             权限denied              Esc/右键重选              Esc取消
                ▼                        ▼                      ▼
             引导授权                  回 selecting            回 idle(hide 窗)
```

- **idle**:遮罩窗 hidden(已预创建复用)。
- **capturing**:F1 触发 → **立即 show 遮罩窗**(先冻结视觉)→ **并行**抓屏(§3.1 时序)→ 位图回来设为背景。mac 若 `getMediaAccessStatus('screen') !== 'granted'` → 不进截图,弹引导。
- **selecting**:全屏压暗 + 放大镜;拖拽画选区;支持自动/手动。选区确定后出工具条。
- **editing**:选区内可标注;工具条选工具、调色/粗细;撤销重做。
- **输出**:发聊天/复制/保存 → 执行后 hide 窗回 idle;Esc/右键(非编辑态)→ 取消回 idle。

### 4.3 IPC 契约(新增,风格对齐现有 CMD/EVT)

```ts
// src/shared/ipc.ts 追加
export const CMD = {
  ...,
  shotCapture:   'shot:capture',    // 渲染层无需主动调;F1 由 main 触发。保留手动触发入口(菜单/按钮)
  shotGetShot:   'shot:getShot',    // overlay ready 后拉背景位图 + display 信息(dataURL + scaleFactor + size)
  shotSaveTemp:  'shot:saveTemp',   // (pngBuffer) → tmpPath;main 写临时文件
  shotToClipboard:'shot:toClipboard',// (pngBuffer) → void;clipboard.writeImage
  shotSaveAs:    'shot:saveAs',     // (pngBuffer) → savedPath|null;弹另存为
  shotSendToChat:'shot:sendToChat', // (pngBuffer, peerFp) → void;写临时文件后复用 sendFiles,resolve 后清理
  shotCancel:    'shot:cancel',     // overlay → main:hide 遮罩窗
} as const

export const EVT = {
  ...,
  shotShow: 'shot:show',  // main → overlay:进入会话(带 shotId),overlay 复位并拉取背景
}

// 背景位图 payload(shotGetShot 返回)
export interface ShotSource {
  dataUrl: string        // 屏幕快照 PNG(物理像素)
  bitmapW: number        // 位图物理宽(getSize 实测)
  bitmapH: number
  displayW: number       // display.size 逻辑宽
  displayH: number
  scaleFactor: number    // 用于对齐;实际裁剪用 ratio = bitmapW/displayW
}
```

**裁剪归属**:框选在遮罩(逻辑坐标)完成 → 渲染层用 `ratioX = bitmapW/displayW` 把逻辑选区换算成物理像素 → 在离屏 canvas 上按物理尺寸裁背景+合成标注 → 导出 PNG buffer。裁剪放**渲染层**(canvas 天然有位图),main 只负责"buffer→临时文件/剪贴板/发送"。

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
  undoStack: ShotElement[][]   // 每次 commit 前 structuredClone 快照
  redoStack: ShotElement[][]
  badgeCounter: number         // 序号自增
}
```

坐标一律存**遮罩逻辑坐标**;导出时统一 × ratio 到物理像素。双层 canvas:底图层(背景快照,几乎不重绘)+ overlay 层(按 elements 全量重绘)。马赛克/模糊基于底图区域重算,用 `clip()` 限定。

### 4.5 边界 / 失败模式(前置到纸面)

| 场景 | 处理 |
|------|------|
| mac 屏幕录制未授权 | 进会话前 `getMediaAccessStatus('screen')` 查;`denied` → 不弹遮罩,引导去系统设置(`x-apple.systempreferences:...ScreenCapture`);`not-determined` → 首次调用系统自动弹,提示授权后重启 |
| F1 注册失败(被占用) | `register` 返回 false → 记录并提示用户"F1 被占用,请改键";提供设置项改快捷键 |
| `thumbnailSize` 实际尺寸 ≠ 传入 | 一律以 `thumbnail.getSize()` 实测,ratio = bitmapW/displayW,不假设 = scaleFactor |
| 高 DPI 裁剪漂移 | 逻辑选区 × ratio 后 `Math.round`;Win 150% 逐屏实测 |
| 抓屏慢导致画面已变 | 先 show 遮罩、并行抓屏,位图作为静态背景快照(所见即所截) |
| 选区为空/过小(w或h<阈值) | 视为无效,不出工具条/不导出;锚点在过小时隐藏 |
| 临时文件清理时机 | **必须等 `sendFiles` Promise resolve 后**再删(流式读);失败也要清 |
| 多屏光标换屏 | 每次 F1 重新 getCursorScreenPoint 选屏 + 重设遮罩 bounds |
| 遮罩盖不住 mac 菜单栏 | `screen-saver` level + `type:'panel'`;实现时实测,不达标再调 |
| transparent 窗开 DevTools 失透明 | 已知,仅调试时;不影响生产 |
| 发送时对方离线 | 复用现有 file 发送的 failed 路径,无需新逻辑 |

### 4.6 实现顺序(按 story 拆,每步可测)

分阶段落地,每阶段跑通再下一步(对应 §Story 清单 ID):

1. **骨架**:多入口构建(overlay.html)+ ScreenshotService + F1 注册 + 空遮罩窗弹出/Esc 关闭。→ A1,A3,A4
2. **抓屏+背景**:选光标屏 + desktopCapturer 抓图 + 遮罩背景渲染 + mac 权限检测。→ A2
3. **框选**:手动拖拽框选 + 内亮外暗 + W×H + 锚点调大小 + 拖整块 + 像素微调 + 右键重选。→ B1–B8
4. **放大镜取色**:像素放大镜 + 坐标/颜色 + 滚轮倍率 + 复制/切格式。→ C1–C4
5. **导出+三出口**:离屏 canvas 裁剪合成(无标注先跑通)+ 复制/保存/发聊天(临时文件+清理)。→ E1–E3
6. **标注编辑器**:双层 canvas + 对象模型 + 撤销重做 + 各工具(先矩形/箭头/画笔/文字 P0,再椭圆/直线/马克笔/马赛克/模糊/序号 P1)+ 调色/粗细。→ D1–D12
7. **回归 & 同步 design**:测试 + 把方案落地差异回写本文档 + 主 DESIGN.md。

> 测试策略:纯逻辑(坐标换算 ratio/裁剪矩形、状态机转移、撤销栈、临时文件命名/清理时机)抽成可单测的纯函数(node 环境,契合项目现有 vitest 约定);canvas 绘制/遮罩窗等 UI 层靠手动验证 + 关键纯函数覆盖。

---

## 附:调研来源

**需求调研(第 1 步)**:Snipaste 官方 wiki(`Snipaste/feedback`,即 docs.snipaste.com 同源)。两 agent 交叉验证。关键事实:序号标注、OCR 均为 Snipaste **PRO 独占**;滚动截图、录屏官方**未提供**;默认保存格式/文件名模板官方文档未明写(存疑)。

**技术调研(第 2 步)**:三 agent,证据来自 `electron.d.ts`(v35.7.5)、Electron 35 官方文档、本项目源码 file:line。详见 §3。

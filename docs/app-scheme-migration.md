# 根治启动慢:用 `app://` 自定义 scheme 替换 `file://` 加载渲染页

> 状态:**已实现**(代码落地,待 mac/win 打包实测 → 通过后发 v0.4.0)。typecheck/test(218)/build 均绿。
> 关联:速修版已上线(主题挂 main,见 DESIGN §12.8);本文是**根治**方案。
> 落地:`src/main/app-protocol.ts`(+ `.test.ts` 8 例)、`index.ts`(顶层注册 privileged + whenReady 内 `registerAppProtocol` + `loadRenderer` prod 走 app://)、`screenshot-service.ts`(overlay 走 app://,删 `overlayFile` dep)。DESIGN §2 已同步。

## 0. 实现坐实的补充事实(实现阶段新增)

- **`net.fetch` 支持 `file://` 已由官方 .d.ts 坐实**(electron@35.7.5,electron.d.ts:9580):「requests made with `net.fetch` can be made to custom protocols as well as `file:`」。故 `net.fetch(pathToFileURL(abs))` 读本地文件成立,读盘方式最终定为此(§4.1/§5.2)。
- **URL 解析先归一化未编码 `../`**:`new URL('app://bundle/../../etc/passwd').pathname === '/etc/passwd'`(`..` 被吃到 host 边界即停),join 到 root 后仍**落在 root 内**(→ 多半不存在 → 404),**不构成越权**。真正攻击面是**编码的 `..%2f`**(URL 不归一化,`decodeURIComponent` 后才现形)——由 `resolveAppPath` 的 normalize + `startsWith(root+sep)` 挡下。单测 `app-protocol.test.ts` 已按此**真实行为**断言(未编码 `../` 断言为 root 内路径而非 null;编码 `..%2f` 断言 null),不是「改代码凑测试」。
- **第二实例顺序无害**:`registerSchemesAsPrivileged` 在模块顶层、单实例锁判断**之前**执行,故第二实例也会跑一次——但它是廉价同步 no-op,且第二实例随后 `app.exit(0)`、永不进 whenReady(不注册 handler、不建窗),无副作用。
- **`bypassCustomProtocolHandlers` 未启用**:默认 `net.fetch` 可触发自定义协议 handler,但我们只 fetch `file://`(无任何自定义 handler 拦截 `file://`),无递归风险,故不传该选项,保持最小。若将来有人 intercept `file://`,再加 `{ bypassCustomProtocolHandlers: true }`。
- **handler 必须 `try/catch` 兜 `net.fetch` 的 reject(code review 发现)**:`net.fetch(file://)` 对某些输入是 **reject 而非返 404 Response**——可复现触发是**路径含 null byte**(`app://bundle/index.html%00.png`):`resolveAppPath` 不拦它(null byte 非越权,仍在 root 内),但 `fs` 拒读含 `\0` 的路径 → `net.fetch` reject;瞬时读盘错误同理。若直接 `return net.fetch(...)`,会漏成 unhandled rejection / errored request。**修法**:`return await net.fetch(...)` 包 `try/catch`,任何失败转 `new Response('Not found', {status: 404})`。已实现(app-protocol.ts),并加单测断言 `resolveAppPath` 对 null byte 留 root 内(防线在 handler,非 resolve 层)。

## 1. 背景与根因(已坐实)

打包版渲染进程用 `win.loadFile(...)` 加载,协议是 **`file://`**。`file://` 是 Chromium 的 **opaque origin(不透明源)**,对它的 Web Storage(localStorage/sessionStorage/IndexedDB)访问有已知性能坑:**首次访问阻塞数秒**。

- 实测:`localStorage.getItem('theme')` 耗时 **3866ms**,且在 `useState` 初始化器里同步执行 → 阻塞 React 首帧 → 白屏 ~4s。
- 官方 issue:electron/electron#24441。VS Code 当年同样踩坑,后来迁到自定义 `vscode-file://` scheme 根治。
- dev 模式走 `http://localhost`(正常 origin),所以 dev 从不慢——这也是"关掉 VS Code 重启后界面很快"其实是 dev 版的原因。

**速修**只是把"主题这一处持久化"搬到 main 侧,绕开了 localStorage。但只要渲染页仍在 `file://` 下,**任何**未来用到 web storage / Cache API / Service Worker / 正常 origin 语义的代码,都会再次踩坑。根治 = 让渲染页跑在一个**标准、安全、非 opaque** 的自定义 origin 上。

## 2. 目标 / 非目标

**目标**
- 打包版主窗 + overlay 都经 `app://` 加载,origin 变为 `app://bundle`(标准安全源),彻底消除 `file://` opaque origin 的 storage 性能坑。
- 保持 dev 不变(仍走 `ELECTRON_RENDERER_URL` = `http://localhost:xxxx`,HMR 不受影响)。
- CSP、相对资源路径、preload、单实例、退出清理等**全部行为不回归**。

**非目标**
- 不改 dev 加载路径(dev 本就正常)。
- 不引入外部依赖(不用 `electron-serve` 之类;Electron 35 原生 `protocol.handle` 足够)。
- 不迁移图片 dataURL 方案(缩略图/大图仍走 IPC dataURL;那是另一条链路,与本次无关)。

## 3. 方案总览

新增一个自定义 scheme `app`,注册为 **privileged + standard + secure**,用 `protocol.handle('app', ...)` 把 `app://bundle/<path>` 映射到磁盘上打包后的 `out/renderer/<path>`,并做**目录穿越防护**。加载入口从 `loadFile(...)` 改为 `loadURL('app://bundle/<entry>.html')`(仅 prod;dev 分支不动)。

```
渲染页 origin:  file:///…/out/renderer/index.html   ❌ opaque, storage 慢
          →     app://bundle/index.html              ✅ standard secure origin
```

选 `app` 作为 scheme 名(短、语义清晰)。用固定 host `bundle` 承载打包产物(预留将来别的 host,如 `app://media/…` 走另一处理器,但本次只做 `bundle`)。

## 4. 关键 API 事实(基于 electron@35.7.5 实测 .d.ts)

- `protocol.registerSchemesAsPrivileged(customSchemes: CustomScheme[])`
  —— **必须在 `app.whenReady()` 之前**(app ready 之前、模块顶层)调用,否则无效。
  `Privileges`(electron.d.ts:21461)可选字段:`standard` / `secure` / `bypassCSP` / `allowServiceWorkers` / `supportFetchAPI` / `corsEnabled` / `stream` / `codeCache`,默认全 false。
  - **`standard: true`** —— 关键。让该 scheme 成为"标准 scheme",拥有**真正的、非 opaque 的 origin**(`app://bundle`),Web Storage 走正常快速路径。这是根治性能坑的核心开关。
  - **`secure: true`** —— 视为安全上下文(等价 https),放开 secure-context 限制(crypto.subtle 等),也让混合内容策略正常。
  - **`supportFetchAPI: true`** —— 允许页面内 `fetch('app://...')`(ESM modulepreload、future fetch)。
  - **`codeCache: true`**(可选,配合 `standard: true`)—— 开 V8 code cache,二次启动 JS 解析更快,顺带优化。
  - 不设 `bypassCSP`(我们要 CSP 生效)。不需要 `stream`(无 `<video>`/`<audio>` 大流)。不需要 `allowServiceWorkers`/`corsEnabled`。
- `protocol.handle(scheme, handler)`(electron.d.ts:10633)
  —— **在 `app.whenReady()` 之后**注册。handler 收 `GlobalRequest`(Web `Request`),返回 `GlobalResponse`(Web `Response`)或其 Promise。用标准 Web `Response` 构造响应,读盘用 `fs.promises.readFile` + 自己判 MIME 塞 `Content-Type`。

> 注意 API 世代:`protocol.handle` 是新式(Electron ≥25)一等公民,取代旧的 `registerFileProtocol`/`registerBufferProtocol`(已 deprecated)。本项目 Electron 35,直接用 `handle`。

### 4.1 VS Code 真实做法(源码坐实,用于校准选型)

调研 VS Code 加载渲染页的 `vscode-file://` scheme 实现(`src/vs/platform/protocol/electron-main/protocolMainService.ts`),坐实:

1. **用 `protocol.registerFileProtocol` + callback 回文件路径字符串**(`callback({ path, headers })`)——**不是** `protocol.handle`,也**不**手写 readFile/MIME,也**不**用 `net.fetch`。由 **Electron 自己读盘 + 按扩展名判 MIME**;callback 只在特殊页(workbench.html 的 COOP/COEP、dev build 的 cache-control)才手动塞 headers。
2. **同时 `interceptFileProtocol` 拦原生 `file://`**,阻断直接文件访问(纵深防御)。
3. **路径校验三道**:① allowlist(TernarySearchTree 限定在 appRoot/extensionsPath/storage 等预批根目录内)② 扩展名白名单(`.svg/.png/.jpg…`)③ `normalize()` 去相对穿越;不过关 abort(错误码 -3)。

**对本方案的校准**:
- VS Code 因历史包袱仍用**老 API** `registerFileProtocol`;**新项目应用 `protocol.handle`**(官方推荐方向)。
- 但**借鉴其"交给 Electron 读盘 + 判 MIME"的省心思路**:在 `protocol.handle` 里返回 `net.fetch(pathToFileURL(abs))`——等价于 VS Code 的"回 path 让 Electron 读",但走新 API,且**免维护 MIME 表**(我们已有的 `imageMime` 只覆盖图片,不含 js/css/html/wasm/map,手写表极易漏)。**这是最终选定的读盘方式**(不再二选一)。
- **借鉴其路径校验**:我们的 `resolveAppPath` 已含 `normalize` 去穿越 + "解析后必须在 rendererRoot 内"(等价 VS Code 的 allowlist,单根)。VS Code 的扩展名白名单对我们非必需(只服务打包自产资源,不服务用户任意文件),**不加**,保持简单。

## 5. 详细设计

### 5.1 scheme 注册(模块顶层,ready 前)

`src/main/index.ts` 顶层(在 `app.whenReady()` 之前,单实例锁附近即可)加:

```ts
import { protocol } from 'electron'

// 自定义 app:// scheme:让打包版渲染页跑在标准安全 origin 上,
// 根治 file:// opaque origin 下 localStorage 首访卡数秒的坑(#24441)。
// 必须在 app ready 之前注册 privileged。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,       // ← 真正的非 opaque origin(app://bundle),storage 走快路径
      secure: true,         // 安全上下文(等价 https)
      supportFetchAPI: true,// 允许 fetch(app://…)(modulepreload 需要)
      codeCache: true       // V8 code cache(需 standard:true),二次启动更快
    }
  }
])
```

dev 分支(`ELECTRON_RENDERER_URL` 存在时)**完全不受影响**——注册了也没人加载 `app://`,无副作用。

### 5.2 protocol handler(ready 后,建窗前)

新建 `src/main/app-protocol.ts`,导出一个纯函数便于单测路径解析,以及一个 `registerAppProtocol(rendererRoot)`:

```ts
import { protocol, net } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = 'bundle'

/**
 * 把 app://bundle/<path> 解析成磁盘绝对路径,并防目录穿越。
 * 返回 null = 非法(host 不对 / 越权 / 空) → 上层回 404。
 * 纯函数,便于单测。
 */
export function resolveAppPath(rendererRoot: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.hostname !== HOST) return null
  // decode + 去查询/锚点;去掉前导 /;空路径回落 index.html
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (p === '') p = 'index.html'
  const abs = normalize(join(rendererRoot, p))
  // 目录穿越防护:解析后必须仍在 rendererRoot 之内
  const root = normalize(rendererRoot.endsWith(sep) ? rendererRoot : rendererRoot + sep)
  if (abs !== normalize(rendererRoot) && !abs.startsWith(root)) return null
  return abs
}

/** ready 后调用一次:把 app://bundle/* 映射到 out/renderer/*。 */
export function registerAppProtocol(rendererRoot: string): void {
  protocol.handle('app', async (req) => {
    const abs = resolveAppPath(rendererRoot, req.url)
    if (!abs) return new Response('Not found', { status: 404 })
    // 交给 net.fetch 读盘:自动处理 Content-Type、Range、404(文件不存在)。
    // net.fetch 接受 file:// URL,等价于"读这个磁盘文件"但省了自己判 MIME。
    return net.fetch(pathToFileURL(abs).toString())
  })
}
```

> 为什么用 `net.fetch(file://abs)` 而不是手写 `readFile` + MIME 表:`net.fetch` 对 `file://` 有内置支持,自动补 `Content-Type`、处理不存在→404、支持 Range,省掉一张易漏的 MIME 映射表(我们已有的 `imageMime` 只覆盖图片,不含 js/css/html/wasm/map)。`net` 在主进程可用(electron.d.ts:24740 `const net`)。
>
> **选型已定**(见 §4.1):`protocol.handle` + `net.fetch(file://)`——新 API + VS Code 同款"交给 Electron 读盘判 MIME"的省心思路。
> **仅兜底**(不是待定项;只有当 `net.fetch(file://)` 在 mac/win 实测行为异常时才启用):退回手写 `readFile` + 覆盖 html/js/css/wasm/json/map/图片字体的 MIME 表,返回 `new Response(buffer, { headers: { 'content-type': mime } })`。默认不走此路。

### 5.3 加载入口改造

**主窗**(`src/main/index.ts` 的 `loadRenderer`):

```ts
function loadRenderer(win: BrowserWindow, entry: 'index' | 'overlay'): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(entry === 'index' ? devUrl : `${devUrl}/${entry}.html`)
  } else {
    win.loadURL(`app://${'bundle'}/${entry}.html`) // ← 原 loadFile 改这里
  }
}
```

**overlay**(`src/main/screenshot-service.ts` 的 `loadOverlay`):同样把 prod 分支的 `win.loadFile(this.deps.overlayFile)` 改为 `win.loadURL('app://bundle/overlay.html')`。

- `ScreenshotService` 的依赖 `overlayFile`(prod 磁盘路径)不再需要;可删掉该 dep,或保留但改传 `'overlay'` entry 名。**外科手术式**:最小改动是把 `overlayFile: string` 换成不需要——但为减少牵连,保留 deps 结构、仅改 `loadOverlay` 内分支用固定 `app://bundle/overlay.html`,并把 `overlayFile` 标注为"已废弃(app:// 后不用)"或直接删该字段+其构造处传参。实现时选删(orphan 清理属于本次改动造成),同步改 index.ts 构造 `ScreenshotService` 处。

### 5.4 rendererRoot 的确定

打包后渲染产物在 `join(__dirname, '../renderer')`(与现有 `loadFile` 路径一致,`__dirname` = `out/main`)。`registerAppProtocol` 接收这个绝对路径:

```ts
// index.ts, app.whenReady() 内、createWindow() 之前:
registerAppProtocol(join(__dirname, '../renderer'))
```

### 5.5 CSP 复核

现有 CSP:`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`。

- `'self'` 在 `app://bundle/index.html` 下解析为 `app://bundle` —— 相对资源 `./assets/*.js|css` 变成 `app://bundle/assets/*`,命中 `'self'`,**放行**。
- `img-src 'self' data:` —— 缩略图/大图用 `data:` URL,仍放行;`app://` 内图片也算 `'self'`。
- 不设 `bypassCSP`,CSP 正常生效,**比 file:// 下更规范**(file:// 的 `'self'` 语义本就模糊)。
- 结论:**CSP 无需改**。

### 5.6 相对路径复核(已实测)

`out/renderer/index.html` 引用:`src="./assets/index-*.js"`、`href="./assets/*.css"`、`modulepreload href="./assets/client-*.js"`(overlay 同理)。相对 `./` 在 `app://bundle/index.html` 下解析为 `app://bundle/assets/*`,handler 能映射到 `out/renderer/assets/*`。**vite `base` 无需改**(默认相对已 OK)。

## 6. 边界情况 / 失败模式(前置到纸面)

| 场景 | 处理 |
|---|---|
| 请求路径越权(`app://bundle/../../etc/passwd`) | `resolveAppPath` normalize 后不在 root 内 → 返回 null → 404。**必须有单测覆盖**。 |
| 文件不存在(如拼错 assets 名) | `net.fetch(file://)` 自动 404(或手写分支 readFile catch → 404)。 |
| host 写错(`app://foo/…`) | `hostname !== 'bundle'` → null → 404。 |
| 空路径 `app://bundle/` | 回落 `index.html`。 |
| URL 编码路径(空格/中文) | `decodeURIComponent` 后再 join。 |
| dev 模式 | 走 `ELECTRON_RENDERER_URL`,不碰 app://;privileged 注册无副作用。 |
| `registerSchemesAsPrivileged` 漏在 ready 后调 | scheme 不 privileged → storage 仍慢/origin 仍 opaque。**约束:必须模块顶层调用**,代码注释显式标注。 |
| overlay 透明窗 | 仅换加载 URL,窗口属性(transparent/frame:false)不变,不影响。 |
| 单实例第二实例 | `app.exit(0)` 早退,不建窗、不加载 app://,无影响。 |
| 退出清理 | 与加载 scheme 无关,不受影响。 |
| Windows 盘符/反斜杠 | `pathToFileURL` 处理盘符;`normalize`/`sep` 用 node path,跨平台。**Windows 上需实测一次**。 |
| `net.fetch(file://)` 平台差异 | 若 mac/win 行为不一,退 5.2 备选(手写 readFile+MIME)。实现阶段实测决定。 |

## 7. 影响面 / 改动清单(外科手术式)

| 文件 | 改动 |
|---|---|
| `src/main/app-protocol.ts` | **新增**:`resolveAppPath`(纯函数)+ `registerAppProtocol`。 |
| `src/main/index.ts` | 顶层 `protocol.registerSchemesAsPrivileged([...])`;whenReady 内 `registerAppProtocol(...)`(建窗前);`loadRenderer` prod 分支改 `loadURL('app://bundle/...')`;`ScreenshotService` 构造去掉 `overlayFile`(若删该 dep)。 |
| `src/main/screenshot-service.ts` | `loadOverlay` prod 分支改 `loadURL('app://bundle/overlay.html')`;删 `overlayFile` dep(orphan 清理)。 |
| `src/main/app-protocol.test.ts` | **新增**:`resolveAppPath` 单测(正常/穿越/host 错/空/编码)。 |
| `src/renderer/src/App.tsx` `useTheme` | **可选**:根治后 `file://` 坑消失,理论上可回退用 localStorage。但速修版(挂 main)已上线且更干净(避免渲染层持久化职责),**建议保留挂 main,不回退**——本次不动。 |
| `docs/DESIGN.md` §4.1 / §12.8 | 同步:加载协议 file://→app://;§12.8 主题挂 main 的"根因"补一句 file:// 已被 app:// 根治。 |

> **不回退 localStorage 的理由**:速修把主题持久化收到 main 是更好的架构(渲染层不承担持久化),且已测已上线;app:// 只是消除"未来再踩坑"的隐患,不是为了退回 localStorage。两者叠加是最稳的。

## 8. 成功标准 / 验证方法

1. **构建**:`pnpm typecheck && pnpm build` 通过。
2. **单测**:`resolveAppPath` 覆盖穿越/host/空/编码;`pnpm test` 全绿。
3. **打包实测(核心)**:mac 打包版启动,首屏出现时间从 ~4s 降到 <1s;控制台无 localStorage 慢日志(已移除)、无 CSP 违规、无资源 404。
4. **origin 验证**:打包版 DevTools 里 `window.location.origin` === `app://bundle`(非 `file://`),`localStorage.setItem/getItem` 往返 <5ms。
5. **overlay 实测**:F1 截图遮罩正常加载、选区/工具条/三出口都在。
6. **Windows 实测**:setup + portable 均正常加载(盘符/反斜杠路径 OK)。
7. **回归**:聊天收发、图片缩略图/大图、单实例、关闭进程清零,全部不回归。

## 9. 分步实现计划(带验证检查点)

1. 写 `app-protocol.ts`(`resolveAppPath` + `registerAppProtocol`)→ 写 `app-protocol.test.ts` → `pnpm test` 绿。 ✅检查点:穿越用例返回 null。
2. index.ts 顶层注册 privileged + whenReady 内 register + `loadRenderer` 改 app:// → `pnpm build`。 ✅检查点:typecheck 过。
3. screenshot-service `loadOverlay` 改 app://,清 `overlayFile` orphan + 同步构造处 → build。 ✅检查点:无未用字段告警。
4. mac 打包实测(成功标准 3/4/5)。 ✅检查点:首屏 <1s、origin=app://bundle。
5. Windows 打包实测(成功标准 6)。
6. 回归清单(成功标准 7)。
7. 回同步 DESIGN §4.1/§12.8。
8. 全绿后再决定发版号(v0.4.0,scheme 迁移属较大底层变更)。

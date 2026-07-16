# Electron 优雅退出 & 僵尸进程 —— 踩坑复盘

> 一次"发多条消息只收到一条"的排查，最终定位到 **Electron 退出时进程卡死变僵尸** 这个根因。
> 这是 Electron 桌面应用的通用坑，记录完整因果链、修复方案与排查手册。

---

## 1. 现象（从表到里）

用户报："给对方发 4-5 条消息，接收端只收到 1-3 条。"

一路排查发现这是**一条因果链**，表面的"丢消息"其实在最底层：

```
server.close() 卡住不 resolve          ← 真正的根因
      ↓
点关闭按钮 → app.quit() 永不完成 → 进程没退，变僵尸挂在后台
      ↓
反复"关闭"其实每次都留一个僵尸 → 堆积多个僵尸进程
      ↓
每个僵尸各占一个端口(53317 被占→回退 53318…)、各自广播 mDNS
      ↓
发送端设备注册表里同一 fingerprint 的 target 端口在僵尸间乱跳
      ↓
连发的消息被"撒"到不同僵尸进程 → 用户盯着的那个界面丢消息
```

**关键教训**：一个"丢消息"的网络层现象，根因可能在**进程生命周期管理**。排查时不要只盯着消息收发逻辑。

---

## 2. 根因：退出清理链卡死

退出流程：点关闭 → `window-all-closed`(非 mac) → `app.quit()` → `before-quit` 里做清理。

清理链里 `await server.close()`（Fastify / Node http.Server）是**卡死点**：

- `server.close()` 的语义是"**停止接受新连接，并等所有现有连接关闭后**才 resolve"。
- 若有**挂起的 keep-alive 连接**（mDNS 心跳、对端还开着的连接、in-flight 请求），这些连接不会主动关，`close()` 可能**久等甚至永不 resolve**。
- `await` 卡住 → `before-quit` 里 `finally { app.quit() }` 永不执行 → **主进程僵尸**。

第二个僵尸来源（单实例锁）：拿不到锁的第二实例原本用 `app.quit()` 退出，但 `quit()` 在 `ready` 之前调用可能不干净、且会走 `before-quit`，同样可能卡住 → 第二实例也变僵尸。

---

## 3. 修复（两层保护 + 强杀）

### 3.1 给 `server.close()` 加超时上限（`src/main/app-core.ts`）
```ts
// fastify close() 等所有活动/keep-alive 连接关闭才 resolve,有挂起连接时可能久等甚至不 resolve。
// 给 1.5s 上限,超时就不等了(进程即将退出,OS 会回收 socket)。
await Promise.race([
  server.close(),
  new Promise((resolve) => setTimeout(resolve, 1500))
])
```

### 3.2 `before-quit` 加强制退出兜底（`src/main/index.ts`）
```ts
// 清理最多等 3s,超时也强制退出。app.exit(0) 比 app.quit() 更硬(quit 本身也可能被拦)。
const forceExit = setTimeout(() => app.exit(0), 3000)
;(async () => {
  const s = store, c = core
  store = null; core = null      // 先摘引用,退出期 IPC 走 ?. 短路(防 "database is not open")
  try { screenshot?.stop(); await c?.stop(); s?.close() }
  catch (err) { console.error('[quit] 清理出错', err) }
  finally { clearTimeout(forceExit); app.quit() }
})()
```

### 3.3 第二实例直接强杀（`src/main/index.ts`）
```ts
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.exit(0)   // 而非 app.quit():ready 前调 quit 可能不干净/走 before-quit 卡住 → 僵尸
}
```

**要点**：`app.quit()` 会触发 `before-quit`、可被拦截、依赖事件循环；`app.exit(0)` 是 `process.exit` 级别的立即强杀。**能优雅则优雅（quit + 超时），必须保证退出时用 exit 兜底。**

---

## 4. 排查手册：怎么判断"进程是否真僵尸"

⚠️ **别把"多个同名进程"直接当僵尸！** 一个正常运行的 Electron app，`tasklist`/活动监视器里**本就有多个同名进程**：主进程 + GPU 进程 + 渲染进程 + 工具(utility)进程。一个 app 有 3-5 个 `Transfer.exe` 是**正常架构**。

**正确判断方法**：
1. **portable 启动器**（`Transfer-x.x.x-win-portable.exe`）应只有 **1 个**（当前运行 app 的启动器）。多余的才是僵尸。
2. **完全关闭 app 后**，`tasklist | findstr transfer`（mac: `ps aux | grep -i transfer`）应**清零**。关了还残留才是真僵尸。

**Windows 清残留**：
```
taskkill /F /IM Transfer.exe
taskkill /F /IM Transfer-x.x.x-win-portable.exe
```

---

## 6. dev 模式的孤儿进程(另一类僵尸,机制/修法都不同)

上面 §1–4 是**打包版退出**卡死变僵尸。**dev 模式**是另一条路径:`pnpm dev`(electron-vite dev)按 **Ctrl+C 后 electron app 不退、留在 Dock**,变孤儿,日积月累攒一堆(实测攒了 8 个,启动时间跨几天、父 PID 全被 launchd 收养成 1)。它们各自发心跳(多播/广播),干扰调试(抓包看到 N 份重复)。

**根因**:electron-vite dev 用 `spawn(electron, {stdio:'inherit'})` 起 electron,只做 `ps.on('close', process.exit)`(electron 关→vite 退),**反向不成立**——vite 被 Ctrl+C 时**不 kill electron 子进程**。叠加 mac `window-all-closed` 不退出(打包版正确行为)→ electron 永留 Dock。

**两个无效/有风险的弯路(别走)**:
1. `process.on('SIGINT'/'SIGTERM', ()=>app.quit())` —— **无效**,Electron 吞信号,handler 根本不触发(实测)。
2. 监听 `process.stdin` end/close 自杀 —— **有风险**,后台/无 tty 启动时 stdin 本就 end,electron 一起就自杀(实测复现)。

**正解(`src/main/index.ts`,v0.5.3)**:dev 下(gated:`process.env['ELECTRON_RENDERER_URL']` 只有 dev 有)记 `process.ppid`(=vite),每秒 `process.kill(ppid, 0)`(信号0=只探测存活)探测;抛错=vite 没了 → `app.quit()`。仅 dev 生效,打包版不触发。
```ts
if (process.env['ELECTRON_RENDERER_URL']) {
  const vitedPid = process.ppid
  const w = setInterval(() => {
    try { process.kill(vitedPid, 0) } catch { clearInterval(w); app.quit() }
  }, 1000)
}
```
验证:Ctrl+C 后 `ps aux | grep <app> | grep MacOS/Electron` 应清零。

## 5. 相关

- 修复版本:v0.3.1(server.close 超时 + before-quit 兜底)、v0.3.2(第二实例 exit)、**v0.5.3(dev 孤儿:父进程轮询)**
- 单实例锁(v0.3.1):防重复启动堆积,但**治不了"关不掉"这个根因**,两者都需要。锁基于 userData 目录,`TRANSFER_USERDATA` 多实例测试因路径不同不受影响。
- 退出竞态 `database is not open`:清理时先摘 store/core 引用置 null,让退出期到达的 IPC 走 `?.` 短路。

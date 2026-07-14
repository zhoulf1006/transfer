# 自定义截图快捷键

> 状态:**已实现**(typecheck/test 246/build 绿,待 dev 实测)。
> 需求:①设置里能自定义截图快捷键 ②显示当前键(未改则显默认)③改后即时生效 ④冲突检测/提示换键
> 落地:`shared/accelerator.ts`(+19 测)、`settings.ts` shortcutCapture(+5 测)、`screenshot-service.ts` `rebindShortcut`(含回滚)、IPC `getShortcut`/`setShortcut`、`SettingsModal` `ShortcutRecorder`。
> **code review 抓到的 bug(已修)**:录制 UI 的 `onBlur` 原本无条件清 hint,会把"捕获后 setShortcut 异步返回的冲突红字"也清掉 → 冲突提示看不到。改为**仅 `recording` 态才因失焦清提示**(捕获时已 `setRecording(false)`,故能区分)。

## 1. 事实层(调研坐实,带 file:line)

- **当前键硬编码 `'F1'`**:`screenshot-service.ts:93-94` `isRegistered('F1')` 守卫 + `register('F1', cb)`;返回值已查但仅 `console.warn`(`:94-99`),`:97` 有 TODO"暴露设置页提示改键"。
- **注册时机**:`start()`(`:70-74`)→ `index.ts:281`,app ready 后。**注销**:`stop()` 用 `globalShortcut.unregisterAll()`(`:78`)。
- **ScreenshotService 不知 settings 存在**(grep 零命中);`ScreenshotDeps`(`:40-50`)= rendererUrl/preload/sentImagesDir/sendFiles,无 settings。`registerShortcut` 是 private。
- **SettingsStore 模式**(`settings.ts`):`AppSettings` = autoAccept + theme;`normalize()` 逐字段容错;set 模式 `this.cache = normalize({...this.cache, X}); persist()`。
- **IPC 模式**:`CMD` = `'settings:<verb><Field>'`;main handler 转发 `settings!.xxx()`;preload 薄封装;`SettingsModal`(`App.tsx:607-670`)分区式,onSave 目前只传 autoAccept。
- **无 KeyboardEvent→accelerator 转换**(全项目零命中)——需新写。

### Electron globalShortcut 能力边界(electron.d.ts 坐实,决定冲突方案上限)

- `register(accel, cb): boolean` —— **被别的 app 占用时 silently fail 返 `false`**(electron.d.ts:7982-7984),不抛错、无冲突详情。
- `isRegistered(accel): boolean` —— **只反映"本 app 注册过没";被别的 app 占用时仍返 `false`**(electron.d.ts:7971-7973)。**无法预知**某键是否被别的 app 占。
- **OS 故意不让 app 互抢全局快捷键** → **无法"覆盖"别的 app 的快捷键**。
- 结论:冲突检测只能**注册试错**(register 返 false 即判占用),不能预知、不能强抢。→ 采「注册失败提示换键」(用户已确认)。

## 2. 决策(已与用户确认)

- **录入方式**:键盘录制——点输入框进入"按下快捷键…"态,捕获 keydown 组合键 → 转 accelerator 显示。
- **冲突处理**:保存时 main 侧试 `register`,返 false → 不保存、回错误给 UI 提示"可能被占用,请换一个"。**不覆盖别的 app**(OS 不允许)。
- **默认键**:保持 `F1`。未改时设置页显示 `F1`。

## 3. 方案

### 3.1 数据模型 + 持久化(settings.ts)

- `AppSettings` 加 `shortcutCapture: string`(Electron accelerator 字符串,如 `'F1'` / `'CommandOrControl+Shift+A'`)。
- `DEFAULT_SETTINGS.shortcutCapture = 'F1'`。
- `normalize()` 加校验:`typeof raw.shortcutCapture === 'string' && raw.shortcutCapture.trim() ? raw.shortcutCapture : DEFAULT`。**注意**:不在 normalize 里校验 accelerator 是否合法/可注册(那是运行时 register 的事);只保证是非空字符串。
- 加 `getShortcutCapture()` / `setShortcutCapture(accel)`。

### 3.2 accelerator 转换 + 校验(新增 shared/accelerator.ts,纯函数便于单测)

- `eventToAccelerator(e: {ctrlKey,metaKey,altKey,shiftKey,key,code}): string | null`
  —— 把 KeyboardEvent 转 Electron accelerator。规则:
  - 修饰键映射:mac 的 metaKey→`Command`,ctrlKey→`Control`;统一用 **`CommandOrControl`**?——**不**:录制是具体按键,mac 按的是 Cmd 就存 `Command`,Win 按 Ctrl 就存 `Control`。跨平台各存各的(用户在哪台录就存哪台的键)。alt→`Alt`,shift→`Shift`。
  - 主键:字母/数字/F1-F24/方向键等 → Electron 接受的键名(`A`/`1`/`F1`/`Up`…)。`e.code`/`e.key` 归一。
  - **只按修饰键(无主键)→ 返 null**(录制未完成)。
  - 允许**纯功能键**(F1-F24 无修饰,如默认 F1)。普通字母键**要求带修饰键**(否则 `A` 这种会拦截正常输入,不合理)——校验:非功能键且无修饰 → 返 null(提示"请配合 Cmd/Ctrl/Alt/Shift")。
- `isValidAccelerator(s: string): boolean` —— 供 main 侧保存前粗校验(非空、结构合法)。

> 为什么放 shared:纯字符串逻辑,renderer(录制时实时显示)和 main(保存校验)都要用,且可单测。

### 3.3 ScreenshotService 改造:可重绑

- `ScreenshotDeps` 加 `getShortcut: () => string`(注入读当前键的回调,解耦 SettingsStore)。
- `registerShortcut()` 改:`const accel = this.deps.getShortcut()`,注册它而非硬编码 `'F1'`。返回值 false 仍 warn(保留)。
- **新增 public `rebindShortcut(accel: string): boolean`**:先 `unregister 旧键`(记住 currentAccel)→ `register 新键` → 返回是否成功。失败则**回滚**(重新注册旧键),保证不会"改失败还把旧键弄没了"。
- **注销精确化**:`stop()` 仍可 `unregisterAll()`(退出全清 OK);但 rebind 用**针对性 `unregister(oldAccel)`**,避免误伤(虽目前只有一个键,但精确更稳)。

### 3.4 IPC

- `CMD.getShortcut: 'settings:getShortcut'` → main 返 `settings!.getShortcutCapture()`。
- `CMD.setShortcut: 'settings:setShortcut'` → main handler:
  1. 收到新 accel。
  2. 调 `screenshot!.rebindShortcut(accel)` 试注册。
  3. 成功 → `settings!.setShortcutCapture(accel)` 持久化 → 返 `{ ok: true, accel }`。
  4. 失败(register 返 false)→ **不持久化**、**回滚到旧键已在 rebind 内完成** → 返 `{ ok: false, reason: 'conflict' }`。
- 返回类型 `SetShortcutResult = { ok: true; accel: string } | { ok: false; reason: 'conflict' | 'invalid' }`。
- preload 暴露 `getShortcut()` / `setShortcut(accel)`。

### 3.5 UI(SettingsModal 加"快捷键"分区)

```
快捷键
截图:  [ F1        ]  ⌨   (点输入框→"按下快捷键…",捕获组合键)
       (冲突时:红字"该快捷键可能被占用,请换一个")
```

- 进弹层 `getShortcut()` 拿当前键显示。
- 点击输入框 → 进入录制态(`recording=true`),`onKeyDown` 阻止默认 + `eventToAccelerator` 实时显示;`Esc` 取消录制。
- 捕获到合法 accel → 调 `setShortcut(accel)`:
  - `ok` → 更新显示、清错误提示。
  - `!ok` → 红字提示,保持旧键。
- **即时生效**:main 的 rebind 已在 setShortcut 时完成,无需重启。

## 4. 边界 / 失败模式(前置纸面)

| 场景 | 处理 |
|---|---|
| 只按修饰键 | eventToAccelerator 返 null,不结束录制,继续等主键 |
| 普通字母无修饰(如按 `A`) | 返 null + UI 提示"需配合 Cmd/Ctrl/Alt/Shift"(否则拦截正常打字) |
| 功能键无修饰(F1-F24) | 允许(默认 F1 即此类) |
| 新键被别的 app 占用 | register 返 false → 不保存 → 回滚旧键 → UI 红字提示换键 |
| 新键 = 旧键 | rebind:unregister 旧→register 同键,正常成功(no-op 语义) |
| rebind 中新键注册失败 | **回滚**重注册旧键,保证截图键不丢 |
| 保存的 accel 非法(手改 settings.json) | normalize 只保证非空字符串;register 时失败 → 启动 warn,截图键不可用但不崩(退化,可接受) |
| 录制中切走窗口/失焦 | 退出录制态(recording=false),不误捕获 |
| Esc | 取消录制,不改键 |
| dev 改 main(rebind/register)不热重载 | 已知:改 main 需重启 dev(本项目通例) |

## 5. 影响面 / 改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/accelerator.ts`(新) | `eventToAccelerator` + `isValidAccelerator` 纯函数。 |
| `src/shared/accelerator.test.ts`(新) | 单测:修饰组合/功能键/纯修饰→null/字母无修饰→null/跨平台键名。 |
| `src/main/settings.ts` | `AppSettings.shortcutCapture` + DEFAULT + normalize 校验 + get/setShortcutCapture。 |
| `src/main/settings.test.ts` | 补 shortcut 持久化/normalize/不互相抹字段 测试。 |
| `src/main/screenshot-service.ts` | `ScreenshotDeps.getShortcut`;`registerShortcut` 读它;新增 `rebindShortcut`(含回滚);注销精确化。 |
| `src/main/index.ts` | 注入 `getShortcut: () => settings!.getShortcutCapture()`;IPC handler getShortcut/setShortcut(调 rebind + 持久化)。 |
| `src/shared/ipc.ts` | CMD getShortcut/setShortcut;`SetShortcutResult` 类型。 |
| `src/preload/index.ts` | 暴露 getShortcut/setShortcut。 |
| `src/renderer/src/App.tsx` | SettingsModal 加"快捷键"分区 + 录制交互 + 冲突提示;样式。 |
| `docs/` | 本文;DESIGN §12.8/相关 若涉及则同步。 |

## 6. 成功标准 / 验证

1. typecheck + test + build 绿。
2. `accelerator.ts` 单测覆盖:Cmd+Shift+A→`'Command+Shift+A'`、F1→`'F1'`、纯修饰→null、`A`无修饰→null、方向键、跨平台修饰名。
3. `settings.test.ts`:shortcut 持久化+重载、normalize 非法回默认、set 不抹 autoAccept/theme。
4. dev 实测:改键为 Cmd+Shift+A → 该键触发截图、F1 不再触发;显示更新;重启后仍是新键。
5. 冲突实测:设一个已被占用的键 → UI 红字提示、旧键仍生效。
6. 回归:默认不改时 F1 照常;其他设置读写不变。

## 7. 分步实现(带检查点)

1. `accelerator.ts` + 单测 → test 绿。✅转换/校验矩阵。
2. settings.ts shortcut 字段 + get/set + 单测 → test 绿。
3. screenshot-service `getShortcut` + `rebindShortcut`(回滚)→ typecheck。✅回滚逻辑。
4. IPC getShortcut/setShortcut + preload + index 注入 → typecheck。
5. SettingsModal 快捷键分区 + 录制 + 冲突提示 → build。
6. dev 实测(改键生效/冲突提示/重启持久)。
7. 回同步 DESIGN。
8. 全绿后发版(v0.4.3)。

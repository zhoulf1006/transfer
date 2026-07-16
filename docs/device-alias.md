# 设备备注(远端设备别名)— 设计文档

> 给局域网发现到的设备加自定义备注并持久化;右键设备 →「修改备注」/「清除备注」,点修改后**行内编辑**设备名。
> 归属:[DESIGN.md](./DESIGN.md) 设备发现/列表。
> **状态:已实现 + 实机验证通过**(七步全走完)。§5 边界含实现后 code-review 抓修的 race(§5.13-15,均已 live 验证);§5.16 右键顺带选中已真机确认不复现。
> 调研已坐实的现状均带 file:line;区分「确认」(读代码坐实)与「推断」(设计选择)。

---

## 0. 决策速览(已与用户确认)

| 维度 | 决策 | 备注 |
|------|------|------|
| **唯一键** | `DeviceInfo.fingerprint`(证书 SHA-256) | 唯一稳定标识;IP/端口会变、默认 alias 也可能变(`device-registry.ts:17` 就是 `Map<fingerprint,…>`) |
| **持久化** | `SettingsStore`(`settings.json`)新增 `deviceAliases: Record<fingerprint, 备注>` | 复用现有 cache+normalize+persist;**不碰 identity.json**(那是本机身份) |
| **显示** | 备注**完全替换**默认名(有备注只显备注) | 原名保留在 `info.defaultAlias`,供恢复/未来副标题 |
| **清空** | 备注设空串 → 删除映射 → 恢复默认名 | 右键「清除备注」直接触发,无需进输入框 |
| **离线保留** | 按 fingerprint **永久保留**,设备离线/真删都不清备注 | 同一 fingerprint 重新出现自动恢复备注 |
| **合并位置** | **main 侧**:发给 renderer 前 `applyAliases()` 合并 | 设备行 + 聊天标题栏两处 UI 自动一致,renderer 无感 |
| **IPC** | **新增** `device:setRemoteAlias(fp, alias) → {ok}` | **不复用** `device:setAlias`(`ipc.ts:58`,那是改本机名的) |
| **编辑入口** | **右键菜单**(自绘,非原生 contextmenu/dialog) | 避开铅笔与未读徽标抢位;项:有备注 `[修改备注][清除备注]`,无备注 `[修改备注]` |
| **编辑交互** | 点「修改备注」→ 设备名**行内变输入框**;回车/blur 提交、Esc 取消 | blur=提交;编辑中设备消失→提交(不丢输入) |
| **失败提示** | 加:main 返回 `{ok:false}` 且**不更新 cache**;renderer 就地标红+「保存失败」小字,编辑态不关 | 低频操作,悄悄失败体验差 |
| **图标** | 右键方案**不需要铅笔图标**;菜单纯文字项 | icons.tsx 不新增;符合 ui-design skill(纯文字菜单,不用 emoji 当图标) |

---

## 1. 需求调研结论(带 file:line)

### 1.1 唯一性(确认)
- 设备唯一标识 = `DeviceInfo.fingerprint`(`src/shared/types.ts:14`),来源是本机自签名证书 SHA-256(`device-identity.ts:81` `certFingerprint(cert)`),存 `identity.json`,**跨重启稳定**。
- `DeviceRegistry` 内部 `Map<fingerprint, RemoteDevice>`(`device-registry.ts:17,33,36`);全 app 引用设备一律用 fingerprint(`app-core.ts:124`、`App.tsx:63,260`)。

### 1.2 持久化基础设施(确认)
- `SettingsStore`(`settings.ts`)存 `userData/settings.json`,有 `cache + normalize() + persist()`,已存 autoAccept/theme/shortcut。**设备备注归宿**。
- `AppCore` 构造 opts **已注入** `settings: SettingsStore`(`app-core.ts:36,303`)→ `applyAliases` 在 app-core 内可直接 `this.opts.settings.getDeviceAliases()`。
- ⚠️ 现有 `device:setAlias`(`ipc.ts:58`,handler `index.ts:140` → `saveAlias`)改的是**本机名**(identity.json),**与本需求无关,不复用**。

### 1.3 设备列表数据流(确认)
- 出口有**三处**必须合并备注:
  - `app-core.ts:168` `if (changed) onDevicesUpdated(registry.list())`(upsert 后)
  - `app-core.ts:200` `if (changed) onDevicesUpdated(registry.list())`(prune 后)
  - `app-core.ts:238-239` `listDevices()` → `registry.list()`(renderer 主动拉)
- renderer 显示 alias 有**两处**,都读同一 `RemoteDevice.info.alias`:
  - 设备行 `App.tsx:269` `{d.info.alias}`
  - 聊天标题栏 `App.tsx:231-232` `peerAliasOf` → `:206` 传入 chat view
- ∴ 只要在 main 出口把 `info.alias` 换成"显示名",两处 UI **自动一致**。

### 1.4 UI 结构(确认)
- `DeviceRow`(`App.tsx:254-278`):当前 `[● 状态圆点(:268)][设备名(:269)]`,副标题 `deviceModel · address`(:271-273),行最右已有**未读徽标**(`:275` `unreadBadge`)。
- 设备行 `onClick={onPick}`(`:262`,选中进聊天)。**右键要 preventDefault + 不触发 onPick**。
- icons.tsx 现有 10 个内联 Lucide 图标(`icons.tsx`),**无铅笔**——本方案改右键菜单后也不需要。
- ⚠️ memory「遮罩指针冒泡坑」:自绘菜单点击必须 `stopPropagation`,否则被行 `onClick` 截走。

---

## 2. 数据结构

### 2.1 settings.ts
```ts
export interface AppSettings {
  autoAccept: AutoAcceptSettings
  theme: ThemePref
  shortcutCapture: string
  deviceAliases: Record<string, string>   // 新增:key=fingerprint, value=备注(非空)
}

// DEFAULT_SETTINGS 加:
deviceAliases: {}
```

**normalize() 容错**(防损坏文件/旧版本无此字段):
```ts
// raw.deviceAliases 非 object → {};逐项过滤:key 非空串、value 非空串才保留
const deviceAliases: Record<string, string> = {}
const rawMap = (r.deviceAliases ?? {}) as Record<string, unknown>
if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
  for (const [fp, name] of Object.entries(rawMap)) {
    if (fp && typeof name === 'string' && name.trim()) deviceAliases[fp] = name
  }
}
```
> 关键:normalize 过滤空 value —— 保证内存里 `deviceAliases` 的 value 恒为非空,消费端不用再判空。

### 2.2 SettingsStore 方法
```ts
getDeviceAliases(): Record<string, string> {
  return this.cache.deviceAliases
}

/** 设备备注。空串(trim 后)= 删除该 key(恢复默认名)。返回是否持久化成功。 */
setDeviceAlias(fingerprint: string, alias: string): boolean {
  const trimmed = alias.trim()
  const next = { ...this.cache.deviceAliases }
  if (trimmed) next[fingerprint] = trimmed
  else delete next[fingerprint]
  const prevCache = this.cache
  this.cache = normalize({ ...this.cache, deviceAliases: next })
  try {
    this.persist()
    return true
  } catch (e) {
    this.cache = prevCache        // ★ 失败回滚,不留"内存改了盘没存"的假成功
    console.error('[settings] persist deviceAlias failed:', e)
    return false
  }
}
```
> ⚠️ 与现有 `setTheme`/`setAutoAccept` 的差异:那些 `persist()` 不 catch(抛异常)。本方法**特意 catch + 回滚 + 返回 bool**,因为要给 renderer 失败反馈。这是**有意的不一致**,不是疏漏。

### 2.3 types.ts
```ts
export interface DeviceInfo {
  alias: string             // 现有:显示名(main 合并后 = 备注优先)
  // …
  defaultAlias?: string     // 新增:对端广播的原始默认名(合并时填,供"清除恢复"与未来副标题)
  hasCustomAlias?: boolean  // 新增:是否有自定义备注(菜单据此决定显不显示[清除备注])
}
```
> 为什么加 `defaultAlias`:合并在 main 做,renderer 只收结果;要"清除后显示原名"需知道原名,由 main 带下来最省事。
> **为什么加 `hasCustomAlias`(review 修的 Bug#1)**:菜单不能靠 `alias !== defaultAlias` 判断"有无备注"——用户把备注设成**与默认名相同**的串时,`alias===defaultAlias` 会误判"无备注"、`[清除备注]` 消失、备注无法从菜单清除。故 main 显式下发布尔,renderer 不做字符串比对。

---

## 3. main 侧:applyAliases 合并 + IPC

### 3.1 合并函数(app-core.ts,私有)
```ts
private applyAliases(devices: RemoteDevice[]): RemoteDevice[] {
  const aliases = this.opts.settings.getDeviceAliases()
  return devices.map((d) => {
    const custom = aliases[d.info.fingerprint]    // 恒非空或 undefined(normalize 已滤空)
    return {
      ...d,
      info: {
        ...d.info,
        defaultAlias: d.info.alias,               // 原名恒保留
        alias: custom || d.info.alias,            // 备注优先
        hasCustomAlias: !!custom                  // ★ 菜单据此判定,不靠字符串比对
      }
    }
  })
}
```
**三处出口全部改走它**(1.3 列的):
- `app-core.ts:168` → `onDevicesUpdated(this.applyAliases(this.registry.list()))`
- `app-core.ts:200` → 同上
- `listDevices()` → `return this.applyAliases(this.registry.list())`
> ⚠️ **三处都要改,漏一处就某条路径显示不一致**(review 时重点查)。

### 3.2 改备注后立即刷新(app-core.ts 新增方法)
```ts
/** 设备备注写盘 + 立即刷新列表。返回 {ok}。 */
setRemoteAlias(fingerprint: string, alias: string): { ok: boolean } {
  const ok = this.opts.settings.setDeviceAlias(fingerprint, alias)
  if (ok) {
    // 立即推一次(不等下次多播),让改动即时可见
    this.opts.events.onDevicesUpdated(this.applyAliases(this.registry.list()))
  }
  return { ok }
}
```
> 不校验 fingerprint 是否在 registry:允许给已离线/已删设备写备注(符合"永久保留"),重新出现自动生效。

### 3.3 IPC 契约
- `ipc.ts`:`setRemoteAlias: 'device:setRemoteAlias'`
- `index.ts` handler:
```ts
ipcMain.handle(CMD.setRemoteAlias, (_e, a: { fingerprint: string; alias: string }): { ok: boolean } => {
  return core?.setRemoteAlias(a.fingerprint, a.alias) ?? { ok: false }
})
```
- `preload/index.ts`:
```ts
setRemoteAlias: (fingerprint: string, alias: string): Promise<{ ok: boolean }> =>
  ipcRenderer.invoke(CMD.setRemoteAlias, { fingerprint, alias }),
```

---

## 4. renderer 侧:右键菜单 + 行内编辑

### 4.1 状态(提到 DeviceList 层,同时只一个可编辑/一个菜单)
```ts
const [menuFp, setMenuFp] = useState<string | null>(null)          // 右键菜单针对哪台设备
const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
const [editingFp, setEditingFp] = useState<string | null>(null)   // 行内编辑中的设备
const [draft, setDraft] = useState('')
const [saveError, setSaveError] = useState(false)                  // 当前编辑框是否保存失败
const [menuClearError, setMenuClearError] = useState(false)        // 菜单「清除备注」是否失败(Bug#2)
```
> 打开/切换菜单、进入编辑时都要 `setMenuClearError(false)` 复位。

### 4.2 右键菜单
- 设备行加 `onContextMenu`:
```ts
onContextMenu={(e) => {
  e.preventDefault()          // 阻原生菜单
  e.stopPropagation()         // 不冒泡到 onPick
  setMenuPos({ x: e.clientX, y: e.clientY })
  setMenuFp(d.info.fingerprint)
}}
```
- 菜单组件(自绘,fixed 定位在 menuPos):
  - 项:`[修改备注]`;若 **`d.info.hasCustomAlias`**(Bug#1 修:用布尔,不用字符串比对)再加 `[清除备注]`。
  - 「修改备注」→ 进入编辑:`setEditingFp(fp); setDraft(d.info.alias); setSaveError(false); setMenuFp(null)`;下一帧 input `focus()+select()`。
  - 「清除备注」→ `const { ok } = await setRemoteAlias(fp, '')`(删映射)。**(Bug#2 修)清除也要失败反馈**:
    - `ok` → `setMenuFp(null)` 关菜单(成功,列表自动刷新去掉备注)。
    - `!ok` → **不关菜单**,菜单内该项下方显红字「清除失败,请重试」;用户可再点。—— 保证清除失败不静默(与行内编辑的标红对齐)。
  - **菜单容器 `onClick`/`onContextMenu` 都 stopPropagation**(memory 冒泡坑)。
- **关闭菜单**:点菜单外(document mousedown 监听)、Esc、选了任一项 → `setMenuFp(null)`。
  - ⚠️ document 监听要在 `menuFp !== null` 时才挂,卸载时移除;监听里判断点击目标不在菜单内才关。
- **定位回弹**:菜单渲染后若 `x+宽 > innerWidth` 则左移、`y+高 > innerHeight` 则上移(防溢出视口)。

### 4.3 行内编辑状态机
一行两形态:
- 展示态(`editingFp !== fp`):`[● 圆点][设备名][未读徽标]`(原样)。
- 编辑态(`editingFp === fp`):`[● 圆点][<input>]`;input 受控 `value={draft}`,`autoFocus`,挂载时 `select()`。

| 触发 | 处理 |
|------|------|
| 输入 | `setDraft(e.target.value); setSaveError(false)` |
| **回车**(Enter) | `commit(fp, draft)` |
| **Esc** | `cancel()`:`setEditingFp(null); setSaveError(false)`(draft 丢弃,不提交) |
| **blur** | 若 `editingFp===fp` 才 `commit(fp, draft)`(见 race §5.2) |

```ts
// ⚠️ 签名带显式 value(不靠 draft 闭包)——见 §5.13 code-review 修的 race。
async function commit(fp: string, value: string) {
  const { ok } = await window.transfer.setRemoteAlias(fp, value)  // main 侧 trim+空判删
  if (ok) {
    // 只在"仍在编辑刚提交的这台"才关:防切换设备后旧提交的 await 迟到清掉新编辑(§5.14)
    setEditingFp((cur) => (cur === fp ? null : cur))
    setSaveError(false)
  } else {
    setSaveError(true)                                            // ★ 失败:编辑态不关,标红
  }
}
function cancel() { setEditingFp(null); setSaveError(false) }
// 所有调用点都传 draft:Enter/blur/切换设备/设备消失兜底 → commit(fp, draft)
```

**startEdit(进入编辑,§5.12 修):**
```ts
function startEdit(fp, currentAlias) {
  // 若正编辑**另一台**未提交 → 先用其当前 draft 提交它(不丢输入),再切
  if (editingFp && editingFp !== fp) void commit(editingFp, draft)
  setEditingFp(fp); setDraft(currentAlias); setSaveError(false); closeMenu()
}
```

### 4.4 失败提示(UI)
- `saveError && editingFp===fp` 时:input 边框用 theme.css 错误色变量、下方一行小字「保存失败,请重试」。
- 用户改内容(onChange)清 `saveError`,再回车重试。
- ⚠️ 失败时 blur 也会再触发 commit —— 幂等(同 draft),失败仍 setSaveError(true),无害。

---

## 5. 边界 / race / 失败模式(批判式前置)

1. **回车与 blur 双触发提交**:回车常导致 input 失焦 → 再触发 blur。`commit` 成功后 `setEditingFp(null)`,blur handler 判 `editingFp===fp` 已为 false → return,不重复提交。**成功路径不双发**;失败路径 `editingFp` 仍在 → blur 会再 commit 一次(同参幂等,仍标红),无害。
2. **Esc 后 blur**:Esc 先 `setEditingFp(null)` → input 卸载触发 blur → handler 判 `editingFp===fp` 为 false → **忽略,不提交**(保证 Esc 真取消)。✅ 靠"blur 只在 editingFp===fp 时提交"这一条统一挡住。
3. **编辑中设备列表刷新**(`devices:updated` 到来):`editingFp`/`draft` 是**独立 UI 状态**,不随 devices 数组重置。要确认重渲染不踩这俩(它们在 DeviceList 顶层 useState,与 devices prop 无耦合)。input 用受控 `draft`(非 `d.info.alias`),故 devices 刷新不覆盖用户正在输入的内容。✅
4. **编辑中设备消失**(offline 超 keep 被真删,行不再渲染):input 卸载 → blur 触发 → 因 `editingFp===fp` 仍成立 → **commit 提交**(用户选的"消失时提交,不丢输入")。备注按 fingerprint 存,设备回来自动生效。提交后 `setEditingFp(null)` 清悬空。
   - 补强(已实现):加 `useEffect([devices])`,若 `editingFp` 不在 `devices` 列表里 → 主动 `commit(editingFp, draft)`(兜底,防某些卸载路径 blur 没触发)。
5. **两处显示一致**:改名走 `applyAliases`+`setRemoteAlias` 刷新,聊天标题栏 `peerAliasOf` 读的是同一份刷新后的 devices,自动跟着变。✅
6. **持久化失败**(磁盘满/无权限):`setDeviceAlias` catch + **回滚 cache** + 返回 false → handler 返回 `{ok:false}` → renderer 标红不关。**不产生假成功**。✅
7. **normalize 兜底**:旧 settings.json 无 `deviceAliases` 字段 → normalize 补 `{}`;文件损坏 → load 时 catch 用默认。✅
8. **fingerprint 碰撞/复用**:证书 SHA-256,实务不碰撞;若用户删 identity.json 重生成证书 → 新 fingerprint → 旧备注失效(遗留在 settings 里但不再匹配任何设备)。可接受(不做清理);未来可加"清理孤儿备注"。
9. **同名不同设备**:两台设备默认名相同,备注按各自 fingerprint 独立存,互不影响。✅
10. **右键菜单指针冒泡**:菜单点击 stopPropagation,不触发行 onPick(选中);`onContextMenu` preventDefault 阻原生菜单。✅(memory 冒泡坑已纳入)
11. **(设计 review Bug#1)备注 == 默认名**:菜单「有无备注」若靠 `alias !== defaultAlias` 判定,会在备注与默认名相同时误判"无备注"、`[清除备注]` 消失。修:main 下发 `hasCustomAlias` 布尔,菜单据此判定。✅
12. **(设计 review Bug#2)清除备注失败静默**:清除走菜单、点完即关,失败则用户无反馈。修:清除 await 返回值,`!ok` 时不关菜单 + 菜单内红字提示。✅

**以下为第 5 步 code-review(实现后批判自审)抓到并修的 race,均已实机 live 验证:**

13. **(code-review)菜单孤儿**:`menuFp` 无 effect 在设备消失时清 → 设备离线被删后菜单悬挂指向不存在设备。修:加 `useEffect([devices])`,`menuFp` 对应设备不在 `devices` 里时 `closeMenu()`。触发条件(offline+5min 真删)极低频,已 live 验证在线设备不被误关。✅
14. **(code-review)切换编辑丢草稿**:编辑 A 未提交时点 B 的「修改备注」→ `startEdit(B)` 直接 `setEditingFp(B)`,A 草稿静默丢。修:`startEdit` 里若正编辑另一台 → 先 `commit(旧fp, draft)` 再切(见 §4.3)。live 验证:切换后 A 的备注已入盘不丢。✅
15. **(code-review)commit 迟到清编辑 race**:修 #14 时暴露——`commit(A)` 是 async,`await` 后 `setEditingFp(null)` 会迟到清掉已切到的 B 的编辑态。修:`commit(fp, value)` 传显式值(不靠 draft 闭包)+ `setEditingFp(cur => cur===fp ? null : cur)` 只关刚提交那台。live 验证:B 编辑态未被 A 的迟到提交清掉。✅
16. **右键顺带选中设备 → 真机确认不复现**:verify 时 CDP 合成 contextmenu 曾观测到右键设备被 `onPick` 选中,但**真机右键实测不会切走聊天对象**——如预期,因为真实鼠标右键**不触发** click 事件(click 仅左键/Enter),`onContextMenu` 只弹菜单。那是 CDP 合成事件的假象,非代码 bug,无需改。✅

---

## 6. 改动清单(实现用)

**main:**
- `settings.ts`:`AppSettings` +`deviceAliases`;`DEFAULT_SETTINGS`;`normalize` 过滤;`getDeviceAliases`/`setDeviceAlias`(catch+回滚+bool)。
- `types.ts`:`DeviceInfo` +`defaultAlias?` +`hasCustomAlias?`(仅 main applyAliases 填,不入协议报文)。
- `app-core.ts`:`applyAliases` + `emitDevices`(统一出口)+ `setRemoteAlias`;三处发现层出口(handleDevice/prune/listDevices)全走合并。
- `ipc.ts`:+`setRemoteAlias` 通道。
- `index.ts`:+handler。
- `preload/index.ts`:+`setRemoteAlias` API(`TransferApi=typeof api` 自动传类型,`global.d.ts` 无需改)。

**renderer(受 ui-design skill:纯文字菜单、theme.css 变量、无 emoji):**
- `App.tsx`:Sidebar 加菜单/编辑状态;`DeviceRow` 加 `onContextMenu` + 编辑态渲染;自绘 `DeviceContextMenu` 组件(定位回弹+点外/Esc 关);两个 `useEffect([devices])`——编辑设备消失兜底提交(§5.4)、菜单设备消失关菜单(§5.13);失败标红。
- 样式走 `theme.css` 变量(`--card`/`--line`/`--danger`/`--line-strong`/`--shadow-md`);新样式加进 `S`(aliasInput/aliasErr/ctxMenu/ctxItem/ctxErr)。

**测试:**
- `settings.test.ts`(+11):setDeviceAlias 增/删(空串删)、trim、normalize 过滤脏数据(空/非串 value、空 key、数组)、跨字段隔离、persist 失败回滚返 false。
- `app-core.alias.test.ts`(+9,新文件):applyAliases 合并(有/无备注)、Bug#1(备注==默认名仍 hasCustomAlias)、setRemoteAlias 推送内容+{ok}、空串清除、离线预设自动生效、persist 失败不推、同名独立、**ghost-fp(不在 registry 的 fp 不崩)**。
- **renderer 状态机不写单测**:本项目刻意不测 renderer(`vitest.config.ts` `environment:'node'`、无 jsdom、`include:['**/*.test.ts']`)。改由 **verify skill 实机 live 驱动**覆盖:右键→改→回车/Esc/blur/清除/切换设备/失败标红/跨重启,均已验证(见 §5.13-15)。

---

## 7. 非目标(本次不做)
- 孤儿备注清理(删证书后遗留的映射)。
- 备注的跨设备同步(仅本机 settings.json)。
- 原名副标题展示(`defaultAlias` 已备下,UI 暂不显)。
- 备注长度限制/字符校验(trim 之外不限;如需再加)。

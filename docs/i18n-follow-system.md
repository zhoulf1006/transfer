# i18n:界面语言支持「跟随系统」

> 目标:app 界面文案支持中英双语,并能**跟随系统语言**。语言偏好三态 `system | zh | en`,默认 `system`,与现有 `theme` 完全对称。

## 0. 背景与现状(事实,带证据)

- **当前无任何 i18n 层**:全项目无 i18n 目录、无翻译文件、无 `t()`。UI 文案全部中文硬编码在 JSX / 主进程里。
- **用户可见文案总量**(Explore 盘点):渲染层约 **50 条** unique(App.tsx ~45、overlay.tsx ~14、ErrorBoundary 2),主进程真正 UI 文案约 **6–7 条** + 文件名前缀。**无 Tray/Menu/Notification**(grep 确认),主进程原生文案仅:`showErrorBox`(index.ts:297/353)、screenshot 权限 `showMessageBox`(screenshot-service.ts:214)、文件名前缀 `图片_`/`截图_`、dialog filter `PNG 图片`。
- **可照抄的范式**:`theme` 已是 `'system'|'light'|'dark'` 三态。持久化(settings.ts:16,44,110-118)、IPC 三段式(ipc.ts:86-87 → preload:61-62 → index.ts:243-244)、渲染层热切换(App.tsx `useTheme` 36-57)全部可作为 `language` 的模板。
- **架构**:主进程 + **两个独立渲染 window**(index + overlay,各自 React root:App.tsx / overlay.tsx),`@shared` 别名三端可用(tsconfig.web/node + electron.vite.config)。

## 1. 选型决策(已与用户对齐)

| 决策点 | 结论 | 依据 |
|---|---|---|
| 支持语言 | zh(简体)+ en | 用户确认 |
| 语言偏好 | `'system'\|'zh'\|'en'` 三态,默认 `system` | 与 theme 对称 |
| 跟随系统判定 | `app.getPreferredSystemLanguages()[0]`,含 `zh` 前缀→zh,否则→en | 官方文档明示此 API 用于"deciding what language to present"(electron.d.ts:1258),优于 `getLocale()` |
| 生效时机 | 手动切 zh/en **即时热切换**;`system` 下系统语言变化需重启读取 | 用户确认;Electron 无系统语言变化事件 |
| 切换 UI | 落在现有 `SettingsModal` 新增「语言」分区;**theme 不动** | 用户确认(窄而完整) |
| 翻译范围 | 渲染层 + 主进程用户可见文案全覆盖 | 用户确认 |
| **t() 引擎** | **自研极简 t() + 共享字典**,零依赖 | 调研:VS Code/Signal/Joplin/Element/Bitwarden/Logseq **无一用 i18next**;走 React 的用 FormatJS/counterpart,其余自研。你 55 条/2 语言/无复数,引擎卖点全用不上;贴合 electron-slimming 取向 |
| system 解析位置 | **主进程解析,IPC 回传 `effective`** | 只有主进程能调 `getPreferredSystemLanguages()`;渲染层不自猜(避免两来源不一致) |
| 主进程语言同步 | `setLanguage` 时更新主进程内存 `currentLang`;后续文案读它 | 主进程文案少且事件时临时生成 |

## 2. 架构设计

### 2.1 共享字典模块(单一数据源,三端 import)

照 VS Code/Joplin 思路:一份纯数据字典,main + 两个 renderer 都 import 同一模块。

```
src/shared/i18n/
  dict.ts     // { zh: {...}, en: {...} } 纯数据 + Lang 类型 + key 联合类型
  t.ts        // createT(getLang): 极简查表 + {var} 插值 + 兜底;不含 React
```

- **`Lang = 'zh' | 'en'`**(有效语言,非偏好);**`LangPref = 'system' | 'zh' | 'en'`**(偏好,存盘)。
- `dict.ts`:`const DICT: Record<Lang, Record<string, string>>`。key 用命名空间点号(见 §4)。
- **翻译完整性用类型保证**:以 `zh` 的 key 集合为 `TKey` 联合类型,`en` 必须实现同一组 key(`Record<TKey, string>`)——缺 key 编译报错。这是自研相比引擎的一个**优势**(引擎多为运行时 key、漏译静默回退)。

### 2.2 `t()` 语义

```ts
// createT 返回一个读“当前有效语言”的 t;当前语言从外部注入(renderer=context state,main=模块内 currentLang)
function t(key: TKey, params?: Record<string, string | number>): string
```

- 查 `DICT[lang][key]`;缺失回退 `DICT.en[key]`;再缺回退 `key` 本身(开发期可见,不崩)。
- 插值:把 `{name}` 形式占位符按 `params` 做字符串替换(**不做字符串相加**,所有含变量文案走 `{var}`)。
- 无复数、无 ICU(需求无)。

### 2.3 渲染层接线(热切换核心)

新增 `src/renderer/src/i18n.tsx`(React 层,薄):

```
LangContext = createContext<{ lang: Lang; pref: LangPref; setPref: (p)=>void }>
useI18n(): { t, lang, pref, setPref }   // t 闭包当前 lang
<I18nProvider>  // 包在 App 与 overlay 两个 root 最外层
```

- **初值**:`pref='system'`、`lang='zh'`(不阻塞首屏;真实值 IPC 异步拉回)——照 `useTheme` 初值 system 的做法(App.tsx:37-38)。
- **首次**:`getLanguage()` IPC 拉回 `{pref, effective}`,`setPref(pref)` + `setLang(effective)`。
- **切换**:`setPref(p)` → `setLanguage(p)` IPC → main 回传新的 `{pref, effective}` → 用 `effective` 更新 context lang → **整树重渲染**(React context 天然驱动,全部 `t()` 重算)。
- **两个 window 各包一个 `<I18nProvider>`**,各自独立拉取——它们读同一 settings,`effective` 一致。
- **⚠️ overlay 是常驻(persistent)且复用的窗**:`ScreenshotService.ensureOverlay` 首次 F1 才懒建,之后只 `hide()`/`show()` 复用,**不重载**。所以它的 `<I18nProvider>` 只在**创建那一刻** mount 一次、只拉一次 `getLanguage()`。这带来两个必须解决的问题:
  - **首帧闪现**:首次 F1 时 overlay 首帧 `lang` 占位 zh,英文用户会看到一瞬中文再校正。
  - **改语言后不更新**:创建后在主窗改语言,overlay 已 mount、不会自己重拉。
- **解法(两件,缺一不可)**:
  1. **URL query 无闪注入**:overlay 真正的加载在 **`ScreenshotService.loadOverlay`**(不是 `index.ts` 的 `loadRenderer`——那只加载主窗!),在此把 `getMainLang()` 拼进 `overlay.html?lang=xx`;`langFromQuery()` 读它作 `lang` 初值 → **首次打开首帧即正确**。
  2. **`EVT.languageChanged` 广播**:`setLanguage` handler 里 `BrowserWindow.getAllWindows()` 逐个 `webContents.send(EVT.languageChanged, effective)`;两个 `<I18nProvider>` 都 `onLanguageChanged` 订阅、`setLang(effective)` 热切换 → **覆盖"另一 window(尤其常驻 overlay)改语言后要更新"**。发起改语言的 window 自身也会收到(值相同,幂等)。
  - query(1)负责常驻 overlay 的**首帧**,广播(2)负责它**创建之后**的所有变化;主窗的即时切换由 `setPref` 自身的 `.then` + 广播共同保证。

### 2.4 主进程接线

- `src/main/i18n.ts`:模块内 `let currentLang: Lang`;`createT(() => currentLang)` 导出 `t`;`setMainLang(lang)` 更新 `currentLang`;`resolveEffective(pref): Lang` 用 `app.getPreferredSystemLanguages()`。
- 启动时(app ready 后)读 `settings.getLanguage()` → `setMainLang(resolveEffective(pref))`。
- **`getLanguage` IPC handler**:返回 `{ pref: settings.getLanguage(), effective: resolveEffective(pref) }`。
- **`setLanguage` IPC handler**:`settings.setLanguage(pref)`(存盘)→ `setMainLang(resolveEffective(pref))`(更新内存)→ 返回同样的 `{pref, effective}` 给 renderer。
- 主进程文案改用 `t('main.dialog.initFail')` 等;文件名前缀 `t('main.file.imagePrefix')`。

### 2.5 持久化(settings.ts)

照 theme 加:
- `export type LangPref = 'system' | 'zh' | 'en'`
- `AppSettings.language: LangPref`;`DEFAULT_SETTINGS.language = 'system'`
- `normalize`:`r.language === 'zh'|'en'|'system' ? r.language : 'system'`
- `getLanguage(): LangPref` / `setLanguage(pref): LangPref`(照 getTheme/setTheme,不 catch 抛异常)

### 2.6 IPC 三段式(照 theme)

- `ipc.ts`:`CMD.getLanguage = 'settings:getLanguage'`、`CMD.setLanguage = 'settings:setLanguage'`;新增事件 `EVT.languageChanged = 'language:changed'`;类型 `LangPref`、`Lang`、`LangResult = { pref: LangPref; effective: Lang }`。
- `preload/index.ts`:`getLanguage(): Promise<LangResult>`、`setLanguage(p: LangPref): Promise<LangResult>`、`onLanguageChanged(cb: (lang: Lang)=>void)`(订阅,返回取消函数)。
- `main/index.ts`:两个 `ipcMain.handle`,如 §2.4;`setLanguage` 里额外 `BrowserWindow.getAllWindows()` 逐个 `send(EVT.languageChanged, effective)`。

## 3. system 语言解析规则(精确)

```ts
function resolveEffective(pref: LangPref): Lang {
  if (pref === 'zh' || pref === 'en') return pref
  // pref === 'system'
  const langs = app.getPreferredSystemLanguages() // ['zh-Hans-CN', 'en-US', ...] 按偏好排序
  const top = (langs[0] ?? '').toLowerCase()
  return top.startsWith('zh') ? 'zh' : 'en'  // 只支持中英:含 zh 前缀→zh,其余(含空/未知)→ en
}
```

- 兜底:`getPreferredSystemLanguages()` 返回空数组 → `top=''` → en。
- **必须 app ready 后调用**(electron.d.ts:1258 同类 API 注明);启动读取放在 ready 之后。

## 4. 翻译 key 结构(命名空间)

```
common.*      cancel/save/openFolder/settings/accept/reject（offline/retry 未用已删,离线走 sidebar.deviceOffline/chat.offlineTag,重试走 error.retry）
sidebar.*     brand、self(本机·{alias})、online(在线·{count})/offline(离线·{count})/searching、received、ctxRenameAlias/ctxClearAlias、aliasSaveFail/aliasClearFail
chat.*        emptyPickDevice/emptySearching、dropHint、inputPlaceholder、captureTitle/sendFileTitle、offlineTag、noMessages
chat.status.* statusLabel 参数化:pendingSent/pendingRecv/accepting/sent/delivered/received/rejected/expired  (× direction 拆成独立 key)
chat.failed.* failedLabel 参数化:busy/timeout/refused/certMismatch/default
downloads.*   title、empty、from(来自 {alias})
image.*       thumbTitle、saveImage、openWithSystem
settings.*    title、sectionReceive/autoAcceptLabel/maxSizeLabel、sectionStorage/fileLabel/openFolderTitle、sectionShortcut、sectionLanguage(新增)、cancel/save
settings.lang.* system/zh/en (语言选择器选项名)、systemHint(改系统语言后需重启应用生效)
shortcut.*    captureLabel、recordGuide/recordGuideEsc、saving、hintNeedModifier/hintUnsupported/hintContinue、errConflict/errInvalid
theme.*       system/light/dark、tooltip(主题:{label}(点击切换))  // theme 文案也一并抽(按钮 title 含中文)
overlay.*     loading、magnifierHint、opHint、strokeWidth(粗细,盘点遗漏、实现时补)、undo/redo/copyClipboard/saveFile、sendToPeer/sendNoPeer
overlay.tool.* rect/ellipse/arrow/line/pen/mosaic/blur/text/badge
error.*       boundarySuffix(出错了)、retry  // ErrorBoundary:{label}出错了 → t('error.boundarySuffix',{label})
main.dialog.* initFailTitle/initFailBody({err})、startFailTitle、screenPermTitle/screenPermDetail/screenPermOpen/screenPermCancel
main.file.*   imagePrefix(图片_)、screenshotPrefix(截图_)、pngFilterName(PNG 图片)
```

**参数化清单**(禁字符串相加,走 `{var}`):
- `sidebar.self {alias}`、`sidebar.online {count}`、`sidebar.offline {count}`、`downloads.from {alias}`、`error.boundarySuffix {label}`、`theme.tooltip {label}`。
- `chat.status.*`:`statusLabel(m)` 按 `status` 拆 key,pending/done 再按 `direction` 拆成 `pendingSent`/`pendingRecv`/`sent`(已送达)/`received`(已接收)——用独立 key 而非运行时拼。
- `chat.failed.*`:`failedLabel(reason)` 按 errorReason 枚举映射;`chat-service` 仍只产 `errorReason` 枚举,文案在渲染层 `t()` 生成(链路不变)。

## 5. 语言选择 UI(SettingsModal 新增分区)

- 在「快捷键」分区后加「语言」分区:一个 `<select>`,选项 `system(跟随系统)/中文/English`,值为 `LangPref`。
- **即时生效**:onChange 直接 `setPref(p)`(走 §2.3 热切换),**不进 SettingsModal 的 onSave**——语言走独立 IPC,和 AutoAccept 的保存/取消解耦(与 theme 独立于 AutoAccept 一致)。因此选完即时切,关 Modal 不回滚。
- select 是项目现无的组件;用原生 `<select>` + theme.css 变量(遵 ui-design 规范,禁硬编码色)。
- **system 提示**(决策):当前 `pref==='system'` 时,select 下方显示一行小字 `settings.lang.systemHint`(zh:「改系统语言后需重启应用生效」/ en 对应),消除 B5 困惑。非 system 时不显示。

## 6. 边界与失败模式(按用户真实操作序列穷举)

| # | 用户操作序列 | 期望 | 设计覆盖 |
|---|---|---|---|
| B1 | 首次启动、系统中文、pref=system | 界面中文 | ready 后 resolveEffective→zh;renderer 首拉 effective=zh |
| B2 | 首次启动、系统英文/其他语言、pref=system | 界面英文 | top 不以 zh 开头 → en |
| B3 | 设置里 system→中文→English 连续切 | 每次即时热切,无需重启 | context 驱动整树重渲;每次 IPC 回传新 effective |
| B4 | 选 English 后关 app 再开 | 仍 English | pref='en' 存盘,启动读回 |
| B5 | pref=system,用户改了系统语言,不重启 app | **不实时变**(重启后变) | 无系统语言事件;select 选中 system 时显示 systemHint 小字说明 |
| B6 | 首次 F1 打开 overlay(system=英文) | overlay 首帧即英文、**无中文闪** | loadOverlay 的 URL query 带 effective,langFromQuery 读作初值 |
| B7 | 切语言后触发 showErrorBox / 截图权限框 / 存图 | 主进程文案用新语言 | setLanguage 已更新 main currentLang;主进程文案读它 |
| B8 | settings.json 里 language 字段损坏/缺失/非法值 | 回退 system | normalize 容错 |
| B9 | `getPreferredSystemLanguages()` 返回空 | 回退 en | resolveEffective 兜底 |
| B10 | 文件名前缀:中文界面存的 `图片_x.png` 切英文后 | 已存文件名不变(历史文件),新存文件用当前语言前缀 | 文件名是生成时快照,不追改(合理) |
| B11 | overlay 创建后在主窗切语言,再 F1 | overlay 用**新**语言 | EVT.languageChanged 广播到常驻 overlay 的 I18nProvider,热切换 lang |

**B11 已解决(原设计误判为"可接受限制")**:code-review 指出 overlay 是**常驻复用**窗(非"每次新建"),故创建后不会自己重拉语言——若只靠 query 注入,改语言后再 F1 仍显旧语言。已加 `EVT.languageChanged` 广播修正。**这是本设计最初的关键疏漏**(误以为 overlay 每次重建),记为教训。

## 7. 非目标(YAGNI)

- 不引入 i18next / react-intl / 任何 i18n 库。
- 不做复数(plurals)、ICU、性别、日期本地化格式(现有 `toLocaleTimeString` 保持不变,它已按系统 locale)。
- 不做翻译文件懒加载 / 后端热加载(55 条直接内联)。
- 不实时监听系统语言变化(B5)。
- 不动 theme 的交互位置(仅把 theme 的中文 title 文案抽 key)。

> 注:原 §7 曾列"不为 overlay 做跨 window 语言热推送"为非目标——**已删除**。实现时发现 overlay 是常驻复用窗,必须做广播(见 §2.3 / B11),否则改语言后再截图显旧语言。这是设计误判被 code-review 纠正的点。
- 不做第三种语言(繁体/日/韩)——字典结构预留,加语言=加一份 `Record<TKey,string>`。

## 8. 测试策略(TDD seam)

- **`src/shared/i18n/t.ts`**(纯函数,首选 seam):
  - `t(key)` 命中 zh/en 正确译文;缺 key 回退 en 再回退 key 本身。
  - `t(key, {name})` 插值替换 `{name}`;多占位符;params 缺失时占位符原样保留(不崩)。
- **`resolveEffective`**(纯函数,注入 langs 数组便于测,不真调 Electron):
  - `['zh-Hans-CN',...]`→zh;`['en-US']`→en;`['fr-FR']`→en;`[]`→en;`['zh']`→zh。
  - `pref='zh'`/`'en'` 直接返回,不看系统。
- **settings.ts**:`getLanguage` 默认 system;损坏/非法字段回退 system;set 后 get 一致(照 settings.test.ts 现有 theme 测法 78/90 行)。
- **字典完整性**:类型层 `en: Record<TKey,string>` 已保证编译期无漏译;可加一个测试断言 `Object.keys(zh)` 与 `Object.keys(en)` 相等(防手滑)。
- 渲染层 context 热切换、UI select 交互:属 UI 行为,e2e/手测验证(纯 UI 无高价值单测,按 CLAUDE.md 可说明理由后以端到端验证覆盖)。

## 9. 实现顺序(TDD,一次一纵切)

1. `shared/i18n/t.ts` + 类型(红:t 查表/插值/回退测)→ 绿。
2. `resolveEffective`(红:各系统语言→effective 测)→ 绿。
3. settings.ts 加 language(红:默认/容错测)→ 绿。
4. IPC 三段式(ipc.ts/preload/main handler)+ main/i18n.ts + 启动读取。
5. `dict.ts` 填充全部 key(zh 先落,en 对齐)。
6. 渲染层 i18n.tsx(context/provider)+ 两个 root 包裹 + 首拉。
7. 替换渲染层所有硬编码文案为 `t()`(App/overlay/ErrorBoundary),含 statusLabel/failedLabel/快捷键提示参数化。
8. 替换主进程文案为 `t()`(index.ts/screenshot-service.ts)。
9. SettingsModal 加语言分区 select。
10. 全量验证网关:typecheck → lint → 单测 → 端到端(切三态、重启持久化、overlay、主进程弹框)。

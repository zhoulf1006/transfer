# Electron 应用瘦身 — 调研 + 方案

> 目标:把 macOS 安装后 **451MB** 的 `.app` 显著减小,以事实为基准,明确每个手段的**收益**与**副作用**。
> 归属:打包/发布优化(`electron-builder.yml`),不改产品功能代码。
> 本文档走七步流程的**第 1 步(调研)+ 第 2 步(方案)**。
> 调研基线:Electron **35.7.5**、electron-builder **26.15.3**、`mac.target.arch: [universal]`,年份 2026。
>
> **✅ 已定案(用户选择)**:**三架构全打(universal + arm64 + x64)+ locale 裁剪**。不砍 universal(保底),额外出两个小架构包让用户自选。配置已落地于 `electron-builder.yml`。详见 §6。

---

## 0. 决策速览(✅ 已定案)

| 维度 | 结论 | 收益 | 副作用 |
|------|------|------|--------|
| **根因** | 451MB 中 **97% 是 Electron/Chromium 框架**,你的业务代码(app.asar)仅 13MB | — | — |
| **✅ 定案** | **三架构全打:`arch: [universal, arm64, x64]` + `electronLanguages` 裁剪** | universal ~410M、arm64/x64 各 ~230M | 见下三行 |
| **↳ 出三个包** | 用户按芯片自选(不确定→universal,M 系列→arm64,Intel→x64) | universal 保底不丢用户;想要小包的能拿 ~230M | 发三个产物;**签名+公证按包各跑一次**(正式版公证等待 ×3,CI 更久) |
| **↳ locale 裁剪** | `mac.electronLanguages: [en, en_GB, zh_CN]` | **≈ −40MB**(三个包**都**受益) | 极小;非保留语系的 Chromium UI 串回退 en(你的产品 i18n 独立,与用户输入/传输的日文法文内容无关) |
| **↳ asar 卫生(可后置)** | 排除 fastify 的 test/benchmark/eslint/`.d.ts` | ≈ −3MB | 无(删的是打包冗余,不碰运行时代码);收益小,可下一版再做 |
| **不能做** | 签名后手删框架内文件(locale/helper) | — | **破坏签名与公证**,Gatekeeper 拒绝(TN2206);必须**签名前**通过 builder 配置裁剪 |
| **icudtl.dat(10MB)** | **保留** | — | 删除会破坏 `Intl`/国际化;且它是单份(不随架构翻倍) |

**一句话**:451MB 属于 universal 构建的**正常水位**(VS Code 官方标称 universal「<500MB 磁盘占用」)。本方案**保留 universal 保底**,同时提供 arm64/x64 小包(各 ~230M,与 VS Code/Slack/Signal 的 per-arch 同档),让用户按需取舍——代价是公证 ×3、发三个产物。

---

## 1. 现状实测(本机 `release/0.6.2` universal `.app`,以 `du`/MiB 计,与 Finder 一致)

全部为**实测**,非估算。命令见每行说明。

### 1.1 整体构成

| 组成 | 大小 | 占比 | 说明 |
|------|------|------|------|
| `Contents/Frameworks/Electron Framework` 二进制(**胖:x86_64 + arm64**) | **334M** | 74% | **universal 翻倍的主体**(`lipo`:x86_64 175M + arm64 158M) |
| `.../Libraries/`(SwiftShader / GLESv2 / ffmpeg,**也是胖**) | 39M | 9% | libvk_swiftshader 21M + libGLESv2 14M + libffmpeg 4.4M |
| `.../Resources/`(icudtl.dat + resources.pak + **55 个 locale**) | 59M | 13% | 其中 locale.pak 合计 **41.5M**、icudtl.dat 10M、resources.pak 5.7M |
| `Contents/Resources/app.asar`(**你的代码 + fastify 树,未 tree-shake**) | 13M | 3% | 含 fastify 全量依赖树(benchmark/test/eslint/`.d.ts`) |
| 其余(4 个 Helper.app、Squirrel/Mantle/ReactiveObjC 等) | ~3M | <1% | 框架固定件 |
| **合计** | **451M** | 100% | `du -sh Transfer.app` |

**测量命令**(可复现):
```bash
APP="release/0.6.2/mac-universal/Transfer.app"
du -sh "$APP"                                    # 451M
du -sh "$APP/Contents/Frameworks"                # 437M(97%)
FW="$APP/Contents/Frameworks/Electron Framework.framework/Versions/A"
lipo -detailed_info "$FW/Electron Framework" | grep -E 'architecture|size'
# architecture x86_64  size 184341984  (175 MiB)
# architecture arm64   size 166152592  (158 MiB)  → 胖二进制 = 两片相加
```

### 1.2 关键事实(区分「确认」与「推断」)

- **确认**:主框架二进制是 `Mach-O universal binary with 2 architectures [x86_64][arm64]`(`file` + `lipo -info` 实测)。抽薄单架构:**arm64-only = 158M**(vs 胖 334M),即单架构框架二进制省 **~176M**。
- **确认**:55 个 `locale.pak` 合计 **41.5M**;`en`/`en_GB`/`zh_CN` 各约 0.5M,保留三者仅 ~1.5M。locale 是**架构无关数据,不随 universal 翻倍**(所以此项收益对 universal / per-arch 相同)。
- **确认**:`app.asar` 内 `node_modules` 有 **1996 个文件,其中 ~250 个是纯冗余**(`benchmark`/`test`/`.test-d.ts`/eslint/`.md`/`types/`)。根因见 §2.3。
- **确认**:`electron-updater` **不是依赖**,`src/` 无任何 `autoUpdater` 用法;`latest-mac.yml` 由 builder 生成但无人消费 → **你是手动分发 DMG**。因此 per-arch 拆分**不触发**自动更新那套坑(见 §4.1)。
- **推断**:per-arch 单个 `.app` ≈ **270M**(框架 334→~175、Libraries 39→~20,其余不变);叠加 locale 裁剪 → **~230M**。数值来自 §1.1 分解 + §3 收益模型,未实际出包验证(实现阶段需出包实测)。

---

## 2. 根因分析:451MB 从哪来

### 2.1 为什么框架占 97%

Electron = Chromium 渲染引擎 + Node.js + V8。这部分是**固定成本**,与你写多少业务代码无关。任何 Electron 应用的下限就在这里。你的业务代码(13M asar)相对可忽略——**这决定了减重的着力点必须是框架侧的“少打一份”,而不是“优化我的代码”**。

### 2.2 为什么是 451MB 而不是 ~250MB:universal 胖二进制

**确认**(electron-builder 官方 Architecture 文档):
- `mac.target[].arch` 取值 `"x64" | "arm64" | "universal"`。
- universal 的机制:**「electron-builder 下载 x64 和 arm64 两份 Electron 二进制,再用 `lipo` 合并」**;官方权衡表明确列 universal 的缺点是 **「~2x file size」**。
- 来源:https://www.electron.build/docs/architecture/ ·(fat-binary 机制佐证:https://github.com/electron/universal 、https://www.electronjs.org/blog/apple-silicon)

即:你打的 universal 把两套 CPU 架构的机器码塞进同一个文件。用户的 Mac 只可能是 arm64 **或** x64,**永远用不到另一半**。这 ~178M 是纯粹为“一个包通吃”付出的冗余。

### 2.3 为什么 app.asar 没被 tree-shake

`electron.vite.config.ts:14` 把 `fastify` 列为 `external`(“原生依赖不打进 bundle,运行时从 node_modules 加载”)。于是 vite/rollup **不打包 fastify**,electron-builder 转而把 fastify 的**原始依赖树整棵拷进 asar**——包含 benchmark、test、eslint 配置、`.d.ts` 类型定义等发布无关文件。React/react-dom 走 renderer 被 vite 打包进 `out/renderer`(已 tree-shake),不在此列。

---

## 3. 收益模型(三杠杆,可独立叠加)

以 `du`/MiB 计。A 为 per-arch 专属;B、C 对 universal 与 per-arch 都生效。

| 杠杆 | 动作 | universal 基线 | 处理后 | 省 | 适用 |
|------|------|---------------|--------|-----|------|
| **A** | universal → per-arch | 框架 334M + Libraries 39M = 373M | ~175M + ~20M = **~195M** | **~178M** | 仅 per-arch |
| **B** | `electronLanguages` 保留 en/en_GB/zh_CN | locale 41.5M | ~1.5M | **~40M** | 两者 |
| **C** | asar 排除 fastify 冗余 | 13M | ~9–10M | ~3M | 两者 |

**组合结果**:
- 只做 **B+C(仍 universal)**:451M → **~408M**(降幅小,universal 仍是主体)
- 只做 **A(per-arch)**:451M → **~270M / DMG**
- **A+B+C(推荐)**:451M → **~230M / DMG**(**≈ −49%**)

> 注:icudtl.dat(10M)、resources.pak(5.7M)、V8 snapshot、SwiftShader/ffmpeg 属框架必需件,**不裁**(裁了要么破坏功能,要么破坏签名)。所以理论下限就在 ~200M 量级——与 per-arch 的大型应用同档。

---

## 4. 各手段的副作用与正确姿势(逐条带来源)

### 4.1 【杠杆 A】universal → per-arch:副作用与你的实际处境

**配置**(确认,electron-builder Architecture 文档):
```yaml
mac:
  target:
    - target: dmg
      arch: [x64, arm64]   # 出两个 DMG:x64 一份、arm64 一份
```

**副作用逐条核对**:

1. **发两个产物 / 用户要选对架构**(确认,官方权衡表列为 con)。
   - 影响面:仅“裸下载链接”场景。你**当前就是手动分发 DMG**,只需在下载页标注「Apple 芯片 / Intel 芯片」二选一(Slack 官方下载页正是这么分的)。arm64 Mac 装了 x64 包会走 Rosetta(能跑但更重更慢),故标注要清楚。

2. **自动更新的坑(electron-updater)—— 你不受影响**。
   - 确认:两个架构 job 都会产出**同名 `latest-mac.yml`**,共享目录 provider 上“后完成的覆盖先前的”(issue #5592),历史上导致 Intel Mac 误更新到 arm64(issue #5616)。
   - 确认:该 bug 已修——electron-updater 加了架构探测,**v4.3.7(~2021)起**在**单个 arch-aware `latest-mac.yml`** 内按产物文件名选对架构(GitHub provider 正常工作)。“完全分离的 per-arch channel 文件/CDN 目录”特性被**关闭为 not planned**(issue #7975)。
   - **对你**:`electron-updater` **不是依赖**,`src/` 无 `autoUpdater`(§1.2 实测)→ 这套坑**与你无关**。未来若接自动更新,用 GitHub provider + 当前版 electron-updater 即可;若自托管 S3/generic,须保证两架构在**同一次发布**产出、别让 `latest-mac.yml` 被覆盖。
   - 来源:#5592 https://github.com/electron-userland/electron-builder/issues/5592 · #5616 https://github.com/electron-userland/electron-builder/issues/5616 · #7975 https://github.com/electron-userland/electron-builder/issues/7975 · 自动更新文档 https://www.electron.build/docs/features/auto-update/

3. **签名/公证**:per-arch 每个包**独立签名 + 公证**,流程与现在一致(你本地 `dist:mac:sign` 走钥匙串 Developer ID)。CI 无凭据时照旧跳过(`CSC_IDENTITY_AUTO_DISCOVERY:false`)。**无新副作用**——只是从签 1 个包变成签 2 个包。

4. **CI 构建时长/带宽**:electron-builder 需分别下载并处理两架构 Electron,**构建更久**(但不再 `lipo` 合并,单包更快;净变化有限)。属工程成本,非产品副作用。

**行业校准**(确认,Homebrew cask JSON,2026 中):**VS Code、Slack、Signal、1Password、Notion 默认发 per-arch**;Discord、Obsidian 发单一 universal DMG(换“一个链接通吃”)。size-conscious 的主流选 per-arch。VS Code 官方标称 universal「磁盘占用 <500MB」→ 印证你 451MB 是 universal 正常值,per-arch ~230–270M 属精简但典型。来源:https://formulae.brew.sh/api/cask/{visual-studio-code,slack,signal,1password,notion,discord,obsidian}.json · VS Code 需求页 https://code.visualstudio.com/docs/supporting/requirements

### 4.2 【杠杆 B】locale 裁剪:副作用与正确姿势

**配置**(确认,electron-builder 源码 `PlatformSpecificBuildOptions.ts`):
```yaml
mac:
  electronLanguages: ["en", "en_GB", "zh_CN"]   # 只保留这些 locale.pak
```
- 属性 `electronLanguages?: Array<string> | string`,JSDoc:「The electron locales to keep. By default, all Electron locales used as-is.」
- **mac-only**:Windows 无对应选项(issue #7506)。
- ⚠️ **版本门槛(已实测本机 26.15.3 通过)**:electron-builder <26 在 mac 上此选项**静默失效**(#9774:排除路径漏了 `Versions/A` 段,PR #9779 修)。**本机 26.15.3 已含修复**——`app-builder-lib/out/electron/ElectronFramework.js:63` 对 MAC 返回 `[getResourcesDir, getMacOsElectronFrameworkResourcesDir]` 两个目录(后者即 55 个 `locale.pak` 所在的 `Versions/A/Resources`)。升级/换机后若 electron-builder <26 会失效,出包必须 `ls .../Versions/A/Resources/*.lproj` 核对。
- ⚠️ **locale 码写法(已核实匹配逻辑)**:代码读**磁盘每个 `.lproj` 目录名并小写**(如 `zh_cn`/`en_gb`),`electronLanguages` 值也小写;保留条件 = `wanted === 磁盘名 || wanted.startsWith(磁盘名+"-") || wanted.startsWith(磁盘名+"_")`(`ElectronFramework.js:82-86`)。即**必须按磁盘实际名写下划线形式**:`[en, en_GB, zh_CN]`(大小写无所谓)。写成 Chrome 风格 `zh-CN`/`en-US` 会匹配不上对应磁盘目录 → 那个语系被误删、UI 串回退 en。无匹配时打印 `no locales found matching wanted languages` warn。
- 来源:https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/options/PlatformSpecificBuildOptions.ts · 配置文档 https://www.electron.build/docs/configuration/ · #9774 https://github.com/electron-userland/electron-builder/issues/9774 · PR #9779 https://github.com/electron-userland/electron-builder/pull/9779

**副作用**:
- **确认**:electron-builder 在**打包阶段(签名前)**删除未保留的 `*.lproj/locale.pak`,签名对**已裁剪**的框架重新封印 → **不破坏签名/公证**。这正是必须用 `electronLanguages` 而**不是** post-build `rm -rf *.lproj` 的原因(后者签名后删=破坏 seal,见 §4.4)。
- **推断/社区共识**:删掉的是 **Chromium 自带 UI 串**(右键菜单、`<input type=file>` 对话框等系统级文字)。缺失语系时 Chromium 回退到 en/base pak。你的**产品 i18n 与此独立**(你自己的界面文字不在这些 `.pak` 里)。为稳妥**保留 en/en_GB 兜底**。
- **已知边角**:`app.getLocale()` 对 Chrome 不支持的 locale 本就可能返回异常(electron/electron #23272),与是否裁剪无关。

**保守取舍**:保留 `en`、`en_GB`(英文兜底)、`zh_CN`(你的主用户)。若产品未来支持繁中/日文再加 `zh_TW`/`ja`。

### 4.3 【杠杆 C】app.asar 卫生:副作用与做法

现状(§2.3):fastify 因 `external` 被整树拷贝。两个正交做法,择一或叠加:

**做法 C-1:`files` 排除冗余(低风险,推荐)**——在 `electron-builder.yml` 的 `files` 里排除发布无关文件:
```yaml
files:
  - out
  - package.json
  - '!**/node_modules/**/{test,tests,benchmark,benchmarks,__tests__}/**'
  - '!**/node_modules/**/*.{md,markdown,map,ts}'         # 注意:别误删运行时需要的 .ts(此项目运行时是 .js)
  - '!**/node_modules/**/{.eslintrc,.eslintrc.js,eslint.config.js,tsconfig.json}'
```
- **副作用**:需**精确**——排除 glob 写宽了会删掉运行时文件导致启动崩溃。`.d.ts`/`.test-d.ts`/`benchmark` 删除安全(运行时不加载);`.ts` 要小心(此项目 fastify 运行时加载 `.js`,`.d.ts` 可删,但 glob `*.ts` 会连 `.d.ts` 一起删——本项目安全,别照抄到 TS-runtime 项目)。
- 验证:出包后 `npx asar list app.asar | grep -c node_modules` 应显著下降,且**冒烟启动 + 跑一次文件传输**确认 fastify 正常。

**做法 C-2(可选):把 fastify 也打进 bundle**——去掉 `electron.vite.config.ts:14` 的 `external: ['fastify']`,让 rollup 打包 + tree-shake fastify。
- **收益**:asar 里 node_modules 近乎空;
- **副作用/风险**:fastify 依赖 `avvio`/`pino` 等,含动态 `require` 与可能的原生件,**打包易踩坑**(运行时 `Cannot find module`)。**不建议**在本次瘦身里做——收益仅几 MB,风险/回归面却大,与“外科手术式改动”原则相悖。**优先 C-1**。

> **重要**:C 的整体收益仅 ~3M,是 451M 里的零头。**做,但别指望它撼动大盘**;真正的量在 A。

### 4.4 【绝对禁忌】签名后手删框架文件

**确认(载荷性事实,Apple TN2206)**:签名把**框架内所有文件的哈希**封进 `Contents/_CodeSignature/CodeResources`;
- 「Bundles should be treated as read-only once they have been signed.」
- 「If you must modify your bundle, do it **before** signing.」
- 现代签名**无法**给某些文件“开洞”豁免(`--resource-rules`/`ResourceRules.plist` 已废弃并会被拒绝)。
- 来源:https://developer.apple.com/library/archive/technotes/tn2206/_index.html · Electron 签名文档 https://www.electronjs.org/docs/latest/tutorial/code-signing

**推论 / 网上常见的错误做法(都别做)**:
- ❌ 打包后 `rm -rf .../locales/*.pak` 或删 Helper.app 省体积 → **破坏 seal,公证/Gatekeeper 失败**。正解:用 `electronLanguages`/`files` 在**签名前**由 builder 裁掉。
- ❌ 对已签名的 universal 包用 `lipo` 事后抽薄单架构 → 同样破坏签名。正解:**让 electron-builder 在打包阶段直接产出各架构包**(本方案 `arch: [universal, arm64, x64]` 就是各架构独立打、独立签,不做事后抽薄)。
- ❌ 依赖 `codesign --deep` 事后补签 → 官方明示「仅供紧急修补」,不可作为常规手段。

**正确顺序恒为:裁剪 → 签名 → 公证**,且裁剪全部通过 electron-builder 配置完成(它保证在签名前执行)。

---

## 5. Windows 侧(用户问的是 mac,附带结论)

- `electronLanguages` **对 Windows 无效**(issue #7506),Windows 无官方 locale 裁剪路径。
- Windows 你已出 `nsis`(x64)+ `portable`(x64),**本就是单架构**,无 universal 翻倍问题。NSIS 安装体积主要仍是框架固定成本。
- 结论:**本次瘦身聚焦 mac**;Windows 无等价低风险杠杆,不动。

---

## 6. 落地方案(✅ 已定案:方案丁)

用户在下列备选上选择了**方案丁 = 甲 + 乙 的并集(三架构全打)**:保留 universal 保底,同时出 arm64/x64 小包,外加 locale 裁剪。理由:不牺牲"一个包通吃"的兜底体验,又给想要小体积的用户 ~230M 的选择。

### ✅ 方案丁(已实现):universal + arm64 + x64 全打 + locale 裁剪
- `mac.target.arch: [universal, arm64, x64]` + `mac.electronLanguages: [en, en_GB, zh_CN]`(已落地 `electron-builder.yml`)。
- 产物:`-universal.dmg`(~410M,保底)、`-arm64.dmg`(~230M,Apple 芯片)、`-x64.dmg`(~230M,Intel)。
- 收益:提供小包选项(想要的用户 −~49%),同时 universal 兜底不丢任何用户;三个包都吃到 locale 裁剪的 −40M。
- 副作用:**发三个产物 + 签名/公证按包各跑一次**(正式版公证等待 ×3,CI 更久);下载页/release note 需按架构列全(已同步 `release-note-template.md`)。
- CI:产物 glob 为 `release/*/*.dmg`,**自动兼容三产物,无需改**(已核对 `build.yml`)。

**备选(未选,留档对比):**

- **方案甲:只裁 locale**(最保守)——仅 `electronLanguages`,451→~408M,仍单 universal,零风险。适用"只想省一点、绝不增加产物数"。
- **方案乙:只出 per-arch(砍掉 universal)**——`arch: [x64, arm64]` + 裁剪,451→~230M/DMG,只发两个包。比丁少一个 universal 兜底(装错芯片的用户没有保底包)。适用"确定用户都会选对架构"。
- **方案丙:乙 + asar 卫生**——乙再加 `files` 排除冗余,再 −~3M。

> asar 卫生(§4.3 C-1)在丁里**未纳入本次**(收益仅 ~3M,glob 需谨慎),标记为**可下一版再做**。

**后续步骤**:第 4 步实现已完成(改 yml + 同步文档/skill/memory);进入**出包实测**——`pnpm dist:mac` 出三个 DMG,`du` 比对预估、`lipo -info` 验架构、`ls .../Versions/A/Resources/*.lproj` 验 locale 裁剪、冒烟传一次文件。

---

## 7. 实现阶段的验证清单(方案确定后用)

1. `pnpm dist:mac`(或 `:sign`)出包,`du -sh release/<v>/mac-*/Transfer.app` 实测比对预估。
2. per-arch:确认产出**两个 DMG**,各 `lipo -info` 应只含**单一架构**。
3. locale:`ls Transfer.app/.../Resources/*.lproj` 应只剩保留项;跑一次应用确认菜单/文件对话框正常。
4. 冒烟:两端 Transfer **实际传一次文件**,确认 fastify(HTTPS server)正常——尤其做了 C 之后。
5. 签名/公证(本地 `:sign`):`codesign --verify --deep --strict Transfer.app` 通过、`spctl -a -vvv` 通过。
6. 回同步:更新 `docs/DESIGN.md` 相关段与本 `electron-builder.yml` 注释,保证“文档 = 配置实际”。

---

## 附:一次性事实清单(便于 review 核对)

| 事实 | 值 | 来源/命令 | 判定 |
|------|-----|-----------|------|
| 安装 `.app` 总大小 | 451M | `du -sh Transfer.app` | 确认 |
| Frameworks 占比 | 97%(437M) | `du -sh Contents/Frameworks` | 确认 |
| 框架二进制胖度 | x86_64 175M + arm64 158M | `lipo -detailed_info` | 确认 |
| arm64-only 抽薄后 | 158M | `lipo -thin arm64` | 确认 |
| locale.pak 合计 | 41.5M / 55 个 | `find -name locale.pak` | 确认 |
| app.asar 冗余文件 | ~250 / 1996 | `npx asar list` | 确认 |
| 无 electron-updater | 非依赖、`src/` 无 autoUpdater | grep | 确认 |
| universal ~2x | 官方权衡表 | electron.build/docs/architecture | 确认 |
| `electronLanguages` mac-only | 源码 + #7506 | GitHub 源码/issue | 确认 |
| 签名后禁改 | TN2206 | Apple 官方 | 确认 |
| per-arch 单包 ~270M | 由分解推算 | §3 模型 | **推断(需出包实测)** |

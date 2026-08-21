# CONTEXT.md — 领域词汇表

> 目的:让每个新开的 agent 上下文不重读全部代码就说对话、不发明错误的同义词。
> 只管「话怎么说」;系统怎么设计见 [docs/DESIGN.md](docs/DESIGN.md),决策轨迹见 [docs/adr/](docs/adr/)。

## Language(术语)

**announce**: 设备通过 UDP 主动宣告自己存在的报文(LocalSend 协议),同时发**多播**(224.0.0.167)与**子网定向广播**(按接口 netmask 计算,如 /24 下的 192.168.3.255)双通道(见 ADR-0006)。
_Avoid_: "心跳"、"beacon"——项目里只叫 announce。

**register(发现回应)**: 收到对方 announce 后,走 `POST /register` **定向 TCP** 回应对方。是"发现回应",不是注册账号(见 ADR-0005)。
_Avoid_: "回应包"——回应不走 UDP 多播(旧实现已废弃)。

**fingerprint**: 本机自签名证书的 SHA-256,设备的**唯一稳定标识**,跨重启不变。全 app 引用设备一律用它(IP/端口/名字都会变)。见 ADR-0002。

**TOFU pinning**: HTTPS 自签证书 + 首次信任后指纹固定的校验模型(见 ADR-0004)。
_Avoid_: "证书校验"——我们不走 CA 链。

**prepare-upload**: LocalSend 协议的传输入口。**文本消息也是 fileType=text 的"文件",正文放 `preview` 字段,只走 prepare-upload、不走 upload**。

**自动接收**: 针对**文件**的可配置开关 + 大小阈值,默认关(全部文件需确认);开启后 `size ≤ 阈值` 自动收。**文本消息不受此开关限制,始终自动接收**。

**备注(远端设备别名)**: 用户给发现到的设备起的自定义名,按 fingerprint 存 `settings.json` 的 `deviceAliases`,**永久保留**(离线/真删不清)。合并在 **main 侧** `applyAliases` 做,renderer 无感。
_Avoid_: 与"本机名"混淆——`device:setAlias` 改**本机名**(identity.json),`device:setRemoteAlias` 才是改远端备注,两者无关。

**alias / defaultAlias / hasCustomAlias**: `alias` = 合并后的**显示名**(备注优先);`defaultAlias` = 对端广播的原始默认名;`hasCustomAlias` = main 显式下发的布尔。
_Avoid_: 用 `alias !== defaultAlias` 判断"有无备注"——备注可以与默认名相同,必须用 `hasCustomAlias`。

**overlay**: 截图选区窗口。懒建后**常驻复用**,只 hide/show 不重建;会变的状态(语言/主题)靠加载时注初值 + 广播事件热更(见 ADR-0009)。
_Avoid_: "每次打开重新加载"——错误假设,曾因此出 bug。

**sent-images**: userData 下存发送截图副本的**内部目录**,不暴露给用户;设置里只展示 downloads 目录。

**userData**: 统一目录名 `Transfer`(`app.setName`,dev 与打包版一致)。多实例测试用 `TRANSFER_USERDATA` 环境变量 override(显式 setPath,优先级高于 name 推导)。

**app:// scheme**: 生产环境渲染页/overlay 用自定义 privileged scheme `app://` 加载(替代 `file://`,根治启动慢,见 ADR-0007)。

## Invariants(不变量)

违反即出错、且多为"不知道就会踩"的约束。不含 file:line 与常量值(那些在代码里)。

**发现与信任**

- **register 是 pinning 的唯一例外**:回应 announce 时本机 registry 里**还没有该 peer**,无指纹可 pin;强套 pin 会 fail-closed → 对方永远发现不了我方,**双向发现塌一半**。故 register 走不 pin 的通道,prepare/upload/cancel 走 pin 通道(ADR-0004 未含此例外)。
- **只对 `announce=true` 回应**:收到 `announce=false` 不再回,否则两端无限对回。
- **register 响应体省略 port**,不能拿它刷新登记,否则会用默认端口覆盖真实端口、连错端口。

**会话与传输**

- **单会话**:同一时刻只接受一个传输会话,重复请求 409;同 IP+fingerprint 的重试覆盖旧 PENDING。
- **待收集合 = 接受集合**(非请求全集):用户可只接受部分文件;"传输完成"的判据是**待收集合清空**,不是请求列表跑完(upload 可并行、乱序)。
- **upload 绑定来源 IP**,且**状态门控**:PENDING 期的 upload 一律 403。
- **超时一律是「空闲」语义,不是「总时长」**(ADR-0020):判据是"还有没有字节在动",不是"传了多久"。
  推论一:**大文件传多久都行**,能传多大由磁盘而非带宽或内存决定;拿总时长当失败判据会把"慢"误判成"断"。
  推论二:**凡是收/发字节的路径都必须刷新空闲计时器**——包括幂等重传那条把 body 直接丢弃的路径。漏掉任何一条,该路径上耗时超过阈值的传输会被判空闲清掉,而**故障是静默的**:文件照常落盘、upload 照常回 200,只是不上报完成,同会话其他文件跟着陪葬。
  推论三:**空闲信号比"每个 chunk 一次"粗得多**——发送端 `pipe` 暂停后要等用户态缓冲整个清空才恢复(实测一次吞下约 1.4MB),两次刷新的间隔 ≈ 已缓冲字节 ÷ 对端消费速率。定阈值时按这个量级留余量。
  代价明知:**没有总时长兜底**,涓流可以让传输无限期挂着(局域网无对抗性对端,已接受)。
- **两端超时的序关系**:发送端空闲阈值必须 > 接收端判空闲的**上界**,而该上界是 `T_IDLE_MS + 扫描间隔`(超时靠定期 sweep 推进,最坏刚好错过一次扫描)——拿 `T_IDLE_MS` 直接比会偏松。让会话的**所有者**(接收端)先清理,发送端随后拿到明确的连接错误;反过来会留下孤儿会话占住单会话锁。护栏在 `protocol.test.ts`。
- **三态 respond**:拒绝 → 403;**接受但无文件要传 → 204 且立即清理、不进 active**(文本消息永远走这条,不占单会话锁);接受且有文件 → 200 + token。
- **发送方本地串行化**:同一 peer 的发送在发送方排队,避免自己的第二条撞自己造成 409(纯本地,不动协议)。
- **按文件的校验必须在组批之前完成**:`sendFiles` 把整批交给**一次** sender 调用,并把**同一个 status/errorReason 套用到批内所有消息**。任何"这个文件不能发"的判定(目录、不存在、无权限……)若留到发送后再判,会把同批的正常文件一起判失败。故此类校验一律在组批前分流:不可发的各自标失败,可发的才进批次。

**持久化与运行时**

- **进度不落库**:progress 只走 IPC 实时推,DB 只存最终 status;节流状态在**任意终态**统一清理,不依赖 100% 帧。
- **消息的 `status` / `error_reason` 是无约束 TEXT 列**:`rowToMessage` 直接强转成联合类型,**联合外的值能真的到达消费端**(用户装过含新状态的版本、写了库,再降级回旧版)。故任何读 status/errorReason 的新代码都必须对联合外的值优雅降级:集合归属判断(终态/传输中/待用户决定)写成覆盖每个成员的 `Record` 查表并把结果收敛成布尔——落在联合外答"否";映射查表必须带兜底,否则返回 `undefined` 会让界面渲染成空白。**别用 `Set.has` 或 `===` 串联**:它们对未知成员一律答 false 且新增成员时照常编译,漏改不会被发现。
- **`Infinity` 绝不进 settings.json**:`JSON.stringify(Infinity)` 得 `"null"` 会损坏持久化;`0 → Infinity` 的换算只存在于运行时。
- **macOS 文件名大小写不敏感**:`transfer` 与 `Transfer` 同目录,故 dev 改名无缝、不需迁移;Win/Linux 大小写敏感,若遇到才需迁移。

**构建与发布**

- **签名后禁改产物**:签名把框架内文件哈希封进 CodeResources;裁剪(locale/架构)**必须在签名前由 electron-builder 完成**,禁 post-build 删文件、禁事后 `lipo` 抽薄、禁 `codesign --deep` 补签。顺序恒定:裁剪 → 签名 → DMG → 公证 staple。
- **安装包只能放 R2,不能进 Pages**:Cloudflare Pages 单文件上限 25 MiB,安装包 81–177 MiB;落地页在 Pages、安装包在 R2,二者不可合并。
- **两个下载源永远都显示**,只调默认高亮,**不做地区强制重定向**(`navigator.language`/时区判地区不可靠,VPN 会干扰)。

**界面图标**

- **图标三来源,按优先级取,每个图标在 `icons.tsx` 注明出处**:Lucide(主库)→ Tabler(仅当 Lucide 无对应语义;二者规格逐字相同,共用同一包装,混排无视觉差异)→ Material Symbols(最后手段)。**Material 是填充式且 viewBox 为 `0 -960 960 960`**,套描边包装会**静默渲染成空白**(不报错),必须走 `FilledIcon`。
- **截图工具条的「文字」工具保留字面 `A`,是唯一的字符图标例外**(2026-08-21 用户裁定)。理由:纯 ASCII 无字体缺字风险(不同于曾用的 `▚ ◍ ①`),且字母本身即该工具最直白的记号。代价明知:系统字体渲染,笔画与相邻 SVG 不是一套、不随 size 缩放。**这条是决定不是遗漏——review 时不要再把它当违规提,也不要"顺手"换成图标。**

**多实例共存(开发/测试实例与用户实例同时运行)**

- **多播 announce 是唯一会打扰旁人的启动动作,端口不是**:HTTP 端口有回退(53317 起向上试),两实例本就能并存;而 announce 会让本实例出现在同网所有设备的列表里。**判据不是"能不能跑起来",而是"用户实例正在运行时跑它,用户或同网的他人能否察觉"**——凡新增启动期动作,先按这条判一遍。
- **临时 userData 起的实例带全新指纹**:身份随 userData 走,所以每次用新临时目录启动都是一台**陌生新设备**,不会与上一次合并;退出后按 `offlineKeepMinutes`(默认 60)滞留在别人列表里。推论:自动化若开着 announce 反复起停,会在用户设备列表里累积互不覆盖的幽灵条目——测试实例必须关断 announce。
- **传输链路不依赖发现**:对端登记有定向 `POST /register` 一路(ADR-0005),知道 address:port 即可建立传输。故"关掉发现"不妨碍测收发,收发已在集成层覆盖;被挡住的只有多播发现自身,而它无法既测又不打扰。
- **窗口不显示 ≠ 取不到渲染**:QUIET 实例的窗口从不 `show()`,但 Playwright 仍能对它 `page.screenshot()` 拿到**真实渲染**——渲染由 renderer 进程完成,不依赖窗口是否上屏。故"改了外观要看渲染结果"(界面规范的验收要求)与"跑测试不打扰用户"两者不冲突,**不要为了截图去显示窗口**。反过来也要记住:`toBeVisible()` 判的是 CSS/布局可见性,不是"用户眼睛能看见",隐藏窗口下它照样为真。

**仓库边界**

- **仓库不携带 agent 配置**:`CLAUDE.md`、`.claude/`、`docs/.workings/` 均在 gitignore 内(前两者由全局 gitignore 排除),**新 clone 拿不到它们**。仓库携带的是项目**知识**(ADR / CONTEXT.md / features / specs / ops / prototypes),不是操作者的**作业指令**(八步流程、skills、界面规范)——后者是操作者的本机资产,跨项目复用,随人不随仓库(ADR-0013 工具链条目的外延)。推论:凡"换台机器也必须知道"的结论,写进上述知识类文档才算落地;停在 `CLAUDE.md` 或 `docs/.workings/` 里等于只存在于这台机器。

## Relationships(关系)

- **发现** = announce(UDP 多播+广播双发) + register(HTTP 定向回应),组成双向发现;发现结果进 `DeviceRegistry`(`Map<fingerprint, RemoteDevice>`)。
- **传输/聊天**走 HTTPS 直连对端 LAN IP,信任依赖 TOFU pinning;文本与文件统一为消息气泡流,持久化在 `messages.db`(node:sqlite,见 ADR-0003)。
- **截图**产物三出口:发送到聊天 / 复制剪贴板 / 存文件(范围见 ADR-0008)。
- **settings.json**(SettingsStore: cache+normalize+persist)存 autoAccept/theme/shortcutCapture/deviceAliases;**identity.json** 是本机身份(证书/名字),两者不混。

## Flagged ambiguities(已消解的歧义)

- **"回应"**:曾指 UDP 多播回包,现指 HTTP `POST /register` 定向回应,旧含义作废(ADR-0005)。
- **"alias"**:不带限定词时指**显示名**;改"本机名"与改"远端备注"是两个不同 IPC(见上)。
- **"扫网段"**:被明确禁止的方案(像横向扫描、触发企业 EDR),不是"广播"的同义词(ADR-0006)。

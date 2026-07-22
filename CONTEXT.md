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

**自动接收**: 可配置开关 + 大小阈值,默认关;开启后 `size ≤ 阈值` 自动收。**消息类永不自动接收**(与 LocalSend 同)。

**备注(远端设备别名)**: 用户给发现到的设备起的自定义名,按 fingerprint 存 `settings.json` 的 `deviceAliases`,**永久保留**(离线/真删不清)。合并在 **main 侧** `applyAliases` 做,renderer 无感。
_Avoid_: 与"本机名"混淆——`device:setAlias` 改**本机名**(identity.json),`device:setRemoteAlias` 才是改远端备注,两者无关。

**alias / defaultAlias / hasCustomAlias**: `alias` = 合并后的**显示名**(备注优先);`defaultAlias` = 对端广播的原始默认名;`hasCustomAlias` = main 显式下发的布尔。
_Avoid_: 用 `alias !== defaultAlias` 判断"有无备注"——备注可以与默认名相同,必须用 `hasCustomAlias`。

**overlay**: 截图选区窗口。懒建后**常驻复用**,只 hide/show 不重建;会变的状态(语言/主题)靠加载时注初值 + 广播事件热更(见 ADR-0009)。
_Avoid_: "每次打开重新加载"——错误假设,曾因此出 bug。

**sent-images**: userData 下存发送截图副本的**内部目录**,不暴露给用户;设置里只展示 downloads 目录。

**userData**: 统一目录名 `Transfer`(`app.setName`,dev 与打包版一致)。多实例测试用 `TRANSFER_USERDATA` 环境变量 override(显式 setPath,优先级高于 name 推导)。

**app:// scheme**: 生产环境渲染页/overlay 用自定义 privileged scheme `app://` 加载(替代 `file://`,根治启动慢,见 ADR-0007)。

## Relationships(关系)

- **发现** = announce(UDP 多播+广播双发) + register(HTTP 定向回应),组成双向发现;发现结果进 `DeviceRegistry`(`Map<fingerprint, RemoteDevice>`)。
- **传输/聊天**走 HTTPS 直连对端 LAN IP,信任依赖 TOFU pinning;文本与文件统一为消息气泡流,持久化在 `messages.db`(node:sqlite,见 ADR-0003)。
- **截图**产物三出口:发送到聊天 / 复制剪贴板 / 存文件(范围见 ADR-0008)。
- **settings.json**(SettingsStore: cache+normalize+persist)存 autoAccept/theme/shortcutCapture/deviceAliases;**identity.json** 是本机身份(证书/名字),两者不混。

## Flagged ambiguities(已消解的歧义)

- **"回应"**:曾指 UDP 多播回包,现指 HTTP `POST /register` 定向回应,旧含义作废(ADR-0005)。
- **"alias"**:不带限定词时指**显示名**;改"本机名"与改"远端备注"是两个不同 IPC(见上)。
- **"扫网段"**:被明确禁止的方案(像横向扫描、触发企业 EDR),不是"广播"的同义词(ADR-0006)。

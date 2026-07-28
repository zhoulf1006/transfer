# ADR-0016: App Store 版用独立 bundle id `com.aloongplanet.transfer`

- 状态: 已接受

## 背景与问题

上架 Mac App Store 后,macOS 上会存在两个来源的 Transfer:App Store 版(沙盒、Apple
Distribution 签名)与官网 DMG 版(Developer ID 签名)。二者原本共用 `com.loong.transfer`。

两个问题同时指向 bundle id:

**① TCC 权限互相顶掉(实测)。** TCC 按 bundle id 记账,同时记录代码签名要求。两个签名
不同的 app 共用一个 id 时,后被授权的那个会让先前那个失效;实测中给 mas-dev 版授权后,
再用系统设置的 `+` 添加 DMG 版**无效**,最终靠 `tccutil reset` 才解开。Apple 开发者论坛
亦有同现象记录(同 Application ID、不同签名 → TCC 逐渐把权限一律当作未授予)。
受影响的是屏幕录制与本地网络两项权限。

**② 反向 DNS 用了并不持有的域名。** `com.loong.transfer` 隐含持有 `loong.com`,而项目
实际域名是 `aloongplanet.com`(官网 transfer.aloongplanet.com、下载站 dl.aloongplanet.com)。
Apple 不验证域名所有权,不影响过审,但这是命名约定的本意所在。

**时限**:bundle id 一经上架**永久不可改**。此决策的窗口只到首次提交审核之前。

## 备选项

1. **App Store 版换 `com.aloongplanet.transfer`,DMG 线保持 `com.loong.transfer`**
2. 两版继续共用 `com.loong.transfer` —— 否决:TCC 冲突持续存在。修掉权限死锁
   (见 postmortems/screen-permission-preflight-deadlock.md)后,截图那条能自愈(探测会
   重新触发系统授权框),但**本地网络那条不能**:发现静默失效、零日志,用户只看到
   "找不到设备",是查不出原因的报障
3. 两版都换成 `com.aloongplanet.transfer` —— 否决:会重置**所有现存 DMG 用户**的 TCC
   授权,收益仅"更合约定",代价与收益严重不匹配
4. 给 App Store 版加后缀如 `com.loong.transfer.mas` —— 否决:能解 TCC 冲突,但把错误的
   域名前缀继续沿用下去;换成实际域名是同等成本、多解一个问题
5. 国内/海外分别上架两个 app,各用一个 id —— 否决:bundle id 全店全球唯一、不分地区,
   两条 ASC 记录必须两个 id;而本 app 无服务器、无账号、无按地区分流的理由,拆两个只
   换来双倍审核与发版成本,且用户换区等于丢失 app。改为**一个 app 全球上架**,两个站点
   落在按语言本地化的 Support/Marketing URL 上

## 决策

选定**方案 1**(用户拍板)。App Store 版独立身份,DMG 线不动。

配置上 `mas.appId` 覆盖顶层 `appId`(`MasConfiguration extends MacConfiguration extends
PlatformSpecificBuildOptions`,`appId` 声明在最底层,per-platform 覆盖合法);
`entitlements.mas.plist` 的 App Group 同步为 `RHQ28XS7D9.com.aloongplanet.transfer`。

## 后果

- 正面:两版可在同一台机器共存,TCC 各记各的账,互不顶替;命名回到实际持有的域名。
- 正面:沙盒容器本就按 bundle id 隔离,换 id 不额外损失数据互通——**同 id 在这个场景下
  也换不来任何数据延续**,因此这项代价为零。
- 负面:Apple 门户侧需重做一批(证书三张**不用动**,均为团队级——证书绑 Team ID,
  全字段不含 bundle id,公钥与 SHA-1 指纹随之不变,备案表只需改 bundle id 一栏):
  新建 App ID 与 App Group、重签 development 与 Mac App Store distribution 两张
  profile、ASC 记录改选新 bundle id、备案按新 id 重报。
- **时机是本决策成立的关键**:ASC 的 bundle id 在**上传第一个构建之前**可直接在
  App Information 里改选(下拉框只列已注册的 App ID,故须先在门户注册);**一旦上传过
  构建即永久锁死**,届时只能新建记录,并连带面对 app 名被释放、可能被抢注的风险。
  本决策在上传前落地,故不触及该风险。这也是"窗口只到首次提交前"的具体含义。
- 用户侧:同时装两版时是系统眼中两个无关程序——各自的下载目录设置、设备备注、聊天
  记录不互通,首次使用各自要授权一次。这是共存的固有代价,非本决策引入。

## 来源

MAS 上架实测(2026-07,macOS 26.0.1);postmortems/screen-permission-preflight-deadlock.md
的「同 bundle id 的两个 app 抢 TCC」一节;Apple 开发者论坛 thread/698337(TCC 同时依据
bundle id 与签名)。

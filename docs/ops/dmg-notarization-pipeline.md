# DMG 公证与发布门禁设计

## 目标

- 正式版干净 tag(例如 `v0.9.1`)只发布通过 Apple 公证、staple 和 Gatekeeper 验证的三个 DMG。
- 预发布 tag(`-beta`、`-rc`、`-alpha`、`-dev`)保持只签名、不公证,只发布到 GitHub Release。
- 只有正式版同步 GitHub Release 产物到 Cloudflare R2;预发布不更新 R2 安装包和 `latest.json`。
- Windows 发布行为不变。

## 已确认事实

- electron-builder 26.15.3 的 `mac.notarize=true` 对签名后的 `.app` 执行,发生在 DMG 创建之前。
- 线上 0.9.0 arm64 DMG 镜像完整,但无 DMG ticket,`spctl --type open` 返回 `rejected / no usable signature`;内部 App 的 Developer ID 签名、stapled ticket 和 Gatekeeper 验证均通过。
- Apple 对嵌套分发的建议是:内部代码从内向外签名,签名最外层 DMG,并公证和 staple 最外层容器。
- **只 staple 最外层容器不够**:ticket 跟着被装订的文件走,用户把 App 拖出 DMG 后票据留在 DMG 里,App 首次启动只能联网查票,断网即被 Gatekeeper 拦下。0.9.0 的问题(App 有票据、DMG 没有)与 1.0.0 的问题(DMG 有票据、App 没有)是同一枚硬币的两面,正解是两处都钉。

## 流水线

### 正式版

1. 在互斥打包分支之前校验签名证书和三项 Apple 公证凭据;`HAS_APPLE` 同时检查 Apple ID、App 专用密码和 Team ID,缺任一项则 macOS job 失败。
2. electron-builder 使用 Developer ID 签名 App,**开启内置公证**(`mac.notarize: true`)把票据 staple 到 `.app` 上,再生成 arm64/x64/universal 三个 DMG(内部 App 已带票据),并用同一 Developer ID Application 身份签名每个 DMG。内置公证跑在打包步骤内,因此三项 Apple 凭据必须注入该步骤;凭据缺失时 electron-builder 只 warn 后静默跳过、不报错,兜底断言见第 4 步的最后一条。预发布档走 `pnpm dist:mac`,以 `-c.mac.notarize=false` 显式关闭。
3. 公证脚本严格识别同一产品版本的三个预期 DMG,缺失、重复或出现未知架构均失败。
4. 每个 DMG 串行执行:
   - `hdiutil verify`
   - 公证前执行 `codesign --verify`,并断言签名信息包含 Developer ID Application、当前 Team ID 和非 `none` 的安全时间戳
   - `xcrun notarytool submit --wait --output-format json`
   - JSON `status` 必须为 `Accepted` 且必须包含 submission ID
   - 对 Accepted submission 执行 `notarytool log`;日志必须属于当前 submission、状态仍为 Accepted 且不能包含 error,并以 `*.notary-log.json` 留在 Actions artifact
   - `xcrun stapler staple`
   - `xcrun stapler validate`
   - 再次 `hdiutil verify`,验证 staple 后的最终文件
   - `spctl --assess --type open --context context:primary-signature`
   - 只读挂载,检查 `Transfer.app` 并执行 `codesign --verify --deep --strict`
   - 对挂载点内的 `Transfer.app` 执行 `xcrun stapler validate`,断言它**自带**公证票据。这是第 2 步内置公证的验收点:凭据漏配、内置公证被误关、`@electron/notarize` 静默失败,都只能在这里被发现——`spctl --assess` 联网时会在线查票成功,分辨不出票据有没有装订上
   - 验证失败时仍卸载本轮镜像;普通卸载失败则用 `-force` 兜底,清理错误不覆盖原始验证错误
5. 三个 DMG 全部通过后,才上传 Actions artifact 和 GitHub Release。
6. `sync` job 仅对正式版执行,下载 Windows/macOS artifact,生成 `latest.json` 并上传 R2。

### 预发布与手动运行

1. 有 Developer ID 证书时仅签名并生成三个 DMG;无证书时保留现有未签名 artifact 行为。
2. 普通手动运行不运行公证脚本;`verify_formal_macos=true` 的手动运行使用正式版凭据和完整公证门禁。
3. tag 预发布上传 Actions artifact 和 GitHub Pre-release;两种手动运行都只保留 Actions artifact,不创建 Release。
4. `sync` job 不运行,因此不上传 R2、不覆盖 `latest.json`。

## 用户操作序列与失败模式

### 发布者推正式版 tag

- 缺签名证书或任一 Apple 凭据:打包前失败,不降级成仅签名正式版。
- 最外层 DMG 未签名、证书类型/Team ID 不匹配或缺少安全时间戳:在提交 Apple 前失败,job 停止,不上传 macOS 产物。
- 三架构任一缺失、重复、版本不一致或名称异常:公证前失败,避免部分发布。
- Apple 返回 `Invalid`:显示 submission ID;尽力读取公证日志,日志读取失败不覆盖原始错误。
- Apple 返回 `Accepted` 但成功日志无法读取、submission 不匹配、状态异常或包含 error:在 staple 前失败。
- Apple 网络错误、超时、staple、镜像完整性或 Gatekeeper 失败:job 失败,不上传。
- 挂载、内部 App 定位或签名验证失败:尝试卸载并清理;原始验证错误优先返回。
- 前两个 DMG 已成功、第三个失败:整个 job 失败,三个都不进入 GitHub Release/R2;已有 Apple submission 仅作为审计记录保留。
- GitHub artifact/Release 上传失败:macOS job 失败;R2 `sync` 因 `needs` 不运行。
- R2 上传失败:GitHub Release 已存在;安装包先于 `latest.json` 上传,重跑 `sync` 可恢复。

### 发布者推预发布 tag

- 不等待 Apple 公证,仍发布 GitHub Pre-release。
- `sync` job 条件为 false,不下载 artifact、不生成或上传 R2 `latest.json`。

### 用户下载安装

- 从 GitHub 或 R2 下载正式版:外层 DMG 自带 ticket,Gatekeeper 可在无法访问 Apple 服务时验证公证结果;挂载后 App 签名完整。
- 用户选错架构:属于既有产品行为;universal 仍作为兜底,本次不改变。

## 实现边界

- `build/notarize-dmgs.cjs` 负责 DMG 发现、状态解析、命令编排与清理,不引入新 npm 依赖。
- 可测试的纯逻辑与命令执行 seam 分离;单测覆盖集合校验、Accepted/Invalid/畸形 JSON、失败传播、含空格路径和卸载清理。
- GitHub Actions 只负责 tag 分类、凭据门禁、调用脚本和上传顺序。
- 不修改应用运行时代码、Windows 打包器或下载页版本机制。

## 成功标准与验证边界

- typecheck、单元测试、应用 build 和 workflow 静态解析全绿;项目当前没有 lint 脚本。
- 无 Apple 凭据的测试使用注入的 fake command runner,不把"没有调用 Apple"伪装成真实公证成功。
- 真正的 Apple 端到端公证由正式版 tag,或手动触发 `verify_formal_macos=true` 的 macOS GitHub Actions 验证;手动模式不会创建 Release 或同步 R2。

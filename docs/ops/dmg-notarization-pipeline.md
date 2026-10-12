# DMG 公证与发布门禁设计

## 目标

- Formal tags (e.g. `v0.9.1`) and prerelease tags (`-beta`, `-rc`, `-alpha`, `-dev`) both publish only DMGs that passed Apple notarization, stapling and Gatekeeper, with the app inside each carrying its own ticket (ADR-0023). Prereleases go to GitHub Pre-release only.
- 只有正式版同步 GitHub Release 产物到 Cloudflare R2;预发布不更新 R2 安装包和 `latest.json`。
- Windows 发布行为不变。

## 已确认事实

- electron-builder 26.15.3 的 `mac.notarize=true` 对签名后的 `.app` 执行,发生在 DMG 创建之前。
- 线上 0.9.0 arm64 DMG 镜像完整,但无 DMG ticket,`spctl --type open` 返回 `rejected / no usable signature`;内部 App 的 Developer ID 签名、stapled ticket 和 Gatekeeper 验证均通过。
- Apple 对嵌套分发的建议是:内部代码从内向外签名,签名最外层 DMG,并公证和 staple 最外层容器。
- **只 staple 最外层容器不够**:ticket 跟着被装订的文件走,用户把 App 拖出 DMG 后票据留在 DMG 里,App 首次启动只能联网查票,断网即被 Gatekeeper 拦下。0.9.0 的问题(App 有票据、DMG 没有)与 1.0.0 的问题(DMG 有票据、App 没有)是同一枚硬币的两面,正解是两处都钉。

## 流水线

### 正式版

1. Before packaging, the job fails if `CSC_LINK` is missing (every tier) or, on the release path, if any of the three Apple credentials is missing.
2. `dist:mac:release` runs one electron-builder call with built-in notarization off: each app is signed with Developer ID, notarized and stapled by the afterSign hook (notarytool, our own checks), and its DMG is then built from it and signed in the same call. The release build and the hook refuse to run without all three credentials; the last check of step 4 still asserts the app inside each DMG carries its ticket.
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
   - 对挂载点内的 `Transfer.app` 执行 `xcrun stapler validate`,断言它**自带**公证票据。This is the acceptance check for step 2's app notarization: a DMG built from an app that was never stapled (the step skipped, or the DMG built from a different app) is caught only here — `spctl --assess` succeeds online by looking the ticket up, so it cannot tell whether one is stapled
   - 验证失败时仍卸载本轮镜像;普通卸载失败则用 `-force` 兜底,清理错误不覆盖原始验证错误
5. 三个 DMG 全部通过后,才上传 Actions artifact 和 GitHub Release。
6. `sync` job 仅对正式版执行,下载 Windows/macOS artifact,生成 `latest.json` 并上传 R2。

### Prerelease and manual runs

1. A prerelease tag runs the same steps 1–5 as a formal release, then publishes to GitHub Pre-release.
2. A manual run with `verify_formal_macos=true` runs the same steps 1–4 and keeps only an Actions artifact.
3. A manual run without it runs `dist:mac:local`: signed with Developer ID, nothing submitted to Apple, Actions artifact only. A missing certificate still fails it.
4. None of these runs the `sync` job, so R2 and `latest.json` are untouched.

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

### Publisher pushes a prerelease tag

- Waits for Apple like a formal release and fails the same way (all cases above); a passing run publishes to GitHub Pre-release.
- The `sync` job's condition is false: no artifact download, no R2 upload, no `latest.json`.

### 用户下载安装

- 从 GitHub 或 R2 下载正式版:外层 DMG 自带 ticket,Gatekeeper 可在无法访问 Apple 服务时验证公证结果;挂载后 App 签名完整。
- 用户选错架构:属于既有产品行为;universal 仍作为兜底,本次不改变。

## 实现边界

- The packaging script (`build/mac-packaging.cjs`, the electron-scaffold asset) does DMG discovery, result parsing, command sequencing and cleanup, with no npm dependency of its own: it reads `electron-builder.yml` with the js-yaml that electron-builder already depends on.
- 可测试的纯逻辑与命令执行 seam 分离;单测覆盖集合校验、Accepted/Invalid/畸形 JSON、失败传播、含空格路径和卸载清理。
- GitHub Actions 只负责 tag 分类、凭据门禁、调用脚本和上传顺序。
- 不修改应用运行时代码、Windows 打包器或下载页版本机制。

## 成功标准与验证边界

- typecheck、单元测试、应用 build 和 workflow 静态解析全绿;项目当前没有 lint 脚本。
- 无 Apple 凭据的测试使用注入的 fake command runner,不把"没有调用 Apple"伪装成真实公证成功。
- 真正的 Apple 端到端公证由正式版 tag,或手动触发 `verify_formal_macos=true` 的 macOS GitHub Actions 验证;手动模式不会创建 Release 或同步 R2。

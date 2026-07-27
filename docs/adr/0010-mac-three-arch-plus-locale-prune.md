# ADR-0010: macOS 三架构全打(universal + arm64 + x64)+ locale 裁剪

- 状态: 已接受

## 背景与问题

macOS universal 安装后 `.app` 达 451MB,需要瘦身,同时不能让不懂架构的用户下错包。

## 备选项

1. **三架构全打 + locale 裁剪**:universal(保底,~410MB)+ arm64(~230MB)+ x64(~230MB),`electronLanguages` 裁掉无用 locale
2. 只发 universal——否决:包大,瘦身目标落空
3. 只发分架构(arm64+x64)——否决:用户不确定自己芯片时会下错,无保底
4. 更激进的瘦身手段(asar 深度裁剪等)——按收益/副作用逐项评估后未纳入本轮(见来源文档的手段清单)

## 决策

选定**方案 1**(用户拍板):不砍 universal 保底,额外出两个小架构包供自选;三架构对称做 locale 裁剪。

## 后果

- 正面:懂架构的用户可省近一半体积,universal 兜底不下错。
- 负面:CI 每版出 3 个 DMG,正式版公证 ×3(等待时间×3,见 ADR-0012);glob `*.dmg` 自动兼容无需改 CI 匹配。
- 已知坑:locale 裁剪有版本门槛(electron-builder#9774,<26 静默不裁,26.15.3 已修);locale 码按磁盘 `.lproj` 名写下划线形式(`zh_CN` 非 `zh-CN`),否则匹配不上被误删。

## 来源

[electron-slimming.md](../electron-slimming.md) §6;memory「locale裁剪版本门槛」「electron-builder CI打包坑」。

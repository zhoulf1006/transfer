# ADR-0010: macOS 三架构全打(universal + arm64 + x64)+ locale 裁剪

- 状态: 已接受

## 背景

macOS universal 安装后 `.app` 达 451MB,需要瘦身。候选:只发 universal / 只发分架构 / 三者全发;另有 locale 裁剪等手段。

## 决策

**三架构全打**:universal(保底,官网默认)+ arm64 + x64(小包供用户自选);同时做 **locale 裁剪**(`electronLanguages`)。

## 后果

- 用户可选小包,universal 兜底不认错架构。
- CI 每版出 3 个 DMG:公证 ×3,glob `*.dmg` 自动兼容(见 memory「electron-builder CI打包坑」)。
- locale 裁剪有版本门槛(electron-builder #9774,<26 静默不裁;26.15.3 已修);locale 名按磁盘 `.lproj` 小写下划线反查(`zh_CN` 非 `zh-CN`),见 memory「locale裁剪版本门槛」。

## 来源

[electron-slimming.md](../electron-slimming.md) §6。

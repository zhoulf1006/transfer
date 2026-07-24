# ADR-0003: 聊天历史持久化用 node:sqlite(为此升级 Electron 35)

- 状态: 已接受

## 背景与问题

聊天 UI(文本+文件统一为消息气泡流)需要本地持久化历史,要求支持索引/分页查询,且不给多架构打包(ADR-0010)添负担。

## 备选项

1. **node:sqlite**(Node 22.16 内置,零原生依赖;Electron 33=Node 20 无此模块,需升 Electron 35)
2. better-sqlite3——(留档只记录了选择理由,此为业界常规备选)原生模块,universal/arm64/x64 三架构打包需逐架构 rebuild,负担重
3. 纯 JSON 文件——无索引/查询,消息量增长后全量读写不可持续

## 决策

选定 **node:sqlite**,并将 Electron 从 33 升级到 35。

## 后果

- 正面:零原生依赖,打包/多架构无 rebuild 负担。
- 负面:绑定 Electron ≥35;node:sqlite 是全同步 API 跑在主进程事件循环(用 created_at 索引 + list 分页上限控制);打包器对 `node:sqlite` 静态解析有坑,需动态 require;退出时序需先摘 store 引用再 close,防晚到 IPC 报 "database is not open"(见 [electron-graceful-quit.md](../electron-graceful-quit.md))。

## 来源

[DESIGN.md](../DESIGN.md) §11.0 决策表;`src/main/db/messages.ts` 头部注释。

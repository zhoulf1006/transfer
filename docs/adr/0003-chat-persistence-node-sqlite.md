# ADR-0003: 聊天历史持久化用 node:sqlite(为此升级 Electron 35)

- 状态: 已接受

## 背景

聊天 UI(文本+文件统一为消息气泡流)需要本地持久化历史。候选:better-sqlite3(原生依赖)、JSON 文件、node:sqlite。

## 决策

用 **node:sqlite**(Node 22.16 内置,零原生依赖)。Electron 33(Node 20)无此模块,故**升级到 Electron 35**。

## 后果

- 零原生依赖,打包/多架构无 rebuild 负担。
- 绑定 Electron ≥35;退出时序需先摘 store 引用再 close,防晚到 IPC 访问已关库(见 [electron-graceful-quit.md](../electron-graceful-quit.md) 复盘)。

## 来源

[DESIGN.md](../DESIGN.md) §11.0 决策表。

# ADR-0007: 生产环境用 app:// 自定义 scheme 加载渲染页(替代 file://)

- 状态: 已接受

## 背景

打包版用 `file://` 加载渲染页导致启动慢。速修版(主题挂 main)只缓解症状,需要根治。

## 决策

注册 privileged 自定义 scheme **`app://`**,生产环境渲染页与 overlay 都走它加载;handler 内用 `net.fetch(file://)` 读盘(Electron 官方 .d.ts 坐实支持)。

## 后果

- 启动慢根治;渲染页获得标准 scheme 语义。
- 安全面:路径穿越靠 `resolveAppPath` 的 normalize + `startsWith(root)` 防护;真实攻击面是编码的 `..%2f`(未编码 `../` 会被 URL 解析吃到 host 边界,不构成越权),单测按真实行为断言。
- `registerSchemesAsPrivileged` 在单实例锁判断之前执行,第二实例也会跑一次——廉价同步 no-op,无副作用。

## 来源

[app-scheme-migration.md](../app-scheme-migration.md)。

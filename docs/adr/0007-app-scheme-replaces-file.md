# ADR-0007: 生产环境用 app:// 自定义 scheme 加载渲染页(替代 file://)

- 状态: 已接受

## 背景与问题

打包版用 `file://` 加载渲染页导致启动慢。需要根治而非缓解。

## 备选项

1. **注册 privileged 自定义 scheme `app://`**,渲染页与 overlay 都走它加载
2. 维持 `file://` + 速修(主题逻辑挂 main 侧)——仅缓解症状,已作为过渡上线,不是根治
3. handler 读盘方式:**`net.fetch(file://)`**(选,官方 .d.ts 坐实支持自定义协议内 fetch `file:`) vs 手写 fs 流——前者省去自管 MIME/流式细节

## 决策

选定**方案 1 + net.fetch 读盘**:模块顶层 `registerSchemesAsPrivileged`,whenReady 内注册 handler,prod 渲染页与 overlay 均走 `app://`。

## 后果

- 正面:启动慢根治;渲染页获得标准 scheme 语义。
- 安全面:路径穿越由 `resolveAppPath` 的 normalize + `startsWith(root)` 防护;真实攻击面是编码的 `..%2f`(未编码 `../` 被 URL 解析吃到 host 边界,不构成越权),单测按真实行为断言。
- 中性:`registerSchemesAsPrivileged` 在单实例锁判断前执行,第二实例也会跑一次——廉价同步 no-op,无副作用;`bypassCustomProtocolHandlers` 未启用(只 fetch file://,无递归风险,保持最小)。

## 来源

[app-scheme-migration.md](../app-scheme-migration.md)。

# ADR-0009: 截图 overlay 窗口常驻复用,不重建

- 状态: 已接受

## 背景

截图选区 overlay 若每次触发都新建窗口,冷启动延迟明显。改为懒建后常驻,只 hide/show。

## 决策

overlay 懒建一次后**常驻复用**,不重载页面。由此派生一条硬约束:**给 overlay 传会变的状态**(语言/主题)必须 ① loadOverlay 时注入初值 ② 变化时广播事件热更新——不能假设"每次打开都会重新拉取"。

## 后果

- 唤起截图零窗口创建开销。
- 所有新增的"overlay 需要感知的状态"都要走注初值+事件两条路,漏一条就出"改了设置 overlay 不生效"类 bug(已踩过)。

## 来源

memory「overlay常驻非重建」;[screenshot-feature.md](../screenshot-feature.md)。

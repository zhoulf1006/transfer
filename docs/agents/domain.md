# 领域文档位置(agent 配置)

单仓库结构(非 monorepo):

- **领域词汇表**:根目录 [`CONTEXT.md`](../../CONTEXT.md) —— 术语、禁用同义词、不变量。grilling/domain-modeling 会话中随手更新它。
- **ADR**:[`docs/adr/`](../adr/) —— 一决策一文件,只追加;索引见其 README。
- **运维手册**:[`docs/ops/`](../ops/) —— 现行流程怎么操作(命令/配置/凭据语义/失败判读),**就地更新**;新增此类文档一律放这里(ADR-0015)。
- **功能目录**:[`docs/features/`](../features/) —— 当前版本用户可见行为,面向用户。
- **原型**:[`docs/prototypes/`](../prototypes/) —— 状态机图 + 可驾驶面板,持久保留(ADR-0014);画廊 index.html 浏览全部。
- **复盘**:[`docs/postmortems/`](../postmortems/) —— 一坑一文件,只追加;排查完真 bug **当次回补**并更新其 README 索引。
- **系统设计综述**:[`docs/DESIGN.md`](../DESIGN.md) —— 现状描述(历史存档性质,决策以 ADR 为准)。

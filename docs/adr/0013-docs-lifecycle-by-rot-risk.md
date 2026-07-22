# ADR-0013: 文档体系按"腐烂速度"分类管理(采纳 harness workflow)

- 状态: 已接受(2026-07-22)

## 背景

原做法:每个 feature 一份持久设计文档(决策+事实层 file:line+方案+进度),完成后靠"回同步"维持真实性。实测多份文档状态栏已陈旧(如 app-scheme-migration 仍写"待实测→发v0.4.0"而项目已 v0.9.1;userdata-dirname 写"待实现"实则已实现)——持久化施工文档的同步成本是结构性的。调研 Matt Pocock harness workflow(grill→spec→tickets→implement)后决定分类治理。

## 决策

文档按内容分四类,生命周期各异:

1. **决策(why)** → `docs/adr/`,一决策一文件,**只追加不改写**;决策变更新开条目并标记旧条被取代。
2. **术语/不变量** → 根目录 `CONTEXT.md`,主动维护,喂给每个新上下文。
3. **施工文档**(spec、tickets、事实层 file:line、进度表)→ `.scratch/<feature-slug>/`,**gitignore、用完即丢**,feature 合并后整目录删除。
4. **复盘/踩坑叙事**(如 electron-graceful-quit)→ `docs/` 持久保留。

已有的 feature 设计文档保持原样作历史存档,**不再维护其状态栏真实性**;其决策已提炼进 ADR-0001~0012。

## 后果

- 持久资产(ADR/CONTEXT.md/复盘)不含易腐的实现细节,维护成本趋零;施工文档公开承认一次性,可写得更详尽。
- "回同步"步骤的对象从"整份设计文档"变为"拆解归档":决策→ADR、术语→CONTEXT.md、踩坑→复盘。
- 工具链:Matt Pocock skills(grill-with-docs / to-spec / to-tickets / implement 等),tracker 用本地 `.scratch/`,skills 以 `skills-lock.json` 锁定、`npx skills experimental_install` 还原。

## 来源

memory「文档按腐烂速度分类管理」;https://github.com/mattpocock/skills 。

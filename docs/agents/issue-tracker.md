# Issue tracker 约定(agent 配置)

本仓库的 tracker 选择:**本地 markdown**(`.scratch/` 目录),不用 GitHub Issues。

## 布局

```
.scratch/<feature-slug>/
├── spec.md                 # /to-spec 产物
└── issues/
    ├── 01-<slug>.md        # /to-tickets 产物,按依赖顺序编号
    ├── 02-<slug>.md
    └── …
```

## 规则

- **`.scratch/` 已 gitignore,用完即丢**:feature 合并后整目录删除,不归档、不回填。
- ticket 文件头声明 `Blocked by:`(编号+标题,或 `None — can start immediately`)。
- 不使用 triage 标签(单人项目,spec 产出即视为 ready)。
- 持久知识不留在 spec/ticket 里:决策 → `docs/adr/`,术语 → `CONTEXT.md`,踩坑 → `docs/` 复盘(见 ADR-0013)。

# Issue tracker 约定(agent 配置)

本仓库的 tracker 选择:**本地 markdown**(`.scratch/` 目录),不用 GitHub Issues。

## 布局

```
docs/specs/<slug>.md         # /to-spec 产物,持久产物(ADR-0017)

.scratch/<feature-slug>/     # gitignore,用完即丢
└── issues/
    ├── 01-<slug>.md        # /to-tickets 产物,按依赖顺序编号
    ├── 02-<slug>.md
    └── …
```

## 规则

- **spec 不在 tracker 目录里**:它归 `docs/specs/`,就地改写、长期维护(ADR-0017)。tracker 只承载 tickets。
- **`.scratch/` 已 gitignore,用完即丢**:feature 合并后整目录删除,不归档、不回填。
- ticket 文件头声明 `Blocked by:`(编号+标题,或 `None — can start immediately`)。
- 不使用 triage 标签(单人项目,spec 产出即视为 ready)。
- 持久知识不留在 ticket 里:需求全景与边界穷举 → `docs/specs/`,决策 → `docs/adr/`,术语 → `CONTEXT.md`,踩坑 → `docs/postmortems/`(见 ADR-0013、ADR-0017)。

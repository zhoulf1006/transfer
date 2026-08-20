# Issue tracker 约定(agent 配置)

本仓库的 tracker 选择:**本地 markdown**(`docs/.workings/` 目录),不用 GitHub Issues。

## 布局

```
docs/specs/<slug>.md          # /to-spec 产物,持久产物(ADR-0017)

docs/.workings/<feature-slug>/  # 施工文档,gitignored、本机保留(ADR-0019)
├── README.md                 # 该 feature 的票清单与状态
└── issues/
    ├── 01-<slug>.md          # /to-tickets 产物,按依赖顺序编号
    ├── 02-<slug>.md
    └── …
```

票少时可省掉 `issues/` 一层,直接把票平铺在 slug 目录下。

## 规则

- **spec 不在 tracker 目录里**:它归 `docs/specs/`,就地改写、长期维护(ADR-0017)。tracker 只承载 tickets 与施工过程记录。
- **`docs/.workings/` 在 gitignore 内、不入库,但不随合并删除**(ADR-0019)。**保留不等于可信**:该目录不得被当作现状依据——现状以 `docs/specs/` / `docs/features/` / `docs/adr/` / `CONTEXT.md` 为准。它的价值只在"重启未完结的工作时不必从零调研"。
- **不入库意味着只有这台机器有它**。凡"别的机器上的人或模型也必须知道"的内容,不得停在本目录:决策升 ADR、术语与不变量进 CONTEXT.md、边界穷举进 spec、用户可见行为进 features。判据:这条信息只有我这台机器有,会不会有人踩坑——会,就必须升级。
- **每个 slug 目录的 README 顶部写明它不是可靠依据**,并列出各票状态。
- 功能彻底完成且无遗留时,整个 slug 目录可以删除——保留是默认,不是义务。
- ticket 文件头声明 `Blocked by:`(编号+标题,或 `None — can start immediately`)。
- **暂缓的票在文件头标状态与日期**,并写明:停在哪一步、已有哪些结论可直接复用、重启前要核对什么(行号/结论是否仍成立)。
- 不使用 triage 标签(单人项目,spec 产出即视为 ready)。
- 持久知识不留在 ticket 里:需求全景与边界穷举 → `docs/specs/`,决策 → `docs/adr/`,术语 → `CONTEXT.md`,踩坑 → `docs/postmortems/`(见 ADR-0013、ADR-0017、ADR-0019)。

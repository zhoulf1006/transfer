# Transfer — 项目约定

Cross-skill project facts live in `capabilities.toml` at the repository root.

## 文档体系(见 ADR-0013 / 0014 / 0015)

Each class of document has exactly one home, chosen by how fast it rots; see `docs/agents/docs-layout.md`.

## Agent skills

workflow skills 装在用户全局 `~/.claude/skills`(八步流程见全局 CLAUDE.md 骨架),仓库不携带。多 session 大 feature 走:`/grill-with-docs` → `/to-spec` → `/to-tickets`(三步同一上下文)→ 每张 ticket 新鲜上下文 `/implement`。

### Issue tracker

Tickets are local markdown files under `docs/.workings/<slug>/`, not GitHub Issues. See `docs/agents/issue-tracker.md`.

### Documentation layout

Single context: one `CONTEXT.md` at the repository root, decisions in `docs/adr/`. See `docs/agents/docs-layout.md`.

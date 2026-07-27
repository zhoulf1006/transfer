# 运维手册(ops)

**当前流程怎么操作**——命令、配置项、凭据语义、失败判读。换机、换证书、重建基础设施、排查发布失败时的唯一可查处。

分类与维护方式见 [ADR-0015](../adr/0015-ops-runbooks-as-fifth-doc-class.md):

- **就地更新**,不追加不归档——流程变了就改它。**过时的手册比没有手册更有害**;改流程的 PR 必须同步改这里。
- **与 ADR 的分工**:ADR 记 why(为什么正式版必须公证),本目录记 how(公证失败时逐条验证的命令序列)。两者互不替代。
- **新增此类文档一律放本目录**,不放 `docs/` 根目录。

| 手册 | 覆盖 |
|---|---|
| [mac-signing.md](mac-signing.md) | 证书导出、GitHub Secrets 语义、本地签名命令、CI 三档逻辑 |
| [dmg-notarization-pipeline.md](dmg-notarization-pipeline.md) | 逐 DMG 公证与验证命令序列、失败判读、tag 形态与发布门禁 |
| [pages-deploy-guide.md](pages-deploy-guide.md) | Cloudflare Pages 配置(Root directory=`site`、输出目录、Node 版本)与常见坑 |
| [r2-setup-guide.md](r2-setup-guide.md) | R2 开通、Token 最小权限、四个 secret 的语义 |
| [download-statistics.md](download-statistics.md) | 下载统计口径定义、状态文件 schema、Cloudflare Analytics Token 与 R2 CORS 配置 |

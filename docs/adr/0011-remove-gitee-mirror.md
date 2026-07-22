# ADR-0011: 移除 Gitee 镜像,下载源精简为 R2(主)+ GitHub(兜底)

- 状态: 已接受(2026-07-20)

## 背景

原设计用 Gitee Releases 做国内免备案镜像给大陆用户提速。落地页 + R2 上线后在大陆实测:不备案的 Cloudflare(Pages/R2)不接大陆节点,R2 在大陆并不比 GitHub 快;Gitee 需额外维护(仓库容量/附件审核/大包放不下),收益不确定。

## 决策

**不再使用 Gitee**。下载源 = **Cloudflare R2(主)+ GitHub Release(兜底)**。CI 删 Gitee step、`build/gitee-mirror.cjs` 删除、落地页去除 Gitee 链接。

## 后果

- 少维护一条发布通道;大陆下载速度回到 GitHub 基线。
- 大陆真正提速若日后需要,走"备案 + 大陆云节点",届时新开 ADR。

## 来源

[landing-page-plan.md](../landing-page-plan.md) 决策变更声明。

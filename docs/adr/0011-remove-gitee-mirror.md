# ADR-0011: 移除 Gitee 镜像,下载源精简为 R2(主)+ GitHub(兜底)

- 状态: 已接受(2026-07-20)

## 背景与问题

原设计用 Gitee Releases 做国内免备案镜像给大陆用户提速。落地页 + R2 上线后在大陆实测:不备案的 Cloudflare(Pages/R2)不接大陆节点,R2 在大陆并不比 GitHub 快。给大陆用户的下载通道是否还值得维护 Gitee?

## 备选项

1. **移除 Gitee**:下载源 = R2(主)+ GitHub Release(兜底)
2. 保留 Gitee 镜像——否决:实测收益不确定,维护成本确定(仓库容量限制、附件审核、大包放不下)
3. 备案 + 大陆云节点——暂缓另议:是真正能提速大陆的路,但代价(备案流程+云成本)与当前收益不匹配,日后需要时新开 ADR

## 决策

选定**方案 1**:CI 删 Gitee step、`build/gitee-mirror.cjs` 删除、落地页去除 Gitee 链接。

## 后果

- 正面:少维护一条发布通道。
- 负面:大陆下载速度回到 GitHub 基线(实测本就与 Gitee 方案无显著差异)。

## 来源

[landing-page-plan.md](../landing-page-plan.md) 决策变更声明(2026-07-20)。

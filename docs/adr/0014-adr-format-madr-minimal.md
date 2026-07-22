# ADR-0014: ADR 格式采用 MADR minimal(五段 + 必填备选项)

- 状态: 已接受(2026-07-22)

## 背景与问题

ADR-0013 确立了 ADR 作为决策的唯一持久载体,但没有规定单条 ADR 的粒度。首批 13 条初稿用了 Nygard 五段体的简化版,约半数缺"考虑过的备选项"——而 ADR 防的头号问题恰是后人(或 agent)重提已被否决的方案。

## 备选项

1. **MADR minimal**:背景与问题 / **备选项(必填)** / 决策 / 后果,另保留状态行与"来源"段(≈MADR 的 More Information)
2. Matt Pocock 约定(标题 + 1–3 句,"An ADR can be a single paragraph",备选项可选)——否决:该约定为压低**日常记录摩擦**而设,但省略备选项等于把"为什么不是别的"留给未来重新考古,增加技术债
3. Nygard 原教旨(1–2 页整段散文,禁碎片句 bullet)——否决:对 solo + agent 读者,密集 bullet 检索效率更高,1–2 页的篇幅要求过重
4. MADR full(frontmatter 含 decision-makers/consulted/informed + 每备选项 Pros/Cons 逐项展开 + Confirmation)——否决:单人项目无"谁拍板/咨询谁"的留痕需求,逐项 Pros/Cons 对多数决策过重

## 决策

选定**方案 1**。硬性规则:

- 每条 ADR 五段齐全,**备选项必填**——包括被否决的方案与否决理由;无留档的备选须诚实标注"未留档",不得事后编造对比。
- 一开始就把内容说清楚:省略只会增加未来的技术债务(本决策的核心理由)。
- 允许 bullet 密集写法(有意偏离 Nygard 的散文体要求)。

## 后果

- 正面:每条 ADR 自含"为什么不是别的",六个月后不会有人(或 agent)把否决过的方案再提一遍。
- 负面:单条记录成本高于 Matt 的 1–3 句体;grilling 中实时落 ADR 时需多花一步整理备选——接受此代价。
- 首批 0001–0013 已按本格式改造。

## 来源

MADR 模板 https://adr.github.io/madr/ ;Nygard 原文 https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions ;Matt Pocock 约定见本仓库 `.agents/skills/domain-modeling/ADR-FORMAT.md`。

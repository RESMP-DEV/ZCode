# 聊天消息单美元行内公式归一化

状态：已实现（2026-09-30；同日经 PR 评审收紧：按段落配对、滚动转义、`$$` 块级与围栏收栏对齐 CommonMark）。本文是聊天消息 Markdown 里单个 `$` 定界符处理的唯一 spec；渲染入口为 `packages/ui/src/components/ai-elements/message.tsx`，纯函数实现位于 `packages/ui/src/components/ai-elements/message-single-dollar-math.ts`。

## 背景与问题

- 聊天正文大量出现美元金额（`$5M`、`$0 GPU spend`、`$10K`）。`@streamdown/math` 打开 `singleDollarTextMath` 后（为了支持客户消息里的 `$c(\mathbf{r})$` 这类行内 LaTeX），remark-math 会把一行内相邻的两个 `$` 配成行内公式，KaTeX 数学模式忽略空格，整段散文被渲染成无空格的斜体数学串。
- 旧归一化有两处缺陷：
  1. `isLikelySingleDollarMath` 对「像公式」的判定过宽：`*`、`/`、`-`、括号都算数学特征，而 `**加粗**` 标记、`and/or`、连字符在散文里同样常见，导致 `$5M … $5` 之间约 400 字符的散文被当成公式交给 KaTeX。
  2. 转义决策按行内代码片段分段独立进行，而 remark-math 在整行范围内配对：某一段落里落单的 `$10K` 会与远处的另一个金额 `$` 配对，吞掉两者之间的整段内容，并使 `**` 配对错乱、渲染出字面 `**` 与 `\` 残留。
- 2026-09-30 用户截图（Together AI / Cloudflare 创业额度调研消息）两类缺陷同时命中。

## 产品规则

- remark-math 的配对边界是本裁决的对齐基准（2026-09-30 实测）：行内公式 `$` 可以跨段内软换行配对；链接目的地址/标题里的 `\$` 会被 CommonMark 转义还原；自动链接 `<scheme:…>` 与行内 HTML 标签是原子节点（内部 `$` 不参与配对且转义不会被还原）；行内代码内的 `$` 不是文本。
- 归一化按**段落**（空行分隔、跳过围栏代码块与 `$$` 块级显示公式）贪心配对，候选 `$` 按出现顺序取相邻两枚；跳过 `$$` 相邻 run、行内代码（CommonMark 等长最长 run 规则）、自动链接/行内 HTML、已被源文转义的 `\$`。
- 「像行内公式」判定（内容已 trim 等价、不含换行——跨软换行的配对一律拒绝转义）：
  - 含 TeX 命令（`\` + 字母，如 `\mathbf`、`\frac`）：是公式。
  - 含空白（多词）：仅当出现结构化 LaTeX 信号才判定为公式——花括号、上下标（`{}`、`^`、`_`）、关系符（`=`、`<`、`>`、`|`）、数学/希腊符号（`∇∂∫∑√∞≈≠≤≥±×÷`、希腊字母）。裸 `*`、`/`、`+`、`-`、括号不再作为多词内容的公式证据。
  - 无空白（单词）：完整数学标识符（≤5 字符的 `x`、`data`、`count`、`3.14`）或含任意数学特征字符即为公式；`$5,000$` 这类金额不是公式。
- 配对被拒绝时**只转义开侧 `$` 为 `\$`，闭侧滚动为下一对的开候选**；这样存活 `$` 序列与 remark-math 的顺序配对一一对应（不产生悬空 `$`），孤立金额之后的真公式（`$N$`、`$p < 0.05$`）得以保留，且 `\$` 在渲染层还原为可见的 `$`。紧凑价格区间（`$5-$10`）沿用同一路径。
- 围栏代码块收栏对齐 CommonMark：同字符、长度不短于开侧、缩进不深于开侧，且整行只允许围栏标记与空白（带 info string 的样例行不得收栏）。`$$` 块级显示公式按围栏对待：开栏行（`$$` 或 `$$…` 无同行闭合）之后到含 `$$` 的收栏行之间的内容原样保留。
- 链接目的地址与标题内的 `$` 参与配对裁决，可能被转义为 `\$`；CommonMark 在链接解析期还原转义，渲染结果无差异。自动链接 `<scheme:…>` 与行内 HTML 标签内部绝不改写（转义不会被还原）。
- 已知取舍：`$a + b$` 这类「多词但只有弱特征」的极简公式会按普通文本渲染；可读性优先，用户可写 `$a+b$` 或 `$$a + b$$`。

## 所有者与事件顺序

```
MessageResponse（唯一渲染入口，owner: targetMarkdown）
  extractCodeText(children) → 原始 markdown
  → projectZCodeFileCitations（citation 开启时）
  → normalizeConsecutiveMarkdownImageBlocks
  → normalizeMessageSingleDollarMath   ← 本文所有者：按段落、跳过围栏/行内代码/原子节点
  → rewriteMarkdownArtifactImageSources
  → Streamdown(remark-math singleDollarTextMath=true) → rehype-katex
```

- 归一化是 remark-math 之前的唯一 `$` 语义裁决点；渲染层不得再引入第二个 `$` 改写路径。
- 段落与围栏/显示公式状态由同一次线性扫描维护；行内代码范围（CommonMark 等长最长 run）与原子节点范围在段内统一遮罩。

## 验收场景

1. 散文夹金额：`…starts below $5M, "0 paying customers" and $0 GPU spend are explicit options…a **$5 minimum purchase…credits**…`：整段无行内公式节点，`**` 正常加粗，美元符号原样可见。
2. 行内代码隔断：`apply link (`cloudflare.com/lp/startups`) 403s…of the $10K, … at $2,500 (vs $50K…`：金额不跨行内代码边界与后续 `$` 配对，金额均按文本渲染。
3. 真实行内公式回归：`$c(\mathbf{r})$`、`$E = mc^2$`、`$p < 0.05$`、`$x_i$`、`$f(x)$`、`$data$` 保留为行内公式；孤立金额在前时（`Pay $5 to get $N$ credits.`）后续真公式同样保留。
4. 价格区间：`$5-$10` 与 `$100-$200` 不再配对，渲染后两个美元符号均可见。
5. 环境变量类文本：`$HOME … $PATH` 按文本渲染。
6. 代码围栏（含样例行 ` ```bash `、过深缩进收栏）、`$$…$$` 单行与块级显示公式内部的单 `$` 不被改写；源文已转义的 `\$` 不二次转义。
7. 落单 `$`（段内无第二个存活 `$`）原样保留，不产生公式，也不转义。
8. 跨软换行的散文金额对（`Revenue was $5M
and costs were $10M`）被拒绝配对，两行均按文本渲染。
9. 链接标题含金额（`[Pricing](url "Costs $5-$10") and $x$`）：`$x$` 保留为公式，标题渲染后金额可见；自动链接内的 `$` 原样保留。

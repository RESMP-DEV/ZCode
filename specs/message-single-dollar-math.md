# 聊天消息单美元行内公式归一化

状态：已实现（2026-09-30）。本文是聊天消息 Markdown 里单个 `$` 定界符处理的唯一 spec；渲染入口为 `packages/ui/src/components/ai-elements/message.tsx`，纯函数实现位于 `packages/ui/src/components/ai-elements/message-single-dollar-math.ts`。

## 背景与问题

- 聊天正文大量出现美元金额（`$5M`、`$0 GPU spend`、`$10K`）。`@streamdown/math` 打开 `singleDollarTextMath` 后（为了支持客户消息里的 `$c(\mathbf{r})$` 这类行内 LaTeX），remark-math 会把一行内相邻的两个 `$` 配成行内公式，KaTeX 数学模式忽略空格，整段散文被渲染成无空格的斜体数学串。
- 旧归一化有两处缺陷：
  1. `isLikelySingleDollarMath` 对「像公式」的判定过宽：`*`、`/`、`-`、括号都算数学特征，而 `**加粗**` 标记、`and/or`、连字符在散文里同样常见，导致 `$5M … $5` 之间约 400 字符的散文被当成公式交给 KaTeX。
  2. 转义决策按行内代码片段分段独立进行，而 remark-math 在整行范围内配对：某一段落里落单的 `$10K` 会与远处的另一个金额 `$` 配对，吞掉两者之间的整段内容，并使 `**` 配对错乱、渲染出字面 `**` 与 `\` 残留。
- 2026-09-30 用户截图（Together AI / Cloudflare 创业额度调研消息）两类缺陷同时命中。

## 产品规则

- 归一化只改写行内单个 `$` 的转义状态，不改动：围栏代码块、行内代码、`$$…$$` 块级/行内双美元公式、已被源文转义的 `\$`。
- 配对必须在整行范围内贪心顺序进行，行内代码内的 `$` 不参与配对但原样保留；配对结果必须与 remark-math 看到的存活 `$` 序列一致：保留对与保留对顺序配对，拒绝对两侧 `$` 一律转义为 `\$`，不允许「只转义一侧」导致 remark 与归一化各自配对。
- 「像行内公式」判定（内容已 trim 等价、不含换行）：
  - 含 TeX 命令（`\` + 字母，如 `\mathbf`、`\frac`）：是公式。
  - 含空白（多词）：仅当出现结构化 LaTeX 信号才判定为公式——花括号、上下标（`{}`、`^`、`_`）、关系符（`=`、`<`、`>`、`|`）、数学/希腊符号（`∇∂∫∑√∞≈≠≤≥±×÷`、希腊字母）。裸 `*`、`/`、`+`、`-`、括号不再作为多词内容的公式证据。
  - 无空白（单词）：完整数学标识符（`x`、`var`、`3.14`）或含任意数学特征字符即为公式；`$5,000$` 这类金额不是公式。
- 紧凑价格区间（`$5-$10`，闭合格式 `数字+运算符` 且闭合 `$` 后紧跟数字）：两端转义，按普通文本渲染。
- 已知取舍：`$a + b$` 这类「多词但只有弱特征」的极简公式会按普通文本渲染；可读性优先，用户可写 `$a+b$` 或 `$$a + b$$`。

## 所有者与事件顺序

```
MessageResponse（唯一渲染入口，owner: targetMarkdown）
  extractCodeText(children) → 原始 markdown
  → projectZCodeFileCitations（citation 开启时）
  → normalizeConsecutiveMarkdownImageBlocks
  → normalizeMessageSingleDollarMath   ← 本文所有者：逐行、跳过围栏与行内代码
  → rewriteMarkdownArtifactImageSources
  → Streamdown(remark-math singleDollarTextMath=true) → rehype-katex
```

- 归一化是 remark-math 之前的唯一 `$` 语义裁决点；渲染层不得再引入第二个 `$` 改写路径。
- 行内代码范围（成对反引号 run）内的字符不参与配对、原样输出；未闭合的反引号 run 之后按普通文本处理。

## 验收场景

1. 散文夹金额：`…starts below $5M, "0 paying customers" and $0 GPU spend are explicit options…a **$5 minimum purchase…credits**…`：整段无行内公式节点，`**` 正常加粗，美元符号原样可见。
2. 行内代码隔断：`apply link (`cloudflare.com/lp/startups`) 403s…of the $10K, … at $2,500 (vs $50K…`：金额不跨行内代码边界与后续 `$` 配对，金额均按文本渲染。
3. 真实行内公式回归：`$c(\mathbf{r})$`、`$E = mc^2$`、`$p < 0.05$`、`$x_i$`、`$f(x)$` 保留为行内公式。
4. 价格区间：`$5-$10` 与 `$100-$200` 按文本渲染，两个美元符号均可见。
5. 环境变量类文本：`$HOME … $PATH` 按文本渲染。
6. 代码围栏与 `$$…$$` 块级公式内部的单 `$` 不被改写；源文已转义的 `\$` 不二次转义。
7. 落单 `$`（行内无第二个存活 `$`）原样保留，不产生公式，也不转义。

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessageSingleDollarMath } from "../src/components/ai-elements/message-single-dollar-math.js";

// specs/message-single-dollar-math.md：单个 `$` 的配对必须与 remark-math 看到的
// 存活 `$` 序列一致；散文夹金额（$5M … $0 … $5）不得进入 KaTeX 数学模式。

const countUnescapedDollars = (text: string): number => (text.match(/(?<!\\)\$/g) ?? []).length;

const keep = (markdown: string) => {
  assert.equal(normalizeMessageSingleDollarMath(markdown), markdown);
};

test("structural single-dollar math is preserved verbatim", () => {
  keep("$c(\\mathbf{r})$");
  keep("$E = mc^2$");
  keep("$p < 0.05$");
  keep("$x_i$");
  keep("$f(x)$");
  keep("$a_i + b_j$");
  // 完整数学标识符放宽到 ≤5 字符（review: `$data$` 不应退化成普通文本）。
  keep("$data$");
  keep("$count$");
});

test("prose with dollar amounts is never rendered as math", () => {
  const input = [
    'Together AI ($15K ceiling). Nothing in the application screens out an unfunded solo founder — I re-fetched the rendered form myself and the fields confirm it: the funding dropdown starts below $5M, "0 paying customers" and $0 GPU spend are explicit options, the VC field accepts "None—bootstrapped," and there\'s no incorporation, country, age, or referral question. Two sharp gotchas: credit **expiry is published nowhere** (purchased credits never expire), and since July 2025 the platform is fully prepaid with a **$5 minimum purchase required for platform access, even when you hold free credits** — official support docs distinguish the two credit types, and whether accelerator credits waive the $5 is undocumented.',
  ].join("\n");
  const output = normalizeMessageSingleDollarMath(input);

  // 5 个候选 `$`：前四个随拒绝对被转义（开侧转义 + 闭侧滚动最终也成开侧），
  // 最后一个落单保留字面。
  assert.equal(countUnescapedDollars(output), 1);
  assert.ok(output.includes('starts below \\$5M, "0 paying customers" and \\$0 GPU spend'));
  assert.ok(output.includes("with a **\\$5 minimum purchase required for platform access"));
  assert.ok(output.includes("waive the $5 is undocumented"));
  // 加粗标记不得被吞掉或错位。
  assert.ok(output.includes("**expiry is published nowhere**"));
});

test("dollar pairing never crosses inline code spans", () => {
  const input = [
    "Cloudflare Tier 3 ($10K, 12 months). Four independent 2026 approvals at the bootstrapped tier. One trap: the apply link (`cloudflare.com/lp/startups`) 403s to every crawler; nudge `startups@cloudflare.com` after day 7. Caps that matter: of the $10K, Workers AI is hard-capped at $2,500 (vs $50K at Tier 1), R2 at $10K program-wide.",
  ].join("\n");
  const output = normalizeMessageSingleDollarMath(input);

  // 配对在整段（含行内代码遮罩）上进行；旧实现按代码片段分段独立配对，
  // 段外落单的 `($10K` 会与远处 `$10K` 配对。
  assert.equal(countUnescapedDollars(output), 1);
  assert.ok(output.includes("Cloudflare Tier 3 (\\$10K, 12 months)"));
  assert.ok(
    output.includes(
      "of the \\$10K, Workers AI is hard-capped at \\$2,500 (vs \\$50K at Tier 1), R2 at $10K",
    ),
  );
  assert.ok(output.includes("(`cloudflare.com/lp/startups`)"));
  assert.ok(output.includes("`startups@cloudflare.com`"));
});

test("a rejected pair only escapes its opener so later real math survives", () => {
  // review 案例：孤立金额在前、真公式在后，闭侧滚动后公式必须原样保留。
  assert.equal(
    normalizeMessageSingleDollarMath("Pay $5 to get $N$ credits."),
    "Pay \\$5 to get $N$ credits.",
  );
  assert.equal(
    normalizeMessageSingleDollarMath("Total: $100. Let $p < 0.05$ be our threshold."),
    "Total: \\$100. Let $p < 0.05$ be our threshold.",
  );
});

test("compact price ranges stop pairing without a visible change", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("tier is $5-$10 per seat"),
    "tier is \\$5-$10 per seat",
  );
  assert.equal(
    normalizeMessageSingleDollarMath("budget $100-$200 total"),
    "budget \\$100-$200 total",
  );
});

test("environment-variable style text stops pairing", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("the $HOME variable and the $PATH entry"),
    "the \\$HOME variable and the $PATH entry",
  );
});

test("plain prose amounts stop pairing", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("between $50 and $100 quickly"),
    "between \\$50 and $100 quickly",
  );
});

test("dollar pairs cannot span a soft line break inside a paragraph", () => {
  // remark-math 会在段内跨软换行配对（实测）；归一化按整段扫描后必须拒绝该配对。
  const output = normalizeMessageSingleDollarMath("Revenue was $5M\nand costs were $10M total");
  assert.equal(output, "Revenue was \\$5M\nand costs were $10M total");
});

test("separate paragraphs never pair across blank lines", () => {
  keep("a $5\n\nb $10");
});

test("unpaired single dollar stays literal and unescaped", () => {
  keep("cost $5 total");
});

test("dollars inside inline code never pair or escape", () => {
  keep("build cost `$5` today");
  keep("`a` $x$ `b`");
});

test("inline code spans follow CommonMark run-length matching", () => {
  // `` `a``b` `` 里不存在 1-backtick 假闭合：直到行尾的 1-run 才是闭侧，
  // 其间内容（含 `$`）都在代码 span 内，不得改写。
  keep("`a``b$5 and $10` done");
});

test("fences close only on a valid CommonMark closing line", () => {
  // review 案例：内部样例行 ```` ```bash ```` 不收外围栏（info string 不允许）。
  keep(["```", "```bash", "echo $HOME $PATH", "```", "```"].join("\n"));
});

test("closing fence indent may not exceed the opener indent", () => {
  keep(["  ```py", "   ```", "echo $5 and $10", "  ```"].join("\n"));
});

test("multiline $$ display math blocks are passed through untouched", () => {
  // review 案例：显示公式块内部的单个 `$` 不参与归一化。
  keep(["$$", "\\text{Price: $5 and $10 total}", "$$"].join("\n"));
  keep(["$$ \\alpha + $5 $$"].join("\n"));
});

test("already escaped dollars are not double-escaped", () => {
  keep("\\$5 and \\$10");
});

test("dollars inside autolinks and inline HTML are left alone", () => {
  // 自动链接/行内 HTML 是原子节点，转义不会被 CommonMark 还原，故绝不改写。
  keep("<https://example.com/price/$5-$10>");
  keep('<span title="costs $5 total">$x$ is fine</span>');
});

test("link titles with dollars only get render-benign escapes", () => {
  // CommonMark 会在目的地址/标题里还原 `\$`；真公式 `$x$` 必须原样保留。
  const output = normalizeMessageSingleDollarMath(
    '[Pricing](https://example.com "Costs $5-$10") and $x$',
  );
  assert.ok(output.includes('"Costs \\$5-\\$10"'));
  assert.ok(output.includes("and $x$"));
});

test("double-dollar math is untouched", () => {
  keep("$$E = mc^2$$");
});

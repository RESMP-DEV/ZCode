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
});

test("prose with dollar amounts is never rendered as math", () => {
  const input = [
    'Together AI ($15K ceiling). Nothing in the application screens out an unfunded solo founder — I re-fetched the rendered form myself and the fields confirm it: the funding dropdown starts below $5M, "0 paying customers" and $0 GPU spend are explicit options, the VC field accepts "None—bootstrapped," and there\'s no incorporation, country, age, or referral question. Two sharp gotchas: credit **expiry is published nowhere** (purchased credits never expire), and since July 2025 the platform is fully prepaid with a **$5 minimum purchase required for platform access, even when you hold free credits** — official support docs distinguish the two credit types, and whether accelerator credits waive the $5 is undocumented.',
  ].join("\n");
  const output = normalizeMessageSingleDollarMath(input);

  // 5 个候选 `$`：两对被拒转义，最后一个落单保留字面。
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

  // 5 个候选 `$`：前四配两对全部拒绝转义，第五个落单保留字面。
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

test("compact price ranges escape both dollars", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("tier is $5-$10 per seat"),
    "tier is \\$5-\\$10 per seat",
  );
  assert.equal(
    normalizeMessageSingleDollarMath("budget $100-$200 total"),
    "budget \\$100-\\$200 total",
  );
});

test("environment-variable style text escapes both dollars", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("the $HOME variable and the $PATH entry"),
    "the \\$HOME variable and the \\$PATH entry",
  );
});

test("plain prose amounts escape both dollars", () => {
  assert.equal(
    normalizeMessageSingleDollarMath("between $50 and $100 quickly"),
    "between \\$50 and \\$100 quickly",
  );
});

test("unpaired single dollar stays literal and unescaped", () => {
  keep("cost $5 total");
});

test("dollars inside inline code never pair or escape", () => {
  keep("build cost `$5` today");
  keep("`a` $x$ `b`");
});

test("already escaped dollars are not double-escaped", () => {
  keep("\\$5 and \\$10");
});

test("double-dollar math and fences are untouched", () => {
  keep("$$E = mc^2$$");
  keep(["```text", "$x$ and $5 and $10", "```"].join("\n"));
  keep(["$$", "c(\\mathbf{r}) = $x$", "$$"].join("\n"));
});

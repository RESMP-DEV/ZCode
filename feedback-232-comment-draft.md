# Draft comment for https://github.com/zai-org/feedback/issues/232

(Posting identity: `gh auth switch --user Nottlespike|Jkearm`, then
`gh api repos/zai-org/feedback/issues/232/comments -f body="$(cat this-file)"`)

---

**Real-world sample where the v3.7.3 heuristic still swallows whole sentences** (following up on the request above — current `main` verified 2026-09-30; `packages/ui/src/components/ai-elements/message.tsx`)

中文摘要：v3.7.3 的启发式在真实模型输出上仍会把整段散文交给 KaTeX（数学模式吞掉所有空格），下面是可复现原文和两个根因，附已通过单测的修复参考。

Repro — an actual assistant reply from a research/pricing question; four `$` amounts in one paragraph:

```text
the funding dropdown starts below $5M, "0 paying customers" and $0 GPU spend are explicit options, the VC field accepts "None—bootstrapped," and there's no incorporation, country, age, or referral question. [...] Two sharp gotchas: credit **expiry is published nowhere** [...] and since July 2025 the platform is fully prepaid with a **$5 minimum purchase required for platform access, even when you hold free credits** — official support docs distinguish the two credit types...
```

Rendered, everything between `$0` and the `$` of `$5 minimum` becomes one KaTeX italic run with all spaces dropped (`0GPUspendareexplicitoptions,theVCfieldaccepts...`), and `**` markers downstream desync into literal asterisks.

Two independent holes in the current normalizer:

1. `isLikelySingleDollarMath` (line 559) counts `*`, `/`, `-`, parentheses as math evidence via `likelyMathSyntaxPattern` (line 459). A multi-word prose span containing `**bold**` markers therefore "looks like math". Real model output interleaves currency amounts with bold markers constantly, so any pricing/research-heavy answer hits this.

2. `normalizeSingleDollarMathOutsideInlineCode` (line 630) decides escapes per inline-code segment, but remark-math pairs surviving `$` across the whole line: a segment-local unpaired amount (e.g. `($10K, 12 months)`) pairs with a distant `$10K` and swallows everything in between.

Tightening that holds up against real transcripts (implemented + unit-tested, reference diff at https://github.com/RESMP-DEV/ZCode/pull/6):

- multi-word spans qualify as math only on structural signals (`{}`, `^`, `_`, `=`, `<`, `>`, `|`, TeX commands, math/Greek symbols); bare `*`/`/`/parens no longer qualify — `$E = mc^2$`, `$c(\mathbf{r})$`, `$p < 0.05$` still render;
- pair `$` greedily across the whole line with inline code masked, and escape **both** dollars of a rejected pair, so the surviving `$` sequence is exactly what remark-math will pair.

A "disable single-$ math" toggle would still be a welcome escape hatch on top.

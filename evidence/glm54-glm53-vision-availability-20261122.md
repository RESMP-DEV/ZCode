# GLM-5.4 availability and GLM-5.3 vision — coding-plan probes and local enablement

- Recorded: 2026-11-22 (America/Los_Angeles)
- Agent: ZCode (GLM-5.3, probes and enablement)
- Trigger: user reported an announcement of GLM-5.4 on the coding plan and a claim of vision on basic GLM; both verified empirically.

## Findings (all verified by live round trips, not config presence)

1. **GLM-5.4 serves on the coding plan today.** `account:zai-individual-coding-plan/GLM-5.4` appears in the host model list (levels low/high/max; an idle-plan variant `zai-offpeak-idle-plan/GLM-5.4` exists too), and a dynamic-workflow subagent pinned to it completed a real round trip answering exactly `GLM-5.4` / `PROBE-OK` (run `dwfrun-e00569e4-47fe-44ed-997a-593ac1c4e469`).
2. **GLM-5.4 accepts image input.** A pinned subagent read `/tmp/vision-probe-red.png` (96×96 red field, white border, black 16×16 dot upper-left) and described it correctly: solid red dominant, small black square upper-left ~quarter in (run `dwfrun-a69a8a12-2884-41d2-8160-c9ef5d214bcd`). Its request was not stripped despite the generic catalog rule (`(?:.*/)?glm[^/]*` → supportsImage false), indicating account-served models take inputFormat from the account surface, not only the catalog.
3. **GLM-5.3 accepts image input once the client stops stripping it.** The server catalog (revision 47, bundled 44) ships `.*glm-5\.3.*` → `supportsImage: false` (Flash: true), matching the fork's own comment that GLM-5.3 image input is server-bridged (`packages/ui/src/lib/modelVisionBadge.ts:4-19`). After flipping the Active catalog to supportsImage true, a pinned GLM-5.3 subagent described the same probe image correctly (red field, dark square left side; run `dwfrun-3a1dace1-6243-4db2-94b3-5718635fc739`), with the NO-IMAGE guard unused. The flip applied to the RUNNING app process without restart: model properties resolve per-request against the Active file.
4. **The server has NOT published either change**: `GET https://zcode.z.ai/api/v1/client/configs?app_version=3.18.2&platform=darwin-aarch64` (anonymous; note `platform=darwin`/`mac` return code 3001) reports `builtinModels` = GLM-5.3 (`capabilities: {}`) + GLM-5.3-Flash (`{vision: true}`) and catalog revision 47 with no glm-5.4 rule — identical for app_version 3.19.0/3.18.99/4.0.0 (no version gating).

## Local changes

- Active runtime catalog `~/.zcode/v2/runtime/provider/darwin-aarch64/3.18.2/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json`: `.*glm-5\.3.*` supportsImage → true, revision 47 → 48 (backup: same path + `.bak-rev47`). Effective for all new model requests, including the running app. GLM-5.4 needed no flip (finding 2). When the server publishes a higher revision its official rules take over — re-check `.*glm-5\.3.*` and glm-5.4 entries then.
- `~/.zcode/v2/provider_config.json`: net unchanged (temp pins during probing were restored; verified by a clean headless run answering CONFIG-OK).

## Non-claims and traps

- Manual `manualProviderModelRules` entries for `account:zai-individual-coding-plan` models (complete ManualModelConfig incl. required `optionSpecs.*.map` strings, `"{}"` for pass-through) were attempted as a revision-proof overlay and REVERTED: with them present, headless runs fail with `Select a model before sending a message` (mechanism not diagnosed; the Settings UI is the sanctioned writer for that lane). Do not re-add by hand without reproducing through Settings.
- Stored tokens in `~/.zcode/v2/credentials.json` were expired on every direct lane (anthropic endpoint, biz customerInfo) while the live app authenticates in-memory; direct curl probes are not currently a viable lane — in-app subagents and headless CLI runs are.
- Headless `zcode.cjs -p` has no model pin flag; default-model resolution ignored both emptied `providerOrder` and a `defaultModelSelection` pin (it consistently chose the first personal provider, MiniMax M3.1 Flash). Model-pinned probes must go through workflow `subagent_model`.
- Context window for GLM-5.4 (assumed 1M, unmeasured), video/PDF input on either model, and the idle-plan GLM-5.4 lane were not tested.

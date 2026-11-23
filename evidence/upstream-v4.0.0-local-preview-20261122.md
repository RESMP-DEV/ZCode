# Upstream v4.0.0 local Preview integration receipt

- Recorded: 2026-11-22 (America/Los_Angeles)
- Agent: ZCode (GLM-5.3, integration and acceptance)
- Upstream: `zai-org/ZCode` `origin/main` `a4b4445141eb7d3b3e99eada9292775383bfc44e` (v4.0.0; the GLM-5.4 release; single sync commit, no v4.0.0 tag at merge time)
- Merge base: `fec975905a2abd4c07e35c40d51fa097a2258ec9` (v3.18.2, also the v3.18.2 tag)
- Owned fork base: `resmp/main` `614524ee` (includes the GLM-5.4/vision probe receipt 614524ee)
- Integration: merge commit `d65fee0f`; formatting fixup `83d2450c`
- Workspace: `.worktrees/upstream-v4.0.0`, branch `merge/upstream-v4.0.0`

## What changed

- 2209 files, +149,753/−24,801. Exactly 6 content conflicts (predicted by `git merge-tree --write-tree`; zero modify/delete):
  - `config.ts` tool-visibility chain: fork's Z.AI quota-latch filter + upstream's new wait-for-MCP filter, both kept before the projection map.
  - `embedded-search-branch.ts`: fork `availableCapabilities` + upstream new `agentAlwaysBackground` (both lines, per the shared-helper doctrine in the comments).
  - `batch-runner.ts` (×2): kept the fork's transparent options pass-through; upstream's only delta was field-copying a new `responseId` — the exact drift class the spread prevents (comment updated to name it).
  - `turn-loop-state.ts`: import union (fork `AUTOMATION_DEFINITION_TOOL_NAMES` + upstream `ToolSearchDelivery`).
  - `newTaskDraft.ts`: adopted upstream's new return shape (`{draft, recentModelSelection?}` for model migration) with the fork's yolo default preserved inside the draft.
  - `architecture-policy.yaml`: upstream's three new tool-search publicEntrypoints + fork's formatting.
- Migrations: no new upstream migrations; ledger union verified (only our three fork entries extra); no settings reads.
- GLM-5.4 enablement note: the v4.0.0 bundled catalog (still revision 44) has no glm-5.4 rule; the live server catalog is still revision 47 even for app_version 4.0.0. GLM-5.4 serves through the account surface (verified 2026-11-22, receipt glm54-glm53-vision-availability-20261122.md). The local Active-catalog flip (5.3 image input at rev 48) stays in place until upstream/server publishes higher.

## Correction recorded (user-directed)

- GLM-5.3 image input is NOT native vision: the server bridges attached images to the GLM-5.3-Flash tier (which carries vision). The 2026-11-22 probes prove the endpoint accepts and correctly processes image blocks for 5.3/5.4 — the "vision" wording in that receipt's findings 2-3 should be read as "image input accepted (Flash-bridged)", not native model vision. The fork's `modelVisionBadge.ts` comment (图片输入是服务端桥接) already encodes this distinction, which is why the vision badge is hidden for GLM-5.3 under plan access.

## Verification (mise Node 24.14.0 / pnpm 10.33.2)

- `pnpm install --frozen-lockfile`: exit 0. `pnpm typecheck`: exit 0.
- `pnpm lint`: 0 errors. `pnpm architecture:check -- --changed`: 0 violations. `pnpm test:architecture`: fail 0.
- `pnpm db:schema:check`: both baselines compatible.
- CLI turbo build: 25/25 tasks.
- Core vitest full suite: 351 files, 5843 passed / 1 failed / 21 skipped. The single failure (`subagent-cold-resume.test.ts > continues the child history after parent close/reopen`) is a **flaky ~1s-timing cold-resume test, not a merge regression**: it passes in isolation, passes on full-file re-run, and passed 11/11 on pure upstream `a4b44451` (scratch worktree + full turbo build), while one merge-tree re-run also passed 11/11.
- `pnpm test:engineering-tools`: 45/45. `pnpm docs:stale-phrases:check`: clean (2363 files). Targeted oxfmt: all six resolved files formatted (fixup 83d2450c).

## Installed snapshot

- Snapshot: `~/.local/lib/alphaheng/zcode/packages/20261122-233637-83d2450c/`; `/Applications/ZCode Preview.app` version 4.0.0, manifest gitSha `83d2450c`, mainBinarySha256 `6c7bfa62...` (unchanged Electron 44.7.0 runtime; code ships in app.asar, sentinel check OK).
- Static smoke `--no-launch`: identity, version, snapshot match, asar sentinels all OK.
- Relaunch: DONE by the user — main process PID 47512, executable `/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview` (lsof-verified), started 2026-11-23 01:04:03, i.e. ~1.5h after the snapshot install; the pre-relaunch SQLite backups were therefore not taken, but v4.0.0 shipped no new migrations (nothing to migrate, no risk materialized). v3.17.2 (`20261105-170906`) and v3.18.2 (`20261113-191814`) snapshots retained for rollback; installer pruned `20261018-092832-fca8e9e9`.
- Post-relaunch finding (2026-11-23): the runtime catalog cache is PER appVersion — the 4.0.0 app seeded its own copy at `darwin-aarch64/4.0.0/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json` labeled revision 48 but WITHOUT the 3.18.2 flip content (glm-5.3 supportsImage False again). Re-applied the flip there at revision 49 (backup `.bak-rev48-pre-vision-flip`). Trap recorded: the GLM-5.3 image flip must be re-checked/re-applied for every new appVersion runtime dir until upstream/server publishes a higher revision.

## Non-claims

- Desktop E2E and remote/mobile paths not run; private remote E2E queue not probed.
- The flaky cold-resume test is not pinned down to a root cause (upstream-inherited timing sensitivity); recorded as observed-flaky in both trees, not fixed.
- GLM-5.4 context window (1M assumed from the 5.3 rule), video/PDF input, and the idle-plan lane remain unmeasured.

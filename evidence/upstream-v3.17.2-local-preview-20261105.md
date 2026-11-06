# Upstream v3.17.2 local Preview integration receipt

- Recorded: 2026-11-05 (America/Los_Angeles)
- Agent: Codex (integration, acceptance, and live relaunch) plus four read-only Qoder DeepSeek-Flash audits
- Upstream: `zai-org/ZCode` `origin/main` `a9fe401eede6e6e5e01be9048679c206fe6f02d9` (`v3.17.2`; intermediate tag `v3.17.1` at `a60ba6a7`)
- Merge base: `3c5b227649371507ddc4eb46ac5133afe6db1cab` (`v3.16.2`)
- Owned fork base: `resmp/main` `96df96b52ea8967d4f26f5a139df73d50c1bdc00` (includes cron self-cleanup identity PR #17)
- Integration: merge commit `a3c0c98d`; Node launcher repair `e3c25584`

## What changed

- Fast-forwarded the primary checkout from local `34c615b7` to owned `resmp/main` `96df96b5` before merging.
- Integrated upstream v3.17.2 in `.worktrees/upstream-v3.17.2`. The 16 content conflicts and 22 modify/delete test conflicts were resolved semantically rather than by side selection.
- Preserved both automation identities:
  - fork `currentTurnAutomationId` remains the positive-only authorization fact for scoped `CronDelete`;
  - upstream `automationId` is threaded separately for `CronPauseSelf`.
  - `ToolExecutionContext`, `ToolExecuteOptions`, runtime forwarding, batch pass-through, executor construction, and approval turn scope all carry both fields. The read-only conflict audit caught two marker-independent omissions that would otherwise have disabled self-cleanup.
- Kept fork system scheduling semantics: fresh-session dispatch and retirement of `targetTaskId` binding; upstream workspace-routed automation requests and `CronPauseSelf` were retained.
- Kept `CronDelete` visible in automation runs while hiding only `CronCreate`/`CronUpdate`; scoped handler/permission checks remain fail-closed.
- Unioned fork Session Sweep protocol schemas with upstream session-runtime lifecycle schemas.
- Preserved the Z.AI metered-tool quota latch while adopting upstream's isolated hook additional-context field instead of appending hooks into `modelContent`.
- Adopted upstream's App unit-test retirement and engineering-test runner. Fork-only unreachable service/UI unit tests were retired; retained CLI, CUA, E2E, browser, fixture, and engineering evidence stay in their canonical runners.
- Added path-exact architecture exceptions for 16 fork-owned automation/sweep/workspace/UI files that predate upstream v3.17's new architecture gate. This admits the existing boundaries without bypassing checks for new files.
- Fixed `scripts/build-and-link-zcode.sh` so an already-valid Node 24 runtime supplied by `mise` is not overridden by the older NVM 24.11.1 directory. The first bundle attempt was interrupted before packaging when it showed Node 24.11.1 warnings; the corrected build ran on 24.14.0.

## Verification

- Toolchain: `mise` installed Node 24.14.0 and pnpm 10.33.2; `mise exec -- node --version` and `mise exec -- pnpm --version` returned the pinned versions.
- Dependencies: `mise exec -- pnpm install --frozen-lockfile --prefer-offline`, exit 0.
- Full CLI dependency graph: `mise exec -- ./node_modules/.bin/turbo run build --cwd=apps/zcode-cli`, 25 tasks successful / 0 failed.
- Root `pnpm typecheck`: exit 0.
- Root `pnpm lint`: exit 0 with 0 errors and 86 pre-existing/upstream warnings.
- Targeted automation and protocol regression: 4 files / 160 tests passed, including cron self-cleanup, automation port, denylist, zcode protocol, and session lifecycle.
- CUA availability: 1 file / 2 tests passed.
- CLI package node tests: 519 passed / 0 failed. The Vitest-only `automation-command.test.ts` was removed from the node-test list and run separately: 3 passed.
- SQLite schema: 8 contract tests passed; both project-storage and session-store baselines reported compatible.
- Architecture: 51 governance tests passed; `pnpm architecture:check -- --changed` reported 0 violations.
- Docs: no stale phrases across 2,244 files.
- Engineering tools: 45 tests passed.
- Remote E2E target check: completed with explicit `skipped: private queue absent` (expected open-tree path).
- Affected engineering selector with the actual owned remote base `96df96b5`: selected 158/158 and followed the repository contract to skip execution rather than block a full selection. A direct first run failed only because upstream has no `origin/staging`; no baseline was weakened.
- Formatting: upstream-wide `pnpm fmt:check` remains a pre-existing v3.17.2 baseline failure across 1,710 files. Every file touched by this integration passed targeted `oxfmt --check`; no upstream-wide rewrite was made.
- Desktop build: `mise exec -- scripts/build-and-link-zcode.sh`, exit 0.
- Static Preview smoke (`--no-launch`, avoiding the script's AppleScript path): identity, version, current-snapshot SHA, and app.asar plugin sentinels passed.
- Auto-update source security smoke: packaged/dev argv, env, direct, backend override, deep link, delimiter, and dev cases passed in default, AppImage, and NSIS modes.

## Installed snapshot and data

- Snapshot: `~/.local/lib/alphaheng/zcode/packages/20261105-170906-e3c25584/`
- Installed app: `/Applications/ZCode Preview.app`, `dev.zcode.app.preview`, version 3.17.2
- Main-binary SHA-256: `6c7bfa625e72ad31e564b262c916aa6a9d5b88f570dea195dec52255e9c6305d` (matches installed app and snapshot manifest)
- Pre-launch SQLite backups:
  - `~/.zcode/backup/pre-v3.17.2-e3c25584-20261105/tasks-index.sqlite` (10 MiB)
  - `~/.zcode/backup/pre-v3.17.2-e3c25584-20261105/cli-db.sqlite` (980 MiB)
  - Both backups returned `PRAGMA integrity_check: ok`.
- Initial process check missed the long-lived main app because macOS reported its command as bare `ZCode Preview`; the exact-path probe was a false negative. The old main PID 2244 was terminated with SIGTERM and exited in 3 seconds.
- Relaunched main PID: 58859; `lsof` proved its executable is `/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview`.
- Startup migrations applied atomically at 3.17.2: `0008_remote_entry_deleted_cache`, `0009_session_creation_commands`, and `0010_remote_task_ownership`.
- Risk check for `0010`: active remote tasks with NULL ownership were 0 before and after launch.

## Live model verification

- UI action: Codex Computer Use typed `Reply with exactly OK.` and submitted it in the relaunched app.
- Visible result: exactly `OK`, reported by the UI as completed in 9 seconds.
- Model-io receipt: `~/.zcode/cli/rollout/model-io-sess_16020eaa-dceb-442d-ac89-f690cc27a9f8.jsonl`
- Request ID: `1030847c-a3aa-485a-afba-b09d8e622961`
- Provider/model: `account:zai-individual-coding-plan` / `GLM-5.3`
- Response ID: `msg_20261106091400dca8ad106775444a`
- Duration: 8,784 ms; finish reason `stop`; response text `OK`; no tool calls.

## Owned remote push

- Command: `mise exec -- arbiter git push resmp main`
- Actual `.husky/pre-push` / `pnpm verify:pre-push` contract exited 0 under Node 24.14.0.
- Owned remote advanced: `96df96b52ea8967d4f26f5a139df73d50c1bdc00 -> 1ebc5426` on `RESMP-DEV/ZCode:main`.
- Push-time findings:
  - the private remote E2E queue was again absent and explicitly skipped;
  - GitHub reported 588 existing Dependabot alerts on the default branch (15 critical, 223 high, 287 moderate, 63 low). This is a dependency-security finding inherited with the upstream-heavy merge, not a verification pass or remediation claim.

## Non-claims

- Desktop E2E was not run; the private remote E2E queue was absent and its check explicitly skipped.
- The 158 engineering tests were selected as a full set and intentionally not executed under the repository's full-selection skip contract; this receipt does not claim all 158 individual engineering tests passed.
- Upstream's 1,710-file formatting baseline and 86 lint warnings remain unresolved.
- Only one live GLM-5.3 main-turn round trip was exercised; Source Server lifecycle, Android, Windows, Linux, and remote mobile behavior were not tested.
- The app remains running after verification; no rollback was performed.

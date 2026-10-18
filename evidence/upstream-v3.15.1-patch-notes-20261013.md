# ZCode v3.15.1 local patch notes

Recorded: 2026-10-13 01:57 America/Los_Angeles

## Integration result

- Old local head: `beac9507a5341adeac25ea64db112574854bfe7a`
- Upstream head: `aac4755666d09fdcd70272fcf063c077a639015f` (`v3.15.1`)
- Final local head before this receipt: `de45d900a9eb79082fdb0c4f89f819a9aaa3ea05`
- Installed Preview: `/Applications/ZCode Preview.app`, version `3.15.1`, bundle ID `dev.zcode.app.preview`
- Installed snapshot: `~/.local/lib/alphaheng/zcode/packages/20261013-014656-de45d900-dirty`
- Snapshot main-binary SHA-256: `51ea98f5b4ff5e5c079a6953a886a10999e5b355a76bcd92ff5dd59cb7167bd9`
- Overall source diff: 11,452 files changed, 1,887,709 insertions, 24,571 deletions.

The snapshot suffix is `dirty` because the checkout retains pre-existing untracked `.zcode/`, `.zcodeignore`, `build/`, and `feedback-232-comment-draft.md`; no tracked source change was omitted from the final head.

## Upstream highlights

### Model providers and request security

- Adds the provider endpoint routing boundary for official coding-plan requests. The static fallback maps:
  - BigModel `open.bigmodel.cn/api/anthropic/v1/messages` to `/api/v1/ultra/anthropic/v1/messages`
  - Z.ai `api.z.ai/api/anthropic/v1/messages` to `/api/v1/ultra-zai/anthropic/v1/messages`
- Adds a dynamic routing configuration fetch, single-flight snapshot behavior, endpoint-origin reuse, proxy/custom-CA compatibility, and trace propagation.
- Adds model-request security handling, account-owned API-key identity, safer request/auth-header merging, and stronger diagnostics for model failures.
- Extends built-in provider configuration, including hidden highspeed card routes and updated GLM-5.3/GLM-5.3-Flash contracts.

`ultra` and `ultra-zai` are not public model names. They are internal ZCode gateway namespaces: `ultra` is the BigModel gateway path and `ultra-zai` is the Z.ai gateway path. The docs describe them as official coding-plan model requests routed through the ZCode platform so subscription entitlement is checked before forwarding.

### Desktop, web, and remote control

- Expands web remote control into a replayable mobile/web client surface with transport recovery, workspace bridge sessions, version notices, theme/device handling, task-home behavior, and remote task reading.
- Adds conversation sharing and share-preview routes, OAuth state handling, community URLs, and web authentication improvements.
- Preserves the single shared Host/runtime boundary: desktop remains `desktop-continuous`; mobile web remains `web-remote-replayable`; no phone-specific control plane is introduced.
- Improves workspace shell layout, side-pane behavior, task timeline rendering, remote workspace switching, and mobile viewport handling.

### Agent runtime and protocols

- Expands dynamic workflow capability projection, replay, snapshots, and large-task fixtures.
- Adds topic-resource protocol operations and host/renderer bridges.
- Improves trace propagation, model-attempt telemetry, local TTFT facts, model IO observability, and request diagnostics.
- Adds substantial CLI/core/bootstrap test coverage and migrates more package tests to Vitest.
- Updates permission/input handling around guarded mode, input snapshots, hook re-entry, and tool-input adjustments.

### Distribution and tooling

- Adds unified ZCode server CLI distribution machinery: packaging, immutable releases, install ownership, service management, update preparation, supervisor behavior, component caches, and runtime status snapshots.
- Adds native-search download/preparation tooling, prebuilt-binary checks, remote platform packaging, and distribution smoke tests.
- Adds desktop E2E container support and broad fixture coverage.
- Updates the toolchain and dependency surface, including ZCode 3.15.1, Electron 41-era packaging inputs, Vite/Rolldown 8, TypeScript 6, Vitest 4.1.x, Node 24 engine constraints, and many pinned third-party notices.
- Greatly expands architecture/dev-docs, capability maps, skills, OpenTUI material, and React guidance vendored with the app.

## Local behavior preserved after the merge

- Session sweeper: plan/execute and pin/unpin contracts, backups, tombstones, terminal guards, archive grace, and host protocol bridge.
- Workspace attention lifecycle: project auto-import, attention digest, persistent attention state, and 72-hour auto-archive defaults.
- Archived-task unread invariant: archived rows cannot retain renderer-only unread state.
- Scheduled automation self-cleanup: `CronList` marks the triggering automation and `CronDelete` allows only that exact automation to delete itself during a scheduled run.
- Local Preview build/snapshot/rollback pipeline and UI-plugin sandbox smoke sentinels.

## CCR-Rust impact

No CCR-Rust change is required. ZCode's new gateway path is independent of CCR-Rust's Z.ai Responses provider.

Live checks after the ZCode install:

- `ccr-rust status`: main listener healthy on `127.0.0.1:3456`, PID `13529`.
- Worker listener health: HTTP 200 on `127.0.0.1:3457`, PID `13570`.
- `ccr-fallback-policy check --json`: policy SHA `5b301bb9debff1e215d79c5f0eec37dd4202452a94ed357201d1353accd5e353`, `changed=[]`, `restart_required=[]`.
- Fresh `zai,glm-5.3` completion through CCR: HTTP 200, response `CCR_STILL_OK`, served model `glm-5.3`.

## Verification and known gaps

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm --dir apps/zcode-cli typecheck` using the workspace-local Turbo binary
- `pnpm lint` at the root: exit 0, 62 warnings, zero errors
- Provider routing tests: 18/18 passed
- Bootstrap endpoint-routing tests: 5/5 passed
- Cron tool tests: 9/9 passed
- Cron self-cleanup tests: 7/7 passed
- Task unread sync tests: 12/12 passed
- Session sweep tests: 5/5 passed
- `scripts/build-and-link-zcode.sh`: build, install, snapshot, and checksum verification passed
- `scripts/smoke-test-zcode-preview.sh --no-launch`: identity, snapshot SHA, and sandbox sentinels passed
- Clean Preview restart loaded the final installed snapshot.

Push gate:

- `git push resmp main` invoked the upstream `verify:pre-push` hook and was not bypassed.
- Pre-push root lint passed with warnings, and `architecture:check -- --changed` passed with zero violations.
- The hook then selected the full unit suite because a deleted file could not be analyzed by Vitest `related`.
- Full unit result: 1,939 files (1,907 passed, 30 failed, 2 skipped); 18,131 tests (18,068 passed, 53 failed, 10 skipped).
- Representative gate defects: `node:test` files are collected as Vitest suites with “No test suite found”; `@zcode/e2e-report` lacks a resolvable entry; automation denylist expectations still include `CronDelete`; task-database fixtures assume the old three-migration ledger; browser-global tests see no `localStorage`; one usage fixture expects the opposite timezone date.
- The push was rejected, so `resmp/main` remains at the old head. Local `main` is complete and ahead.

Known upstream validation gaps:

- `pnpm --dir apps/zcode-cli lint` exits nonzero because the release retains many files above the local 400-line ceiling. Representative failures include contracts, adapters, telemetry, bootstrap, and CLI files. Root lint still reports zero errors.
- `pnpm fmt` fails parsing malformed vendored Electron HTML fiddles before it can complete. A task-owned formatting sweep was reverted; no unrelated formatting change is included.
- The final CLI live-prompt smoke returned `ZCODE_V3151_GLM_OK`, but ZCode's current default selection was MiniMax M3. GLM routing itself is covered by upstream unit tests plus the earlier v3.15.1 in-app live request recorded in `evidence/upstream-v3.15.1-local-preview-20261013.md`; CCR GLM was separately proven live after the install.
- Upstream v3.15.1 still contains `HYDRATION_TRACE_ID = "hydrate-trace"` and dynamic-workflow replay events timestamped at Unix epoch 0. The wrong-date trace display remains a local/upstream bug, not fixed by this release.

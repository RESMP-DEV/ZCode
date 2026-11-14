# Upstream v3.18.2 local Preview integration receipt

- Recorded: 2026-11-13 (America/Los_Angeles)
- Agent: ZCode (GLM-5.3, integration and acceptance)
- Upstream: `zai-org/ZCode` `origin/main` `fec975905a2abd4c07e35c40d51fa097a2258ec9` (v3.18.2; includes v3.18.0 `b95ebaff` and v3.18.1 `c5904686`; no tags past v3.17.2)
- Merge base: `a9fe401eede6e6e5e01be9048679c206fe6f02d9` (`v3.17.2`)
- Owned fork base: `resmp/main` `2be4cd42136df473af94ff47a156a441029ad549`
- Integration: merge commit `aa7a8a00`; alignment fixups `b253026d`
- Workspace: `.worktrees/upstream-v3.18.2`, branch `merge/upstream-v3.18.2`

## What changed

- 19 content conflicts (predicted exactly by `git merge-tree --write-tree` dry run; 0 modify/delete conflicts this time, vs 22 in v3.17.2) resolved semantically:
  - Dual automation identity preserved: `automationTurn: hasPositiveAutomationTurnIdentity(state)` + `currentTurnAutomationId: resolveCurrentTurnAutomationId(state)` (fork, positive-only authorization) alongside upstream's new `pluginDiscoveryUi` threading in `turn-tools.ts` and `streaming-tool-coordinator.ts`.
  - `batch-runner.ts`: kept fork's transparent options pass-through over upstream's field-by-field copy (upstream's only delta was adding `pluginDiscoveryUi` to the copy — the exact drift class the spread prevents).
  - `call-runner.ts` failure path: adopted upstream's rewritten error-result construction (`annotateUnsettledCall` + `modelNote` + `withHookAdditionalContexts`) and re-seated the fork's Z.AI tool-quota observation (`observeZaiToolQuotaExhaustion`) after it.
  - `host/index.ts`: kept fork's `dispatchCronRun`/`automationDispatch` architecture (v3.17.2 decision) over upstream's inline cron-run block; upstream's only semantic addition (`clientLanguage: resolveHostClientLanguage()` session-create telemetry) re-homed into the fork's `buildAutomationDispatchDeps` injection.
  - Settings split adoption: upstream v3.18 moved message-stream/interaction/model-io settings from `GeneralSectionContent` into a new `AgentBehaviorSectionContent` and REMOVED toolGrouping entirely (6 refs in base, 0 in v3.18.2 — an upstream feature removal, not fork-owned; followed upstream). The fork's workspaceAutoImport card stayed in General, upgraded with `searchId` and registered in `settingsSearchIndex.ts` (v3.18 types `searchId` against that catalog).
  - Unions: `.gitignore`, tsup targets (fork `automation-runner` + upstream `extension-host`), ready-marker whitelist, `architecture-policy.yaml` exceptions, tool exports (`session-sweep` + `plugin-discovery`), handler gating (independent `includeSessionSweep` / `includeTopicResource` ifs), `zcodeAgentService` imports, `schema.baseline.sql` (`archived_at` fork column + upstream `worktree_root`), `taskIndexRepo` (upstream `readWorktreePlacement` spread + fork title fallback), `project-sidebar/view.ts` (fork amber-dot fn + upstream comment reword), `validationAppSettings` migration chain (fork `migrateTaskAutoArchiveDefaults` + upstream `applyPersistedUiLocaleFields`; upstream's rejected `migrateTaskAutoArchiveReset` stays out per the standing fork decision).
- Migrations: upstream added only `0007_task_permanent_deletion` (`task_purge` table + triggers). Ledger union verified complete (every upstream id present + fork `0004_archived_clear_unread`, `0005_task_archived_at`, `0006_automation_system_scheduling`). No migration reads settings fields — the v3.16.2 projects-seeding trap does not recur.
- Alignment fixups (`b253026d`):
  - SessionSweep tool entries gained `shouldDefer: true` (v3.18 tool-search defers non-resident builtins).
  - `newTaskDraft.ts` admitted path-exact in architecture-policy (upstream file carrying a 4-line fork default-permission divergence; the moved changed-base made it "new" to the gate).
  - Three test files aligned to documented fork semantics. All three failures were proven pre-existing on `2be4cd42` by direct run (cron-tool: 3 failed on main, 1 after merge — upstream's v3.18 updates fixed two; main-tool-pool and runtime-tool-loop were inside main's 167-failure set). None were introduced by this merge.

## Verification (all under `mise` Node 24.14.0 / pnpm 10.33.2)

- `pnpm install --frozen-lockfile --prefer-offline`: exit 0.
- Root `pnpm typecheck`: exit 0.
- Root `pnpm lint`: 0 errors, 541 warnings (upstream-inherited baseline; v3.17.2 carried 86 — the warning growth came with upstream v3.18 code).
- `pnpm architecture:check -- --changed`: 0 violations (base merge-base origin/main).
- `pnpm test:architecture`: 61/61 pass.
- `pnpm db:schema:check`: 8 contract tests pass; project-storage and session-store baselines both compatible.
- Core CLI vitest full suite: **321 files / 5025 passed / 0 failed** (21 skipped), including the automation/cron/tool-search regression set.
- Bootstrap (`automation-port` + protocol): 37 + 18 passed. Contracts automation: 7 passed.
- `pnpm test:engineering-tools`: 45/45.
- `pnpm docs:stale-phrases:check`: clean across 2281 files.
- Targeted formatting: every file touched by this integration passes oxfmt (stdin-filepath mode); upstream-wide `fmt:check` remains a pre-existing baseline failure and was not rewritten.
- Desktop build + snapshot: see Installed snapshot below.

## Installed snapshot and data

- Snapshot: `~/.local/lib/alphaheng/zcode/packages/20261113-191814-b253026d-dirty/`
- Installed app: `/Applications/ZCode Preview.app`, `dev.zcode.app.preview`, version 3.18.2
- Manifest: gitSha `b253026d-dirty`, version 3.18.2, mainBinarySha256 `6c7bfa625e72ad31e564b262c916aa6a9d5b88f570dea195dec52255e9c6305d` — identical to v3.17.2's because it hashes the unchanged Electron 44.7.0 runtime executable; fork code ships in app.asar, and the asar sentinel check passed.
- Build: `mise exec -- scripts/build-and-link-zcode.sh` exit 0 (bundle 224.9 MiB, limit 500); static smoke `--no-launch`: identity, version, current-snapshot match, and app.asar plugin-sandbox sentinels all OK.
- Pre-relaunch SQLite backups: PENDING (to be taken before user-confirmed relaunch)
- Relaunch: ARMED, awaiting explicit user go (standing policy: never auto-restart ZCode Preview). The previous snapshot `20261018-090615-5501a199-dirty` was pruned by the installer; `20261105-170906-e3c25584` (v3.17.2) remains for rollback.

## Non-claims

- Desktop E2E and remote mobile paths not run; the private remote E2E queue was not probed.
- The 541 lint warnings and upstream-wide fmt:check baseline remain unresolved (inherited).
- Only static smoke performed on the snapshot; live model round trip not yet exercised (planned post-relaunch, per playbook).
- Dependabot alert counts not re-queried this cycle; the 588-alert finding from the v3.17.2 push stands as the last known state.

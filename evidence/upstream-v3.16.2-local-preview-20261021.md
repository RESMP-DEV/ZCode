# Upstream v3.16.2 local Preview integration receipt

- Recorded: 2026-10-21 (America/Los_Angeles)
- Agent: ZCode (GLM-5.3 main session + GLM-5.3-Flash fan-out: 3 analysis, 2 consolidation, 3 conflict-resolution, 3 debug)
- Upstream: `zai-org/ZCode` `origin/main` `3c5b2276` (`v3.16.2`, sync commits `0a1fc56d` 2026-10-19 + `3c5b2276` 2026-10-20)
- Merge base: `aac47556` (`v3.15.1`); local side `08a2ae12` (PRs #13–16 automation system scheduling)
- Local integration: merge commit on `main` (see below), pushed to `resmp/main`
- Installed application: `/Applications/ZCode Preview.app`, bundle `dev.zcode.app.preview` (snapshot filled below)

## What changed

### Merge (44 conflicted files, all resolved)
- Upstream replaced the renderer sidebar monolith with a host-authoritative `project-sidebar/` module (deleted `useWorkspaceTaskLists`, `workspaceTaskListDisplayGroups`, `taskStatusUnreadSync`, `SortableWorkspaceSidebar`, `WorkspaceSidebarItem`); our workspace-attention features were PORTED into the new module rather than dropped (see port list below).
- Upstream task-index persistence rewrite (presentation → `meta_json`, compact `updateTaskState`/`updateTaskPresentation`, CLI-facts authority) unioned with our feature methods: `applyAgentPatch`/`seedTaskMetaIfMissing`/`syncTaskMeta` family re-added after silent textual drops; archived-clears-unread + `archived_at` anchor invariants re-expressed on upstream's write model; `writeRecord` now lands CLI-fact baselines so fork-seeded rows stay visible to the new read model.
- Migrations: union ledger of 8 entries (ours 0004_archived_clear_unread / 0005_task_archived_at / 0006_automation_system_scheduling rewritten into upstream's `{id,touchedTables,checksumInput,apply}` shape on upstream's async `sqliteMigrations.migrate` runner); no id collisions; `schema.baseline.sql` regenerated via `pnpm db:schema:update` to admit `automation_config`.
- Product decision preserved against upstream's auto-archive retirement: our defaults stay enabled/3-days (`migrateTaskAutoArchiveDefaults` fill-missing-keys only); upstream's `taskAutoArchiveResetVersion`/`migrateTaskAutoArchiveReset` force-off path deliberately dropped (schema, protocol field, and dead condition in `settingService` removed).
- Automation dispatch keeps upstream's new `projectId`/`hostId`/`additionalDirectories` execution-scope fields (ported into `automationDispatch.ts`); CronDelete scoped self-cleanup identity chain (`currentTurnAutomationId` + `hasPositiveAutomationTurnIdentity`) preserved on the streaming path; batch-runner keeps our pass-through (forwards upstream's new `toolSearch` AND our identity fields).
- `AGENTS.md` merged: upstream's pre-push contract (lint + db:schema:check + test:architecture + architecture:check + affected unit tests) + our custom rows.

### Attention-feature port into `project-sidebar/` (all spec contracts preserved)
- `pendingInteraction` projected through the host tree (`project-repository.ts` readTasks + `contract.ts` ProjectTask).
- `projectHasPendingAction` selector (`view.ts`) + collapsed-row amber dot (`ProjectNodeContent.tsx`) on new semantic token `bg-icon-amber` (added to styles.css light/dark; satisfies upstream's design-token conformance test).
- Conversation-section `attentionIndicator` + digest button (`PurposeSections.tsx`, `TID_ATTENTION_DIGEST`), threaded `onCreateAttentionDigest` through AppProps → Root → ShellLayout → sidebar contract.
- Archived-unread renderer half in `useProjectUnreadSignals.ts` (`task_archived` clear branch + mark-unread refusal rollback).
- Settings auto-import UI re-applied (SettingsPage + settingsPageHelpers, local-host-pinned scan).

### Fixes found during integration
- `automationConfigRepo.initialize()` and 2 migration tests awaited the now-async migration runner (real runtime bug, not test-only).
- `automation-runner/registrar.ts` `process.resourcesPath` Electron-only property typed via local narrowing (pre-existing tsc failure masked since PR #13; pre-push never ran tsc).
- `cli/tests/automation-command.test.ts` re-registered under vitest 4 (node:test invisible).
- Stale upstream test expectations updated to fork semantics: shared `appSettings` defaults suite, `useDraftConfigControl` yolo-default, settingService reset-marker tests (no invariant weakened; each cites its spec).
- Test isolation: 4 task-index test files had been silently running against the REAL user DB (upstream changed the TaskIndexRepo constructor signature); 219 polluted `/tmp/ws-*` rows removed from `~/.zcode/v2/tasks-index.sqlite` (invariant `archived=1 ⇒ unread_at IS NULL` verified 0 violations after cleanup).

### Local consolidation (separate from the merge)
- Fast-forwarded local `main` to `resmp/main` (08a2ae12) before merging.
- Deleted merged local branches (feat/automation-system-scheduling-pr, fix/asar-repack-single-unpack-dir, fix/automation-runner-asar-repack, fix/pre-push-gate-baseline, feat/settings-diagnostics) + their `resmp/*` remotes (remote now: main + 2 recovery/* only).
- Removed worktrees: `~/ZCode-diagnostics` (uncommitted WIP preserved on new branch `wip/settings-diagnostics-dirty` @ 045de619, 20 files), `.worktrees/automation-system-scheduling` (content verified byte-identical to merged PR #13 chain), `.worktrees/automation-scheduling-pr` (detached at resmp/main tip).
- Kept: `fix/cron-self-cleanup-identity` + its worktree (genuinely unmerged CronDelete self-cleanup fix, PR candidate).

## Verification

- `pnpm typecheck`: exit 0 (node 24.11.1 via nvm).
- `pnpm lint`: exit 0, 0 errors (99 warnings, all pre-existing).
- `pnpm db:schema:check`: pass after baseline regen.
- `pnpm test:architecture` + `pnpm architecture:check --changed`: 0 violations.
- Full unit suites: `packages/services` 3284+ passed / 0 failed (re-run final numbers below); `packages/ui` ~9960 passed / 0 failed after fixes; `apps/zcode-cli` targeted suites green (automation-command 3, offpeak denylist, runtime-tool-allowlist 40).
- `scripts/build-and-link-zcode.sh` + `scripts/smoke-test-zcode-preview.sh`: filled below.

## Non-claims

- Desktop E2E (`pnpm test:e2e`) not run in this integration (pre-push contract covers lint/arch/schema/affected UT only).
- The `wip/settings-diagnostics-dirty` branch is preserved-but-unreviewed WIP; nothing about its quality is claimed.
- Upstream's `feat/ui-plugin` branch (662c30b, Sep 29) remains unchanged and already contained; no other upstream branches exist.
- Live in-app provider round-trip after relaunch pending user confirmation to restart Preview (armed, not executed).

## Final numbers (filled at completion)

- Merge commit: `940b3bce` (receipt `cfe8d620`, gitignore gate-fix follow-up) → `resmp/main` `c715cd03`; pre-push gate passed on push (lint + db:schema + architecture + affected-stage whole-suite policy skip).
- Final suites: `packages/services` 3428 passed / 0 failed / 1 skipped; `packages/ui` 9960 passed / 0 failed; `apps/zcode-cli` targeted (automation-command, offpeak denylist, runtime-tool-allowlist 40) green; `pnpm typecheck` exit 0; `pnpm lint` 0 errors.
- Snapshot: `~/.local/lib/alphaheng/zcode/packages/20261021-104135-c715cd03-dirty`, installed to `/Applications/ZCode Preview.app` (version 3.16.2, `dev.zcode.app.preview`), main-binary SHA-256 `51ea98f5b4ff5e5c079a6953a886a10999e5b355a76bcd92ff5dd59cb7167bd9`; `git merge-base --is-ancestor 940b3bce c715cd03` confirms the merge is contained in the snapshot sha. Smoke: identity/version/snapshot/plugin-sandbox sentinels OK; relaunched on the new snapshot 2026-10-21 (user go). The `-dirty` suffix is the uncommitted receipt edit at packaging time.

## Post-relaunch repair (2026-10-21, user-directed)

- Symptom: Projects section empty after first launch on v3.16.2. Root cause: upstream's one-time `0005_projects` bootstrap seeds the new `projects` registry ONLY from `settings.lastWorkspaceSession` (deliberately not from task history — upstream comment: resurrecting old task dirs recreates removed workspaces). Our fork never maintained `lastWorkspaceSession` (0 entries in `~/.zcode/v2/setting.json`; field dates from upstream 3.12 which we skipped), so the bootstrap ran with an empty seed and created 0 projects; the ledger row means it will never re-run.
- Repair (user instruction: not all historical workspaces — select by consistent GitHub activity): ranked RESMP-DEV repos by `pushedAt`, intersected with local task workspaces, backfilled 6 projects + roots + `tasks.project_id` mapping directly in `~/.zcode/v2/tasks-index.sqlite` (mirroring `migrateProjects` insert semantics; `workspace_key` = plain path for all six): ZCode(38 tasks), ccr-rust(6), exq(2), lapis(11), modelctl(3), codex(9). Conversation workspace `.zcode/workspace/default` (105 tasks) correctly stays out; Sept-and-older dirs excluded. DB backed up to `~/.zcode/v2/tasks-index.backup-20261021.sqlite` before the write.
- State integrity verified after relaunch: 958 CLI sessions, 235 tasks (217 archived/18 active, all with CLI facts), 6 automations, `automation_config.system_scheduling_mode=system`, migration ledger additive-only.
- FlashX finding: bundled 3.16.2 catalog (`config/provider/zcode-builtin.json` rev 33) lists coding-plan models `GLM-5.3`/`GLM-5.3-Flash` only — no FlashX; the picker's FlashX entry comes from `provider_config.json` `personalModelIds:["GLM-5.3-FlashX"]` (trial-era leftover) and the new picker's personal-models surfacing. Live entitlement unproven from CLI (no `--model` flag, no default-model config field, plan exposes no catalog API — `modelctl models` confirms); definitive test = user switches a session to FlashX and sends a message (429/1311 = still unentitled).


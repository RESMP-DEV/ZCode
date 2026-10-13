# Upstream v3.15.1 local Preview integration receipt

- Recorded: 2026-10-13 01:45 America/Los_Angeles
- Agent: Codex
- Upstream: `zai-org/ZCode` `aac4755666d09fdcd70272fcf063c077a639015f` (`v3.15.1`)
- Local integration head: `b6ed471bca23a67e1ddc290b5521828709fbd9c5`
- Installed application: `/Applications/ZCode Preview.app`, version 3.15.1, bundle `dev.zcode.app.preview`
- Snapshot: `~/.local/lib/alphaheng/zcode/packages/20261013-013922-af0ce9e4-dirty`
- Snapshot main-binary SHA-256: `51ea98f5b4ff5e5c079a6953a886a10999e5b355a76bcd92ff5dd59cb7167bd9`

## What changed

- Fetched upstream `v3.15.1` and integrated it in the isolated `.worktrees/upstream-v3.15.1` worktree.
- Preserved the local session sweeper, workspace attention/auto-import, archived-unread, and scheduled-automation self-cleanup contracts that conflicted with the upstream release squash.
- Built and installed the Preview-identity desktop bundle, then relaunched the app rather than reusing processes loaded from 3.14.3.

## Verification

- `pnpm install --frozen-lockfile --prefer-offline`: pass.
- `pnpm typecheck` with Node 24.11.1: pass.
- `pnpm lint`: exit 0; upstream retained 62 warnings, zero errors.
- `pnpm --filter @zcode/contracts build`: pass.
- Focused adapters tests (`official-coding-plan-gateway`, `provider-endpoint-routing-fetch`, `model-execution`): 44/44 pass.
- `pnpm architecture:check --changed`: pass, 0 violations.
- `scripts/build-and-link-zcode.sh`: build, install, snapshot, and Preview smoke check pass.
- Live in-app GLM-5.3 request after relaunch: request `b3854a2b-144b-4711-8b5b-cd8ea1cceb4d`, response `msg_202610131641455ef25fb7069f42ae`, text `OK`, 7.33 s.

## Non-claims

- The installed snapshot label is `af0ce9e4-dirty`; the final contract-restoration commit `b6ed471b` was committed immediately after packaging from that dirty working tree.
- The old scheduled task retained a pre-upgrade failure in its transcript. It was not replayed after upgrade; a new clean task proved the live provider path. Its next scheduled execution is the remaining end-to-end confirmation for that specific task.
- The local branch had not been pushed to `resmp/main` when this receipt was recorded.

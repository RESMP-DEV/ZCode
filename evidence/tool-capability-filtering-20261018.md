# Host tool capability filtering receipt — 2026-10-18

## Change

Commit `0637c0bf` adds trusted, machine-readable `hostToolCapabilities` to legacy create/resume and V4 create, propagates them into child runtimes and branch refresh, and filters `ToolEntry.requiredCapabilities` before built-in registration. SessionSweep tools require `session-sweep`; explicit agent `tools:` allowlists cannot resurrect them on a host that did not declare the capability.

The protocol port is now injected only when the same capability is declared. Handler port checks remain as defense in depth. The mechanism is generic: replacement tools can declare their own stable capability key instead of reusing SessionSweep's name-specific gate.

## Validation

- `pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts` — PASS, 75 tests
- `pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/runtime-tool-allowlist.test.ts` — PASS, 29 tests
- `pnpm exec vitest run packages/services/test/zcodeAgentService.dynamicWorkflowPolicy.test.ts` — PASS, 26 tests
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS with 61 pre-existing warnings and 0 errors
- `pnpm architecture:check -- --changed` — PASS, 0 violations

## Non-claims

- No production ZCode.app relaunch or live six-hour scheduled sweep was performed.
- A host that falsely declares `session-sweep` without implementing `sessionSweep/*` can still fail at execution; this repair trusts only the same Host service that registers the protocol handlers.
- The branch is local because it sits atop eleven unpublished v3.15.1 integration commits; pushing it against `resmp/main` would mix unrelated integration work into the PR.

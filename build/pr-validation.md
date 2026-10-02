# PR9 repair validation at e36c8ce

- `bash -n scripts/build-and-link-zcode.sh` — pass.
- `shellcheck scripts/build-and-link-zcode.sh scripts/consolidate-branches.sh` — pass.
- Three-snapshot `--list` — descending names all printed, exit 0.
- `--keep-snapshots` gates — 3/0/18 accepted; 18446744073709551616, 18446744073709551615, -1, 007 rejected with exit 1.
- End-to-end fake-bundle snapshot/install/prune with keep 2 — app discovered and installed; pointers flipped after verification; only unprotected old snapshots pruned; current and actual previous-good targets retained.
- Rollback — installed checksum matched selected snapshot; pointers exchanged.
- Install identity guards — production bundle refused and retained; unreadable identity refused and retained; pointers unchanged.
- `pnpm --dir packages/services exec tsx --test test/sessionSweep.test.ts test/taskIndexArchivedUnread.test.ts` — 9/9 pass.
- `pnpm --dir packages/ui exec tsx --test test/taskStatusUnreadSync.test.ts` — 4/4 pass.
- `../../node_modules/.bin/turbo run typecheck` from apps/zcode-cli — 27/27 pass.
- `pnpm lint` — 0 errors, 70 pre-existing warnings.
- `pnpm architecture:check -- --changed` — 0 violations.
- `pnpm --dir apps/zcode-cli registry:check` — pass.
- `git merge-tree --write-tree resmp/main HEAD` — predicted post-merge tree equals validated HEAD tree.

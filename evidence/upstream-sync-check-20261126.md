# Upstream sync check receipt, 2026-11-26

- Recorded: 2026-11-26 (America/Los_Angeles)
- Agent: ZCode (GLM-5.4, coordination and acceptance); five read-only Flash sub-agents (GitHub surfaces, distribution feeds, server model catalog, plugin marketplace, marketplace refresh mechanics)
- Question: after the v4.0.0 / GLM-5.4 integration (`evidence/upstream-v4.0.0-local-preview-20261122.md`), is there anything upstream left to bring into the fork?
- Answer: no. Source, release and distribution surfaces are all at or behind the integrated commit. The only upstream content behind locally is the official plugin marketplace index, which is trigger-refreshed and has not been refreshed since 2026-10-17.
- Fork state: `main` `477572d5` == `resmp/main` (both fetched today); `node scripts/check-workspace-freshness.mjs` reports ahead 162 / behind 0 against `origin/main`.
- Nothing was changed by this check: no merge, no code edit, no plugin, catalog or config state modified.

## Source and release surfaces

| surface | newest item | newer than `a4b44451` (v4.0.0)? |
| --- | --- | --- |
| `origin/main` (zai-org/ZCode) | `a4b44451` "chore: sync ZCode source v4.0.0" | no; `git log HEAD..origin/main` is empty, merge-base is `a4b44451` |
| tags | `v4.0.0` -> `a4b44451` (new since the integration fetch) | no; same commit |
| GitHub releases | `v4.0.0`, published 2026-11-23T08:14:37Z, not draft, not prerelease, 7 assets, target `a4b44451` | no; same commit |
| branches | `main` + `feat/ui-plugin` (`662c30be`, 2026-09-29) | no; diverged ahead 1 / behind 9, already contained in our `main` |
| pull requests (all states) | 0 | n/a |
| raw refs (`git ls-remote origin`) | `HEAD`, 2 heads, tags through `v4.0.0` | no |

## Official distribution feeds

- Desktop update manifest `https://zcode.z.ai/api/v1/releases/electron/manifest?platform=darwin-aarch64&channel=1` (stable) and `channel=3` (preview): both `version: 4.0.0`, `releaseDate: "2026-11-22T11:43:52.709Z"`. Windows and Linux stable feeds also advertise 4.0.0 (sub-agent probe).
- Source-server descriptor `https://cdn-zcode.z.ai/zcode/electron/releases/4.0.0/source-server-release.json`: 4.0.0.
- The CLI has no install or version endpoint in the repository; its download root is operator-supplied (`ZCODE_DIST_BASE_URL`, `scripts/build-zcode.mjs:17`).

## Installed build

- `/Applications/ZCode Preview.app` is 4.0.0 from snapshot `20261122-233637-83d2450c`; `git merge-base --is-ancestor origin/main 83d2450c` holds, so the running build contains everything upstream `main` has.
- Snapshot commit to `main` differs by one evidence file only. Installed `app.asar` and the snapshot's `app.asar` match in size and mtime (389,019,048 bytes, 2026-11-22 23:35:09). Main process PID 47512 started 2026-11-23 01:04:03.

## Server model catalog versus local

- Fetch path: `GET https://zcode.z.ai/api/v1/client/configs?app_version=4.0.0&platform=darwin-aarch64` (anonymous, `code: 0`) returns `builtin_provider_config_json` = `https://cdn-zcode.z.ai/zcode/config/zcode-builtin-production-4135.json` (`packages/provider-node/src/zcode-builtin-download.ts:74-87`).
- Server: revision 48. Rule `.*glm-5\.3.*` has `supportsImage: false`, `.*glm-5\.3-flash.*` has `true`. `GLM-5.4` is listed in `builtinModelIds` and enabled for `zai-api` / `bigmodel-api`; no rule in any rule group references `glm-5\.4`, so no capability value applies to GLM-5.4.
- Local 4.0.0 Active copy (`~/.zcode/v2/runtime/provider/darwin-aarch64/4.0.0/endpoint-78d7c3bef4024722642626fe3669a799/zcode-builtin.json`): revision 49, `.*glm-5\.3.*` `supportsImage: true` (the manual flip, intact). Its `.bak-rev48-pre-vision-flip` backup carries the same content as the server file.
- Refresh control (`zcode-builtin-refresh.json`): `failureCount: 0`, last download 1795725792158, next eligible 1795727592137, a 30 minute interval. The running app treats the server copy as stale and keeps the local one.
- **Equal-revision trap (new, from `packages/provider-node/src/zcode-builtin-provider-config-source.ts:74-83`)**: a server release with a lower revision is ignored, an equal revision with identical content is "unchanged", a higher revision overwrites the Active copy, and an equal revision with different content throws `ZCode Built-in 相同 revision <n> 对应不同内容`. Our edited copy is labeled 49, so the next server publish, if numbered 49, will be rejected with that error on every refresh cycle (warn `ZCode Built-in Config 远端刷新失败`, `packages/services/src/node.ts:1700`, with exponential backoff) instead of applied. Recovery at that point: restore the `.bak-rev48-pre-vision-flip` copy so the server's 49 applies as an update. The 3.18.2 runtime directory (local 48 with the flip, server 48 without) is already in that state; it only matters if the 3.18.2 snapshot is run.
- Transient refresh failures in `~/.zcode/v2/logs`: `远端刷新失败` per day, Nov 23: 1, Nov 24: 4, Nov 25: 5, Nov 26: 1 (as of 13:12); Nov 10 to 22: 5 in total. The clusters clear by themselves and are not the equal-revision signature.

## Official plugin marketplace

- Local record (`~/.zcode/cli/plugins/known_marketplaces.json`, `zcode-plugins-official`): `lastUpdated: 2026-10-17T20:48:29.195Z`, no `lastRefreshFailure`. `cdn-marketplace.json` has the same mtime and 46 plugins.
- Live index `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json` (`packages/shared/src/plugin-marketplaces.ts:44`): 58 plugins plus `unlistedPlugins: [openpencil]`. Delta since the local shard: 15 added, 17 updated, removed `video2code` and `zcode-context`, `openpencil` unlisted.
- Installed-plugin impact: `github` is the only installed official plugin with a newer version (cached 0.1.2, advertised 0.1.4). Bundled (seed) plugins match the app bundle.
- Why stale: refresh is trigger-driven only. Triggers are a Plugin Store page mount behind a 10 minute gate (`packages/ui/src/settings/officialMarketplaceAutoRefresh.ts:15`, `packages/ui/src/settings/PluginStorePage.tsx:196-201`), the manual check-for-updates button, `zcode plugin marketplace update`, and install or discovery flows. App startup re-seeds only the bundled partition and never fetches the CDN. No trigger has fired since 2026-10-17; the endpoint answered a fresh fetch today. Verdict: stale by design, not a failing refresh.
- Not refreshed by this check (it changes local state); opening the Plugin Store page once is sufficient.
- Aside, outside ZCode upstream: in the `claude-plugins-official` cache, `chrome-devtools-mcp` 1.5.0, `coderabbit` 1.1.1 and `superpowers` 6.1.1 sit behind the git SHAs that marketplace now advertises (it publishes no versions for them).

## Verification method

- Parent replayed: `git fetch origin --tags`, `HEAD..origin/main`, `gh api` for `commits/main`, `releases/latest`, `pulls?state=all` and `branches`, both darwin update manifests, the configs hop plus catalog revision and rules, the three local catalogs and the refresh control file, the `known_marketplaces.json` record, the index delta, and the store auto-refresh gate.
- Sub-agent only (not replayed): Windows and Linux feeds, the source-server descriptor, CLI endpoint absence, the log survey for plugin RPCs.

## Non-claims

- The official `/Applications/ZCode.app` was not inspected.
- The cause of the transient catalog refresh failures is not diagnosed; the log serializes the error as `{}`.
- A CLI build published outside the repository would not be visible from this check.
- `claude-plugins-official` freshness is compared by advertised SHA only.

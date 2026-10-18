# Z.AI Web 工具额度闩锁 — 工作凭证（2026-10-18）

- **做了什么**：新增 specs/zai-web-tool-quota-gate.md 与实现——观察到 Z.AI 工具额度耗尽
  （HTTP 429 + 业务码 1310，或官方 MCP `quota_exceeded`）后，把 `WebSearch` / `WebFetch` /
  `mcp__web_reader__*` 三个计费 Web 工具从 provider 可见 schema 移除，6h TTL 自动恢复。
- **执行者**：ZCode（GLM-5.3，主会话代理），用户指令 2026-10-18。
- **动机（实测）**：Coding Plan 月度工具额度耗尽（webReader 实测
  `MCP error -429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your
  limit will reset at 2026-10-29 11:26:14"}}`）；三个工具继续留在 schema 只会浪费回合。
  指令层（~/AGENTS.md 同日已改走 Exa/Jina）是第一道防线，本实现是 schema 级第二道。
- **改动**：
  - `apps/zcode-cli/packages/core/src/tool/zai-web-tool-quota-gate.ts`（新）：进程内单例
    门 + 签名识别（`"code":"1310"` 字符串/数字、`quota_exceeded`）+ modelContent 文本提取。
  - `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`：`getTools` 在 model 在场
    且门闩上时过滤三个工具；枚举调用（model 缺席）不过滤，与 `shouldExposeWebSearch`
    同约定。对旧会话追溯生效：过滤发生在每次请求装配，不依赖会话重建。
  - `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`：两条完成路径的观察
    钩子——失败收口（thrown error）与成功收口（仅计费 Web 工具名的 result 内容；官方
    MCP 配额 429 以正常 tool result 返回、不抛异常，实测 webReader 即如此）。
  - `apps/zcode-cli/packages/core/tests/zai-web-tool-gate.test.ts`（新）：11 测试。
- **验证（命令 + 结果）**：
  - `npx vitest run tests/zai-web-tool-gate.test.ts` → 11 passed。
  - 回归：`tests/websearch.test.ts`(14) + `tests/runtime-tool-allowlist.test.ts`(29) +
    `tests/tool-executor-{error,trace,resolve-input}.test.ts`(63) → 全 passed。
  - 仓库根 `pnpm typecheck` → exit 0。
  - 仓库根 `pnpm lint` → exit 0（61 条既有 warning，0 error；core 包内 `oxlint src` 的
    29 条 max-lines 为存量，call-runner.ts 在本次改动前已 737 行超限）。
  - `pnpm architecture:check --changed` → violations 0。
  - 完整 core 套件结果见本文件底部追加记录。
- **Non-claims**：
  - 不预检额度：每个 Host 进程在每个耗尽窗口的第一发 429 仍会发生一次后闩上。
  - 不跨进程持久化：应用重启后第一发失败重新闩上。
  - 原生 WebSearch 若以流级错误（非 tool 执行路径）失败不闩锁；同窗口内任意
    webReader/WebFetch 失败会补闩。
  - 未验证桌面端 E2E（改动位于 CLI core 请求装配路径，单测覆盖 getTools 三态）。

## 完整 core 套件结果

- `npx vitest run tests`（全量）：3904 passed / 37 skipped / **9 failed**。
- 9 个失败为**存量**：stash 本次改动后在 HEAD 上重跑同一批文件，仍为同样 9 个失败
  （io-boundary 的 adapters mcp network.ts 出网、main-tool-pool 的 CronDelete 曝光、
  tool-contracts 的 ReplyToChannel.outputSchema anyOf、message-persistence-anchor、
  runtime-module-boundary、runtime-unbound-resume、runtime-trace、subagent-background、
  runtime-compact）。本次改动未新增任何失败，也未修复存量失败。

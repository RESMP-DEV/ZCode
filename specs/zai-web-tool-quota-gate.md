# Z.AI 计费 Web 工具的额度闩锁（quota gate）

## 背景与目标

Coding Plan 的工具调用额度（官方 Server MCP 与原生 web 工具共用同一计量）耗尽时，服务端对
`WebSearch` / `WebFetch` / 官方 `web_reader` MCP 一律回 HTTP 429 + 业务码 1310。实测
2026-10-18：`MCP error -429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted.
Your limit will reset at 2026-10-29 11:26:14"}}`。继续把这三个工具留在 schema 里只会诱导
模型浪费回合。全局指令层（`~/AGENTS.md`）已要求改走 Exa / Jina；本 spec 定义运行时的第二道
防线：**观察到额度耗尽后，把它们从 provider 可见的工具 schema 中移除，TTL 过期自动恢复**。

## 行为

- 门状态是 core 进程内单例（`apps/zcode-cli/packages/core/src/tool/zai-web-tool-quota-gate.ts`），
  同一 Host 进程内所有 runtime（主会话、子代理、workflow actor）共享；不落盘、不跨进程。
- 观察：`observeZaiToolQuotaExhaustion(text)` 识别两种签名——Z.AI 业务信封 `"code":"1310"`
  （字符串或数字形态）与官方 MCP 结构化 `quota_exceeded`（`packages/shared/src/official-mcp-tool-error.ts`）。
  命中且当前未闩上时，把 blockedUntil 设为 now + 6h；已闩上时忽略新证据（避免反复失败无限续期）。
- 观察点在 `tool/executor/call-runner.ts` 的两条完成路径，覆盖全部三种工具：
  1. 失败收口（thrown error → `result.error.message` 与 baseModelContent）；
  2. 成功收口（仅对 ZAI 计费 Web 工具名的 modelContent 文本——官方 MCP 的配额错误以
     **正常 tool result 内容**形态返回、不抛异常，实测 webReader 的 429 即如此）。
- 生效：`runtime/methods/config.ts` 的 `getTools` 在 model 在场（真实请求装配）且门闩上时
  过滤 `WebSearch` / `WebFetch` / `mcp__web_reader__*`。model 缺席的枚举调用（持久化与
  UI 元数据）不过滤，与既有 `shouldExposeWebSearch` 的「无 model 即完整注册表」约定一致。
- 恢复：固定 6h TTL，**不**解析 "will reset at" 文案——该时间串的时区语义不在任何契约内，
  解析错误会把工具锁死到错误时间点。TTL 过期后若额度仍耗尽，下一次失败调用重新闩上；
  代价是每个耗尽窗口、每个 Host 进程至多一次失败调用。

## 所有权与不变量

- 门只影响 provider 可见性（getTools 过滤），不注销工具、不改注册表、不动权限分类：
  注册表与 UI 元数据保持完整。
- 闩锁是进程级观察事实，不是配置：不提供用户开关，不做跨 provider 区分（1310 只会在
  Z.AI 计费调用上出现，闩锁有 TTL 上界，误伤面有限且有界）。
- 子代理 explore 工具白名单里的 `WebFetch` / `WebSearch` 名可以保留：曝光过滤发生在
  getTools，全部 runtime 共用同一过滤路径，无需在各档位重复实现。

## 验收

```bash
cd apps/zcode-cli/packages/core && pnpm vitest run tests/zai-web-tool-gate.test.ts tests/runtime-tool-allowlist.test.ts tests/websearch.test.ts
pnpm typecheck && pnpm lint
```

- 单测覆盖：两种签名的识别（含实测信封原文）、无关错误文本不闩、TTL 过期、
  getTools 闩上隐藏 / 未闩可见 / 枚举调用不过滤、webReader 以 `mcp__web_reader__` 前缀匹配。

## Non-claims

- 不预检额度（不做 proactive quota API 调用）：每个 Host 进程在每个耗尽窗口内的第一发
  429 仍会发生一次，随后闩上。
- 不跨进程持久化：应用或 Host 重启后，第一发失败调用重新闩上。
- 三个工具共用一个门：任一工具的 1310 失败会把三个一起隐藏；额度是同一账户级计量，这是
  期望行为而非误伤。

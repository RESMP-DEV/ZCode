# 集成上游 feat/ui-plugin：UI Plugins（MCP Apps）与 Gen UI

状态：已实施（2026-10-06，待验证与评审）。来源：上游 `zai-org/ZCode` 分支 `origin/feat/ui-plugin`，单提交 `662c30b`（"feat: add UI plugins and Gen UI"），基点 `29628c9`（v3.14.3），与本地 `main` 同基。本 spec 记录集成的范围、fork 侧不变量、冲突裁决与验收；功能本体行为以上游代码与其 `CONTRACT.md`（8 份，分布在 pluginSandbox / mcp-ui / mcp-apps / gen-ui / plugin-ui-bridge / plugin-ui）为准，不在此重复。

## 集成范围

- UI Plugins（MCP Apps）：插件工具结果以 `_meta.ui.resourceUri` 声明交互 HTML 页面，经 Main 进程 `pluginSandbox`（`zcode-sandbox://`、CSP `default-src 'none'`、permission gate、64 实例上限）在会话内联或侧栏渲染；页面可 `callServerTool` / `updateModelContext` / `sendMessage` / `registerTool` / `createSamplingMessage` / 订阅 MCP resources。
- Gen UI：agent 按问题生成 HTML 写入 executor 拥有的输出目录（`ZCODE_GEN_UI_OUTPUT_ROOT`，工作区外），以 `::visualize{...}` / JSON 标记引用，渲染为带 Tweak 控件与 widgetState（≤16 KiB）的内联页面。
- MCP elicitation、sampling（并发 1/4/8、60s 截止）、工具进度条展示。
- 官方 `visualize` 插件（vendored d3/lucide/floating-ui，SHA-256 清单锁定）默认启用。
- 平台门控：能力以 `platform.pluginSandbox` 判定，仅 Desktop；web/移动端回退普通工具卡片。

## Fork 侧不变量（合并必须保全）

1. session-sweep 链路端到端完整：`server-operations.ts` 装配 `createProtocolSessionSweepPort` → `ZCodeAppOptions.sessionSweepPort` → runtime deps → tool handlers（plan/execute/setPinned）。上游重构 `call-runner.ts`（权限/钩子/校验拆分为 `permission-flow.ts` / `hook-flow.ts` / `validation.ts`）后，`sessionSweepPort` 必须重新进入 `ToolExecutionContext` 的 deps 拷贝。
2. automation 回合权限围栏：`resolveToolPermission` 必须携带 `{automationTurn, currentTurnAutomationId}` 回合作用域（`ToolApprovalTurnScope`），否则 CronDelete 自清理准入退化、scheduled run 无 responder 时走错语义。
3. 生命周期并置：`disposeHostResourcesBestEffort` 同时调用 `stopTaskAutoArchiveSweep()`（ours）与 `pluginSandboxRegistrationBridge.dispose()`（theirs），二者都不可丢。
4. app-tool 授权路径（`authorizeAppTool` → `resolveToolPermission`）以 `turnScope === undefined` 走 positive-identity + deny 语义；需确认该路径不会在 automation 回合下运行（否则 deny 语义错位）。

## 冲突裁决记录

- 文本冲突 4 个文件（merge-tree 预演）：`bootstrap/src/app/types.ts`、`core/tool/executor/types.ts`、`core/tool/types.ts` 仅 import 块并集，正文两侧保留；`core/tool/executor/call-runner.ts` 采用上游新结构，手工移植 ours 三处（turnScope 传参入 `permission-flow.ts::resolveToolPermission` 并透传至 `resolveToolApproval`；context build 补 `currentTurnAutomationId`；deps 拷贝补 `sessionSweepPort`）。
- 其余 422 文件自动合并；无 delete/modify、无 add/add。
- 构建：新增 tsup 目标 `plugin-sandbox-alias`、preload 入口、`gen-ui-runtime-assets.mjs`（tsup onSuccess 校验 vendor 清单）；`architecture-policy.yaml` 上游已注册全部 8 个新模块，本地无冲突。

## 验收

1. `pnpm install` 后 `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 全绿。
2. 既有测试全绿：ui / services / cli-core（含 sessionSweep、attention、taskIndex、single-$ math）。
3. 上游新增测试全绿：executor / mcp-ui / plugin-ui / gen-ui / pluginSandbox 各 vitest 套件。
4. 活体验证：`node packages/desktop/scripts/gen-ui-e2e.mjs` 与 `node packages/desktop/scripts/mcp-apps-host-e2e.mjs` 通过。
5. 不变量 1–4 逐条核查（见提交内审计注释与 PR 描述）。
6. Preview 冒烟（快照重建后）覆盖 `out/plugin-sandbox/*` 产物存在性。

## 非声明（non-claims）

- sampling 结果展示上游即未完成（内容与进度 pending），集成不修。
- web/mobile 回退路径仅静态确认（`useGenUi` 以 `platform` 判空），未做实机验证。
- `mcp-apps/CONTRACT.md` 仍写 partition v1（代码实为 v2）为上游文档陈旧，不在本次修正。
- `patches/@open-pencil__core@0.14.0.patch` 为上游孤儿补丁（未挂 `patchedDependencies`），保留原样，另行反馈上游。

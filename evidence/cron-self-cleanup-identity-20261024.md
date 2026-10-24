# cron 自清理身份修复重放 — 工作凭证（2026-10-24）

- **执行者**：CCR worker（ZCode 仓库重放任务），分支
  `consolidation/cron-self-cleanup-20261024`，worktree
  `/Users/kearm/ZCode/.worktrees/branch-consolidation-cron-identity`。
- **动机**：把 `fix/cron-self-cleanup-identity` 的两个专题提交重放到 owned 基线
  `resmp/main` = `34c615b7`，不引入源分支继承历史。

## 重放结果

| 新 SHA | 原 SHA | 主题 |
|---|---|---|
| `6b325c10` | `6a965988` | fix(harness): derive currentTurnAutomationId from automation-prefixed queryId |
| `2728896c` | `4f72394b` | fix(protocol): pass resolved automationId into legacy session/send admission |
| `6dd86016` | —（本次新增） | test: register cron self-cleanup suite under vitest 4 |

- 父链：`34c615b7` → `6b325c10` → `2728896c` → `6dd86016`；作者与提交信息沿用源提交，
  提交者时间记为本次重放时间。
- **提交对象落在 `build/ccr-cron-identity-git`**（本 worktree 内、被 `/build/` 忽略的
  临时 git 仓库，`objects/info/alternates` 指向主仓库对象库）。原因：本会话沙箱对
  `/Users/kearm/ZCode/.git/**` 只读，`git cherry-pick` 无法写 `index.lock`。父代理合并时：
  ```bash
  git -C /Users/kearm/ZCode fetch \
    /Users/kearm/ZCode/.worktrees/branch-consolidation-cron-identity/build/ccr-cron-identity-git \
    consolidation/cron-self-cleanup-20261024
  # 之后把分支 fast-forward 到 6dd86016（或按需 rebase）
  ```
- 工作树内容与 `6dd86016` 完全一致（5 个文件逐字节 `cmp` 相同）。
- 重放保真：`git diff 34c615b7 2728896c` 与源分支 `git diff 739d13c7 4f72394b`
  的增删行集合逐行相同（各 115 行，`diff` 输出为空）。
- `6a965988` 在 `streaming-tool-coordinator.ts`、`turn-tools.ts` 上因上游 v3.16.2 同步
  产生上下文漂移（import 顺序、`toolSearch` 字段），按语义人工落位：导入
  `resolveCurrentTurnAutomationId`，两处执行边界
  `currentTurnAutomationId: state.automationId` → `resolveCurrentTurnAutomationId(state)`。

## 为什么多出第三个提交

`apps/zcode-cli/packages/core/test/cron-self-cleanup.test.ts` 原本
`import test from "node:test"`。vitest 4 不再注册 node:test 套件，该文件在 vitest 下收集
0 个测试并以 `No test suite found` 报错（`9c9ad87e` 已对根 workspace 的 11 个同类文件
做过同样转换）。本次重放带入的 5 个回归用例必须注册后才会真正执行，故按仓库既有做法
单列一个测试注册提交；改动只有这一行 import。

## 测试取证

| 命令 | 退出码 | 结果 |
|---|---|---|
| `node scripts/check-workspace-freshness.mjs --no-fetch` | 0 | 基线新鲜，与 resmp/main 同步 |
| `apps/zcode-cli` `vitest run packages/core/test/cron-self-cleanup.test.ts`（重放后） | 1 | `No test suite found`：node:test 套件未注册 |
| 同上（`6dd86016` 注册后） | 0 | 1 文件 12 用例全过 |
| `apps/zcode-cli` `vitest run` 5 个聚焦 cron/protocol 测试文件（最终态） | 0 | 5 文件 166 用例全过 |
| `apps/zcode-cli/packages/core` `oxlint`（3 个改动文件） | 0 | 无错误 |
| `apps/zcode-cli/packages/bootstrap` `oxlint src/zcode-protocol/server-operations.ts` | 0 | 0 错误；2 条 unused-import 警告为基线已有（110/112 行，基线可复现） |
| 根 `oxlint`（`pnpm run lint`） | 0 | 6718 文件，99 警告 0 错误 |
| `node --test scripts/test/architecture-*.test.mjs scripts/test/source-size-policy.test.mjs`（`pnpm run test:architecture`） | 0 | 36 用例全过 |
| `node scripts/architecture/architecture-check.mjs check --changed` | 0 | violations 0 / new 0 |
| `node scripts/run-affected-unit-tests.mjs --scope worktree` | 0 | 选中 0/2063：根 vitest 配置不含 `apps/**`，结构上看不到本次改动 |
| `node scripts/run-affected-unit-tests.mjs --scope push` | 2 | 脏工作区拒绝执行（`Push 工作区不干净`，基线语义，非测试失败） |
| `apps/zcode-cli/packages/core` `vitest run tests`（改动后） | 1 | 12 文件失败、4 用例失败、4128 通过、21 跳过 |
| 同上，4 个 core 改动文件临时换回基线后跑 `tests/cron-tool.test.ts` + `tests/main-tool-pool.test.ts` | 1 | 2 failed / 18 passed，与改动后同型 → **基线存量失败** |
| `apps/zcode-cli/packages/bootstrap` `vitest run tests`（改动后） | 1 | 36 文件失败、182 用例失败、2852 通过、15 跳过 |
| 同上，`server-operations.ts` 换回基线后重跑全量 | 1 | **同样** 36/182/2852/15 → 全部为基线存量失败 |

存量失败集中在 `fake-provider-server`、`workflow-fault-matrix.*`（需要
`ZCODE_FAULT_MATRIX=full` 与 provider 基建）、SQLite 冷恢复/迁移，以及其余
node:test 套件在 vitest 4 下的断签文件；与本次改动的 cron 身份解析、legacy
session/send admission 无关。

## 非声明（non-claims）

- 不证明 cron 自清理在真实生产派发链路上已修复，只证明单元与协议层用例通过。
- 根 `pnpm verify:pre-push` 未整体跑完：末段 `--scope push` 因工作区脏拒绝执行
  （重放的提交对象在 worktree 内，`HEAD` 未前进），其余步骤已逐条单跑并记录退出码。
- `apps/zcode-cli/packages/{core,bootstrap}` 的 `tsc --noEmit` 未取得结果：执行器单次
  调用约 10 秒上限，后台进程随调用结束被回收，命令被截断。
- `apps/zcode-cli/packages/core/test/cron-self-cleanup.test.ts` 在基线上就有 2 处
  oxfmt 偏差（`makeContext` 签名、长行 `deny(...)`），源分支与本次重放保持一致，
  未额外改格式；该文件格式状态相对基线无回归。
- 本会话为跑测试临时建了被 `.gitignore` 覆盖的 `node_modules/`（真实目录 + 指向
  主 checkout `node_modules` 的符号链接）与 `.vite*` 缓存目录；均为忽略路径，不影响
  `git status`。

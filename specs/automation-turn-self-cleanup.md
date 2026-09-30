# Automation 执行轮的自清理（scoped CronDelete）

## 行为

定时 automation 执行轮（cron dispatch turn）可以在本轮内调用 `CronDelete` 删除**触发本轮的那一个 automation**，作为任务永久完成后的内置自清理路径（例如 pr-loop 驱动的 PR 已合并、监听已无意义）。删除其他 automation 依旧被拒绝；`CronCreate` / `CronUpdate` 在执行轮依旧不可见，防止递归修改任务定义。

## 状态所有者

- automation 定义与生命周期归 `automationService` / `automationRepo`（不变）。
- 「本轮是哪个 automation 派发的」这一事实由 host admission 拥有（`StartPromptTurnParams.automationId` → `RegularTurnLoopState.automationId`），只认本轮显式身份，不从持久 task metadata 推断；本变更仅把该身份沿 `ExecuteToolsOptions → ToolExecuteOptions → ToolExecutionContext.currentTurnAutomationId` 投影到工具执行边界。

## 边界（三层）

1. **可见性**：执行轮的 turn-scoped denylist 只合并 `CronCreate` / `CronUpdate`；`CronList`（只读）与 `CronDelete`（受限）保持可见。可见性判定（`isAutomationMutationRestrictedTurn`）保留 denylist 兜底信号——兜底误伤只是继续隐藏本就禁用的工具，不改变权限语义。
2. **执行边界最终校验**：`CronDelete` handler 在 `automationTurn === true` 时要求 `input.id === currentTurnAutomationId`，否则 `PermissionDenied`；身份缺失（无 automationId）时保守拒绝（fail closed）。执行边界的 `automationTurn` 标志只认正向身份（`hasPositiveAutomationTurnIdentity`：显式 `automationId` 或 `automation-` 前缀 queryId），**不使用 denylist 兜底**——普通交互轮也可能恰好同时禁用 `CronCreate` + `CronUpdate`，兜底会把这类 turn 误判为执行轮并拒绝其全部 `CronDelete`。
   2a. **审批收窄与直接否决**：CronDelete 默认 `ask`；定时执行轮没有权限响应者，且 `permissionTimeoutMs` 默认未设，无人应答的 ask 会把工具调用（进而整轮）永久挂起。`prepareApproval` 钩子收到 turn 范围事实（`automationTurn` + `currentTurnAutomationId`）后分流：「确为 automation 轮且 `input.id === currentTurnAutomationId`」→ ask 收窄为 proceed（自清理）；执行轮内其余情形（其他 id、身份缺失、输入不合法）→ 直接 deny 并附原因，调用即刻得到带原因的 `PermissionDenied` 结果。deny 规则与 PreToolUse hook 在更早边界评估，`allow` 判定不受钩子影响（钩子只在 ask 分支内运行）；交互轮保持 ask 走人工审批；handler 内 `assertCronDeleteAllowed` 独立复核同一身份（纵深防御）。
3. **自识别**：`CronList` 输出为匹配 `currentTurnAutomationId` 的条目附加 `isCurrentTurnAutomation: true`（仅 CronList 投影，additive optional 字段），让执行轮无需标题匹配即可找到自己。身份缺失的执行轮（`automation-` 前缀 queryId 兜底但无显式 `automationId`）**不会标记任何条目**；模型指引明确要求此时停止自清理而不是猜测 id（乱猜的删除会被 2a 的 deny 即刻拒绝）。

## 事件顺序与幂等

- 执行轮中途删除自己只影响**未来的派发**（scheduler 拥有 nextRunAt）；本轮照常运行到结束，不中断、不重放。
- 删除是幂等的（重复删除返回 `deleted: false`）。

## 失败语义

| 场景                                            | 行为                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| 执行轮删除非自身 automation                     | `prepareApproval` 直接 deny（附原因），即刻返回 `PermissionDenied`，不进入无人应答的审批等待；handler 亦复核身份 |
| 执行轮删除自身（自清理）                        | `prepareApproval` 收窄为 proceed，无需响应者即执行；handler 复核身份     |
| 执行轮身份缺失时任何 CronDelete                 | `prepareApproval` 即 deny（fail closed）；若仍执行到 handler 则 `PermissionDenied` |
| 执行轮身份缺失时 CronList                       | 无任何 `isCurrentTurnAutomation` 标记；模型指引要求停止自清理而非猜测 id |
| 普通交互轮恰好 deny `CronCreate` + `CronUpdate` | 不是执行轮：`automationTurn === false`，任意 id 可删，走正常审批         |
| 非执行轮（常规交互轮）                          | 行为不变：任意 id 可删，走正常审批                                       |

## 验收场景

1. automation 轮内 `CronList` 恰好一条 `isCurrentTurnAutomation: true`，等于触发 id。
2. automation 轮内删除自身 → 成功，后续不再派发；删除其他 id → `prepareApproval` 即刻 deny，调用返回带原因的 `PermissionDenied` 错误结果，不挂起等待审批。
3. automation 轮内 `CronCreate` / `CronUpdate` 仍不可见（provider 请求边界隐藏）。
4. 常规交互轮 `CronDelete` / `CronList` 行为与字段完全不变（输出无 `isCurrentTurnAutomation`）。
5. 常规交互轮的 denylist 恰好等于 `{CronCreate, CronUpdate}` 时，`automationTurn` 仍为 `false`：`CronDelete` 任意 id 走正常审批，`CronList` 输出无 `isCurrentTurnAutomation`。
6. 身份缺失的 automation 轮（queryId 兜底）内：`CronList` 无任何标记条目，任何 id 的 `CronDelete` 被 deny，模型指引要求停止自清理。

# Session Sweeper：agent 驱动的会话清理（备份 → 删除 → backlog）

状态：已实现（2026-09-25 增补 pin/unpin 与 6h 周期；root + zcode-cli 四包 typecheck 全绿、services 27/27 测试通过（3 条 sweep 用例）、architecture 0 违规）。承接 `specs/workspace-attention-lifecycle.md` 的归档体系：自动归档只隐藏不删除；本 spec 定义由 agent 判断相关性、由确定性代码执行「备份后删除」的清理链路。

## 产品规则

- Host 能力必须在 runtime 工具目录构建前下发。`session-sweep` 是受支持的工具能力键；Host 未声明该键时，三个 SessionSweep 工具必须从 registry/model request 中缺席，`tools:` 白名单或 agent profile 不能复活它们。端口存在只代表协议适配层可发起请求，不代表目标 Host 已实现 `sessionSweep/*` 方法。
- 清理由 `session-sweeper` 子代理（GLM-5.3，thoughtLevel max）驱动：调用 `SessionSweepPlan` 获取候选（含钉住侧候选）、用 `SessionSweepSetPinned` 钉住值得保留/解除过期钉、用 `SessionSweepExecute` 提交删除清单。
- 钉住/解除钉住是纯 membership 元数据：钉住 = 长期保留（永久退出候选守卫）；解除钉住不删除任何东西，只让该会话重新满足「可清理候选」守卫，交给后续轮次提名。两者均可逆。
- 删除 = 先备份再删除：快照文件移动进 backlog 目录，tasks-index 行写 tombstone（deleted=1，去掉分组引用）。业务上"列表与磁盘都不再活跃"，但 backlog 可人工恢复。
- 「不在行动中」由服务端守卫强制，agent 无法绕过：`deleted=0`、终态 completed/error、未钉住、无未读、无 pendingInteraction、off-peak 身份排除、cron 身份按在途判定（session 存在非终态 automation_run 时受保护；终态 run session 按常规年龄门槛可清理；绑定目标（target_task_id）已随系统级调度迁移退役，见 specs/automation-system-scheduling.md）、年龄门槛分级：终态手动归档行以归档时刻（`archived_at`，0→1 转换打点、解除归档清空）起算固定 1 天宽限——用户手动归档即「已完成」信号，宽限与该行先前的 `updated_at` 无关；auto-archive 产生的终态归档行不打点，宽限仍按 `updated_at` 计；存量行 `archived_at` 为空时守卫经 `COALESCE(archived_at, updated_at)` 退回旧行为（迁移 0005 纯加列、不回填）。未归档终态行走 minAgeDays（默认 3 天，与 72h 自动归档的节奏对齐）。归档本身不能替代终态。钉住侧候选 = 同款守卫但 `pinned=1`。执行阶段在同一事务内按同一谓词复核。
- 周期执行：cron automation 每 6 小时派发一条 prompt，由会话内 agent 派发 session-sweeper 子代理执行并一行回报。

## 状态所有者与事件顺序

```
agent 工具调用 SessionSweep(plan)
  → CLI sessionSweepPort → 协议 sessionSweep/plan（requestClient，同 automation/* 模式）
  → host zcodeAgentService handler → SessionSweepService.plan
      （TaskIndexRepo.listSessionSweepCandidates：只读守卫查询）
agent 判断 → SessionSweep(execute, taskIds)
  → 协议 sessionSweep/execute → SessionSweepService.execute
      1. mkdir backlog 运行目录 ~/.zcode/v2/session-sweep-backlog/<runId>/
      2. repo.sweepDeleteTasks（BEGIN IMMEDIATE，逐项守卫复核 + tombstone）
      3. rename 快照 {taskId}.json / {taskId}.deleted.json → backlog/<workspaceHash>-<taskId>/
      4. 写 meta.json（task meta、原路径、时间、是否缺快照）
  → bridge notifier（adapter 安装）→ workspace_task_list_changed(task_deleted) 广播
```

- TaskIndexRepo 是 tasks-index 唯一写者；SessionSweepService 是 backlog 目录唯一写者；CLI 只经协议触达，绝不直接碰 sqlite。
- 备份在 tombstone 之后执行：tombstone 是事务权威点；若备份移动失败，tombstone 已生效但 meta.json 记录 `snapshotMoveFailed`，快照留在原位（rename 失败不回滚删除，因为原文件仍在原路径，数据无损）。

## 失败语义

- plan 查询失败 → 协议错误，agent 停止本轮。
- execute 单项守卫复核失败 → 该项 skip 并带 reason，其余继续。
- 快照缺失 → 仍删除，meta.json 标 `snapshotMissing`。
- 未安装 bridge notifier（无 adapter 的上下文）→ 无广播，UI 在下次 membership 读取时收敛。

## 验收

1. plan 只返回满足全部守卫的候选，包含 title/status/时间/workspace 与 searchable_text 预览。
2. execute 后：tasks-index 行 deleted=1；backlog 目录存在对应 meta.json 与（如有的）快照文件；打开中的侧栏收到 task_deleted 收敛。
3. 钉住/未读/pending/非终态/未过年龄门槛/off-peak 任务不会被删除；cron 仅保护存在非终态 automation_run 的 session（在途保护，判定修订见 specs/automation-system-scheduling.md），终态 run session 与孤儿 run-transcript 按产品规则可清理（事务内复核）。
4. `~/.zcode/agents/session-sweeper.md` 存在且 frontmatter 为 `model: <GLM-5.3 路由>` + `thoughtLevel: max`。
5. cron automation 每 6 小时触发；prompt 指示派发 session-sweeper 子代理并回报结果；旧版 app（无该工具）中运行时 prompt 明确要求直接结束不做任何事。
6. 未声明 `session-sweep` 能力时：三个 SessionSweep 工具不出现在 runtime registry/model contract，session-sweeper agent 的显式 `tools:` 白名单不能使它们出现；声明能力且端口在场时三者出现。替换工具可以使用同一机器可读能力键机制独立启停。
7. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 全绿；services 测试覆盖守卫矩阵与备份-删除路径。

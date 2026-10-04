# 归档任务不持未读：archived ⇒ unread_at IS NULL

状态：已实现（2026-10-01）。修复背景：用户将 cron automation 任务归档后，automation 复用同一 task 行继续后台运行，终态 `background_terminal` 未读信号把 `unread_at` 写回归档行；所有可见列表按 membership 排除归档行，蓝点无处展示，而 dock badge 的 `countAllUnreadTasks` 仍计入（optimistic 池/兼容 map），表现为「图标卡在 2 条未读、UI 内没有任何未读」，且自动归档 sweep 与 session sweep 的守卫都拒绝 unread 行，僵尸状态永不自愈、每轮 cron 重新感染。

## 产品规则

- 归档 = 用户已处理：`archived=1` 的 task 行不允许持有 `unread_at`。归档是显式 dismissal，未读是「等用户打开」的注意力状态，两者互斥。
- 归档写入（`archiveTask` / 批量归档 / 任何 `archived: true` patch）顺带清未读；已归档行上的未读写请求一律拒绝（返回 meta 不带 `unreadAt`，调用方按返回值对账收敛）。
- unarchive 不复活未读：解除归档后的行从 `unreadAt IS NULL` 起步，用户打开前不产生新未读。
- 后台终态未读（`task_status_changed` + `unreadSignal: background_terminal`）对归档行不生效：服务端拒绝落库，renderer 收到不含 `unreadAt` 的回包后回滚本地 optimistic 未读。
- 存量脏数据（旧版本写入的 archived+unread 行）由 tasks-index 迁移 `0004_archived_clear_unread` 一次性清零。

## 状态所有者与事件顺序

```
cron 后台完成
  → zcodeTaskIndexSyncer.applyTerminalTransition
      emitWorkspaceTaskListChanged(task_status_changed, unreadSignal=background_terminal)
  → renderer syncTaskUnreadFromStatusWorkspaceEvent
      optimistic 未读 overlay + setTaskUnreadIndicator(true)   ← 旧实现到此即抬高 badge
      → service.setTaskUnread(unread: true)
          → TaskIndexRepo.updateTaskState
              行已归档 → 拒绝写 unread_at，返回 meta.unreadAt=undefined   ← 本修复
      → 回包无 unreadAt → rollback overlay + indicator(false)            ← 本修复（镜像不变量）
归档（本端或远端）
  → repo.updateTaskState({archived: true}) 强制 unread_at=NULL（writeUnreadAt 随归档置真）
  → broadcast task_archived
  → renderer 收到 task_archived → setTaskUnreadIndicator(false) + overlay 回滚 ← 本修复
```

- `TaskIndexRepo.updateTaskState` 是不变量的唯一裁决点：`willBeArchived = patch.archived === true || row.archived === 1` 时 `nextMeta.unreadAt` 恒为 `undefined`，且 `writeUnreadAt` 置真让清除真正落盘（含对已归档行的任意状态写，读侧收敛）。
- dock badge（`countAllUnreadTasks`）与列表蓝点继续读同一份 task meta `unreadAt`，不另建第二套过滤；不变量在数据所有者处保证归档行永远喂不进未读。
- renderer 的 `task_archived` 清理覆盖本端与远端归档（本端 mutation 也会 emit 归属类事件），不依赖 meta merge 的 updatedAt 竞争。

## 失败语义

- `setTaskUnread` 在归档行上不是错误：正常返回（`unreadAt: undefined`），overlay 与广播按返回值收敛。
- 迁移失败 → tasks-index 打开失败（沿用现有迁移失败语义），不静默降级。
- 旧版本 renderer 收到拒绝回包时仍可能短暂显示乐观未读（`?? optimisticUnreadAt` 旧行为），下次 membership 读取收敛；新版本立即回滚。

## 验收

1. 已归档行调用 `setTaskUnread(unread: true)`：返回 meta 无 `unreadAt`，DB `unread_at IS NULL`。
2. 未读行执行归档：DB `archived=1 AND unread_at IS NULL`，`task_archived` 事件 meta 不带 `unreadAt`。
3. 归档行上的任意 `updateTaskState` 状态写：`unread_at` 保持 NULL（自愈式收敛）。
4. 迁移 `0004_archived_clear_unread`：存量 `archived=1 AND unread_at NOT NULL` 行清零。
5. renderer：`task_archived` 事件清 indicator/overlay；`setTaskUnread` 回包无 `unreadAt` 时回滚 optimistic 未读，不再用 `?? optimisticUnreadAt` 顶替。
6. dock badge 恢复与可见蓝点一致：无可见未读时 badge 为 0。
7. `pnpm typecheck` / `pnpm lint` / services 与 ui 测试全绿。

## 部署记录

- 2026-10-04，ZCode（GLM-5.3-FlashX）会话：用户报告 Preview 图标 dock badge 卡在 2、无任何可消未读。实况取证：`~/.zcode/v2/tasks-index.sqlite` 存在 3 条 `archived=1 AND unread_at IS NOT NULL` 的 cron automation 行（Session Cleanup / lapis PR #35 review re-query / Agent instruction parity check，badge 只计开窗 workspace 的 2 条）；运行中的 Preview 是 20260927-2252-da7ad305-dirty 快照，早于本修复（PR #7）。处理：main ff 至 resmp/main（e43c354），`scripts/build-and-link-zcode.sh` 重建并安装快照 20261004-040036-e43c3544-dirty，smoke test 静态检查通过，安装副本 app.asar 内确认含 `0004_archived_clear_unread`。证据：安装输出与 smoke 输出记录于会话；live DB 迁移水位停在 0003，下次启动迁移 0004 一次性清零 3 条僵尸行。非声明：badge 归零需重启 Preview 后才发生（运行中实例仍持旧 renderer 内存态）；迁移清零效果以重启后 `SELECT COUNT(*) FROM tasks WHERE unread_at IS NOT NULL` = 0 为准。

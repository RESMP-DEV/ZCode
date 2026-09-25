# Workspace 自动导入、持续待办提醒、待办摘要与 72h 自动归档

状态：已实现（2026-09-24，验证：typecheck/lint/architecture 全绿，services 24/24 测试通过，其中 14 条为本次新增；2026-09-25 增补：任务分区头琥珀点 + pendingInteraction 全量 rollup）。本文是四项行为的唯一 spec，覆盖产品规则、状态所有者、接口与验收场景。

## 背景与问题

1. 侧栏项目列表只能逐个手动添加；已有大量本地项目目录的用例希望自动出现在侧栏。
2. 通知是瞬态的：点击系统通知后只清 Renderer 本地未读映射，不落盘清除持久化 `unreadAt`；permission / 需要输入 的阻塞状态只活在 sessions-index 实时摘要里，会话未打开或 app 重启后无任何持久痕迹——「点完通知就再也找不到哪件事还等着处理」。
3. 缺少一个跨 workspace 汇总「还有什么要做」的入口；用户希望能派一个 agent 去读活跃消息并给出摘要。
4. 已完成的任务长期堆积在时间线里；期望 72 小时后无活跃打开任务的项自动归档。

## 行为 1：侧栏项目自动导入

产品规则：

- 设置 `workspaceAutoImportEnabled`（默认 true）+ `workspaceAutoImportRoots: string[]`（默认 `[]`，表示使用 home 目录）。扫描深度固定 2 层，只认包含 `.git` 的目录，跳过隐藏目录、`node_modules`、`Library`、`Applications`、`.Trash` 等噪声目录。
- 只新增 tab，永不移除、永不激活、永不抢占焦点；新导入的 tab 追加到列表尾部（`ensureWorkspaceTab` 新增 `append` 选项），上限 24 个/次。
- 触发时机：Renderer 完成 tab 恢复（`useTabPersistence` 的 initial restore 完成）后执行一次；设置页提供手动「立即扫描」。

所有者与事件顺序：

```
setting.json (owner: host settingService)
  → Root: hasCompletedInitialRestore → useWorkspaceAutoImport
  → services.fileService.discoverWorkspaceCandidates (host fs, 只读 BFS)
  → tabStore.ensureWorkspaceTab(path, { append: true })   (owner: renderer tab store)
  → useTabPersistence debounce 写回 lastWorkspaceSession
```

失败语义：目录不可读/不存在 → 跳过该子树并继续；服务调用失败 → 记 logger.warn，不影响启动。

## 行为 2：持久化「需要处理」状态（pendingInteraction 落盘 + 指示器回退）

产品规则：

- `ZCodeTaskMeta.pendingInteraction`（既有类型字段，此前从未被 services 持久化）由 task index 权威化：sessions-index summary / 协议 snapshot 出现阻塞交互时写入队首摘要；交互消失时清空（`undefined` 显式清除）。
- 侧栏任务行在没有实时 `__zcodeSessionActivity` sidecar 时（app 重启、workspace 未订阅）回退读持久化 `meta.pendingInteraction`，继续显示 Permission/Input 角标。
- 项目行（收起态）在组内存在 pendingInteraction 时显示琥珀色「需要处理」点，与蓝色未读点并列为两个语义：蓝 = 有没看过的结果，琥珀 = 有等用户处理的阻塞。
- 侧栏「任务」分区（conversation workspace，任务不属于任何项目）收起时，分区头显示同语义琥珀点：任一 conversation workspace 组内存在 pendingInteraction 即点亮；分区展开时隐藏（任务行自身角标已可见）。分区收起时其内容组件卸载，rollup 由侧栏层的 workspace-kind 任务查询维持（sessions-index 订阅按 endpoint+workspace 引用计数复用，不产生重复订阅）。
- pendingInteraction rollup 覆盖分页窗口之外：列表查询在分页裁剪前的完整结果上固化 `hasPendingAction` 布尔（与 `unreadTaskKeys` 同一先例——「若只检查可见 items，收起行会漏掉分页窗口之外的未读」），项目行与任务分区头共用该标志；缓存等价性比较包含该字段，仅翻转它也会发布新结果。
- 系统通知点击路径与任务行点击路径对齐：点击通知激活任务时同样执行持久化未读清除（compare-and-clear，`expectedUnreadAt` 取 query-cache 当前值），消除「正在看着的任务仍计入 dock 角标」的不一致。

所有者与事件顺序：

```
CLI sessions-index 帧
  → zcodeTaskIndexSyncer.processSummary diff(previous/next.pendingInteraction)
  → taskIndexRepo.applyAgentPatch({ pendingInteraction }) (owner: tasks-index.sqlite)
  → workspace_task_list_changed(task_meta_changed) 广播
  → UI query cache → 任务行角标（live sidecar 优先，meta 回退）→ 项目行琥珀点 rollup + 「任务」分区头琥珀点 rollup（WorkspaceSidebar 单一计算，分组来源同一条 useWorkspaceTaskLists 管线，conversation workspace 一并进入 scope）
清除：交互解决/输入后的下一帧 summary/snapshot 携带空 pendingInteraction → 同一写入路径清空。
```

快照路径：`buildMetaFromSnapshot` / `buildBaselineMetaFromSummary` 同步映射，`syncTaskMeta` 全量覆盖（无保留分支），`applyAgentPatch` 采用 `lastError` 同款「键缺席 = 保留，显式 undefined = 清除」语义。

## 行为 3：待办摘要 agent 任务

产品规则：

- 入口在侧栏 Conversations 区头部（图标按钮 + tooltip）。点击后由 host 收集候选任务，在 conversation workspace（`~/.zcode/workspace/default`）创建一个真实 agent 任务，prompt 内嵌候选任务的最近消息尾部，由 agent 产出「按优先级排列的待办清单」，按当前 locale 输出。
- 候选集（跨全部 workspace，上限 12）：`pendingInteraction` 非空 > `task_status='error'` > `unreadAt` 非空 > 近 72h 仍在 running 且有更新。每任务取最近 8 条消息。
- 结果是普通任务：可读、可续聊追问，无新协议。

```
Renderer 侧栏 action
  → services.zcodeTaskService.createAttentionDigestTask({ locale })
  → taskIndexRepo.listAttentionCandidates (只读查询)
  → adapter.getTaskSnapshot(messageLimit:8) 逐任务取尾部
  → createTask({ workspacePath: conversationWorkspace, v4Create: true }) + sendPrompt
  → Renderer 激活 conversation workspace tab + 该任务
```

失败语义：候选为空 → 仍创建任务，prompt 说明当前无待办；快照获取失败的单个任务跳过并保留其 meta 摘要行。

## 行为 4：72h 自动归档

产品规则：

- 默认开启：`taskAutoArchiveEnabled` 缺省 true、`taskAutoArchiveOlderThanDays` 缺省 3。存量 setting.json 中两键均缺席时一次性迁移为 true/3（标记 `taskAutoArchiveDefaultsInitialized`）；已显式保存过任一键的用户不受翻转。
- 归档条件沿用既有 SQL（`archiveStaleTasks`）：未删除、未归档、未钉住、无未读、`updated_at` 早于阈值、`task_status='completed'`——即「没有活跃打开任务」；新增 JS 侧防御：meta 携带 `pendingInteraction` 的行跳过。
- 触发：既有 grouped view 读取时触发保持不变；新增 host 内周期 sweep（启动后 60s 首跑，之后每小时），scope 为 tasks-index 中出现过的全部 workspace。多窗口 host 并发 sweep 由 `archived = 0` 谓词与 BEGIN IMMEDIATE 事务保证幂等。

```
desktop host (timer owner: taskAutoArchiveSweep, 单模块单例)
  → services.zcodeTaskService.runTaskAutoArchiveSweep()
  → adapter.runWorkspaceTaskAutoArchive(taskIndexRepo.listWorkspaceScopes())
  → archiveStaleTasks(逐 workspace) → task_meta_changed 广播（既有路径）
```

## 验收场景

1. 新装 app（无 setting.json 历史）：侧栏在启动恢复后出现 home 下两层内的 git 项目（追加在尾部，不改激活 tab）；设置页可关闭与配置根目录。
2. 后台任务的 agent 发起 permission 请求后退出该 workspace：侧栏任务行仍显示 Permission 角标，项目行收起时显示琥珀点；重启 app 后仍显示；答复 permission 后两者消失。
3. conversation workspace（「任务」分区）的任务发起 permission 后收起该分区：分区头显示琥珀点；答复后消失。待办任务排在分页窗口之外（非前 5 条）时点同样点亮（hasPendingAction 全量标志）。
4. 点击系统通知跳转任务后，dock 角标计数即时下降，重启后不回弹。
5. 侧栏 Conversations 头部点击摘要按钮：在 conversation workspace 生成一个任务，内容为按优先级排列的跨项目待办清单，语言跟随 locale。
6. 一个 completed、未钉、无未读、无 pending 的任务在 72h 后（下次 sweep 或任意 grouped view 读取）进入已归档；有 pendingInteraction 或未读或钉住的任务永不自动归档。
7. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿；新增 node:test 用例（迁移、候选查询、发现扫描、pending rollup）通过。

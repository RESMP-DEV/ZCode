import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey } from "../src/lib/taskQueryCache.js";
import { countAllUnreadTasks } from "../src/lib/unreadTaskCount.js";
import { syncTaskUnreadFromStatusWorkspaceEvent } from "../src/lib/taskStatusUnreadSync.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";

// specs/archived-task-unread-invariant.md：归档任务不持未读。
// renderer 镜像不变量：task_archived 事件清 indicator/overlay；
// setTaskUnread 回包没有 unreadAt（服务端拒绝归档行未读）时回滚乐观未读，
// 不再用乐观值顶替，否则 dock badge 留下 UI 内无处展示的僵尸未读。

const WORKSPACE_PATH = "/ws/unread-sync";

function buildTaskMeta(params: {
  taskId: string;
  status?: ZCodeTaskMeta["status"];
  unreadAt?: number;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: WORKSPACE_PATH,
    createdAt: 1000,
    updatedAt: 2000,
    mode: "build",
    ...(params.status ? { status: params.status } : {}),
    ...(typeof params.unreadAt === "number" ? { unreadAt: params.unreadAt } : {}),
  };
}

function buildEvent(params: {
  taskId: string;
  reason: ZCodeWorkspaceTaskListChanged["reason"];
  taskMeta?: ZCodeTaskMeta;
  unreadSignal?: "background_terminal";
}): ZCodeWorkspaceTaskListChanged {
  return {
    type: "workspace_task_list_changed",
    workspacePath: WORKSPACE_PATH,
    taskId: params.taskId,
    reason: params.reason,
    ...(params.taskMeta ? { taskMeta: params.taskMeta } : {}),
    ...(params.unreadSignal ? { unreadSignal: params.unreadSignal } : {}),
  };
}

interface RecordedUnreadCall {
  taskId: string;
  unread: boolean;
}

function buildService(metaByCall: Array<ZCodeTaskMeta | undefined>): {
  service: {
    setTaskUnread: (params: { taskId: string; unread: boolean }) => Promise<ZCodeTaskMeta>;
  };
  calls: RecordedUnreadCall[];
} {
  const calls: RecordedUnreadCall[] = [];
  const service = {
    setTaskUnread: (params: { taskId: string; unread: boolean }) => {
      calls.push({ taskId: params.taskId, unread: params.unread });
      const meta = metaByCall[calls.length - 1];
      return Promise.resolve(meta ?? buildTaskMeta({ taskId: params.taskId }));
    },
  };
  return { service, calls };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// node:test 同文件共享模块级 store 状态；badge 计数跨 workspace 全量统计，
// 每条用例前清空两个 store，保证断言只反映当前用例。
function resetStores(): void {
  useTaskQueryCacheStore.getState().clearAll();
  useZCodeSessionStore.setState({ workspaces: {} });
}

function badgeUnreadCount(taskId: string): number {
  const workspaceState = useZCodeSessionStore
    .getState()
    .getWorkspaceState(WORKSPACE_PATH, undefined);
  assert.ok(workspaceState, `workspace state 应按需创建 taskId=${taskId}`);
  return countAllUnreadTasks({ [WORKSPACE_PATH]: workspaceState });
}

function queryOverlayUnreadAt(taskId: string): number | null | undefined {
  return useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[
    buildTaskEntityKey({ taskId, workspacePath: WORKSPACE_PATH })
  ];
}

test("后台终态未读：服务端确认后落地 indicator 与 overlay", async () => {
  resetStores();
  const { service, calls } = buildService([
    buildTaskMeta({ taskId: "task-commit", status: "completed", unreadAt: 1234 }),
  ]);

  syncTaskUnreadFromStatusWorkspaceEvent({
    activeWorkspace: { workspacePath: "/ws/elsewhere" },
    event: buildEvent({
      taskId: "task-commit",
      reason: "task_status_changed",
      taskMeta: buildTaskMeta({ taskId: "task-commit", status: "completed" }),
      unreadSignal: "background_terminal",
    }),
    service,
  });
  await flushAsync();

  assert.deepEqual(calls, [{ taskId: "task-commit", unread: true }]);
  assert.equal(badgeUnreadCount("task-commit"), 1, "已确认未读计入 dock badge");
  assert.equal(queryOverlayUnreadAt("task-commit"), 1234, "overlay 对账服务端值");
});

test("服务端拒绝归档行未读：回滚乐观未读，不用乐观值顶替", async () => {
  resetStores();
  const { service, calls } = buildService([
    // 服务端守卫拒绝后回包不带 unreadAt（归档行不持未读）。
    buildTaskMeta({ taskId: "task-refused" }),
  ]);

  syncTaskUnreadFromStatusWorkspaceEvent({
    activeWorkspace: { workspacePath: "/ws/elsewhere" },
    event: buildEvent({
      taskId: "task-refused",
      reason: "task_status_changed",
      taskMeta: buildTaskMeta({ taskId: "task-refused", status: "completed" }),
      unreadSignal: "background_terminal",
    }),
    service,
  });
  await flushAsync();

  assert.equal(calls.length, 1, "仍发起一次写请求");
  assert.equal(badgeUnreadCount("task-refused"), 0, "拒绝后不得残留 renderer-only 未读");
  assert.equal(
    queryOverlayUnreadAt("task-refused"),
    undefined,
    "overlay 回滚后删除，不保留乐观未读",
  );
});

test("task_archived 事件：清 indicator 与 overlay，不发起未读写", async () => {
  resetStores();
  const { service, calls } = buildService([]);
  const store = useZCodeSessionStore.getState();
  // 归档前任务已带未读（归档前终态写入）。
  store.setTaskUnreadIndicator(WORKSPACE_PATH, "task-archived", true, undefined);
  assert.equal(badgeUnreadCount("task-archived"), 1, "前置：归档前存在未读");

  syncTaskUnreadFromStatusWorkspaceEvent({
    activeWorkspace: { workspacePath: "/ws/elsewhere" },
    event: buildEvent({
      taskId: "task-archived",
      reason: "task_archived",
      taskMeta: buildTaskMeta({ taskId: "task-archived" }),
    }),
    service,
  });
  await flushAsync();

  assert.deepEqual(calls, [], "归档事件不得触发未读写");
  assert.equal(badgeUnreadCount("task-archived"), 0, "归档后未读清零");
});

test("事件携带已持久化 unreadAt：只对账 indicator，不重复落库", async () => {
  resetStores();
  const { service, calls } = buildService([]);

  syncTaskUnreadFromStatusWorkspaceEvent({
    activeWorkspace: { workspacePath: "/ws/elsewhere" },
    event: buildEvent({
      taskId: "task-persisted",
      reason: "task_status_changed",
      taskMeta: buildTaskMeta({
        taskId: "task-persisted",
        status: "completed",
        unreadAt: 4321,
      }),
      unreadSignal: "background_terminal",
    }),
    service,
  });
  await flushAsync();

  assert.deepEqual(calls, [], "已有持久化未读时不得重复写库");
  assert.equal(badgeUnreadCount("task-persisted"), 1);
});

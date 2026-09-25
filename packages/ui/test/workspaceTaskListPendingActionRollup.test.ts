import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildWorkspaceTaskListDisplayGroups } from "../src/hooks/workspaceTaskListDisplayGroups.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
} from "../src/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "../src/store/taskQueryCacheStore.js";

// specs/workspace-attention-lifecycle.md：pendingInteraction 的琥珀点 rollup 覆盖
// 分页窗口之外——列表缓存在分页裁剪前的完整结果上固化 hasPendingAction，
// 项目行与「任务」分区头（conversation workspace，任务不属于任何项目）共用该标志。

const WORKSPACE_PATH = "/ws/conversation";

function buildTask(params: {
  taskId: string;
  updatedAt: number;
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: WORKSPACE_PATH,
    createdAt: params.updatedAt - 1000,
    updatedAt: params.updatedAt,
    mode: "build",
    ...(params.pendingInteraction ? { pendingInteraction: params.pendingInteraction } : {}),
  };
}

function buildFixture(visibleTasks: ZCodeTaskMeta[], cacheExtras: {
  total: number;
  hasPendingAction?: boolean;
}) {
  const scope = { workspacePath: WORKSPACE_PATH };
  const workspaceKey = buildTaskWorkspaceKey(WORKSPACE_PATH);
  const descriptor = buildTaskListCacheDescriptor({
    kind: "workspace",
    workspaceScopes: [scope],
    sortBy: "updated",
    search: "",
    expanded: false,
    visibleLimit: 5,
  });
  const queryKey = `${buildTaskListCacheKeyFromDescriptor(descriptor)}::version=0`;
  const cachedResult: CachedTaskListResult = {
    taskKeys: visibleTasks.map((task) => buildTaskEntityKey(task)),
    ...(cacheExtras.hasPendingAction === undefined
      ? {}
      : { hasPendingAction: cacheExtras.hasPendingAction }),
    total: cacheExtras.total,
    hasMore: cacheExtras.total > visibleTasks.length,
    fetchedAt: Date.now(),
    invalidationVersion: 0,
    stale: false,
    partial: false,
    loadingShardKeys: [],
    failedShardKeys: [],
    descriptor,
  };
  return {
    queryConfigs: [{ scope, workspaceKey, visibleLimit: 5, queryKey }],
    resultsByQueryKey: { [queryKey]: cachedResult },
    queryKey,
    descriptor,
  };
}

test("cached full-result hasPendingAction lights rollup beyond the visible window", () => {
  // 分页窗口（前 5 条）里没有 pendingInteraction，但完整结果（第 6 条）有。
  const visibleTasks = [
    buildTask({ taskId: "task-1", updatedAt: 6000 }),
    buildTask({ taskId: "task-2", updatedAt: 5000 }),
    buildTask({ taskId: "task-3", updatedAt: 4000 }),
    buildTask({ taskId: "task-4", updatedAt: 3000 }),
    buildTask({ taskId: "task-5", updatedAt: 2000 }),
  ];
  const { queryConfigs, resultsByQueryKey } = buildFixture(visibleTasks, {
    total: 6,
    hasPendingAction: true,
  });

  const { groups } = buildWorkspaceTaskListDisplayGroups({
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey: Object.fromEntries(
      visibleTasks.map((task) => [buildTaskEntityKey(task), task]),
    ),
    taskUnreadOverlayByEntityKey: {},
    optimisticTaskOverlayByWorkspaceKey: new Map(),
    previousGroupsByWorkspaceKey: new Map(),
    sortBy: "updated",
  });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].hasPendingAction, true);
});

test("visible pendingInteraction lights rollup without the cached flag", () => {
  const visibleTasks = [
    buildTask({
      taskId: "task-1",
      updatedAt: 6000,
      pendingInteraction: { interactionId: "i-1", kind: "permission" },
    }),
  ];
  const { queryConfigs, resultsByQueryKey } = buildFixture(visibleTasks, { total: 1 });

  const { groups } = buildWorkspaceTaskListDisplayGroups({
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey: Object.fromEntries(
      visibleTasks.map((task) => [buildTaskEntityKey(task), task]),
    ),
    taskUnreadOverlayByEntityKey: {},
    optimisticTaskOverlayByWorkspaceKey: new Map(),
    previousGroupsByWorkspaceKey: new Map(),
    sortBy: "updated",
  });

  assert.equal(groups[0].hasPendingAction, true);
});

test("rollup stays off when neither source reports a pending interaction", () => {
  const visibleTasks = [buildTask({ taskId: "task-1", updatedAt: 6000 })];
  const { queryConfigs, resultsByQueryKey } = buildFixture(visibleTasks, {
    total: 1,
    hasPendingAction: false,
  });

  const { groups } = buildWorkspaceTaskListDisplayGroups({
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey: Object.fromEntries(
      visibleTasks.map((task) => [buildTaskEntityKey(task), task]),
    ),
    taskUnreadOverlayByEntityKey: {},
    optimisticTaskOverlayByWorkspaceKey: new Map(),
    previousGroupsByWorkspaceKey: new Map(),
    sortBy: "updated",
  });

  assert.equal(groups[0].hasPendingAction, false);
});

test("query cache republishes when only hasPendingAction flips", () => {
  const store = useTaskQueryCacheStore.getState();
  store.clearAll();
  const task = buildTask({ taskId: "task-1", updatedAt: 6000 });
  const { queryKey, descriptor } = buildFixture([task], { total: 1 });
  const baseEntry = {
    queryKey,
    descriptor,
    items: [task],
    total: 1,
    hasMore: false,
  };

  try {
    store.setQueryResults([{ ...baseEntry, hasPendingAction: true }]);
    const first = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
    assert.equal(first?.hasPendingAction, true);

    // 同值 republish：内容等价，保留旧结果引用。
    store.setQueryResults([{ ...baseEntry, hasPendingAction: true }]);
    assert.equal(useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey], first);

    // 仅翻转 hasPendingAction：必须发布新结果，否则琥珀点停留在旧值。
    store.setQueryResults([{ ...baseEntry, hasPendingAction: false }]);
    const flipped = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
    assert.notEqual(flipped, first);
    assert.equal(flipped?.hasPendingAction, false);
  } finally {
    useTaskQueryCacheStore.getState().clearAll();
  }
});

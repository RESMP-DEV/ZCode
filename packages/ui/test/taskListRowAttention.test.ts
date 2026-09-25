import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  attachTaskListRowActivity,
  getTaskListAttention,
} from "../src/v4/taskListRowActivity.js";

// specs/workspace-attention-lifecycle.md 行为 2：任务行角标读实时 sidecar 优先、
// meta 回退。回退只在 sidecar 整体缺席时生效——sidecar 在场而 pendingInteractions
// 为空是 sessions-index 的权威「当前无阻塞」，不得被 tasks-index 的 stale 持久值覆盖。

function buildTask(params: {
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-task-1",
    title: "task-1",
    workspacePath: "/tmp/ws-a",
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    ...(params.pendingInteraction ? { pendingInteraction: params.pendingInteraction } : {}),
  };
}

test("live sidecar without pendingInteractions overrides stale persisted value", () => {
  const persisted = buildTask({
    pendingInteraction: { interactionId: "req-1", kind: "permission" },
  });
  const withLiveSidecar = attachTaskListRowActivity(persisted, {
    phase: "completedSuccess",
    lastActivityAt: 3,
    hasBackgroundWork: false,
  });
  assert.equal(getTaskListAttention(withLiveSidecar), null);
});

test("persisted pendingInteraction is used only when the sidecar is absent", () => {
  const persisted = buildTask({
    pendingInteraction: { interactionId: "req-1", kind: "userInput" },
  });
  assert.deepEqual(getTaskListAttention(persisted), { kind: "userInput", count: 1 });
});

test("live summary counts win when the sidecar carries interactions", () => {
  const task = attachTaskListRowActivity(buildTask({}), {
    phase: "running",
    lastActivityAt: 3,
    hasBackgroundWork: false,
    pendingInteractions: { permissionCount: 2, userInputCount: 1 },
  });
  assert.deepEqual(getTaskListAttention(task), { kind: "userInput", count: 3 });
});

test("no sidecar and no persisted interaction yields no attention", () => {
  assert.equal(getTaskListAttention(buildTask({})), null);
});

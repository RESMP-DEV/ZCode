import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

function buildMeta(params: {
  taskId: string;
  workspacePath: string;
  updatedAt: number;
  status?: ZCodeTaskMeta["status"];
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
  title?: string;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.title ?? params.taskId,
    workspacePath: params.workspacePath,
    createdAt: params.updatedAt - 1000,
    updatedAt: params.updatedAt,
    mode: "build",
    ...(params.status ? { status: params.status } : {}),
    ...(params.pendingInteraction ? { pendingInteraction: params.pendingInteraction } : {}),
  };
}

async function withRepo(run: (repo: TaskIndexRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-index-attention-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  try {
    await repo.ensureReady();
    await run(repo);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readMeta(
  repo: TaskIndexRepo,
  workspacePath: string,
  taskId: string,
): Promise<ZCodeTaskMeta | null> {
  const metas = await repo.listTaskMetas({ workspacePath });
  return metas.find((meta) => meta.taskId === taskId) ?? null;
}

test("applyAgentPatch 持久化并清除 pendingInteraction（键缺席=保留）", async () => {
  await withRepo(async (repo) => {
    const workspacePath = "/tmp/ws-a";
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "task-1", workspacePath, updatedAt: 1000, status: "running" }),
    });

    // 键缺席的 patch 不得清掉 pendingInteraction。
    await repo.applyAgentPatch({
      workspacePath,
      taskId: "task-1",
      patch: { title: "renamed", updatedAt: 2000 },
    });
    let meta = await readMeta(repo, workspacePath, "task-1");
    assert.equal(meta?.pendingInteraction, undefined);

    await repo.applyAgentPatch({
      workspacePath,
      taskId: "task-1",
      patch: {
        pendingInteraction: { interactionId: "req-1", kind: "permission", toolName: "Bash" },
        updatedAt: 3000,
      },
    });
    meta = await readMeta(repo, workspacePath, "task-1");
    assert.equal(meta?.pendingInteraction?.interactionId, "req-1");
    assert.equal(meta?.pendingInteraction?.kind, "permission");
    assert.equal(meta?.pendingInteraction?.toolName, "Bash");

    await repo.applyAgentPatch({
      workspacePath,
      taskId: "task-1",
      patch: { title: "no-touch", updatedAt: 4000 },
    });
    meta = await readMeta(repo, workspacePath, "task-1");
    assert.equal(meta?.pendingInteraction?.interactionId, "req-1");

    // 显式 undefined 清除（交互解决后的下一帧）。
    await repo.applyAgentPatch({
      workspacePath,
      taskId: "task-1",
      patch: { pendingInteraction: undefined, updatedAt: 5000 },
    });
    meta = await readMeta(repo, workspacePath, "task-1");
    assert.equal(meta?.pendingInteraction, undefined);
  });
});

test("listWorkspaceScopes 去重返回全部 workspace", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "a", workspacePath: "/tmp/ws-a", updatedAt: 1000 }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "b", workspacePath: "/tmp/ws-a", updatedAt: 2000 }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "c", workspacePath: "/tmp/ws-b", updatedAt: 3000 }),
    });
    const scopes = await repo.listWorkspaceScopes();
    assert.equal(scopes.length, 2);
    assert.ok(scopes.some((scope) => scope.workspacePath === "/tmp/ws-a"));
    assert.ok(scopes.some((scope) => scope.workspacePath === "/tmp/ws-b"));
  });
});

test("listAttentionCandidates 按阻塞>错误>未读>运行排序", async () => {
  await withRepo(async (repo) => {
    const now = Date.now();
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "running",
        workspacePath: "/tmp/ws-a",
        updatedAt: now - 1000,
        status: "running",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "unread", workspacePath: "/tmp/ws-a", updatedAt: now - 2000 }),
    });
    await repo.updateTaskState({
      workspacePath: "/tmp/ws-a",
      taskId: "unread",
      patch: { unreadAt: now },
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "error",
        workspacePath: "/tmp/ws-b",
        updatedAt: now - 3000,
        status: "error",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "pending",
        workspacePath: "/tmp/ws-c",
        updatedAt: now - 4000,
        status: "running",
        pendingInteraction: { interactionId: "req-9", kind: "userInput" },
      }),
    });
    const candidates = await repo.listAttentionCandidates({ limit: 10 });
    assert.deepEqual(
      candidates.map((meta) => meta.taskId),
      ["pending", "error", "unread", "running"],
    );
  });
});

test("archiveStaleTasks 跳过 pendingInteraction 行并按天数归档", async () => {
  await withRepo(async (repo) => {
    const now = Date.now();
    const old = now - 5 * 24 * 60 * 60 * 1000;
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "stale-completed",
        workspacePath: "/tmp/ws-a",
        updatedAt: old,
        status: "completed",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "stale-pending",
        workspacePath: "/tmp/ws-a",
        updatedAt: old,
        status: "completed",
        pendingInteraction: { interactionId: "req-stale", kind: "permission" },
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "fresh-completed",
        workspacePath: "/tmp/ws-a",
        updatedAt: now,
        status: "completed",
      }),
    });
    const archived = await repo.archiveStaleTasks({
      workspacePath: "/tmp/ws-a",
      olderThanDays: 3,
    });
    assert.deepEqual(
      archived.map((meta) => meta.taskId),
      ["stale-completed"],
    );
  });
});

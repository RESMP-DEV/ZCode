import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { pendingInteractionChanged } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
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

test("listAttentionCandidates 优先级行不被更新的低优先级行挤出 SQL 窗口", async () => {
  await withRepo(async (repo) => {
    const now = Date.now();
    // 201 条更新的未读行按 recency 序全部落在 LIMIT 200 窗口内；
    // 最旧的 pendingInteraction 行 recency 排第 202——纯 recency 窗口会把它挤出候选集，
    // 优先级排序必须进 SQL 才能让阻塞行稳定进摘要。
    for (let index = 0; index < 201; index += 1) {
      const taskId = `unread-${index}`;
      await repo.syncTaskMeta({
        meta: buildMeta({ taskId, workspacePath: "/tmp/ws-a", updatedAt: now - index }),
      });
      await repo.updateTaskState({
        workspacePath: "/tmp/ws-a",
        taskId,
        patch: { unreadAt: now - index },
      });
    }
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "pending-old",
        workspacePath: "/tmp/ws-b",
        updatedAt: now - 100000,
        status: "running",
        pendingInteraction: { interactionId: "req-old", kind: "permission" },
      }),
    });
    const candidates = await repo.listAttentionCandidates({ limit: 12 });
    assert.equal(candidates[0]?.taskId, "pending-old");
  });
});

test("pendingInteractionChanged 判定出现/解决/换代与不变", () => {
  const permission: ZCodeTaskMeta["pendingInteraction"] = {
    interactionId: "req-1",
    kind: "permission",
  };
  const nextKind: ZCodeTaskMeta["pendingInteraction"] = {
    interactionId: "req-1",
    kind: "userInput",
  };
  // 出现 / 解决。
  assert.equal(pendingInteractionChanged(undefined, permission), true);
  assert.equal(pendingInteractionChanged(permission, undefined), true);
  // 换代（interactionId 或 kind 变化）。
  assert.equal(pendingInteractionChanged(permission, nextKind), true);
  assert.equal(
    pendingInteractionChanged(permission, { interactionId: "req-2", kind: "permission" }),
    true,
  );
  // 不变（toolName 等次要字段不参与判定）。
  assert.equal(
    pendingInteractionChanged(permission, { ...permission, toolName: "Bash" }),
    false,
  );
  assert.equal(pendingInteractionChanged(undefined, undefined), false);
});

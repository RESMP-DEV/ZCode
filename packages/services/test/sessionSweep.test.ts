import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath, setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  executeSessionSweep,
  getSessionSweepBacklogDir,
  planSessionSweep,
  setPinnedSessionSweep,
} from "../src/session/sessionSweepService.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildMeta(params: {
  taskId: string;
  workspacePath: string;
  updatedAt: number;
  status?: ZCodeTaskMeta["status"];
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: params.workspacePath,
    createdAt: params.updatedAt - 10 * DAY_MS,
    updatedAt: params.updatedAt,
    mode: "build",
    ...(params.status ? { status: params.status } : {}),
    ...(params.pendingInteraction ? { pendingInteraction: params.pendingInteraction } : {}),
  };
}

async function withSweepEnv(
  run: (repo: TaskIndexRepo, root: string, now: number) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-sweep-"));
  setDataBaseDir(root);
  try {
    const repo = new TaskIndexRepo(join(root, "tasks-index.sqlite"));
    await repo.ensureReady();
    await run(repo, root, Date.now());
    repo.close();
  } finally {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  }
}

test("plan 只返回满足全部守卫的候选", async () => {
  await withSweepEnv(async (repo, _root, now) => {
    const old = now - 20 * DAY_MS;
    const recent = now - 2 * DAY_MS;
    // 可清理：终态过期 + 已归档过期。
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "ok-completed",
        workspacePath: "/w",
        updatedAt: old,
        status: "completed",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "ok-archived", workspacePath: "/w", updatedAt: old }),
    });
    await repo.updateTaskState({
      workspacePath: "/w",
      taskId: "ok-archived",
      patch: { archived: true },
    });
    // 不可清理矩阵：近期、运行中、钉住、未读、带阻塞交互。
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "recent",
        workspacePath: "/w",
        updatedAt: recent,
        status: "completed",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "running",
        workspacePath: "/w",
        updatedAt: old,
        status: "running",
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "pinned",
        workspacePath: "/w",
        updatedAt: old,
        status: "completed",
      }),
    });
    await repo.updateTaskState({ workspacePath: "/w", taskId: "pinned", patch: { pinned: true } });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "unread",
        workspacePath: "/w",
        updatedAt: old,
        status: "completed",
      }),
    });
    await repo.updateTaskState({ workspacePath: "/w", taskId: "unread", patch: { unreadAt: now } });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "pending",
        workspacePath: "/w",
        updatedAt: old,
        status: "completed",
        pendingInteraction: { interactionId: "r1", kind: "permission" },
      }),
    });
    const plan = await planSessionSweep(repo, {});
    const ids = plan.candidates.map((candidate) => candidate.taskId).sort();
    assert.deepEqual(ids, ["ok-archived", "ok-completed"]);
  });
});

test("execute 备份快照、tombstone 行、并跳过守卫复核失败项", async () => {
  await withSweepEnv(async (repo, _root, now) => {
    const old = now - 20 * DAY_MS;
    for (const taskId of ["del-1", "del-2"]) {
      await repo.syncTaskMeta({
        meta: buildMeta({ taskId, workspacePath: "/w", updatedAt: old, status: "completed" }),
      });
      const snapshotPath = getLegacyTaskSessionSnapshotPath("/w", taskId);
      await mkdir(dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, JSON.stringify({ taskId, messages: [] }));
    }
    // del-2 在 execute 前被钉住 → 事务内复核跳过；missing 不存在 → not_found。
    await repo.updateTaskState({ workspacePath: "/w", taskId: "del-2", patch: { pinned: true } });

    const result = await executeSessionSweep(repo, {
      taskIds: ["del-1", "del-2", "missing"],
      minAgeDays: 14,
    });
    assert.deepEqual(
      result.deleted.map((item) => item.taskId),
      ["del-1"],
    );
    assert.equal(result.deleted[0]?.snapshotMoved, true);
    const skippedById = new Map(result.skipped.map((item) => [item.taskId, item.reason]));
    assert.equal(skippedById.get("del-2"), "guard_recheck_failed");
    assert.equal(skippedById.get("missing"), "not_found_or_already_deleted");

    // 行已 tombstone：常规列表查询不再可见。
    const visible = await repo.listTaskMetas({ workspacePath: "/w" });
    assert.ok(!visible.some((meta) => meta.taskId === "del-1"));
    assert.ok(visible.some((meta) => meta.taskId === "del-2"));

    // backlog：单个 run 目录，内含 meta.json 与移动后的快照；原快照路径已空。
    const backlogRoot = getSessionSweepBacklogDir();
    const runs = await readdir(backlogRoot);
    assert.equal(runs.length, 1);
    const runDir = join(backlogRoot, runs[0]!);
    const entries = await readdir(runDir);
    assert.deepEqual(entries, [
      `${dirname(getLegacyTaskSessionSnapshotPath("/w", "del-1")).split("/").pop()}-del-1`,
    ]);
    const backupDir = join(runDir, entries[0]!);
    const backupEntries = (await readdir(backupDir)).sort();
    assert.deepEqual(backupEntries, ["del-1.json", "meta.json"]);
    const metaJson = JSON.parse(await readFile(join(backupDir, "meta.json"), "utf8"));
    assert.equal(metaJson.meta.taskId, "del-1");
    assert.equal(metaJson.moved, getLegacyTaskSessionSnapshotPath("/w", "del-1"));
    await assert.rejects(() => readFile(getLegacyTaskSessionSnapshotPath("/w", "del-1")));
  });
});

test("setPinned 钉住/解除钉住并影响下一轮 plan 候选", async () => {
  await withSweepEnv(async (repo, _root, now) => {
    const old = now - 20 * DAY_MS;
    for (const taskId of ["s-1", "s-2"]) {
      await repo.syncTaskMeta({
        meta: buildMeta({ taskId, workspacePath: "/w", updatedAt: old, status: "completed" }),
      });
    }

    // 钉住 s-1：从候选消失、进入钉住侧候选。
    const pinResult = await setPinnedSessionSweep(repo, { taskIds: ["s-1"], pinned: true });
    assert.deepEqual(pinResult.updated, [{ taskId: "s-1", pinned: true }]);
    let plan = await planSessionSweep(repo, {});
    assert.deepEqual(
      plan.candidates.map((c) => c.taskId),
      ["s-2"],
    );
    assert.deepEqual(
      plan.pinnedCandidates.map((c) => c.taskId),
      ["s-1"],
    );

    // 重复钉住 → already_pinned；不存在 → not_found。
    const dup = await setPinnedSessionSweep(repo, { taskIds: ["s-1", "ghost"], pinned: true });
    assert.deepEqual(dup.updated, []);
    assert.deepEqual(
      dup.skipped.map((s) => [s.taskId, s.reason]),
      [
        ["s-1", "already_pinned"],
        ["ghost", "not_found_or_already_deleted"],
      ],
    );

    // 解除钉住：重新回到删除候选（守卫其余部分仍由 execute 复核）。
    const unpin = await setPinnedSessionSweep(repo, { taskIds: ["s-1"], pinned: false });
    assert.deepEqual(unpin.updated, [{ taskId: "s-1", pinned: false }]);
    plan = await planSessionSweep(repo, {});
    assert.deepEqual(plan.candidates.map((c) => c.taskId).sort(), ["s-1", "s-2"]);
    assert.deepEqual(plan.pinnedCandidates, []);
  });
});

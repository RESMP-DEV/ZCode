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
    // 手动归档会把 archived_at 打点为当前时刻（宽限从此起算）；回拨到 old
    // 模拟宽限已过，使该行回到「已归档且过期」的可清理侧。
    repo["getDatabase"]()
      .prepare("UPDATE tasks SET archived_at = ? WHERE task_id = ?")
      .run(old, "ok-archived");
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

test("手动归档走 1 天宽限；未归档终态仍需满 minAgeDays", async () => {
  await withSweepEnv(async (repo, _root, now) => {
    const twoDaysAgo = now - 2 * DAY_MS;
    // 手动归档 = 用户此刻的「已完成」信号：1 天宽限从归档动作（archived_at）
    // 起算，与该行先前的 updated_at 无关——归档一个两天没动的任务不能立刻可清理。
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "arch-2d",
        workspacePath: "/w",
        updatedAt: twoDaysAgo,
        status: "completed",
      }),
    });
    await repo.updateTaskState({
      workspacePath: "/w",
      taskId: "arch-2d",
      patch: { archived: true },
    });
    // 未归档终态 + 2 天前活跃：不满 3 天 → 不可清理。
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "live-2d",
        workspacePath: "/w",
        updatedAt: twoDaysAgo,
        status: "completed",
      }),
    });
    const freshPlan = await planSessionSweep(repo, {});
    const freshIds = freshPlan.candidates.map((c) => c.taskId);
    assert.ok(!freshIds.includes("arch-2d"), "manual archive restarts the 1-day grace from now");
    assert.ok(!freshIds.includes("live-2d"), "unarchived terminal row must still wait out minAgeDays");

    // 宽限过期：archived_at 退回 2 天前（模拟时间流逝）→ 过 1 天宽限，可清理。
    repo["getDatabase"]()
      .prepare("UPDATE tasks SET archived_at = ? WHERE task_id = ?")
      .run(twoDaysAgo, "arch-2d");
    const agedPlan = await planSessionSweep(repo, {});
    assert.ok(
      agedPlan.candidates.some((c) => c.taskId === "arch-2d"),
      "archived row passes the 1-day grace measured from archived_at",
    );

    // 解除归档清空锚点：重新归档会重新起算宽限。
    await repo.updateTaskState({
      workspacePath: "/w",
      taskId: "arch-2d",
      patch: { archived: false },
    });
    const cleared = repo["getDatabase"]()
      .prepare("SELECT archived_at FROM tasks WHERE task_id = ?")
      .get("arch-2d") as { archived_at: number | null };
    assert.equal(cleared.archived_at, null, "unarchive clears the archived_at anchor");
  });
});

test("孤儿 cron transcript 可清理；存活 automation 的 run 仍受保护", async () => {
  await withSweepEnv(async (repo, _root, now) => {
    const old = now - 20 * DAY_MS;
    await repo.syncTaskMeta({
      meta: {
        ...buildMeta({
          taskId: "cron-orphan",
          workspacePath: "/w",
          updatedAt: old,
          status: "completed",
        }),
        cronAutomationId: "automation-dead",
      },
    });
    await repo.syncTaskMeta({
      meta: {
        ...buildMeta({
          taskId: "cron-live",
          workspacePath: "/w",
          updatedAt: old,
          status: "completed",
        }),
        cronAutomationId: "automation-alive",
      },
    });
    // 存活 automation：只有 automations 表里存在 enabled=1 且 active 的行才受保护。
    repo["getDatabase"]().exec(
      `INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path, created_at, updated_at, next_run_at)
       VALUES ('automation-alive', 't', '* * * * *', 'p', '/w', '/w', 1, 1, 1)`,
    );
    const plan = await planSessionSweep(repo, {});
    const ids = plan.candidates.map((c) => c.taskId);
    assert.ok(ids.includes("cron-orphan"), "orphaned cron transcript should be eligible");
    assert.ok(!ids.includes("cron-live"), "live automation transcript stays protected");
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

    // 钉住已归档的行：必须同时解除归档（侧栏 Pinned 区只显示 pinned 且未归档）。
    await repo.updateTaskState({ workspacePath: "/w", taskId: "s-2", patch: { archived: true } });
    const pinArchived = await setPinnedSessionSweep(repo, { taskIds: ["s-2"], pinned: true });
    assert.deepEqual(pinArchived.updated, [{ taskId: "s-2", pinned: true }]);
    // 未归档 + 钉住 + 终态过期 → 出现在钉住侧候选；不在删除候选。
    const afterArchivedPin = await planSessionSweep(repo, {});
    assert.ok(!afterArchivedPin.candidates.some((meta) => meta.taskId === "s-2"));
    assert.ok(afterArchivedPin.pinnedCandidates.some((meta) => meta.taskId === "s-2"));
    // 还原状态，不影响后续断言：解除钉住并重新归档。
    await setPinnedSessionSweep(repo, { taskIds: ["s-2"], pinned: false });
    await repo.updateTaskState({ workspacePath: "/w", taskId: "s-2", patch: { archived: true } });
    await repo.updateTaskState({ workspacePath: "/w", taskId: "s-2", patch: { archived: false } });

    // 解除钉住：重新回到删除候选（守卫其余部分仍由 execute 复核）。
    const unpin = await setPinnedSessionSweep(repo, { taskIds: ["s-1"], pinned: false });
    assert.deepEqual(unpin.updated, [{ taskId: "s-1", pinned: false }]);
    plan = await planSessionSweep(repo, {});
    assert.deepEqual(plan.candidates.map((c) => c.taskId).sort(), ["s-1", "s-2"]);
    assert.deepEqual(plan.pinnedCandidates, []);
  });
});

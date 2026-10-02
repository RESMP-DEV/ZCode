import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

// specs/archived-task-unread-invariant.md：archived ⇒ unread_at IS NULL。
// 归档写入顺带清未读；已归档行拒绝未读写；归档行上的状态写自愈清残留；
// 迁移 0004 清存量僵尸行（cron automation 复用归档 task 行后台运行，
// 终态未读写回归档行会造成 dock badge 永不清零的僵尸未读）。

function buildMeta(params: {
  taskId: string;
  workspacePath: string;
  updatedAt: number;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: params.workspacePath,
    createdAt: params.updatedAt - 1000,
    updatedAt: params.updatedAt,
    mode: "build",
  };
}

async function withRepo(
  run: (repo: TaskIndexRepo, dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-index-archived-unread-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  try {
    await repo.ensureReady();
    await run(repo, dbPath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readUnreadAt(
  repo: TaskIndexRepo,
  workspacePath: string,
  taskId: string,
): Promise<number | undefined> {
  const metas = await repo.listTaskMetas({ workspacePath, archived: true });
  return metas.find((meta) => meta.taskId === taskId)?.unreadAt;
}

test("已归档行拒绝未读写请求", async () => {
  await withRepo(async (repo) => {
    const workspacePath = "/tmp/ws-archived-unread";
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "task-refuse", workspacePath, updatedAt: 1000 }),
    });
    await repo.updateTaskState({
      workspacePath,
      taskId: "task-refuse",
      patch: { archived: true },
    });

    const meta = await repo.updateTaskState({
      workspacePath,
      taskId: "task-refuse",
      patch: { unreadAt: 5000 },
    });
    assert.equal(meta.unreadAt, undefined, "归档行上的未读写必须被拒绝");
    assert.equal(await readUnreadAt(repo, workspacePath, "task-refuse"), undefined);
  });
});

test("归档写入顺带清未读", async () => {
  await withRepo(async (repo) => {
    const workspacePath = "/tmp/ws-archive-clears";
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "task-clear", workspacePath, updatedAt: 1000 }),
    });
    const unreadMeta = await repo.updateTaskState({
      workspacePath,
      taskId: "task-clear",
      patch: { unreadAt: 2000 },
    });
    assert.equal(typeof unreadMeta.unreadAt, "number", "未归档行的未读写正常生效");

    const archivedMeta = await repo.updateTaskState({
      workspacePath,
      taskId: "task-clear",
      patch: { archived: true },
    });
    assert.equal(archivedMeta.unreadAt, undefined, "归档后 meta 不再携带未读");
    assert.equal(await readUnreadAt(repo, workspacePath, "task-clear"), undefined);
  });
});

test("归档行上的任意状态写自愈清残留未读", async () => {
  await withRepo(async (repo, dbPath) => {
    const workspacePath = "/tmp/ws-self-heal";
    const taskId = "task-heal";
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId, workspacePath, updatedAt: 1000 }),
    });
    await repo.updateTaskState({ workspacePath, taskId, patch: { archived: true } });

    // 模拟旧版本/外部写入留下的僵尸行：repo API 已无法制造 archived+unread，
    // 只能直接改库。
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA busy_timeout = 2000");
    raw.prepare("UPDATE tasks SET unread_at = 777 WHERE task_id = ?").run(taskId);

    const meta = await repo.updateTaskState({
      workspacePath,
      taskId,
      patch: { status: "completed", updatedAt: 3000 },
    });
    assert.equal(meta.unreadAt, undefined, "状态写后 meta 未读被清");
    const row = raw.prepare("SELECT unread_at FROM tasks WHERE task_id = ?").get(taskId) as {
      unread_at: number | null;
    };
    assert.equal(row.unread_at, null, "状态写必须把 unread_at 真正落盘为 NULL");
    raw.close();
  });
});

test("迁移 0004 清存量归档未读行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-index-migration-0004-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  try {
    const repo = new TaskIndexRepo(dbPath);
    await repo.ensureReady();
    const workspacePath = "/tmp/ws-migration";
    const taskId = "task-legacy";
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId, workspacePath, updatedAt: 1000 }),
    });
    await repo.updateTaskState({ workspacePath, taskId, patch: { archived: true } });
    repo.close();

    // 模拟旧版本数据库：存量 archived+unread 行 + 账本尚未应用 0004。
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("UPDATE tasks SET unread_at = 555 WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id = '0004_archived_clear_unread'").run();

    runTasksDatabaseMigrations(db);

    const row = db.prepare("SELECT unread_at FROM tasks WHERE task_id = ?").get(taskId) as {
      unread_at: number | null;
    };
    assert.equal(row.unread_at, null, "迁移必须清掉归档行的存量未读");
    const ledger = db
      .prepare("SELECT id FROM tasks_schema_migration WHERE id = '0004_archived_clear_unread'")
      .get();
    assert.ok(ledger, "迁移入账");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

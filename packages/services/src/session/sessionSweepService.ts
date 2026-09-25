// Session Sweep 服务：agent 判断、确定性执行「备份 → tombstone」。
// TaskIndexRepo 是 tasks-index 唯一写者；本模块是 backlog 目录唯一写者。
// CLI 侧只能经协议（sessionSweep/plan、sessionSweep/execute）触达，绝不直接碰 sqlite。
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ZCodeSessionSweepCandidate,
  ZCodeSessionSweepExecuteProtocolResult,
  ZCodeSessionSweepSetPinnedProtocolResult,
} from "@zcode/shared";
import {
  getAppConfigDir,
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "../paths.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { TaskIndexRepo } from "./taskIndexRepo.js";

const logger = createServiceLogger("session-sweep");

const SESSION_SWEEP_BACKLOG_DIR_NAME = "session-sweep-backlog";

export function getSessionSweepBacklogDir(): string {
  return join(getAppConfigDir(), SESSION_SWEEP_BACKLOG_DIR_NAME);
}

export interface SessionSweepPlanResult {
  candidates: ZCodeSessionSweepCandidate[];
  pinnedCandidates: ZCodeSessionSweepCandidate[];
  backlogDir: string;
  generatedAt: number;
}

function toSweepCandidate(row: ZCodeTaskMeta & { archived: boolean; preview: string }) {
  return {
    taskId: row.taskId,
    workspacePath: row.workspacePath,
    ...(row.workspaceIdentity ? { workspaceIdentity: row.workspaceIdentity } : {}),
    title: row.title,
    ...(row.status === "completed" || row.status === "error" ? { status: row.status } : {}),
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    preview: row.preview,
  };
}

export async function planSessionSweep(
  repo: TaskIndexRepo,
  params: { minAgeDays?: number; limit?: number } | undefined,
): Promise<SessionSweepPlanResult> {
  const minAgeDaysFilter =
    params?.minAgeDays !== undefined ? { minAgeDays: params.minAgeDays } : undefined;
  const [rows, pinnedRows] = await Promise.all([
    repo.listSessionSweepCandidates({
      ...minAgeDaysFilter,
      ...(params?.limit !== undefined ? { limit: params.limit } : {}),
    }),
    repo.listSessionSweepPinnedCandidates({ ...minAgeDaysFilter }),
  ]);
  return {
    candidates: rows.map(toSweepCandidate),
    pinnedCandidates: pinnedRows.map(toSweepCandidate),
    backlogDir: getSessionSweepBacklogDir(),
    generatedAt: Date.now(),
  };
}

/**
 * 设置/解除钉住（sweep 面）。pin/unpin 不触发删除路径，只是 membership 元数据；
 * 解除钉住的效果是让该会话重新满足「可清理候选」守卫，交给下一轮 plan 提名。
 */
export async function setPinnedSessionSweep(
  repo: TaskIndexRepo,
  params: { taskIds: string[]; pinned: boolean },
): Promise<ZCodeSessionSweepSetPinnedProtocolResult> {
  const { updated, skipped } = await repo.sweepSetPinned(params);
  if (updated.length > 0) {
    notifySessionSweepCompleted({ pinnedChanged: updated.map((item) => item.meta) });
  }
  return {
    updated: updated.map((item) => ({ taskId: item.taskId, pinned: item.pinned })),
    skipped,
  };
}

function buildRunDir(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return join(getSessionSweepBacklogDir(), stamp);
}

async function moveIfExists(source: string, targetDir: string): Promise<string | null> {
  try {
    await rename(source, join(targetDir, basename(source)));
    return source;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function executeSessionSweep(
  repo: TaskIndexRepo,
  params: { taskIds: string[]; minAgeDays?: number },
): Promise<ZCodeSessionSweepExecuteProtocolResult> {
  const runDir = buildRunDir();
  // tombstone 是事务权威点；备份移动失败不回滚删除（原文件仍在原路径，数据无损），
  // 失败信息写进 meta.json 供人工补搬。
  const { deleted, skipped } = await repo.sweepDeleteTasks({
    taskIds: params.taskIds,
    ...(params.minAgeDays !== undefined ? { minAgeDays: params.minAgeDays } : {}),
  });
  const result: ZCodeSessionSweepExecuteProtocolResult = {
    deleted: [],
    skipped,
  };
  if (deleted.length === 0) {
    return result;
  }
  await mkdir(runDir, { recursive: true });
  for (const meta of deleted) {
    const backupDir = join(
      runDir,
      `${basename(dirname(getLegacyTaskSessionSnapshotPath(meta.workspacePath, meta.taskId, meta.workspaceIdentity)))}-${meta.taskId}`,
    );
    let snapshotMoved = false;
    let snapshotMoveFailed = false;
    try {
      await mkdir(backupDir, { recursive: true });
      const snapshotPath = getLegacyTaskSessionSnapshotPath(
        meta.workspacePath,
        meta.taskId,
        meta.workspaceIdentity,
      );
      const deletedSnapshotPath = getLegacyDeletedTaskSessionSnapshotPath(
        meta.workspacePath,
        meta.taskId,
        meta.workspaceIdentity,
      );
      const moved = await moveIfExists(snapshotPath, backupDir);
      snapshotMoved = moved !== null;
      // 旧 tombstone 产生的 .deleted.json 一并搬走，避免残留半份会话。
      await moveIfExists(deletedSnapshotPath, backupDir);
      await writeFile(
        join(backupDir, "meta.json"),
        `${JSON.stringify({ meta, originalSnapshotPath: snapshotPath, moved, snapshotMoveFailed: false, deletedAt: Date.now() }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      snapshotMoveFailed = true;
      logger.warn(
        undefined,
        `[SessionSweep] 备份写入失败（tombstone 已生效，快照留在原路径） taskId=${meta.taskId}`,
        error,
      );
      try {
        await mkdir(backupDir, { recursive: true });
        await writeFile(
          join(backupDir, "meta.json"),
          `${JSON.stringify({ meta, snapshotMoveFailed: true, deletedAt: Date.now() }, null, 2)}\n`,
          "utf8",
        );
      } catch {
        // meta.json 也写不进去时只剩日志；原始数据未受影响。
      }
    }
    result.deleted.push({
      taskId: meta.taskId,
      backupPath: backupDir,
      snapshotMoved: snapshotMoved && !snapshotMoveFailed,
    });
  }
  notifySessionSweepCompleted({ deleted });
  return result;
}

// ---- 广播桥 ----
// tombstone/pin 变更发生在 zcodeAgentService 的协议 handler 里，拿不到 task adapter
// 的 workspace emitter；adapter 创建时安装 notifier，把变更事实转发成
// workspace_task_list_changed（task_deleted / task_meta_changed），让打开中的侧栏
// 即时收敛。无 adapter 的上下文（远端/测试）不安装，UI 靠下次 membership 读取收敛。
type SessionSweepNotifier = (result: {
  deleted?: ZCodeTaskMeta[];
  pinnedChanged?: ZCodeTaskMeta[];
}) => void;
let sessionSweepNotifier: SessionSweepNotifier | null = null;

export function installSessionSweepNotifier(notifier: SessionSweepNotifier | null): void {
  sessionSweepNotifier = notifier;
}

function notifySessionSweepCompleted(result: {
  deleted?: ZCodeTaskMeta[];
  pinnedChanged?: ZCodeTaskMeta[];
}): void {
  try {
    sessionSweepNotifier?.(result);
  } catch (error) {
    logger.warn(undefined, "[SessionSweep] 变更结果广播失败（不影响已完成的变更）", error);
  }
}

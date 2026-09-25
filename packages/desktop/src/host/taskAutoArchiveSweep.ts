// 72h 自动归档周期 sweep 的 timer 所有者。
// host 是 window-scoped 的（多窗口多个 host 进程内实例），但 sweep 只依赖
// tasks-index 写路径（幂等：archived=0 谓词 + BEGIN IMMEDIATE 事务保证并发安全），
// 因此由首个完成初始化的 host 启动单例 timer；该 host 释放时停止，其余 host
// 的后续初始化可再次接管。归档写入与事件广播复用 adapter 的既有路径，不新增状态。
import { createServiceLogger } from "@zcode/services/node";

const logger = createServiceLogger("task-auto-archive-sweep");
/** 启动后先等一分钟：避开启动高峰（tab 恢复、agent 预热、sessions-index 水合）。 */
const SWEEP_INITIAL_DELAY_MS = 60_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let initialDelayTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

function runSweep(
  resolveTaskService: () => {
    runTaskAutoArchiveSweep(): Promise<{ archivedCount: number }>;
  } | null,
): void {
  if (sweepInFlight) {
    return;
  }
  const zcodeTaskService = resolveTaskService();
  if (!zcodeTaskService) {
    return;
  }
  sweepInFlight = true;
  void zcodeTaskService
    .runTaskAutoArchiveSweep()
    .then((result) => {
      if (result.archivedCount > 0) {
        logger.info(undefined, `周期自动归档完成 数量=${result.archivedCount}`);
      }
    })
    .catch((error: unknown) => {
      // 单轮失败不影响下一小时重试；adapter 内部对逐 workspace 失败已有日志。
      logger.warn(
        undefined,
        `周期自动归档执行失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      sweepInFlight = false;
    });
}

export function startTaskAutoArchiveSweep(
  resolveTaskService: () => {
    runTaskAutoArchiveSweep(): Promise<{ archivedCount: number }>;
  } | null,
): void {
  if (initialDelayTimer || sweepTimer) {
    return;
  }
  initialDelayTimer = setTimeout(() => {
    initialDelayTimer = null;
    runSweep(resolveTaskService);
    sweepTimer = setInterval(() => runSweep(resolveTaskService), SWEEP_INTERVAL_MS);
  }, SWEEP_INITIAL_DELAY_MS);
}

export function stopTaskAutoArchiveSweep(): void {
  if (initialDelayTimer) {
    clearTimeout(initialDelayTimer);
    initialDelayTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

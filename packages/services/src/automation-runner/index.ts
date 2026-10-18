/* eslint-disable max-lines -- automation runner 集中维护 tick 执行器与管理动词两个面，
   共享同一批 repo/config 装配；稳定后可按 tick/verbs 拆分（对齐 automationRepo 先例）。 */
// automation runner：detached tick 执行器 + `zcode automation` 管理命令实现
// （specs/automation-system-scheduling.md）。
// - tick：廉价 due 检查（只开 AutomationRepo）；有到期工作才构建完整 services 栈
//   （createLocalServices 与 desktop host 同一工厂，单一执行路径），派发后等待终态落账再退出。
// - 管理动词与 Automations tab 读写同一 tasks-index；无第二条 SQL 写路径。
// 本模块由 desktop 打包成独立 bundle（tsup entry automation-runner/index），OS 注册项
// 直接执行该 bundle；`zcode automation` CLI 委托到这里。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AUTOMATION_MISFIRE_OFF_TOO_LONG_MS,
  AUTOMATION_MISFIRE_OFF_TOO_LONG_REASON,
  ZCODE_ENV,
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationSchedulingConfig,
} from "@zcode/shared";
import { AutomationRepo } from "../session/automationRepo.js";
import { AutomationService } from "../session/automationService.js";
import {
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "../session/automationCron.js";
import { AutomationConfigRepo } from "../session/automationConfigRepo.js";
import {
  dispatchAutomationRun,
  dispatchManualAutomationRun,
  type AutomationDispatchDeps,
} from "../zcode-agent/automationDispatch.js";
import { IZCodeTaskService } from "../session/zcodeTaskService.js";
import { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import type { ServiceCollection } from "../collection.js";
import {
  createPlatformRegistrar,
  resolveTickCommand,
  type AutomationRegistrar,
  type AutomationRegistrarStatus,
} from "./registrar.js";

/** 每 run 的硬性 wall-clock 上限：超时先 stopGeneration 争取干净终态，再硬退由僵尸认领兜底。 */
export const AUTOMATION_RUN_WALL_CLOCK_MS = 30 * 60_000;
/** stopGeneration 之后等待干净终态的宽限；再超时直接退出（10 分钟僵尸回收是最终兜底）。 */
const AUTOMATION_RUN_HARD_EXIT_GRACE_MS = 2 * 60_000;

type TickLog = (message: string) => void;

export interface AutomationTickResult {
  mode: "app" | "system";
  claimed: number;
  dispatched: number;
  skipped: number;
  manualDispatched: number;
}

/** builtin provider 配置解析（Electron-free 版 desktopProviderConfig）：env → 打包相对 → dev findUp。 */
export function resolveBuiltinProviderConfigPath(runnerEntry?: string): string {
  const explicit = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  const entry = runnerEntry?.trim() || process.argv[1];
  if (entry) {
    // 打包态：runner bundle 在 <resources>/automation-runner/index.js。
    const packaged = join(
      dirname(dirname(entry)),
      "config",
      "provider",
      "zcode-builtin.json",
    );
    if (existsSync(packaged)) return packaged;
    // dev 态：从 bundle/源码位置向上找仓库根的 config/provider。
    const filename = ZCODE_ENV === "production" ? "zcode-builtin.json" : "zcode-builtin.test.json";
    let current = dirname(entry);
    while (true) {
      const candidate = join(current, "config", "provider", filename);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(
    "无法定位 zcode-builtin provider 配置：设置 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 或从打包/仓库形态运行",
  );
}

/** 懒构建派发依赖：只在确实有到期工作时支付 services 栈启动成本。
 * createLocalServices 经动态 import 取得——它所在的 node.js 反向聚合了本模块的消费者，
 * 静态互引会成环；这里只在真正派发时加载。 */
async function buildDispatchDeps(
  repo: AutomationRepo,
  log: TickLog,
): Promise<AutomationDispatchDeps & { services: ServiceCollection }> {
  const { createLocalServices } = await import("../node.js");
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: resolveBuiltinProviderConfigPath(),
  });
  const zcodeTaskService = services.getOptional(IZCodeTaskService);
  const modelSelectionService = services.getOptional(IModelSelectionService);
  if (!zcodeTaskService || !modelSelectionService) {
    throw new Error("automation runner：services 栈缺少 task/model-selection 服务");
  }
  return {
    repo,
    zcodeTaskService,
    modelSelectionService,
    logWarn: (message, error) => log(`${message}: ${String(error)}`),
    logInfo: (message) => log(message),
    services,
  };
}

interface InFlightRun {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** 等待全部终态落账；wall-clock 超时先 stopGeneration，硬宽限再超时进程退出（僵尸认领兜底）。 */
async function awaitRunSettlement(
  settled: Array<Promise<void>>,
  inFlight: InFlightRun[],
  deps: AutomationDispatchDeps,
  log: TickLog,
): Promise<void> {
  if (settled.length === 0) return;
  let hardExit: ReturnType<typeof setTimeout> | null = null;
  const all = Promise.allSettled(settled).finally(() => {
    if (hardExit) clearTimeout(hardExit);
  });
  const stopTimer = setTimeout(() => {
    for (const run of inFlight) {
      void deps.zcodeTaskService
        .stopGeneration({
          taskId: run.taskId,
          workspacePath: run.workspacePath,
          ...(run.workspaceIdentity ? { workspaceIdentity: run.workspaceIdentity } : {}),
        })
        .catch((error: unknown) =>
          log(`stopGeneration 超时收口失败 task=${run.taskId}: ${String(error)}`),
        );
    }
    hardExit = setTimeout(() => {
      log("wall-clock 硬上限到达，退出进程；未收口的 run 由 10 分钟僵尸认领回收");
      process.exit(1);
    }, AUTOMATION_RUN_HARD_EXIT_GRACE_MS);
    hardExit.unref?.();
  }, AUTOMATION_RUN_WALL_CLOCK_MS);
  stopTimer.unref?.();
  await all;
}

/**
 * detached tick：OS 注册项每 30s 调用一次。app 模式下完整让位（app 内 scheduler 负责），
 * system 模式下认领 local due 行（>24h 的错过记 skipped 后推进），派发并等终态。
 * resolveDispatchDeps 是测试注入缝：缺省懒构建真实 services 栈（createLocalServices）。
 */
export async function runAutomationTick(options?: {
  dbPath?: string;
  now?: number;
  log?: TickLog;
  resolveDispatchDeps?: (repo: AutomationRepo, log: TickLog) => Promise<AutomationDispatchDeps>;
}): Promise<AutomationTickResult> {
  const log = options?.log ?? ((message: string) => console.log(`[automation-tick] ${message}`));
  const repo = new AutomationRepo(options?.dbPath);
  const configRepo = new AutomationConfigRepo(options?.dbPath);
  try {
    await repo.ensureReady();
    await configRepo.ensureReady();
    const now = options?.now ?? Date.now();
    await configRepo.touchLastTick(now).catch((error) => {
      log(`touchLastTick 失败（不阻断 tick）: ${String(error)}`);
    });
    const mode = await configRepo.getMode();
    if (mode !== "system") {
      // app 模式：runner 完整让位，避免与 app 内 scheduler 形成双写。
      return { mode, claimed: 0, dispatched: 0, skipped: 0, manualDispatched: 0 };
    }

    const result: AutomationTickResult = {
      mode,
      claimed: 0,
      dispatched: 0,
      skipped: 0,
      manualDispatched: 0,
    };
    const settled: Array<Promise<void>> = [];
    const inFlight: InFlightRun[] = [];
    let deps: AutomationDispatchDeps | null = null;
    const ensureDeps = async () => {
      deps ??= await (options?.resolveDispatchDeps?.(repo, log) ?? buildDispatchDeps(repo, log));
      return deps;
    };

    const claimed = await repo.claimDue(now, { localOnly: true });
    result.claimed = claimed.length;
    for (const automation of claimed) {
      const scheduledAt = automation.nextRunAt ?? automation.retryAt ?? now;
      const runId = `${automation.automationId}:${scheduledAt}`;
      const workspaceKey = resolveWorkspaceKey({
        workspacePath: automation.workspacePath,
        workspaceIdentity: automation.workspaceIdentity,
      });
      // 补跑上限：错过超过 24h 的窗口不追历史欠账（sleep 合并只补最新一次）。
      const isRetry = automation.dispatchAttempts > 0;
      const missedTooLong =
        !isRetry &&
        automation.nextRunAt != null &&
        automation.nextRunAt <= now - AUTOMATION_MISFIRE_OFF_TOO_LONG_MS;
      if (missedTooLong) {
        const finalize = isOneShotAutomation(automation);
        const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
        await repo.skipAndReschedule({
          automationId: automation.automationId,
          runId,
          workspaceKey,
          scheduledAt,
          reason: AUTOMATION_MISFIRE_OFF_TOO_LONG_REASON,
          nextRunAt,
          finalize,
        });
        result.skipped += 1;
        log(
          `skip missed-too-long automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
        );
        continue;
      }

      await repo.upsertRunClaimed({
        runId,
        automationId: automation.automationId,
        workspaceKey,
        scheduledAt,
        trigger: "schedule",
      });
      const run = await repo.getRun(runId);
      try {
        const dispatchDeps = await ensureDeps();
        const dispatch = await dispatchAutomationRun(
          {
            automationId: automation.automationId,
            runId,
            prompt: automation.prompt,
            modelSelection: run?.modelSelection ?? automation.modelSelection,
            mode: automation.mode,
            workspacePath: automation.workspacePath,
            ...(automation.workspaceIdentity
              ? { workspaceIdentity: automation.workspaceIdentity }
              : {}),
          },
          dispatchDeps,
        );
        inFlight.push({
          taskId: dispatch.taskId,
          workspacePath: automation.workspacePath,
          ...(automation.workspaceIdentity
            ? { workspaceIdentity: automation.workspaceIdentity }
            : {}),
        });
        const settleAt = Date.now();
        await repo.markRunDispatch({
          runId,
          dispatchStatus: "dispatched",
          sessionId: dispatch.sessionId,
        });
        const fresh = await repo.get(automation.automationId);
        const nextRunAt = fresh ? computeAutomationNextRunAt(fresh, settleAt) : null;
        await repo.markDispatched(automation.automationId, {
          dispatchedAt: settleAt,
          nextRunAt,
        });
        settled.push(dispatch.waitUntilSettled());
        result.dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repo.markRunDispatch({
          runId,
          dispatchStatus: "failed_to_dispatch",
          error: message,
        });
        const fresh = await repo.get(automation.automationId);
        await repo.markDispatchFailed(automation.automationId, {
          failedAt: Date.now(),
          error: message,
          kind: "transient",
          nextRunAt: fresh ? computeAutomationNextRunAt(fresh, Date.now()) : null,
        });
        log(`dispatch failed automation=${automation.automationId}: ${message}`);
      }
    }

    // manual run 认领（app 崩溃恢复 + tick 语境下的立即运行队列）。
    const manualRuns = await repo.claimManualRuns(Date.now(), { localOnly: true });
    for (const claimed1 of manualRuns) {
      try {
        const dispatchDeps = await ensureDeps();
        const dispatch = await dispatchManualAutomationRun(
          { automation: claimed1.automation, run: claimed1.run },
          dispatchDeps,
        );
        inFlight.push({
          taskId: dispatch.taskId,
          workspacePath: claimed1.automation.workspacePath,
          ...(claimed1.automation.workspaceIdentity
            ? { workspaceIdentity: claimed1.automation.workspaceIdentity }
            : {}),
        });
        settled.push(dispatch.waitUntilSettled());
        result.manualDispatched += 1;
      } catch (error) {
        log(
          `manual dispatch failed automation=${claimed1.automation.automationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (deps) {
      await awaitRunSettlement(settled, inFlight, deps, log);
    }
    return result;
  } finally {
    repo.close();
    configRepo.close();
  }
}

// ---- 管理动词 ----

export interface AutomationCliOptions {
  dbPath?: string;
  stdout?: (text: string) => void;
}

function jsonOut(options: AutomationCliOptions, value: unknown): void {
  (options.stdout ?? console.log)(JSON.stringify(value, null, 2));
}

function printAutomationRow(automation: ZCodeAutomation): string {
  const status = automation.enabled
    ? automation.lifecycleStatus
    : (automation.lifecycleStatus ?? "paused");
  const next = automation.nextRunAt ? new Date(automation.nextRunAt).toISOString() : "-";
  const last = automation.lastRunAt ? new Date(automation.lastRunAt).toISOString() : "-";
  return `${automation.automationId}\t${status}\t${next}\t${last}\t${automation.runCount}\t${automation.title}`;
}

export async function listAutomations(options: AutomationCliOptions & { json?: boolean }) {
  const service = new AutomationService(new AutomationRepo(options.dbPath));
  const automations = await service.list();
  if (options.json) return jsonOut(options, automations);
  (options.stdout ?? console.log)(
    ["ID\tSTATUS\tNEXT\tLAST\tRUNS\tTITLE", ...automations.map(printAutomationRow)].join("\n"),
  );
}

export async function showAutomation(id: string, options: AutomationCliOptions & { json?: boolean }) {
  const repo = new AutomationRepo(options.dbPath);
  const automation = await repo.get(id);
  repo.close();
  if (!automation) throw new Error(`automation 不存在: ${id}`);
  if (options.json) return jsonOut(options, automation);
  (options.stdout ?? console.log)(JSON.stringify(automation, null, 2));
}

export async function listAutomationRuns(
  id: string,
  options: AutomationCliOptions & { json?: boolean },
) {
  const repo = new AutomationRepo(options.dbPath);
  const runs = await repo.listRuns(id);
  repo.close();
  if (options.json) return jsonOut(options, runs);
  (options.stdout ?? console.log)(
    [
      "RUN_ID\tTRIGGER\tDISPATCH\tOUTCOME\tSESSION\tERROR",
      ...runs.map(
        (run) =>
          `${run.runId}\t${run.trigger}\t${run.dispatchStatus}\t${run.outcome ?? "-"}\t${run.sessionId ?? "-"}\t${run.error ?? "-"}`,
      ),
    ].join("\n"),
  );
}

export async function setAutomationPaused(id: string, paused: boolean, options: AutomationCliOptions) {
  const service = new AutomationService(new AutomationRepo(options.dbPath));
  await service.setEnabled(id, !paused);
  (options.stdout ?? console.log)(paused ? `paused ${id}` : `resumed ${id}`);
}

export async function deleteAutomationById(id: string, options: AutomationCliOptions) {
  const service = new AutomationService(new AutomationRepo(options.dbPath));
  const deleted = await service.delete(id);
  if (!deleted) throw new Error(`automation 不存在: ${id}`);
  (options.stdout ?? console.log)(`deleted ${id}`);
}

/** 立即运行一次：runNow 单飞认领后内联派发并等待终态（与 app 内 Run now 同一实现）。 */
export async function runAutomationNow(id: string, options: AutomationCliOptions) {
  const repo = new AutomationRepo(options.dbPath);
  const service = new AutomationService(repo);
  try {
    const claimed = await service.runNow(id);
    if (!claimed) {
      throw new Error(`无法认领（不存在或已有派发在途）: ${id}`);
    }
    const deps = await buildDispatchDeps(repo, (message) =>
      (options.stdout ?? console.log)(`[automation-run] ${message}`),
    );
    const dispatch = await dispatchManualAutomationRun(
      { automation: claimed.automation, run: claimed.run },
      deps,
    );
    (options.stdout ?? console.log)(`dispatched task=${dispatch.taskId} runId=${claimed.run.runId}`);
    await awaitRunSettlement(
      [dispatch.waitUntilSettled()],
      [
        {
          taskId: dispatch.taskId,
          workspacePath: claimed.automation.workspacePath,
          ...(claimed.automation.workspaceIdentity
            ? { workspaceIdentity: claimed.automation.workspaceIdentity }
            : {}),
        },
      ],
      deps,
      (message) => (options.stdout ?? console.log)(`[automation-run] ${message}`),
    );
    const run = await repo.getRun(claimed.run.runId);
    (options.stdout ?? console.log)(
      `outcome=${run?.outcome ?? "unknown"} sessionId=${run?.sessionId ?? "-"}`,
    );
  } finally {
    repo.close();
  }
}

export interface AutomationSchedulingStatusView {
  config: ZCodeAutomationSchedulingConfig;
  registration: AutomationRegistrarStatus;
  counts: { total: number; active: number; paused: number; terminal: number };
  /** mode=system 但注册缺失/心跳陈旧时的诊断提示。 */
  warnings: string[];
}

export async function getAutomationSchedulingStatus(
  options: AutomationCliOptions & {
    registrar?: AutomationRegistrar;
  } = {},
): Promise<AutomationSchedulingStatusView> {
  const repo = new AutomationRepo(options.dbPath);
  const configRepo = new AutomationConfigRepo(options.dbPath);
  try {
    await repo.ensureReady();
    await configRepo.ensureReady();
    const config = await configRepo.getConfig();
    const registrar = options.registrar ?? createPlatformRegistrar();
    const registration = await registrar.status();
    const automations = await repo.list();
    const counts = {
      total: automations.length,
      active: automations.filter((a) => a.enabled && a.lifecycleStatus === "active").length,
      paused: automations.filter((a) => !a.enabled).length,
      terminal: automations.filter(
        (a) => a.lifecycleStatus === "completed" || a.lifecycleStatus === "failed",
      ).length,
    };
    const warnings: string[] = [];
    if (config.mode === "system" && !registration.installed) {
      warnings.push("mode=system 但 OS 注册缺失；运行 enable 重新安装（自愈）");
    }
    if (
      config.mode === "system" &&
      config.lastTickAt != null &&
      Date.now() - config.lastTickAt > 5 * 60_000
    ) {
      warnings.push(
        `last tick 陈旧（${new Date(config.lastTickAt).toISOString()}）；注册可能未在运行`,
      );
    }
    return { config, registration, counts, warnings };
  } finally {
    repo.close();
    configRepo.close();
  }
}

export async function enableSystemScheduling(
  options: {
    dbPath?: string;
    runnerEntry?: string;
    preferCronFallback?: boolean;
    registrar?: AutomationRegistrar;
    stdout?: (text: string) => void;
  } = {},
): Promise<void> {
  const say = options.stdout ?? console.log;
  const registrar =
    options.registrar ?? createPlatformRegistrar({ preferCronFallback: options.preferCronFallback });
  const tick = resolveTickCommand({ runnerEntry: options.runnerEntry });
  await registrar.install(tick);
  const configRepo = new AutomationConfigRepo(options.dbPath);
  try {
    await configRepo.ensureReady();
    await configRepo.setMode("system", { registrationKind: registrar.kind });
  } finally {
    configRepo.close();
  }
  say(`system scheduling enabled via ${registrar.kind}: ${tick.command} ${tick.args.join(" ")}`);
}

export async function disableSystemScheduling(
  options: {
    dbPath?: string;
    registrar?: AutomationRegistrar;
    stdout?: (text: string) => void;
  } = {},
): Promise<void> {
  const say = options.stdout ?? console.log;
  const registrar = options.registrar ?? createPlatformRegistrar();
  await registrar.uninstall();
  const configRepo = new AutomationConfigRepo(options.dbPath);
  try {
    await configRepo.ensureReady();
    await configRepo.setMode("app");
  } finally {
    configRepo.close();
  }
  say("system scheduling disabled; automations run only while the app is running (app mode)");
}

const USAGE = `usage: zcode automation <verb> [args]

verbs:
  tick                          run one detached scheduler tick (used by the OS registration)
  list [--json]                 list all automations across workspaces
  show <id> [--json]            show one automation
  runs <id> [--json]            list run history for one automation
  pause <id> / resume <id>      pause / resume
  delete <id>                   delete
  run <id>                      run once now and wait for the outcome
  status [--json]               scheduling mode, OS registration, last tick, counts
  enable [--runner-entry <p>] [--cron-fallback]   install the OS job and switch to system mode
  disable                       remove the OS job and return to app mode

env: ZCODE_AUTOMATION_DB_PATH overrides the tasks-index sqlite path (testing).`;

/** CLI 入口：desktop bundle 与 `zcode automation` 委托共用。返回进程退出码。 */
export async function runAutomationRunnerCli(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const dbPath = process.env.ZCODE_AUTOMATION_DB_PATH;
  const VALUE_FLAGS = new Set(["--runner-entry"]);
  const has = (flag: string) => rest.includes(flag);
  const value = (flag: string) => {
    const index = rest.indexOf(flag);
    return index >= 0 ? (rest[index + 1] ?? null) : null;
  };
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  const id = positional[0] ?? null;
  try {
    switch (verb) {
      case undefined:
      case "help":
        console.log(USAGE);
        return 0;
      case "tick": {
        const result = await runAutomationTick({ dbPath });
        console.log(JSON.stringify(result));
        return 0;
      }
      case "list":
        await listAutomations({ dbPath, json: has("--json") });
        return 0;
      case "show":
        if (!id) throw new Error("show 需要 automation id");
        await showAutomation(id, { dbPath, json: has("--json") });
        return 0;
      case "runs":
        if (!id) throw new Error("runs 需要 automation id");
        await listAutomationRuns(id, { dbPath, json: has("--json") });
        return 0;
      case "pause":
        if (!id) throw new Error("pause 需要 automation id");
        await setAutomationPaused(id, true, { dbPath });
        return 0;
      case "resume":
        if (!id) throw new Error("resume 需要 automation id");
        await setAutomationPaused(id, false, { dbPath });
        return 0;
      case "delete":
        if (!id) throw new Error("delete 需要 automation id");
        await deleteAutomationById(id, { dbPath });
        return 0;
      case "run":
        if (!id) throw new Error("run 需要 automation id");
        await runAutomationNow(id, { dbPath });
        return 0;
      case "status": {
        const view = await getAutomationSchedulingStatus({ dbPath });
        if (has("--json")) {
          console.log(JSON.stringify(view, null, 2));
        } else {
          console.log(
            [
              `mode: ${view.config.mode}`,
              `registration: ${view.registration.installed ? "installed" : "missing"} (${view.registration.kind}${view.registration.detail ? `; ${view.registration.detail}` : ""})`,
              view.config.lastTickAt
                ? `last tick: ${new Date(view.config.lastTickAt).toISOString()}`
                : "last tick: never",
              `automations: ${view.counts.total} total, ${view.counts.active} active, ${view.counts.paused} paused, ${view.counts.terminal} terminal`,
              ...view.warnings.map((warning) => `warning: ${warning}`),
            ].join("\n"),
          );
        }
        return 0;
      }
      case "enable": {
        await enableSystemScheduling({
          dbPath,
          runnerEntry: value("--runner-entry") ?? undefined,
          preferCronFallback: has("--cron-fallback"),
        });
        return 0;
      }
      case "disable":
        await disableSystemScheduling({ dbPath });
        return 0;
      default:
        console.error(`未知动词: ${verb}`);
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

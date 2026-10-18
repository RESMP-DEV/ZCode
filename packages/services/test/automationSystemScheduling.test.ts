// 系统级调度（specs/automation-system-scheduling.md）单测：
// 迁移 0006、automation_config kv、claimDue localOnly、detached tick（补跑上限/派发/终态结算）、
// registrar 命令构造与 launchd 安装幂等、共享派发核心（automationDispatch）。
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_MISFIRE_OFF_TOO_LONG_REASON,
  type ModelSelection,
  type ZCodeTaskTerminalOutcome,
} from "@zcode/shared";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";
import { AutomationConfigRepo } from "../src/session/automationConfigRepo.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  dispatchAutomationRun,
  dispatchManualAutomationRun,
  type AutomationDispatchDeps,
} from "../src/zcode-agent/automationDispatch.js";
import {
  runAutomationTick,
  enableSystemScheduling,
  getAutomationSchedulingStatus,
} from "../src/automation-runner/index.js";
import {
  AUTOMATION_SCHEDULER_LABEL,
  buildCrontabLine,
  buildLaunchdPlistContent,
  buildSchtasksCreateArgs,
  buildSystemdTimerContent,
  buildSystemdUnitContent,
  buildWindowsTickShimContent,
  createLaunchdRegistrar,
  resolveTickCommand,
} from "../src/automation-runner/registrar.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SELECTION: ModelSelection = {
  providerId: "fake",
  modelId: "fake-model",
  options: { reasoningLevel: "high" },
};

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-automation-scheduling-"));
  try {
    await run(join(root, "tasks-index.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function openRaw(dbPath: string): Promise<InstanceType<typeof DatabaseSync>> {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
}

async function createAutomation(
  dbPath: string,
  params: { automationId?: string; recurring?: boolean } = {},
): Promise<string> {
  const service = new AutomationService(new AutomationRepo(dbPath));
  const automation = await service.create({
    title: "t",
    cronExpr: "* * * * *",
    prompt: "p",
    workspacePath: "/w",
    recurring: params.recurring ?? true,
  });
  return automation.automationId;
}

// ---- 迁移 0006 ----

describe("迁移 0006：系统级调度", () => {
  const databases: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("全新库创建 automation_config 且默认 app 模式；ledger 幂等", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    expect(
      db.prepare("SELECT value FROM automation_config WHERE key='system_scheduling_mode'").get(),
    ).toEqual({ value: "app" });
    const before = db.prepare("SELECT * FROM tasks_schema_migration").all();
    runTasksDatabaseMigrations(db);
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(before);
  });

  it("存量会话绑定退役：target_task_id 与 cron_automation_id 镜像一次性清除", () => {
    const db = open();
    runTasksDatabaseMigrations(db);
    db.prepare("DELETE FROM tasks_schema_migration WHERE id='0006_automation_system_scheduling'").run();
    db.exec(
      `INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path, target_task_id, created_at, updated_at)
       VALUES ('a1', 't', '* * * * *', 'p', '/w', '/w', 'task-bound', 1, 1)`,
    );
    db.exec(
      `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at, cron_automation_id)
       VALUES ('/w', '/w', 'task-bound', 't', 1, 1, 'a1')`,
    );
    runTasksDatabaseMigrations(db);
    expect(
      db.prepare("SELECT target_task_id FROM automations WHERE automation_id='a1'").get(),
    ).toEqual({ target_task_id: null });
    expect(
      db.prepare("SELECT cron_automation_id FROM tasks WHERE task_id='task-bound'").get(),
    ).toEqual({ cron_automation_id: null });
  });
});

// ---- automation_config kv ----

describe("AutomationConfigRepo", () => {
  it("默认 app；setMode/touchLastTick 回读", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      expect(await repo.getMode()).toBe("app");
      await repo.setMode("system", { registrationKind: "launchd" });
      const config = await repo.getConfig();
      expect(config.mode).toBe("system");
      expect(config.registrationKind).toBe("launchd");
      expect(config.enabledAt).toBeGreaterThan(0);
      const tickAt = Date.now();
      await repo.touchLastTick(tickAt);
      expect((await repo.getConfig()).lastTickAt).toBe(tickAt);
      await repo.setMode("app");
      expect(await repo.getMode()).toBe("app");
      expect((await repo.getConfig()).disabledAt).toBeGreaterThan(0);
      repo.close();
    });
  });
});

// ---- claimDue localOnly ----

describe("claimDue localOnly", () => {
  it("remote 行不被 detached runner 认领", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      await repo.ensureReady();
      const localId = await createAutomation(dbPath);
      const remoteId = await createAutomation(dbPath);
      const raw = await openRaw(dbPath);
      const past = Date.now() - 60_000;
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(past, localId);
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(past, remoteId);
      const config = new AutomationConfigRepo(dbPath);
      await config.ensureReady();
      await config.setMode("system");
      config.close();
      const claimedAll = await repo.claimDue(Date.now());
      expect(claimedAll.map((a) => a.automationId).sort()).toEqual([localId, remoteId].sort());
      for (const claimed of claimedAll) {
        await repo.releaseClaim(claimed.automationId);
      }
      raw.prepare("UPDATE automations SET location_kind = 'remote' WHERE automation_id = ?").run(remoteId);
      const claimedLocal = await repo.claimDue(Date.now(), { localOnly: true });
      expect(claimedLocal.map((a) => a.automationId)).toEqual([localId]);
      repo.close();
      raw.close();
    });
  });
});

// ---- detached tick ----

interface TickEventLog {
  events: Array<{ kind: string; detail?: unknown }>;
  fireTerminal: (inputId: string, outcome: ZCodeTaskTerminalOutcome["outcome"]) => void;
  deps: AutomationDispatchDeps;
}

function buildFakeDispatch(
  log: string[],
  options: { autoFireOutcome?: ZCodeTaskTerminalOutcome["outcome"] } = {},
): TickEventLog {
  const subscribers: Array<(result: ZCodeTaskTerminalOutcome) => void> = [];
  let taskSeq = 0;
  const deps = {
    repo: null as unknown as AutomationDispatchDeps["repo"],
    zcodeTaskService: {
      async createTask(params: Record<string, unknown>) {
        taskSeq += 1;
        const taskId = `task-${taskSeq}`;
        log.push(`createTask:${params.automationId}:${taskId}`);
        return { taskId };
      },
      async sendPrompt(params: Record<string, unknown>) {
        log.push(`sendPrompt:${params.taskId}:${params.traceId}`);
        // tick 会 await 终态落账后才返回；自动模式下 sendPrompt 后立刻触发终态事件。
        if (options.autoFireOutcome) {
          queueMicrotask(() => {
            for (const callback of subscribers) {
              callback({
                taskId: String(params.taskId),
                inputId: String(params.traceId),
                outcome: options.autoFireOutcome!,
              });
            }
          });
        }
      },
      onDynamicTaskTerminalOutcome(_taskId: string) {
        return (callback: (result: ZCodeTaskTerminalOutcome) => void) => {
          subscribers.push(callback);
          return { dispose() {} };
        };
      },
      async setTaskUnread(params: Record<string, unknown>) {
        log.push(`unread:${params.taskId}`);
      },
      async stopGeneration(params: Record<string, unknown>) {
        log.push(`stop:${params.taskId}`);
      },
    },
    modelSelectionService: {
      async getView() {
        return {
          preferredSelection: SELECTION,
          effectiveSelection: SELECTION,
          selectionIssue: null,
        };
      },
    },
    logWarn: (message: string) => log.push(`warn:${message}`),
    logInfo: (message: string) => log.push(`info:${message}`),
  } as unknown as AutomationDispatchDeps;
  return {
    events: [],
    deps,
    fireTerminal(inputId, outcome) {
      for (const callback of subscribers) {
        callback({ taskId: "task-1", inputId, outcome });
      }
    },
  };
}

describe("runAutomationTick", () => {
  it("app 模式完整让位：不构建派发栈", async () => {
    await withTempDb(async (dbPath) => {
      const automationId = await createAutomation(dbPath);
      const raw = await openRaw(dbPath);
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(
        Date.now() - 60_000,
        automationId,
      );
      raw.close();
      const log: string[] = [];
      const result = await runAutomationTick({
        dbPath,
        log: () => log.push("tick"),
        resolveDispatchDeps: () => {
          throw new Error("app 模式不应构建派发栈");
        },
      });
      expect(result).toEqual({ mode: "app", claimed: 0, dispatched: 0, skipped: 0, manualDispatched: 0 });
    });
  });

  it("system 模式派发 due 行：fresh session + runId traceId + 终态落账后推进", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      const configRepo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      await configRepo.ensureReady();
      await configRepo.setMode("system");
      const automationId = await createAutomation(dbPath);
      const scheduledAt = Date.now() - 30_000;
      const raw = await openRaw(dbPath);
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(
        scheduledAt,
        automationId,
      );
      raw.close();
      const log: string[] = [];
      const fake = buildFakeDispatch(log, { autoFireOutcome: "succeeded" });
      const result = await runAutomationTick({
        dbPath,
        resolveDispatchDeps: async (tickRepo) => {
          fake.deps.repo = tickRepo;
          return fake.deps;
        },
        log: () => undefined,
      });
      expect(result.mode).toBe("system");
      expect(result.claimed).toBe(1);
      expect(result.dispatched).toBe(1);
      expect(result.skipped).toBe(0);
      const runId = `${automationId}:${scheduledAt}`;
      expect(log).toContain(`createTask:${automationId}:task-1`);
      expect(log).toContain(`sendPrompt:task-1:${runId}`);
      // tick 返回即代表终态已落账（autoFireOutcome 在 sendPrompt 后触发）。
      const run = await repo.getRun(runId);
      expect(run?.dispatchStatus).toBe("dispatched");
      expect(run?.sessionId).toBe("task-1");
      expect(run?.outcome).toBe("succeeded");
      expect(log).toContain("unread:task-1");
      const automation = await repo.get(automationId);
      expect(automation?.nextRunAt).toBeGreaterThan(scheduledAt);
      repo.close();
      configRepo.close();
    });
  });

  it("错过超过 24h 记 skipped（machine_off_too_long）；一次性任务直接终态", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      const configRepo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      await configRepo.ensureReady();
      await configRepo.setMode("system");
      const recurringId = await createAutomation(dbPath);
      const oneShotId = await createAutomation(dbPath, { recurring: false });
      const stale = Date.now() - 25 * DAY_MS;
      const raw = await openRaw(dbPath);
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(stale, recurringId);
      raw.prepare("UPDATE automations SET next_run_at = ? WHERE automation_id = ?").run(stale, oneShotId);
      raw.close();
      const result = await runAutomationTick({
        dbPath,
        resolveDispatchDeps: () => {
          throw new Error("超限补跑不应派发");
        },
        log: () => undefined,
      });
      expect(result.skipped).toBe(2);
      expect(result.dispatched).toBe(0);
      const recurring = await repo.get(recurringId);
      expect(recurring?.nextRunAt).toBeGreaterThan(Date.now() - 60_000);
      expect(recurring?.enabled).toBe(true);
      const oneShot = await repo.get(oneShotId);
      expect(oneShot?.lifecycleStatus).toBe("completed");
      expect(oneShot?.nextRunAt).toBeUndefined();
      const skippedRun = await repo.getRun(`${recurringId}:${stale}`);
      expect(skippedRun?.dispatchStatus).toBe("skipped");
      expect(skippedRun?.error).toBe(AUTOMATION_MISFIRE_OFF_TOO_LONG_REASON);
      repo.close();
      configRepo.close();
    });
  });
});

// ---- registrar ----

describe("registrar 命令构造", () => {
  const tick = {
    command: "/usr/bin/electron",
    args: ["/Applications/ZCode Preview.app/Contents/Resources/automation-runner/index.js", "tick"],
    env: { ELECTRON_RUN_AS_NODE: "1", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/zcode-builtin.json" },
    cwd: "/Applications/ZCode Preview.app/Contents/Resources",
  };

  it("launchd plist：label、30s StartInterval、ProgramArguments 与 env 固化", () => {
    const plist = buildLaunchdPlistContent(tick);
    expect(plist).toContain(`<string>${AUTOMATION_SCHEDULER_LABEL}</string>`);
    expect(plist).toContain("<integer>30</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("/Applications/ZCode Preview.app/Contents/Resources/automation-runner/index.js");
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(plist).toContain("<key>ZCODE_BUILTIN_PROVIDER_CONFIG_FILE</key>");
  });

  it("systemd unit/timer：ExecStart 引号转义 + Persistent", () => {
    const unit = buildSystemdUnitContent(tick);
    expect(unit).toContain(`ExecStart=${JSON.stringify(tick.command)} ${JSON.stringify(tick.args[0])}`);
    expect(unit).toContain("Environment=ELECTRON_RUN_AS_NODE=");
    expect(buildSystemdTimerContent()).toContain("Persistent=true");
  });

  it("crontab 行单行且带 label；schtasks 与 Windows shim 构造", () => {
    const line = buildCrontabLine(tick);
    expect(line).not.toContain("\n");
    expect(line).toContain(`# ${AUTOMATION_SCHEDULER_LABEL}`);
    expect(buildSchtasksCreateArgs("C:\\shim.cmd")).toContain("/TN");
    const shim = buildWindowsTickShimContent(tick);
    expect(shim).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(shim).toContain("\"tick\"");
  });

  it("resolveTickCommand：Electron 语境注入 ELECTRON_RUN_AS_NODE 并透传 provider 配置", () => {
    const originalProvider = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    try {
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "/tmp/provider.json";
      const resolved = resolveTickCommand({
        runnerEntry: "/opt/automation-runner/index.js",
        isElectron: true,
      });
      expect(resolved.args).toEqual(["/opt/automation-runner/index.js", "tick"]);
      expect(resolved.env).toEqual({
        ELECTRON_RUN_AS_NODE: "1",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/tmp/provider.json",
      });
      expect(resolved.cwd).toBe("/opt");
    } finally {
      if (originalProvider === undefined) {
        delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      } else {
        process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = originalProvider;
      }
    }
  });

  it("launchd registrar：install 写 plist + bootstrap；uninstall 禁用；status 反映", async () => {
    await withTempDb(async (dbPath) => {
      const plistPath = join(dbPath, "..", "com.zcode.automations-test.plist");
      const calls: string[] = [];
      const registrar = createLaunchdRegistrar({
        plistPath,
        runCommand: (command, args) => {
          calls.push(`${command} ${args.join(" ")}`);
          return { ok: true, output: "" };
        },
      });
      await registrar.install(tick);
      const plist = readFileSync(plistPath, "utf8");
      expect(plist).toContain(`<string>${AUTOMATION_SCHEDULER_LABEL}</string>`);
      expect(calls.some((call) => call.includes("launchctl bootstrap"))).toBe(true);
      expect((await registrar.status()).installed).toBe(true);
      await registrar.uninstall();
      expect(readFileSync(`${plistPath}.disabled`, "utf8")).toContain(AUTOMATION_SCHEDULER_LABEL);
    });
  });
});

// ---- enable / status ----

describe("enableSystemScheduling / status", () => {
  it("enable 安装注册并落 mode=system；status 汇总注册与计数", async () => {
    await withTempDb(async (dbPath) => {
      const configRepo = new AutomationConfigRepo(dbPath);
      await configRepo.ensureReady();
      const plistPath = join(dbPath, "..", "com.zcode.automations-test.plist");
      const registrar = createLaunchdRegistrar({
        plistPath,
        runCommand: () => ({ ok: true, output: "" }),
      });
      await enableSystemScheduling({ dbPath, registrar, stdout: () => undefined });
      expect(await configRepo.getMode()).toBe("system");
      const status = await getAutomationSchedulingStatus({ dbPath, registrar });
      expect(status.config.mode).toBe("system");
      expect(status.registration.installed).toBe(true);
      expect(status.registration.kind).toBe("launchd");
      expect(status.counts.total).toBe(0);
      configRepo.close();
    });
  });
});

// ---- 共享派发核心 ----

describe("automationDispatch 共享核心", () => {
  it("schedule 派发：固定选择、fresh createTask、runId traceId、终态回写与未读", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      const configRepo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      await configRepo.ensureReady();
      const automationId = await createAutomation(dbPath);
      const runId = `${automationId}:${Date.now()}`;
      await repo.upsertRunClaimed({
        runId,
        automationId,
        workspaceKey: "/w",
        scheduledAt: Date.now(),
        trigger: "schedule",
      });
      const log: string[] = [];
      const fake = buildFakeDispatch(log);
      fake.deps.repo = repo;
      const dispatch = await dispatchAutomationRun(
        {
          automationId,
          runId,
          prompt: "hello",
          workspacePath: "/w",
        },
        fake.deps,
      );
      expect(dispatch.taskId).toBe("task-1");
      expect(log).toContain(`createTask:${automationId}:task-1`);
      expect(log).toContain(`sendPrompt:task-1:${runId}`);
      const run = await repo.getRun(runId);
      expect(run?.modelSelection?.modelId).toBe("fake-model");
      fake.fireTerminal(runId, "failed");
      await dispatch.waitUntilSettled();
      expect((await repo.getRun(runId))?.outcome).toBe("failed");
      expect(log).toContain("unread:task-1");
      repo.close();
      configRepo.close();
    });
  });

  it("session 创建遥测：sendPrompt accepted 后才上报；首 Send 拒绝不 Report", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      const configRepo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      await configRepo.ensureReady();
      const automationId = await createAutomation(dbPath);
      const runId = `${automationId}:${Date.now()}`;
      await repo.upsertRunClaimed({
        runId,
        automationId,
        workspaceKey: "/w",
        scheduledAt: Date.now(),
        trigger: "schedule",
      });
      const log: string[] = [];
      const fake = buildFakeDispatch(log);
      fake.deps.repo = repo;
      const reported: string[] = [];
      const deps: AutomationDispatchDeps = {
        ...fake.deps,
        onSessionCreate: (event) => reported.push(event.sessionId),
      };
      let accept: (() => void) | null = null;
      (deps.zcodeTaskService as unknown as { sendPrompt: unknown }).sendPrompt =
        (): Promise<void> =>
          new Promise<void>((resolve) => {
            accept = resolve;
          });
      const dispatchPromise = dispatchAutomationRun(
        { automationId, runId, prompt: "hello", workspacePath: "/w" },
        deps,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(reported).toEqual([]);
      accept?.();
      await dispatchPromise;
      expect(reported).toEqual(["task-1"]);

      // 首条 prompt 被拒：派发失败，不报告 session 创建。
      const rejectedReported: string[] = [];
      const rejectedRunId = `${automationId}:${Date.now() + 1}`;
      await repo.upsertRunClaimed({
        runId: rejectedRunId,
        automationId,
        workspaceKey: "/w",
        scheduledAt: Date.now(),
        trigger: "schedule",
      });
      const rejectDeps: AutomationDispatchDeps = {
        ...fake.deps,
        repo,
        onSessionCreate: (event) => rejectedReported.push(event.sessionId),
      };
      (rejectDeps.zcodeTaskService as unknown as { sendPrompt: unknown }).sendPrompt =
        async (): Promise<void> => {
          throw new Error("rejected");
        };
      await expect(
        dispatchAutomationRun(
          { automationId, runId: rejectedRunId, prompt: "hello", workspacePath: "/w" },
          rejectDeps,
        ),
      ).rejects.toThrow("rejected");
      expect(rejectedReported).toEqual([]);
      repo.close();
      configRepo.close();
    });
  });

  it("manual 派发失败：结算 failed_to_dispatch 并释放 single-flight 锁", async () => {
    await withTempDb(async (dbPath) => {
      const repo = new AutomationRepo(dbPath);
      const configRepo = new AutomationConfigRepo(dbPath);
      await repo.ensureReady();
      await configRepo.ensureReady();
      const automationId = await createAutomation(dbPath);
      const claimed = await repo.runNow(automationId, { now: Date.now() });
      expect(claimed).not.toBeNull();
      const log: string[] = [];
      const fake = buildFakeDispatch(log);
      fake.deps.repo = repo;
      // 派发抛错（模型选择不可用路径由 createTask 抛出模拟）。
      (fake.deps.zcodeTaskService as unknown as { createTask: unknown }).createTask =
        async () => {
          throw new Error("spawn failed");
        };
      await expect(
        dispatchManualAutomationRun(
          { automation: claimed!.automation, run: claimed!.run },
          fake.deps,
        ),
      ).rejects.toThrow("spawn failed");
      const run = await repo.getRun(claimed!.run.runId);
      expect(run?.dispatchStatus).toBe("failed_to_dispatch");
      expect(run?.error).toContain("spawn failed");
      const raw = await openRaw(dbPath);
      const row = raw.prepare("SELECT running FROM automations WHERE automation_id = ?").get(
        automationId,
      ) as { running: number };
      expect(row.running).toBe(0);
      raw.close();
      repo.close();
      configRepo.close();
    });
  });
});

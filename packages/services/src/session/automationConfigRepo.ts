import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  ZCodeAutomationSchedulingConfig,
  ZCodeAutomationSchedulingMode,
  ZCodeAutomationSchedulingRegistrationKind,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const MODE_KEY = "system_scheduling_mode";
const REGISTRATION_KIND_KEY = "system_scheduling_registration_kind";
const ENABLED_AT_KEY = "system_scheduling_enabled_at";
const DISABLED_AT_KEY = "system_scheduling_disabled_at";
const LAST_TICK_AT_KEY = "system_scheduling_last_tick_at";

/**
 * 系统级调度配置仓库：tasks-index 的 automation_config kv 表（specs/automation-system-scheduling.md）。
 * 是调度模式的唯一事实源——app 内 scheduler 每轮 tick 读取决定是否让位，runner tick 读取
 * last_tick 诊断注册健康。与 AutomationRepo 相同的初始化/迁移协调与构造期固定 dbPath 测试注入。
 */
export class AutomationConfigRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    // runTasksDatabaseMigrations 合并后为异步（上游备份/journal 语义）：不 await 会在
    // automation_config 建表完成前就返回，随后的 read 抛 no such table。与
    // AutomationRepo.initialize 的等待约定一致，并把 dbPath 传给备份目录推导。
    if (!isTasksStorageMigrated(path, this.db)) await runTasksDatabaseMigrations(this.db, path);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationConfigRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  private read(key: string): string | null {
    const row = this.getDatabase()
      .prepare("SELECT value FROM automation_config WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private write(key: string, value: string, now: number): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  private static parseEpoch(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  async getConfig(): Promise<ZCodeAutomationSchedulingConfig> {
    await this.ensureReady();
    const mode = this.read(MODE_KEY);
    const registrationKind = this.read(REGISTRATION_KIND_KEY);
    return {
      mode: mode === "system" ? "system" : "app",
      ...(registrationKind ? { registrationKind: registrationKind as ZCodeAutomationSchedulingRegistrationKind } : {}),
      enabledAt: AutomationConfigRepo.parseEpoch(this.read(ENABLED_AT_KEY)),
      disabledAt: AutomationConfigRepo.parseEpoch(this.read(DISABLED_AT_KEY)),
      lastTickAt: AutomationConfigRepo.parseEpoch(this.read(LAST_TICK_AT_KEY)),
    };
  }

  async getMode(): Promise<ZCodeAutomationSchedulingMode> {
    await this.ensureReady();
    return this.read(MODE_KEY) === "system" ? "system" : "app";
  }

  /** 启用/停用系统级调度；registrationKind 记录本次安装的注册方式供 status 诊断。 */
  async setMode(
    mode: ZCodeAutomationSchedulingMode,
    options?: { registrationKind?: ZCodeAutomationSchedulingRegistrationKind },
  ): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    if (mode === "system") {
      this.write(MODE_KEY, "system", now);
      this.write(ENABLED_AT_KEY, String(now), now);
      if (options?.registrationKind) {
        this.write(REGISTRATION_KIND_KEY, options.registrationKind, now);
      }
      return;
    }
    this.write(MODE_KEY, "app", now);
    this.write(DISABLED_AT_KEY, String(now), now);
  }

  /** runner 每次 tick 落账；UI/CLI 用它判断 OS 注册是否真的在跑。写入失败不阻断 tick。 */
  async touchLastTick(now: number): Promise<void> {
    await this.ensureReady();
    this.write(LAST_TICK_AT_KEY, String(now), now);
  }
}

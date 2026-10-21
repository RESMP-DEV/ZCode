import { TaskGroupRepository } from "#src/task-groups/index.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  normalizeAgentProviderToZCodeAgent,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";
// upstream v3.16.2 把分组域类型收进 task-groups 模块；grouped 视图排序的规范化
// 由 TaskGroupRepository 内部负责，repo 侧只保留 fork 的写入面辅助。
import type { TaskGroupColor as ZCodeTaskGroupColor } from "#src/task-groups/contract.js";

import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getZCodeDataRootDir } from "#src/paths.js";
import { projectStorage, type ProjectMigrationContext } from "#src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // Bugfix: ZCode Agent 列表入口只展示当前 glm runtime 产生的 task。
  // 旧 Claude Code 导入也不再例外，否则非 glm 历史数据仍会混入项目树与任务区。
  where.push("provider = ?");
  args.push(provider);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;
type SQLInputValue = import("node:sqlite").SQLInputValue;

interface TaskIndexRow {
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: "completed" | "interrupted" | "error" | null;
  cli_deleted?: number | null;
  handoff_pending?: number;

  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  archived_at: number | null;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
  // fork：searchableText 可空；传入 undefined 表示保留 existing 行的现有值。
  // applyAgentPatch / seedTaskMetaIfMissing 这类不带 messages 上下文的写入
  // 不能把已索引的正文清空。
  searchableText?: string;
}

// fork：patch 面保留完整可选键集。upstream v3.16.2 把状态写拆成 updateTaskState（紧凑 SQL）
// 与 updateTaskPresentation（meta_json）后，本接口仍是 applyAgentPatch / syncTaskMeta 族的
// 键缺席语义载体：键缺席 = 保留现值；显式 undefined = 清除。
interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  title?: string;
  titleOverridden?: boolean;
  unreadAt?: number;
  model?: string;
  status?: ZCodeTaskMeta["status"];
  lastError?: ZCodeTaskMeta["lastError"];
  target?: ZCodeTaskMeta["target"];
  // fork 语义保留：键缺席 = 保留现值；显式 undefined = 清除（终端态/对账路径依赖）。
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
  updatedAt?: number;
}

interface TaskGroupViewNodeOrderRow {
  node_type: "group" | "task";
  node_key: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface TaskGroupMemberRow {
  group_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  sort_order: number | null;
  added_at: number;
  created_at: number;
  updated_at: number;
}

interface WorkspaceBootstrapScope {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const GROUPED_TASK_ORDER_STEP = 1000;
const GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY = "__zcode_internal_grouped_workspace_bootstrap_once__";
const DEFAULT_TASK_GROUP_COLOR: ZCodeTaskGroupColor = "gray";
const WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] satisfies ZCodeTaskGroupColor[];
const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function taskOrderNodeKey(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): string {
  // task_group_view_node_orders.node_key 不能使用 "\u0000" 分隔；
  // node:sqlite 读 TEXT 时会截断 NUL 后面的 taskId，导致 grouped 视图排序写入后查询匹配不上。
  return JSON.stringify([workspaceKey(params), params.taskId]);
}

function shouldPreserveNewerTerminalStatus(
  existingMeta: ZCodeTaskMeta | null,
  incomingMeta: ZCodeTaskMeta,
): boolean {
  if (!existingMeta || !isTerminalTaskStatus(existingMeta.status)) {
    return false;
  }
  if (incomingMeta.status && incomingMeta.status !== "running") {
    return false;
  }
  return existingMeta.updatedAt > incomingMeta.updatedAt;
}

function workspaceGroupId(targetWorkspaceKey: string): string {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest("hex");
  return `workspace-group-${hash.slice(0, 24)}`;
}

function workspaceGroupTitle(workspacePath: string): string {
  const normalized = workspacePath.replace(/[\\/]+$/u, "");
  const leaf = normalized.split(/[\\/]/u).filter(Boolean).at(-1);
  return leaf?.trim() || normalized.trim() || "Workspace";
}

function workspaceGroupColor(targetWorkspaceKey: string): ZCodeTaskGroupColor {
  const hash = createHash("sha256").update(targetWorkspaceKey).digest();
  const colorIndex = hash.readUInt8(0) % WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS.length;
  return WORKSPACE_BOOTSTRAP_TASK_GROUP_COLORS[colorIndex] ?? DEFAULT_TASK_GROUP_COLOR;
}


function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const meta = readPresentation(row);
  return {
    ...meta,
    // 上游 v3.16.2 以 CLI 事实（cli_* 列）为标题/时间/终态的权威来源；CLI 事实缺席的
    // 行（fork sessions-index 种子行、CLI reconcile 落地前的存量行）回退 meta_json
    // 投影，避免读出空标题与 0 时间戳。cli_* 在场时行为与上游逐位一致。
    title: row.title_overridden === 1 ? row.title : (row.cli_title ?? meta.title ?? ""),
    titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
    createdAt: row.cli_created_at ?? meta.createdAt ?? row.created_at,
    updatedAt: row.cli_updated_at ?? meta.updatedAt ?? row.updated_at,
    // status 只承接 CLI 终态（cli_last_outcome，interrupted 映射 completed）：
    // sessions-index 的 running 是活动态不是持久结果，上游读取模型刻意不把它
    // 投影回 meta.status（syncer 不变式测试锁定该语义）；running 判定走 task_status 列。
    status:
      row.cli_last_outcome === "interrupted" ? "completed" : (row.cli_last_outcome ?? undefined),
  };
}

function readPresentation(row: TaskIndexRow): ZCodeTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // off-peak 身份同款策略：meta_json 为准、列兜底——存量迁移只写列即可生效。
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    logger.warn(
      undefined,
      `读取 task index meta_json 非法 taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    traceId: `zcode-${row.task_id}`,
    title: "",
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: 0,
    updatedAt: 0,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    // 旧行 provider 列可能残留三方 CLI 值；meta 回退投影时统一归一为 glm。
    provider: row.provider
      ? normalizeAgentProviderToZCodeAgent(row.provider as ZCodeTaskMeta["provider"])
      : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
  };
}

/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  const meta = rowToMeta(row);
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function migrateLegacyTaskMetaJson(
  rawMetaJson: string,
  fallback: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: string;
    provider?: string;
    model?: string;
    status?: ZCodeTaskMeta["status"];
  },
): ZCodeTaskMeta {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(rawMetaJson) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const meta = {
    ...parsed,
    taskId: fallback.taskId,
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId
        ? parsed.traceId
        : `zcode-${fallback.taskId}`,
    title: fallback.title,
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : fallback.createdAt,
    updatedAt: fallback.updatedAt,
    mode: typeof parsed.mode === "string" ? parsed.mode : fallback.mode,
    provider: typeof parsed.provider === "string" ? parsed.provider : fallback.provider,
    model: typeof parsed.model === "string" ? parsed.model : fallback.model,
    status: typeof parsed.status === "string" ? parsed.status : fallback.status,
    migrationSource: undefined,
  };
  return zcodeTaskMetaSchema.parse(meta) as ZCodeTaskMeta;
}

export class TaskIndexRepo {
  /** 启动迁移结果，供 main 提示；不参与任务事实或组织状态。 */
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly migrationSettings?: ProjectMigrationContext["settings"],
    private readonly storageHostId?: string,
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}

  /** Host 装配层共用迁移后的组织库；UI 只能通过 project/remote-projects 服务访问。 */
  private admitTaskGroup(meta: ZCodeTaskMeta, archived: boolean, deleted: boolean) {
    if (this.storageHostId && this.storageHostId !== "local") return;
    // 本机只登记本机事实；远程成员由控制端服务验证远端投影后写入。
    if (meta.workspaceIdentity?.trim()) return;
    new TaskGroupRepository(this.getDatabase()).admit([
      { ...meta, hostId: "local", archived, deleted },
    ]);
  }

  async getOrganizationDatabase() {
    await this.ensureReady();
    return this.getDatabase();
  }

  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    const taskMigration = await runTasksDatabaseMigrations(this.db, path);
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getZCodeDataRootDir(), "backup")],
      warn: (message, details) => createServiceLogger("project-migration").warn(message, details),
    });
    this.migrationBackupSkipped = taskMigration.backupSkipped || migration.backupSkipped;
    this.backfillOffPeakTaskMarkers();
    // Bugfix: z-code-2 早期列表 task_id 是 wrapper id，真实 ZCode session id 在旧列
    // acp_session_id。直接运行时映射会让 read/send/subscribe 到处变成双 ID 兜底；
    // 初始化时把索引行迁到真实 session id，后续统一走新协议正常路径。
    this.migrateLegacyAcpTaskIds();
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return columns.some((item) => item.name === column);
  }

  /**
   * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
   * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
   * join 只补投影列——rowToMeta 以列兜底即可生效，下次展示更新会回填 meta_json。
   * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    const hasOffPeakTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  private migrateLegacyAcpTaskIds(): void {
    if (!this.hasColumn("tasks", "acp_session_id")) {
      return;
    }

    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
      )
      .all() as unknown as LegacyAcpTaskIndexRow[];
    if (rows.length === 0) {
      return;
    }

    const findTarget = db.prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const updateRow = db.prepare(
      `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
    );
    const updateTarget = db.prepare(
      `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
    );
    const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

    db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = 0;
      for (const row of rows) {
        const nextTaskId = row.acp_session_id?.trim();
        if (!nextTaskId) {
          continue;
        }
        const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
        const merged = this.buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
        if (target) {
          updateTarget.run(merged);
          deleteOld.run(row.workspace_key, row.task_id);
        } else {
          updateRow.run({ ...merged, old_task_id: row.task_id });
        }
        migrated += 1;
      }
      db.exec("COMMIT");
      if (migrated > 0) {
        logger.info(undefined, `已迁移 legacy ACP task_id 到 ZCode session id 数量=${migrated}`);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private buildLegacyAcpMigratedRow(
    source: LegacyAcpTaskIndexRow,
    target: TaskIndexRow | null,
    taskId: string,
  ): Record<string, SQLInputValue> {
    const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
      taskId,
      workspacePath: source.workspace_path,
      workspaceIdentity: source.workspace_identity ?? undefined,
      title: source.title,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      mode: source.mode,
      provider: source.provider ?? undefined,
      model: source.model ?? undefined,
      status: source.task_status ? (source.task_status as ZCodeTaskMeta["status"]) : undefined,
    });
    if (!target) {
      return {
        workspace_key: source.workspace_key,
        task_id: taskId,
        title: source.title,
        task_status: source.task_status,
        provider: source.provider,
        mode: source.mode,
        model: source.model,
        migration_source: null,
        forked_from_task_id: source.forked_from_task_id,
        created_at: source.created_at,
        updated_at: source.updated_at,
        unread_at: source.unread_at,
        last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
        pinned: source.pinned,
        archived: source.archived,
        deleted: source.deleted,
        title_overridden: source.title_overridden,
        searchable_text: source.searchable_text,
        meta_json: JSON.stringify(sourceMeta),
      };
    }

    const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
      ...sourceMeta,
      taskId,
      workspacePath: target.workspace_path,
      workspaceIdentity: target.workspace_identity ?? undefined,
      title: target.title || source.title,
      createdAt: Math.min(target.created_at, source.created_at),
      updatedAt: Math.max(target.updated_at, source.updated_at),
      mode: target.mode || source.mode,
      provider: target.provider ?? source.provider ?? undefined,
      model: target.model ?? source.model ?? undefined,
      status: target.task_status
        ? (target.task_status as ZCodeTaskMeta["status"])
        : source.task_status
          ? (source.task_status as ZCodeTaskMeta["status"])
          : undefined,
    });
    const title = source.title_overridden === 1 ? source.title : target.title || source.title;
    const updatedAt = Math.max(target.updated_at, source.updated_at);
    const unreadAt =
      source.unread_at !== null && target.unread_at !== null
        ? Math.max(source.unread_at, target.unread_at)
        : (source.unread_at ?? target.unread_at);
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title,
      task_status: target.task_status ?? source.task_status,
      provider: target.provider ?? source.provider,
      mode: target.mode || source.mode,
      model: target.model ?? source.model,
      migration_source: null,
      forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
      created_at: Math.min(target.created_at, source.created_at),
      updated_at: updatedAt,
      unread_at: unreadAt,
      last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
      pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
      archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
      deleted: source.deleted === 1 ? 1 : target.deleted,
      title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
      searchable_text: target.searchable_text || source.searchable_text,
      meta_json: JSON.stringify({
        ...targetMeta,
        title,
        updatedAt,
        unreadAt: unreadAt ?? undefined,
        migrationSource: undefined,
      }),
    };
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private getNextGroupedTopSortOrder(): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT MIN(sort_order) AS min_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { min_sort_order: number | null } | undefined;
    return (row?.min_sort_order ?? GROUPED_TASK_ORDER_STEP * 2) - GROUPED_TASK_ORDER_STEP;
  }

  private upsertGroupedTopOrder(params: {
    nodeType: "group" | "task";
    nodeKey: string;
    sortOrder: number;
    now: number;
  }): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO task_group_view_node_orders (
          node_type,
          node_key,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_type, node_key) DO UPDATE SET
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
      )
      .run(params.nodeType, params.nodeKey, params.sortOrder, params.now, params.now);
  }

  async hasGroupedWorkspaceBootstrapRun(): Promise<boolean> {
    await this.ensureReady();
    return this.hasGroupedWorkspaceBootstrapRunSync();
  }

  async archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
    provider?: ZCodeProvider;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const normalizedDays = Math.max(1, Math.floor(params.olderThanDays));
    const cutoff = Date.now() - normalizedDays * 24 * 60 * 60 * 1000;
    const where = [
      "workspace_key = ?",
      "deleted = 0",
      "archived = 0",
      "pinned = 0",
      "unread_at IS NULL",
      "updated_at < ?",
      "task_status = 'completed'",
    ];
    const args: Array<string | number> = [workspaceKey(params), cutoff];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC, task_id DESC`,
      )
      .all(...args) as unknown as TaskIndexRow[];
    if (rows.length === 0) {
      return [];
    }
    // 防御：meta 仍带 pendingInteraction 的行视为「还有等用户处理的阻塞」，
    // 即使 task_status 已收敛为 completed 也不自动归档（两者理论上互斥，
    // 但导入行/旧数据可能不一致，归档必须保守）。
    const archivableRows = rows.filter((row) => rowToMeta(row).pendingInteraction == null);
    if (archivableRows.length === 0) {
      return [];
    }

    const archiveTask = this.getDatabase().prepare(
      // 自动归档不打 archived_at：这类行 updated_at 本就 ≥3 天，sweep 宽限
      // 仍按 updated_at 计（COALESCE 回退），保持到期即可清理的既有节奏。
      `UPDATE tasks
      SET archived = 1
      WHERE workspace_key = ? AND task_id = ?`,
    );
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const row of archivableRows) {
        archiveTask.run(row.workspace_key, row.task_id);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return archivableRows.map(rowToMeta);
  }

  /** 全库出现过的 workspace scope（去重），供周期自动归档 sweep 使用。 */
  async listWorkspaceScopes(): Promise<
    Array<{ workspacePath: string; workspaceIdentity?: string }>
  > {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(`SELECT DISTINCT workspace_path, workspace_identity FROM tasks WHERE deleted = 0`)
      .all() as unknown as Array<{ workspace_path: string; workspace_identity: string | null }>;
    const scopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
    for (const row of rows) {
      const workspacePath = row.workspace_path?.trim();
      if (!workspacePath) {
        continue;
      }
      const workspaceIdentity = row.workspace_identity?.trim() || undefined;
      const key = workspaceIdentity ?? workspacePath;
      if (!scopes.has(key)) {
        scopes.set(
          key,
          workspaceIdentity ? { workspacePath, workspaceIdentity } : { workspacePath },
        );
      }
    }
    return [...scopes.values()];
  }

  /** 跨全部 workspace 的「需要处理」候选，供待办摘要 agent 收集上下文。 */
  async listAttentionCandidates(params: { limit?: number }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    const limit = Math.max(1, Math.floor(params.limit ?? 12));
    // 优先级排序必须进 SQL：只按 recency 截断的 LIMIT 窗口会让 200 条更新的
    // 低优先级行（未读/运行中）把更旧的 pendingInteraction 行挤出候选集，
    // 与 JS 侧 rank 的优先级语义冲突。LIMIT 200 仍是安全上限。
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        FROM tasks
        WHERE deleted = 0
          AND archived = 0
          AND (
            unread_at IS NOT NULL
            OR task_status = 'error'
            OR task_status = 'running'
            OR meta_json LIKE '%"pendingInteraction"%'
          )
        ORDER BY
          CASE
            WHEN meta_json LIKE '%"pendingInteraction"%' THEN 3
            WHEN task_status = 'error' THEN 2
            WHEN unread_at IS NOT NULL THEN 1
            ELSE 0
          END DESC,
          updated_at DESC,
          created_at DESC,
          task_id DESC
        LIMIT 200`,
      )
      .all() as unknown as TaskIndexRow[];
    const now = Date.now();
    // running 只收近 72h 有活动的行：上次退出前未收口的历史任务不该灌进摘要。
    const runningWindowMs = 72 * 60 * 60 * 1000;
    // error/running 判定与上方 SQL 同源，用 task_status 列：status 只承载 CLI 终态
    // （rowToMeta），sessions-index 写入的活动态（running/error 转换前的运行态）
    // 保存在 task_status 列，不进 meta.status 读取面。
    const isRowError = (row: TaskIndexRow, meta: ZCodeTaskMeta): boolean =>
      row.task_status === "error" || meta.status === "error";
    const rank = (row: TaskIndexRow, meta: ZCodeTaskMeta): number => {
      if (meta.pendingInteraction) return 3;
      if (isRowError(row, meta)) return 2;
      if (typeof meta.unreadAt === "number") return 1;
      return 0;
    };
    return rows
      .map((row) => ({ row, meta: rowToMeta(row) }))
      .filter(({ row, meta }) => {
        if (meta.pendingInteraction) return true;
        if (isRowError(row, meta)) return true;
        if (typeof meta.unreadAt === "number") return true;
        return row.task_status === "running" && now - meta.updatedAt < runningWindowMs;
      })
      .sort(
        (left, right) =>
          rank(right.row, right.meta) - rank(left.row, left.meta) ||
          right.meta.updatedAt - left.meta.updatedAt,
      )
      .slice(0, limit)
      .map((entry) => entry.meta);
  }

  /**
   * Session Sweep 的守卫谓词（plan 与 execute 复用同一份）：
   * 「不在行动中」= 未删除、未钉住、无未读、终态 completed/error、无在途
   * cron/off-peak run、最后更新早于 cutoff；归档只影响年龄锚点，不能替代终态。
   * pendingInteraction 在 JS 侧按 meta 复核（meta_json 列）。
   * cron 在途判定按 automation_runs 台账（specs/automation-system-scheduling.md）：
   * session 存在 outcome 未终态（NULL/running）且近期仍有活动的 run 即受保护；
   * 终态 run session 与孤儿 run-transcript 按常规年龄门槛可清理。host 崩溃遗留的
   * 永不终态 run 由窗口上限兜底，不能把会话永久钉成不可清理。
   */
  private static readonly SESSION_SWEEP_INFLIGHT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
  private static readonly SESSION_SWEEP_INFLIGHT_RUN_GUARD_SQL =
    "NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.session_id = tasks.task_id AND (r.outcome IS NULL OR r.outcome = 'running') AND r.updated_at > ?)";
  private static readonly SESSION_SWEEP_GUARD_SQL = [
    "deleted = 0",
    "pinned = 0",
    "unread_at IS NULL",
    "task_status IN ('completed', 'error')",
    TaskIndexRepo.SESSION_SWEEP_INFLIGHT_RUN_GUARD_SQL,
    "off_peak_task_id IS NULL",
    // 年龄门槛按归档状态分级：手动归档 = 用户显式的「已完成」信号，宽限从归档
    // 动作时刻（archived_at）起算固定 1 天——归档一个两天没动的任务不能立刻
    // 可清理。参数顺序：第一个 ? 是在途 run 窗口 cutoff，之后是归档宽限 cutoff
    // 与常规 cutoff。未打点的行（auto-archive / 存量数据）退回 updated_at 保持
    // 原行为；未归档终态行走 minAgeDays（默认 3 天）。
    "((archived = 1 AND COALESCE(archived_at, updated_at) < ?) OR (archived = 0 AND updated_at < ?))",
  ];

  /** 钉住侧候选：同款守卫但 pinned=1 —— 终态、无未读无阻塞、过期的钉住会话。 */
  private static readonly SESSION_SWEEP_PINNED_GUARD_SQL = [
    "deleted = 0",
    "pinned = 1",
    "unread_at IS NULL",
    "task_status IN ('completed', 'error')",
    TaskIndexRepo.SESSION_SWEEP_INFLIGHT_RUN_GUARD_SQL,
    "off_peak_task_id IS NULL",
    // 年龄门槛按归档状态分级：手动归档 = 用户显式的「已完成」信号，宽限从归档
    // 动作时刻（archived_at）起算固定 1 天——归档一个两天没动的任务不能立刻
    // 可清理。参数顺序：第一个 ? 是在途 run 窗口 cutoff，之后是归档宽限 cutoff
    // 与常规 cutoff。未打点的行（auto-archive / 存量数据）退回 updated_at 保持
    // 原行为；未归档终态行走 minAgeDays（默认 3 天）。
    "((archived = 1 AND COALESCE(archived_at, updated_at) < ?) OR (archived = 0 AND updated_at < ?))",
  ];

  private sessionSweepGuardHolds(
    row: TaskIndexRow,
    archivedCutoff: number,
    fullCutoff: number,
  ): boolean {
    if (row.deleted === 1 || row.pinned === 1) return false;
    if (row.unread_at != null) return false;
    if (!isTerminalTaskStatus(row.task_status as ZCodeTaskMeta["status"])) {
      return false;
    }
    if (row.off_peak_task_id != null) return false;
    // 事务内复核与 SQL 谓词同语义：在途 run（outcome 未终态且窗口内仍活跃）受保护。
    const inFlight = this.getDatabase()
      .prepare(
        `SELECT 1 FROM automation_runs
        WHERE session_id = ? AND (outcome IS NULL OR outcome = 'running')
          AND updated_at > ? LIMIT 1`,
      )
      .get(row.task_id, Date.now() - TaskIndexRepo.SESSION_SWEEP_INFLIGHT_RUN_WINDOW_MS);
    if (inFlight) return false;
    // 与 SQL 谓词同语义：归档行宽限锚点为 archived_at（手动归档打点），
    // 未打点退回 updated_at。
    const sweepClock = row.archived === 1 ? (row.archived_at ?? row.updated_at) : row.updated_at;
    if (sweepClock >= (row.archived === 1 ? archivedCutoff : fullCutoff)) return false;
    // meta 仍带阻塞交互 = 还有等用户的动作，一律不删。
    return rowToMeta(row).pendingInteraction == null;
  }

  /** 跨全部 workspace 的可清理候选（只读）；agent 只拿这份清单做相关性判断。 */
  async listSessionSweepCandidates(params: {
    minAgeDays?: number;
    limit?: number;
  }): Promise<Array<ZCodeTaskMeta & { archived: boolean; preview: string }>> {
    await this.ensureReady();
    const minAgeDays = Math.max(1, Math.floor(params.minAgeDays ?? 3));
    const limit = Math.max(1, Math.floor(params.limit ?? 60));
    const now = Date.now();
    const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
    const archivedCutoff = now - 1 * 24 * 60 * 60 * 1000;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
          provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
          off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned,
          archived, archived_at, deleted, title_overridden, searchable_text, meta_json
        FROM tasks
        WHERE ${TaskIndexRepo.SESSION_SWEEP_GUARD_SQL.join(" AND ")}
        ORDER BY updated_at ASC, created_at ASC, task_id ASC
        LIMIT ?`,
      )
      .all(
        now - TaskIndexRepo.SESSION_SWEEP_INFLIGHT_RUN_WINDOW_MS,
        archivedCutoff,
        cutoff,
        limit * 2,
      ) as unknown as TaskIndexRow[];
    return rows
      .filter((row) => rowToMeta(row).pendingInteraction == null)
      .slice(0, limit)
      .map((row) => {
        const meta = rowToMeta(row);
        return {
          ...meta,
          archived: row.archived === 1,
          preview: (row.searchable_text ?? "").slice(0, 240),
        };
      });
  }

  /** 钉住侧候选（只读）：满足除 pinned 外全部守卫的钉住会话，供 agent 判断是否解除钉住。 */
  async listSessionSweepPinnedCandidates(params: {
    minAgeDays?: number;
    limit?: number;
  }): Promise<Array<ZCodeTaskMeta & { archived: boolean; preview: string }>> {
    await this.ensureReady();
    const minAgeDays = Math.max(1, Math.floor(params.minAgeDays ?? 3));
    const limit = Math.max(1, Math.floor(params.limit ?? 30));
    const now = Date.now();
    const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
    const archivedCutoff = now - 1 * 24 * 60 * 60 * 1000;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
          provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
          off_peak_task_id, created_at, updated_at, unread_at, last_unread_at, pinned,
          archived, archived_at, deleted, title_overridden, searchable_text, meta_json
        FROM tasks
        WHERE ${TaskIndexRepo.SESSION_SWEEP_PINNED_GUARD_SQL.join(" AND ")}
        ORDER BY updated_at ASC, created_at ASC, task_id ASC
        LIMIT ?`,
      )
      .all(
        now - TaskIndexRepo.SESSION_SWEEP_INFLIGHT_RUN_WINDOW_MS,
        archivedCutoff,
        cutoff,
        limit,
      ) as unknown as TaskIndexRow[];
    return rows
      .filter((row) => rowToMeta(row).pendingInteraction == null)
      .map((row) => {
        const meta = rowToMeta(row);
        return {
          ...meta,
          archived: row.archived === 1,
          preview: (row.searchable_text ?? "").slice(0, 240),
        };
      });
  }

  /**
   * 设置/解除钉住（sweep 面）。pin/unpin 是纯 membership 元数据，不做守卫矩阵；
   * 删除侧安全完全由 sweepDeleteTasks 的事务内守卫承担（解除钉住只是让它重新可被
   * 后续清理提名）。不存在/已删除的行 skip。
   */
  async sweepSetPinned(params: { taskIds: string[]; pinned: boolean }): Promise<{
    updated: Array<{ taskId: string; pinned: boolean; meta: ZCodeTaskMeta }>;
    skipped: Array<{ taskId: string; reason: string }>;
  }> {
    await this.ensureReady();
    const updated: Array<{ taskId: string; pinned: boolean; meta: ZCodeTaskMeta }> = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const taskId of params.taskIds) {
      if (seen.has(taskId)) {
        continue;
      }
      seen.add(taskId);
      const row = this.getTaskRowById(taskId);
      if (!row || row.deleted === 1) {
        skipped.push({ taskId, reason: "not_found_or_already_deleted" });
        continue;
      }
      if ((row.pinned === 1) === params.pinned) {
        skipped.push({
          taskId,
          reason: params.pinned ? "already_pinned" : "already_unpinned",
        });
        continue;
      }
      // identity 以行主键投影为准（同 rowToMeta 语义），避免残留 identity 列把
      // 更新写到另一个 workspace_key 桶。
      const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
      const meta = await this.updateTaskState({
        workspacePath: row.workspace_path,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        taskId,
        // 钉住语义 = 保留并可见：侧栏 Pinned 区只显示 pinned=1 AND archived=0，
        // 对归档行钉住必须同时解除归档，否则「值得保留的决策记录」被钉进不可见区。
        // 解除钉住不动归档状态——unpin 只是放开后续清理提名，不改变当前可见性。
        patch: {
          pinned: params.pinned,
          ...(params.pinned && row.archived === 1 ? { archived: false } : {}),
        },
      });
      updated.push({ taskId, pinned: params.pinned, meta });
    }
    return { updated, skipped };
  }

  /**
   * 事务内逐项守卫复核后 tombstone（deleted=1 + 去分组引用）。
   * 返回成功删除的 meta 与被跳过项及原因；不做任何文件操作（备份由 SessionSweepService 负责）。
   */
  async sweepDeleteTasks(params: {
    taskIds: string[];
    minAgeDays?: number;
  }): Promise<{ deleted: ZCodeTaskMeta[]; skipped: Array<{ taskId: string; reason: string }> }> {
    await this.ensureReady();
    const minAgeDays = Math.max(1, Math.floor(params.minAgeDays ?? 3));
    const now = Date.now();
    const cutoff = now - minAgeDays * 24 * 60 * 60 * 1000;
    const archivedCutoff = now - 1 * 24 * 60 * 60 * 1000;
    const deleted: ZCodeTaskMeta[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];
    const seen = new Set<string>();
    this.getDatabase().exec("BEGIN IMMEDIATE");
    try {
      for (const taskId of params.taskIds) {
        if (seen.has(taskId)) {
          continue;
        }
        seen.add(taskId);
        const row = this.getTaskRowById(taskId);
        if (!row || row.deleted === 1) {
          skipped.push({ taskId, reason: "not_found_or_already_deleted" });
          continue;
        }
        if (!this.sessionSweepGuardHolds(row, archivedCutoff, cutoff)) {
          skipped.push({ taskId, reason: "guard_recheck_failed" });
          continue;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: false,
          archived: row.archived === 1,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        this.deleteTaskGroupingReferencesReady(row.workspace_key, row.task_id);
        deleted.push(meta);
      }
      this.getDatabase().exec("COMMIT");
    } catch (error) {
      this.getDatabase().exec("ROLLBACK");
      throw error;
    }
    return { deleted, skipped };
  }

  private getTaskRowById(taskId: string): TaskIndexRow | undefined {
    return this.getDatabase()
      .prepare(`SELECT * FROM tasks WHERE task_id = ? LIMIT 1`)
      .get(taskId) as unknown as TaskIndexRow | undefined;
  }

  private hasGroupedWorkspaceBootstrapRunSync(): boolean {
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS found
        FROM task_group_workspace_bootstraps
        LIMIT 1`,
      )
      .get() as { found: number } | undefined;
    return Boolean(row);
  }

  private bootstrapWorkspaceGroupsForActiveTasks(params: {
    scopes: WorkspaceBootstrapScope[];
    activeTasks: TaskIndexRow[];
  }): void {
    if (params.scopes.length === 0 || this.hasGroupedWorkspaceBootstrapRunSync()) {
      return;
    }
    const database = this.getDatabase();
    const candidateRowsByWorkspaceKey = new Map<string, TaskIndexRow[]>();
    for (const row of params.activeTasks) {
      const rows = candidateRowsByWorkspaceKey.get(row.workspace_key) ?? [];
      rows.push(row);
      candidateRowsByWorkspaceKey.set(row.workspace_key, rows);
    }
    const now = Date.now();
    const markBootstrapRun = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        updated_at = excluded.updated_at`,
    );
    if (candidateRowsByWorkspaceKey.size === 0) {
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      return;
    }
    const existingGroupOrderKeys = new Set(
      (
        database
          .prepare(
            `SELECT node_key
            FROM task_group_view_node_orders
            WHERE node_type = 'group'`,
          )
          .all() as Array<{ node_key: string }>
      ).map((row) => row.node_key),
    );
    const maxOrderRow = database
      .prepare(
        `SELECT MAX(sort_order) AS max_sort_order
        FROM task_group_view_node_orders`,
      )
      .get() as { max_sort_order: number | null } | undefined;
    let nextGroupSortOrder = maxOrderRow?.max_sort_order ?? 0;
    const insertGroup = database.prepare(
      `INSERT OR IGNORE INTO task_groups (
        group_id,
        title,
        color,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertGroupOrder = database.prepare(
      `INSERT OR IGNORE INTO task_group_view_node_orders (
        node_type,
        node_key,
        sort_order,
        created_at,
        updated_at
      ) VALUES ('group', ?, ?, ?, ?)`,
    );
    const deleteExistingMember = database.prepare(
      `DELETE FROM task_group_members
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const insertMember = database.prepare(
      `INSERT INTO task_group_members (
        group_id,
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        sort_order,
        added_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        group_id = excluded.group_id,
        workspace_path = excluded.workspace_path,
        workspace_identity = excluded.workspace_identity,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at`,
    );
    const deleteTopTaskOrder = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'task' AND node_key = ?`,
    );
    const insertBootstrap = database.prepare(
      `INSERT INTO task_group_workspace_bootstraps (
        workspace_key,
        group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        group_id = excluded.group_id,
        updated_at = excluded.updated_at`,
    );
    const deleteEmptyGroups = database.prepare(
      `DELETE FROM task_groups
      WHERE group_id NOT IN (
        SELECT DISTINCT group_id
        FROM task_group_members
      )`,
    );
    const deleteDanglingGroupOrders = database.prepare(
      `DELETE FROM task_group_view_node_orders
      WHERE node_type = 'group'
        AND node_key NOT IN (
          SELECT group_id
          FROM task_groups
        )`,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      // grouped workspace bootstrap 是迁移期的一次性初始化。记录全局 marker，
      // 避免后续新 workspace 出现时再次自动生成 workspace group。
      markBootstrapRun.run(GROUPED_WORKSPACE_BOOTSTRAP_ONCE_KEY, now, now);
      for (const scope of params.scopes) {
        const rows = candidateRowsByWorkspaceKey.get(scope.workspaceKey);
        if (!rows) {
          continue;
        }
        // 初始化按没有分组功能时的 workspace 视角重建 membership，
        // 旧 group 不参与归属判断，避免历史分组把 task 留在非 workspace group 里。
        const groupedRows = rows.sort((left, right) => {
          if (right.updated_at !== left.updated_at) {
            return right.updated_at - left.updated_at;
          }
          if (right.created_at !== left.created_at) {
            return right.created_at - left.created_at;
          }
          return left.task_id.localeCompare(right.task_id);
        });
        if (groupedRows.length === 0) {
          continue;
        }
        const groupId = workspaceGroupId(scope.workspaceKey);
        const title = workspaceGroupTitle(scope.workspacePath);
        insertGroup.run(groupId, title, workspaceGroupColor(scope.workspaceKey), now, now);
        if (!existingGroupOrderKeys.has(groupId)) {
          nextGroupSortOrder += GROUPED_TASK_ORDER_STEP;
          insertGroupOrder.run(groupId, nextGroupSortOrder, now, now);
          existingGroupOrderKeys.add(groupId);
        }
        groupedRows.forEach((row, index) => {
          deleteExistingMember.run(row.workspace_key, row.task_id);
          insertMember.run(
            groupId,
            row.workspace_key,
            row.workspace_path,
            row.workspace_identity,
            row.task_id,
            (index + 1) * GROUPED_TASK_ORDER_STEP,
            now,
            now,
            now,
          );
          deleteTopTaskOrder.run(
            taskOrderNodeKey({
              workspacePath: row.workspace_path,
              workspaceIdentity: row.workspace_identity ?? undefined,
              taskId: row.task_id,
            }),
          );
        });
        insertBootstrap.run(scope.workspaceKey, groupId, now, now);
      }
      deleteEmptyGroups.run();
      deleteDanglingGroupOrders.run();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    const database = this.getDatabase();
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      // 本方法只在预留行首次落 CLI 事实时调用，正文索引与未读 CAS marker 都不归它写：
      // 读一次现有行，ON CONFLICT 时原样保留 searchable_text / unread_at。
      const existing = this.getTaskRow({
        workspacePath: record.meta.workspacePath,
        workspaceIdentity: record.meta.workspaceIdentity,
        taskId: record.meta.taskId,
      });
      // fork：调用方传入 searchableText 时截断后落盘（syncTaskMeta 族）；
      // 不传保留现有值，ON CONFLICT 的 excluded.searchable_text 不能清空已索引正文。
      const searchableText =
        record.searchableText !== undefined
          ? record.searchableText.slice(0, TASK_SEARCH_TEXT_MAX_CHARS)
          : (existing?.searchable_text ?? "");
      this.getDatabase()
        .prepare(
          `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json,
          cli_title,
          cli_title_source,
          cli_created_at,
          cli_updated_at,
          cli_last_outcome,
          cli_deleted
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json,
          @cli_title,
          @cli_title_source,
          @cli_created_at,
          @cli_updated_at,
          @cli_last_outcome,
          @cli_deleted
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = tasks.unread_at,
          last_unread_at = MAX(tasks.last_unread_at, COALESCE(tasks.unread_at, 0)),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json,
          -- fork 合并修复：syncTaskMeta / applyAgentPatch 族写入的行在上游 v3.16.2 的
          -- CLI-facts 读取模型里（rowToMeta 以 cli_* 为权威、listTaskMetas 以
          -- cli_created_at IS NOT NULL 过滤、列表按 cli_updated_at 排序）必须是一等任务，
          -- 因此 writeRecord 随写落 CLI-facts 基线。已有事实不被 fork 写覆盖：
          -- 身份/来源/终态只补 NULL（权威事实由 applyCliFacts 端口写入），时间取单调 max。
          cli_title = COALESCE(tasks.cli_title, excluded.cli_title),
          cli_title_source = COALESCE(tasks.cli_title_source, excluded.cli_title_source),
          cli_created_at = COALESCE(tasks.cli_created_at, excluded.cli_created_at),
          cli_updated_at = MAX(COALESCE(tasks.cli_updated_at, excluded.cli_updated_at), excluded.cli_updated_at),
          cli_last_outcome = COALESCE(excluded.cli_last_outcome, tasks.cli_last_outcome),
          cli_deleted = MAX(COALESCE(tasks.cli_deleted, 0), excluded.cli_deleted)`,
      )
      .run({
        workspace_key: workspaceKey(record.meta),
        workspace_path: record.meta.workspacePath,
        workspace_identity: record.meta.workspaceIdentity ?? null,
        task_id: record.meta.taskId,
        title: record.meta.title,
        task_status: record.meta.status ?? null,
        provider: record.meta.provider ?? null,
        mode: record.meta.mode,
        model: record.meta.model ?? null,
        migration_source: record.meta.migrationSource ?? null,
        forked_from_task_id: record.meta.forkedFromTaskId ?? null,
        // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
        cron_automation_id: record.meta.cronAutomationId ?? null,
        // off-peak 身份（D48）同款投影。
        off_peak_task_id: record.meta.offPeakTaskId ?? null,
        created_at: record.meta.createdAt,
        updated_at: record.meta.updatedAt,
        unread_at: record.meta.unreadAt ?? null,
        last_unread_at: record.meta.unreadAt ?? 0,
        pinned: record.pinned ? 1 : 0,
        archived: record.archived ? 1 : 0,
        deleted: record.deleted ? 1 : 0,
        title_overridden: record.titleOverridden ? 1 : 0,
        searchable_text: searchableText,
        meta_json: serializeMetaJson(record.meta),
        // fork：CLI-facts 基线（见上方 ON CONFLICT 注释）。titleOverridden 行保持
        // cli_title_source 为 NULL，让 writeRecord 末尾的 handoff bit-2 标记照常置位，
        // applyCliFacts 的 CASE 才会保留用户手动标题。
        cli_title: record.meta.title,
        cli_title_source: record.titleOverridden ? null : "default",
        cli_created_at: record.meta.createdAt,
        cli_updated_at: record.meta.updatedAt,
        // cli_last_outcome 只承接终态（completed/error）；running 属会话活动态，
        // 读侧由 rowToMeta 从 meta_json 兜底，CLI 事实落地后照常覆盖。
        cli_last_outcome:
          record.meta.status === "completed" || record.meta.status === "error"
            ? record.meta.status
            : null,
        cli_deleted: record.deleted ? 1 : 0,
        });
      projectStorage.admitTaskIdentity(database, record.meta, this.storageHostId);
      if (record.titleOverridden)
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 2 WHERE workspace_key=? AND task_id=? AND cli_title_source IS NULL",
          )
          .run(workspaceKey(record.meta), record.meta.taskId);

      const persisted = this.getTaskRow(record.meta);
      if (!persisted) {
        throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
      }
      this.admitTaskGroup(rowToMeta(persisted), persisted.archived === 1, persisted.deleted === 1);
      if (ownTransaction) database.exec("COMMIT");
      return rowToMeta(persisted);
    } catch (error) {
      if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  async syncTaskMeta(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    // 调用方可以从 snapshot.messages 计算正文，传进来同步刷新 searchable_text。
    // 不传则保留 sqlite 已有的 searchable_text（在 writeRecord 里兜底）。
    searchableText?: string;
  }): Promise<ZCodeTaskMeta> {
    const result = await this.syncTaskMetaWithGroupedAdmission(params, false);
    return result.meta;
  }

  /** 首次公开 root task 时，原子提交 task row 与 grouped 顶层顺序。 */
  async syncTaskMetaAtGroupedTop(params: {
    meta: ZCodeTaskMeta;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
    titleOverridden?: boolean;
    searchableText?: string;
  }): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    return this.syncTaskMetaWithGroupedAdmission(params, true);
  }

  private async syncTaskMetaWithGroupedAdmission(
    params: {
      meta: ZCodeTaskMeta;
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      titleOverridden?: boolean;
      searchableText?: string;
    },
    initializeGroupedAtTop: boolean,
  ): Promise<{ meta: ZCodeTaskMeta; initializedGroupedOrder: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const database = this.getDatabase();
      if (initializeGroupedAtTop) database.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        const existingMeta = existing ? rowToMeta(existing) : null;
        const titleOverridden = params.titleOverridden ?? existing?.title_overridden === 1;
        // snapshot 来源的 updatedAt 是 runtime sessionStore 里的"最后一次结构变更"时间，
        // 不一定包含 session.titleUpdated / turn.completed 这些事件触发的 Date.now() 增量。
        // 如果这里直接用 params.meta.updatedAt 覆盖，会把刚刚走 applyAgentPatch 写入的更新时间戳冲回旧值，
        // 表现为新会话第一次 prompt 后又被压回列表底部。这里取与 sqlite 已有值的 max，保证单调不回退。
        const updatedAt = Math.max(params.meta.updatedAt, existingMeta?.updatedAt ?? 0);
        const preserveExistingTerminalStatus = shouldPreserveNewerTerminalStatus(
          existingMeta,
          params.meta,
        );
        const meta: ZCodeTaskMeta = {
          ...params.meta,
          // agent 只负责 session 核心标题，用户手动重命名属于 app 侧 task 状态。
          // 同步 agent snapshot 时保留已覆盖标题，避免后台状态刷新把用户标题冲掉。
          title: titleOverridden && existingMeta ? existingMeta.title : params.meta.title,
          titleOverridden,
          // turn.completed 会先通过 applyAgentPatch 写入较新的 completed/error。
          // 随后到达的 protocol snapshot 可能仍带较旧 running；如果这里降级 status，
          // 手机 replayable 切回 task 时就会把已完成任务恢复成“工作中”。
          status: preserveExistingTerminalStatus ? existingMeta?.status : params.meta.status,
          lastError: preserveExistingTerminalStatus
            ? existingMeta?.lastError
            : params.meta.lastError,
          target: Object.prototype.hasOwnProperty.call(params.meta, "target")
            ? params.meta.target
            : existingMeta?.target,
          // pendingInteraction 与 target 同款「键缺席 = 保留」：snapshot 同步方
          // （legacy snapshot 只有 pendingPermissions，无 userInput 摘要）不带该键时，
          // 不能把 sessions-index 路径刚持久化的阻塞痕迹冲掉。
          pendingInteraction: Object.prototype.hasOwnProperty.call(
            params.meta,
            "pendingInteraction",
          )
            ? params.meta.pendingInteraction
            : existingMeta?.pendingInteraction,
          // Claude Code 导入升级成真实 ZCode session 后，protocol snapshot
          // 本身不知道迁移来源。同步运行态快照时保留已有 migrationSource，避免
          // 列表过滤和后续切模型把导入任务重新当成普通 ZCode 任务。
          migrationSource: params.meta.migrationSource ?? existingMeta?.migrationSource,
          // 同步运行态快照时保留已有 cron automation 身份：运行态 protocol snapshot 的 meta 不带 cron 标记，
          // 不用已存值兜底会在后续 sync 时把 cron 身份冲掉，导致 icon / 分组 / 关联查询失效。
          cronAutomationId: params.meta.cronAutomationId ?? existingMeta?.cronAutomationId,
          // off-peak 身份同款兜底：快照不带标记时保全既有归属。
          offPeakTaskId: params.meta.offPeakTaskId ?? existingMeta?.offPeakTaskId,
          updatedAt,
          unreadAt: params.meta.unreadAt ?? existingMeta?.unreadAt,
        };
        const persistedMeta = this.writeRecord({
          meta,
          pinned: params.pinned ?? existing?.pinned === 1,
          archived: params.archived ?? existing?.archived === 1,
          deleted: params.deleted ?? existing?.deleted === 1,
          titleOverridden,
          searchableText: params.searchableText,
        });
        // cron session 首次获得 cronAutomationId 时归入固定 cron 分组。
        // 会话内 CronCreate 是给已有 task 补 cron 标记，不能只判断 !existing，否则左侧列表不会归入定时任务分组。
        // INSERT OR IGNORE 不覆盖已有成员关系——用户后续把它拖出 cron 组后不会被自动拖回。
        if (meta.cronAutomationId && !existingMeta?.cronAutomationId) {
          this.ensureCronGroupMembership(meta);
        }
        // 闲时会话首次获得 offPeakTaskId 时归入固定闲时系统分组（机制同 cron）。
        if (meta.offPeakTaskId && !existingMeta?.offPeakTaskId) {
          this.ensureOffPeakGroupMembership(meta);
        }
        // root draft 首发过去先提交 task row，再另一次写 sort_order；
        // sessions-index 在两次写之间公开 task 时，Renderer 会把缺序节点补到末尾。
        const initializedGroupedOrder = initializeGroupedAtTop
          ? this.initializeGroupedTaskAtTopReady(meta)
          : false;
        if (initializeGroupedAtTop) database.exec("COMMIT");
        return { meta: persistedMeta, initializedGroupedOrder };
      } catch (error) {
        if (initializeGroupedAtTop) database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * 只在索引行不存在时写入基线元数据；已存在（含已删除）的产品壳状态原样保留。
   *
   * 远端 workspace 的 V4 会话路径可能晚于会话创建才建立 sessions-index
   * 订阅。首次 snapshot 必须能补齐全新的 tasks-index.sqlite，但不能用摘要默认值
   * 覆盖已有的 pin/archive/unread/手动标题，也不能与随后到达的完整 snapshot 竞态回写。
   */
  async seedTaskMetaIfMissing(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(meta, () => {
      const existing = this.getTaskRow(meta);
      if (existing) {
        return rowToMeta(existing);
      }
      return this.writeRecord({
        meta,
        pinned: false,
        archived: false,
        deleted: false,
        titleOverridden: meta.titleOverridden ?? false,
      });
    });
  }

  async applyAgentPatch(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: Pick<
      TaskIndexStatePatch,
      "title" | "status" | "lastError" | "target" | "pendingInteraction" | "updatedAt"
    >;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const row = this.getTaskRow(params);
      if (!row || row.deleted === 1) {
        return null;
      }
      const current = rowToMeta(row);
      const canAcceptAgentTitle = row.title_overridden !== 1;
      const nextMeta: ZCodeTaskMeta = {
        ...current,
        title: canAcceptAgentTitle && params.patch.title ? params.patch.title : current.title,
        titleOverridden: row.title_overridden === 1,
        updatedAt: params.patch.updatedAt ?? current.updatedAt,
        status: params.patch.status ?? current.status,
        lastError: "lastError" in params.patch ? params.patch.lastError : current.lastError,
        target: "target" in params.patch ? params.patch.target : current.target,
        // lastError 同款语义：键缺席 = 保留现值（显式 undefined = 清除）。
        // pendingInteraction 是「还有等用户处理的阻塞」持久痕迹，只有摘要明确
        // 变空时才允许清除。
        pendingInteraction:
          "pendingInteraction" in params.patch
            ? params.patch.pendingInteraction
            : current.pendingInteraction,
      };
      // 不带 searchableText：writeRecord 保留现有正文索引，也不会碰 unread CAS。
      return this.writeRecord({
        meta: nextMeta,
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        deleted: row.deleted === 1,
        titleOverridden: row.title_overridden === 1,
      });
    });
  }

  private deleteTaskGroupingReferencesReady(workspaceKeyValue: string, taskId: string): void {
    const database = this.getDatabase();
    database
      .prepare(
        `DELETE FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(workspaceKeyValue, taskId);
    database
      .prepare(
        `DELETE FROM task_group_view_node_orders
        WHERE node_type = 'task' AND (node_key = ? OR node_key = ?)`,
      )
      .run(JSON.stringify([workspaceKeyValue, taskId]), workspaceKeyValue);
  }

  /**
   * 把一条 cron session 归入固定的 cron 系统分组（见 CRON_DEFAULT_GROUP_ID）。
   * 幂等：分组行、视图排序、成员关系都用 INSERT OR IGNORE，绝不覆盖用户手动整理的结果。
   * 仅在 session 首次获得 cronAutomationId 时由 syncTaskMeta 调用一次。
   */
  private ensureCronGroupMembership(meta: ZCodeTaskMeta): void {
    this.ensureSystemGroupMembership(meta, {
      groupId: CRON_DEFAULT_GROUP_ID,
      title: "cron",
      color: "blue",
    });
  }

  /**
   * 把一条闲时会话归入固定的闲时系统分组（见 OFF_PEAK_DEFAULT_GROUP_ID）。
   * 机制与 cron 完全同构；仅在首次获得 offPeakTaskId 时由 syncTaskMeta 调用，
   * 或由 bootstrap 为存量回填补齐。
   */
  private ensureOffPeakGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): void {
    // 闲时任务暂不支持远程 workspace：远程会话即使带标记也不归入闲时系统分组。
    if (meta.workspaceIdentity && isRemoteWorkspaceIdentity(meta.workspaceIdentity)) {
      return;
    }
    this.ensureSystemGroupMembership(meta, {
      groupId: OFF_PEAK_DEFAULT_GROUP_ID,
      title: "off-peak",
      color: "purple",
    });
  }

  private ensureSystemGroupMembership(
    meta: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
    params: { groupId: string; title: string; color: string },
  ): void {
    const database = this.getDatabase();
    const now = Date.now();
    database
      .prepare(
        `INSERT OR IGNORE INTO task_groups (group_id, title, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(params.groupId, params.title, params.color, now, now);
    // 分组视图排序：不存在才插入（OR IGNORE），避免每次新建系统分组 session 都把该组顺序打乱。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_view_node_orders (node_type, node_key, sort_order, created_at, updated_at)
        VALUES ('group', ?, ?, ?, ?)`,
      )
      .run(params.groupId, this.getNextGroupedTopSortOrder(), now, now);
    // OR IGNORE：若该 task 已有成员关系（用户已手动分组），保持不动。
    database
      .prepare(
        `INSERT OR IGNORE INTO task_group_members (
          group_id,
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          sort_order,
          added_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        params.groupId,
        workspaceKey(meta),
        meta.workspacePath,
        meta.workspaceIdentity ?? null,
        meta.taskId,
        now,
        now,
        now,
      );
  }

  private initializeGroupedTaskAtTopReady(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): boolean {
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1 || row.archived === 1 || row.pinned === 1) {
      return false;
    }
    const database = this.getDatabase();
    const existingMember = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_members
        WHERE workspace_key = ? AND task_id = ?
        LIMIT 1`,
      )
      .get(workspaceKey(params), params.taskId) as { found: number } | undefined;
    const nodeKey = taskOrderNodeKey(params);
    const existingTopOrder = database
      .prepare(
        `SELECT 1 AS found
        FROM task_group_view_node_orders
        WHERE node_type = 'task' AND node_key = ?
        LIMIT 1`,
      )
      .get(nodeKey) as { found: number } | undefined;
    if (existingMember || existingTopOrder) {
      return false;
    }
    const now = Date.now();
    // session 可见与首标题缺行都可能并发触发完整 snapshot 回源。
    // 顶层顺序只能在第一次出现时初始化；重复回源若再次分配最小 sort_order，
    // 较慢完成的旧任务会越过之后创建的新任务，使最终顺序依赖异步完成时序。
    this.upsertGroupedTopOrder({
      nodeType: "task",
      nodeKey,
      sortOrder: this.getNextGroupedTopSortOrder(),
      now,
    });
    return true;
  }

  async listReconciliationRows(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT * FROM tasks WHERE workspace_key=?")
      .all(workspaceKey(target)) as unknown as TaskIndexRow[];
    return rows.map((row) => ({ meta: rowToMeta(row), handoffPending: row.handoff_pending ?? 0 }));
  }

  /** CLI 确认 child 后移除旧版本误建的派生行，不修改会话正文或 CLI deleted。 */
  async removeSubagentIndexRow(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey(target), target.taskId);
    });
  }

  async markCliOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare(
          "UPDATE tasks SET handoff_pending=handoff_pending | 4 WHERE workspace_key=? AND task_id=?",
        )
        .run(workspaceKey(target), target.taskId);
    });
  }

  /** 仅 syncer 消费 CLI 明确删除，不以列表缺席推断删除。 */
  async applyCliDeletion(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tasks SET cli_deleted=1,deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=?",
        ).run(workspaceKey(target), target.taskId);
        const row = this.getTaskRow(target);
        if (row) this.admitTaskGroup(rowToMeta(row), row.archived === 1, true);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 仅 syncer 调用：CLI 事实是唯一来源，组织态写者不得合成这些值。 */
  async applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        // 预留行尚无 CLI 事实。首条事实补齐 provider/展示基线，保留预留后发生的组织操作。
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        const source = params.titleSource ?? "default";
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        const persisted = this.getTaskRow(params.meta)!;
        this.admitTaskGroup(
          rowToMeta(persisted),
          persisted.archived === 1,
          persisted.deleted === 1,
        );
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 旧库补列时 watermark 默认为 0；清除前必须吸收现存 marker，避免重启后时钟回拨复用旧值。
        const updated = db
          .prepare(
            "UPDATE tasks SET last_unread_at=max(last_unread_at,unread_at),unread_at=NULL WHERE workspace_key=? AND task_id=? AND deleted=0 AND unread_at=?",
          )
          .run(workspaceKey(params), params.taskId, params.expectedUnreadAt);
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        db.exec("COMMIT");
        return { meta: rowToMeta(row), cleared: Number(updated.changes) > 0 };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        // 删除事实交给 CLI；持久化意图使中途断线后仍可按既有 handoff 对账完成。
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 1 WHERE workspace_key=? AND task_id=?",
          )
          .run(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        // 归档即视为用户已处理（specs/archived-task-unread-invariant.md）：archived 行
        // 不允许持有 unread。可见列表按 membership 排除归档行，蓝点与 dock badge 都
        // 读不到它；cron automation 会复用已归档 task 行继续后台运行，终态未读写回
        // 归档行会生成永远无法清除的僵尸未读（自动归档与 session sweep 守卫都拒绝
        // unread 行）。因此归档写入顺带清未读（对已归档行的任何状态写都重新断言
        // unread_at IS NULL，读侧自愈收敛），请求的未读值一并丢弃。
        const willBeArchived = params.patch.archived === true || row.archived === 1;
        // marker 的 watermark 在清除后仍保留；旧手机 CAS 不能清除同毫秒内的新未读。
        const hasUnread = willBeArchived || "unreadAt" in params.patch;
        const unread = willBeArchived
          ? null
          : typeof params.patch.unreadAt === "number"
            ? Math.max(params.patch.unreadAt, row.last_unread_at + 1, (row.unread_at ?? 0) + 1)
            : null;
        db.prepare(`UPDATE tasks SET pinned=coalesce(?,pinned),archived=coalesce(?,archived),
          unread_at=CASE WHEN ? THEN ? ELSE unread_at END,
          last_unread_at=max(last_unread_at,coalesce(?,0)) WHERE workspace_key=? AND task_id=?`).run(
          params.patch.pinned === undefined ? null : Number(params.patch.pinned),
          params.patch.archived === undefined ? null : Number(params.patch.archived),
          Number(hasUnread),
          unread,
          hasUnread ? unread : null,
          workspaceKey(params),
          params.taskId,
        );
        // 归档宽限锚点（specs/session-sweeper.md）：手动归档是用户此刻的「已完成」
        // 信号，1 天宽限从归档动作起算（archived_at），与该行先前的 updated_at
        // 无关——否则归档一个两天没动的任务会立刻可清理。解除归档清空锚点，
        // 重新归档重新起算。auto-archive（archiveStaleTasks）不打点，存量行为经
        // COALESCE(archived_at, updated_at) 保持不变。
        if (params.patch.archived === true && row.archived !== 1) {
          db
            .prepare("UPDATE tasks SET archived_at = ? WHERE workspace_key = ? AND task_id = ?")
            .run(Date.now(), row.workspace_key, row.task_id);
        } else if (params.patch.archived === false && row.archived === 1) {
          db
            .prepare("UPDATE tasks SET archived_at = NULL WHERE workspace_key = ? AND task_id = ?")
            .run(row.workspace_key, row.task_id);
        }
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 展示缓存不接受 title/time/status/deleted；CLI 事实由独立端口写入。 */
  async updateTaskPresentation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    presentation: Partial<
      Pick<
        ZCodeTaskMeta,
        | "mode"
        | "model"
        | "thoughtLevel"
        | "lastError"
        | "target"
        | "migrationSource"
        | "cronAutomationId"
        | "offPeakTaskId"
        // fork：阻塞交互摘要属展示层事实，随 meta_json 落盘；
        // {...current, ...presentation} 展开天然实现「键缺席 = 保留，显式 undefined = 清除」。
        | "pendingInteraction"
      >
    >;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const meta = { ...rowToMeta(row), ...params.presentation };
        this.getDatabase()
          .prepare(
            `UPDATE tasks SET mode=?,model=?,migration_source=?,cron_automation_id=?,off_peak_task_id=?,meta_json=?,searchable_text=coalesce(?,searchable_text) WHERE workspace_key=? AND task_id=?`,
          )
          .run(
            meta.mode,
            meta.model ?? null,
            meta.migrationSource ?? null,
            meta.cronAutomationId ?? null,
            meta.offPeakTaskId ?? null,
            serializeMetaJson(meta),
            params.searchableText ?? null,
            workspaceKey(params),
            params.taskId,
          );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND cli_created_at IS NOT NULL
          AND (@include_deleted = 1 OR (deleted = 0 AND coalesce(cli_deleted,0) = 0))
          -- Bugfix: ZCode Agent 列表只接受当前 glm provider；Claude Code 导入也属于非 glm 历史数据。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY cli_updated_at DESC, cli_created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = [
      "deleted = 0",
      "coalesce(cli_deleted,0) = 0",
      "cli_created_at IS NOT NULL",
      `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
    ];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push(
        "(LOWER(CASE WHEN title_overridden=1 THEN title ELSE cli_title END) LIKE ? OR LOWER(searchable_text) LIKE ?)",
      );
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    const total = totalRow?.total ?? 0;

    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    const orderBy =
      params.sortBy === "created"
        ? "cli_created_at DESC, cli_updated_at DESC, task_id DESC"
        : "cli_updated_at DESC, cli_created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > rows.length,
    };
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}

import type { CrashDiagnosticsEntry, CrashDiagnosticsV8OomSummary } from "./diagnostics.js";

/**
 * crash 历史纯投影：history.jsonl 行、归档 .dmp.json sidecar 与两路数据源的合并排序。
 * 不做任何 IO，供 diagnosticsService（read model）与 desktop 捕获侧（history 截断）共用，
 * 保证两侧对同一数据的解释不会漂移（specs/settings-diagnostics-crash-logs.md 行为 1/3）。
 */

/** history.jsonl 的容量上限：归档只留 5 个 dump，history 让诊断视图不受该保留上限影响。 */
export const CRASH_HISTORY_MAX_LINES = 200;

const CRASH_DUMP_FILE_SUFFIX = ".dmp";

const EMPTY_CRASH_SIDECAR_PROJECTION: CrashSidecarProjection = {
  crashedAtMs: null,
  archivedAtMs: null,
  sizeBytes: null,
  v8OomSummary: null,
};

/** dump 文件名（*.dmp）推导出的去重 id（basename 去扩展）；非 .dmp 或空 id 返回 null。 */
export function crashDumpIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(CRASH_DUMP_FILE_SUFFIX)) {
    return null;
  }
  const id = fileName.slice(0, -CRASH_DUMP_FILE_SUFFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * 宽松数值化：接受有限 number 与纯数字字符串；其余（boolean/对象/NaN/"abc"）一律 null。
 * history/sidecar 是跨版本数据，宁可丢一个字段也不能让坏数据伪装成时间戳。
 */
function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

/**
 * v8OomSummary 子集投影。desktop 完整注解摘要（CrashDumpV8OomSummary）序列化后是字段超集；
 * 这里只取 UI 需要的子集，缺失字段退化为 null（oomKind 契约上不可空，缺省按 "unknown"）。
 */
function projectV8OomSummary(value: unknown): CrashDiagnosticsV8OomSummary | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const processType =
    typeof record.processType === "string" && record.processType.length > 0
      ? record.processType
      : null;
  const oomKind =
    typeof record.oomKind === "string" && record.oomKind.length > 0 ? record.oomKind : "unknown";
  return {
    processType,
    oomKind,
    oldSpaceBytes: coerceFiniteNumber(record.oldSpaceBytes),
    codeSpaceBytes: coerceFiniteNumber(record.codeSpaceBytes),
  };
}

/** 解析一行 history.jsonl。非 JSON、缺 id 的行返回 null，由调用方跳过（单行损坏不拖垮整表）。 */
export function parseCrashHistoryLine(line: string): CrashDiagnosticsEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  // id 是与 dump/sidecar 关联的去重键，没有 id 的行无法参与合并。
  if (id === "") {
    return null;
  }
  return {
    id,
    dumpPath: null,
    crashedAtMs: coerceFiniteNumber(record.crashedAtMs),
    archivedAtMs: coerceFiniteNumber(record.archivedAtMs),
    sizeBytes: coerceFiniteNumber(record.sizeBytes),
    v8OomSummary: projectV8OomSummary(record.v8OomSummary),
    source: "history",
  };
}

/** sidecar JSON 的宽松投影；缺失/损坏的字段为 null，由归档扫描侧的 stat 兜底。 */
export interface CrashSidecarProjection {
  crashedAtMs: number | null;
  archivedAtMs: number | null;
  sizeBytes: number | null;
  v8OomSummary: CrashDiagnosticsV8OomSummary | null;
}

/** 解析归档 .dmp.json sidecar。非 JSON 时返回全 null 投影，绝不抛错。 */
export function parseCrashSidecarJson(text: string): CrashSidecarProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_CRASH_SIDECAR_PROJECTION;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_CRASH_SIDECAR_PROJECTION;
  }
  const record = parsed as Record<string, unknown>;
  return {
    // 新 sidecar 显式写 crashedAtMs；旧 sidecar 只有 ISO 字符串的 archivedAt。
    crashedAtMs: coerceFiniteNumber(record.crashedAtMs),
    archivedAtMs:
      coerceFiniteNumber(record.archivedAtMs) ?? coerceIsoTimestampMs(record.archivedAt),
    sizeBytes: coerceFiniteNumber(record.sizeBytes),
    v8OomSummary: projectV8OomSummary(record.v8OomSummary),
  };
}

/** 条目排序时间键：crash 时间优先，缺省回退归档时间，二者皆未知为 null（排序置尾）。 */
function crashEntryTimeMs(entry: CrashDiagnosticsEntry): number | null {
  return entry.crashedAtMs ?? entry.archivedAtMs;
}

function compareCrashDiagnosticsEntriesDesc(
  left: CrashDiagnosticsEntry,
  right: CrashDiagnosticsEntry,
): number {
  const leftMs = crashEntryTimeMs(left);
  const rightMs = crashEntryTimeMs(right);
  if (leftMs === null && rightMs === null) {
    return left.id.localeCompare(right.id);
  }
  if (leftMs === null) {
    return 1;
  }
  if (rightMs === null) {
    return -1;
  }
  return rightMs - leftMs || left.id.localeCompare(right.id);
}

/**
 * 合并 history 与归档扫描两路条目：按 id 去重，history 优先（crash 时间的权威来源）；
 * 仅归档可见的条目保留 source "archive"。history 行不带 dump 路径，dump 仍在盘上时
 * 从归档条目回填 dumpPath，让 UI 能对该行提供「显示于文件夹」。输出按
 * crashedAtMs ?? archivedAtMs 降序，未知时间置尾。
 */
export function mergeCrashDiagnosticsSources(params: {
  historyEntries: readonly CrashDiagnosticsEntry[];
  archiveEntries: readonly CrashDiagnosticsEntry[];
}): CrashDiagnosticsEntry[] {
  const merged = new Map<string, CrashDiagnosticsEntry>();
  for (const entry of params.historyEntries) {
    merged.set(entry.id, entry);
  }
  for (const entry of params.archiveEntries) {
    const existing = merged.get(entry.id);
    if (!existing) {
      merged.set(entry.id, { ...entry, source: "archive" });
      continue;
    }
    if (existing.dumpPath === null && entry.dumpPath !== null) {
      merged.set(entry.id, { ...existing, dumpPath: entry.dumpPath });
    }
  }
  return [...merged.values()].sort(compareCrashDiagnosticsEntriesDesc);
}

/**
 * 从 history 行中挑选最新的 limit 行（按 crashedAtMs ?? archivedAtMs 降序，null 置尾，
 * 损坏行不占容量）。返回值保持原文件的追加顺序（旧行在前），调用方整体重写文件即可，
 * 不破坏 history.jsonl 的追加语义。
 */
export function selectNewestCrashHistoryLines(
  lines: readonly string[],
  limit: number = CRASH_HISTORY_MAX_LINES,
): string[] {
  if (limit <= 0) {
    return [];
  }
  const indexed: Array<{ line: string; index: number; entry: CrashDiagnosticsEntry }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const entry = parseCrashHistoryLine(line);
    if (entry) {
      indexed.push({ line, index, entry });
    }
  }
  indexed.sort(
    (left, right) =>
      compareCrashDiagnosticsEntriesDesc(left.entry, right.entry) || left.index - right.index,
  );
  return indexed
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.line);
}

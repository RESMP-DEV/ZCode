import { IDiagnosticsService } from "./diagnostics.js";
import type { CrashDiagnosticsEntry, CrashDiagnosticsPaths } from "./diagnostics.js";
import {
  crashDumpIdFromFileName,
  mergeCrashDiagnosticsSources,
  parseCrashHistoryLine,
  parseCrashSidecarJson,
  type CrashSidecarProjection,
} from "./crashHistoryProjection.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "#src/paths.js";

/**
 * 设置页诊断只读服务（read model）。数据两路合并：
 * 1. crash/history.jsonl —— 捕获侧追加的崩溃历史，dump 被保留策略清理后仍可见；
 * 2. crash/archive 现存 *.dmp 扫描（stat + 兄弟 .dmp.json 宽松解析）。
 * 只读边界：绝不触碰 crash/live（Crashpad/远端 SDK 所有）。
 * 失败语义：目录/文件不存在 → 空数据；单条损坏 → 跳过该条（specs/settings-diagnostics-crash-logs.md 行为 1）。
 */

const CRASH_DIRECTORY_NAME = "crash";
const CRASH_ARCHIVE_DIRECTORY_NAME = "archive";
const CRASH_HISTORY_FILE_NAME = "history.jsonl";
const LOGS_DIRECTORY_NAME = "logs";
const CRASH_SIDECAR_FILE_SUFFIX = ".json";

interface CrashDiagnosticsDirPaths extends CrashDiagnosticsPaths {
  historyPath: string;
}

function resolveCrashDiagnosticsPaths(): CrashDiagnosticsDirPaths {
  const configDir = getAppConfigDir();
  return {
    crashArchiveDir: join(configDir, CRASH_DIRECTORY_NAME, CRASH_ARCHIVE_DIRECTORY_NAME),
    historyPath: join(configDir, CRASH_DIRECTORY_NAME, CRASH_HISTORY_FILE_NAME),
    logsDir: join(configDir, LOGS_DIRECTORY_NAME),
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const EMPTY_CRASH_SIDECAR: CrashSidecarProjection = {
  crashedAtMs: null,
  archivedAtMs: null,
  sizeBytes: null,
  v8OomSummary: null,
};

async function readCrashHistoryEntries(historyPath: string): Promise<CrashDiagnosticsEntry[]> {
  let content: string;
  try {
    content = await readFile(historyPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
  // 单行损坏只跳过该行，不影响整表。
  const entries: CrashDiagnosticsEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseCrashHistoryLine(line);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

async function readCrashSidecar(sidecarPath: string): Promise<CrashSidecarProjection> {
  try {
    return parseCrashSidecarJson(await readFile(sidecarPath, "utf-8"));
  } catch {
    // sidecar 缺失/损坏只影响该行的取证信息（归档时间、OOM 摘要），不影响整表。
    return EMPTY_CRASH_SIDECAR;
  }
}

async function scanCrashArchiveEntries(archiveDir: string): Promise<CrashDiagnosticsEntry[]> {
  let dumpFileNames: string[];
  try {
    const dirEntries = await readdir(archiveDir, { withFileTypes: true });
    dumpFileNames = dirEntries
      .filter((entry) => entry.isFile() && crashDumpIdFromFileName(entry.name) !== null)
      .map((entry) => entry.name);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const entries: CrashDiagnosticsEntry[] = [];
  for (const fileName of dumpFileNames) {
    const id = crashDumpIdFromFileName(fileName);
    if (id === null) {
      continue;
    }
    const dumpPath = join(archiveDir, fileName);
    let dumpStats;
    try {
      dumpStats = await stat(dumpPath);
    } catch {
      // readdir 后 dump 可能被并发清理；它不再属于本次只读快照。
      continue;
    }
    const sidecar = await readCrashSidecar(`${dumpPath}${CRASH_SIDECAR_FILE_SUFFIX}`);
    entries.push({
      id,
      dumpPath,
      // 归档时 utimesSync 把 mtime 保留为源 dump 的 crash 时间；新 sidecar 的显式字段优先。
      crashedAtMs: sidecar.crashedAtMs ?? dumpStats.mtimeMs,
      archivedAtMs: sidecar.archivedAtMs,
      sizeBytes: dumpStats.size,
      v8OomSummary: sidecar.v8OomSummary,
      source: "archive",
    });
  }
  return entries;
}

export function createDiagnosticsService(): IDiagnosticsService {
  async function listCrashArchives(): Promise<CrashDiagnosticsEntry[]> {
    const paths = resolveCrashDiagnosticsPaths();
    const [historyEntries, archiveEntries] = await Promise.all([
      readCrashHistoryEntries(paths.historyPath),
      scanCrashArchiveEntries(paths.crashArchiveDir),
    ]);
    return mergeCrashDiagnosticsSources({ historyEntries, archiveEntries });
  }

  async function getDiagnosticsPaths(): Promise<CrashDiagnosticsPaths> {
    const { crashArchiveDir, logsDir } = resolveCrashDiagnosticsPaths();
    return { crashArchiveDir, logsDir };
  }

  return {
    listCrashArchives,
    getDiagnosticsPaths,
  };
}

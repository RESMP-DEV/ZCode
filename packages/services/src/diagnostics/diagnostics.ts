import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * V8 OOM 摘要的跨包可序列化子集；desktop 侧完整注解摘要序列化进
 * history/sidecar 后由 read model 宽松投影到该形状（specs/settings-diagnostics-crash-logs.md）。
 */
export interface CrashDiagnosticsV8OomSummary {
  processType: string | null;
  /** "code_space_exhausted" | "js_heap_exhausted" | "unknown"；宽容字符串以避免跨包枚举漂移。 */
  oomKind: string;
  oldSpaceBytes: number | null;
  codeSpaceBytes: number | null;
}

export interface CrashDiagnosticsEntry {
  /** dump 文件名去扩展（Crashpad UUID）。 */
  id: string;
  /** 归档 .dmp 路径；dump 已被保留策略清理、仅 history 有记录时为 null。 */
  dumpPath: string | null;
  /** 实际 crash 时间（源 dump mtime）；未知为 null。 */
  crashedAtMs: number | null;
  archivedAtMs: number | null;
  sizeBytes: number | null;
  v8OomSummary: CrashDiagnosticsV8OomSummary | null;
  source: "history" | "archive";
}

export interface CrashDiagnosticsPaths {
  crashArchiveDir: string;
  logsDir: string;
}

export interface IDiagnosticsService {
  listCrashArchives(): Promise<CrashDiagnosticsEntry[]>;
  getDiagnosticsPaths(): Promise<CrashDiagnosticsPaths>;
}

export const IDiagnosticsService = createServiceDescriptor<IDiagnosticsService>(
  ServiceChannels.Diagnostics,
);

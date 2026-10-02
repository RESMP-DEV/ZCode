import type { CrashDiagnosticsEntry } from "@zcode/services";

/**
 * 设置页诊断区的纯展示逻辑（specs/settings-diagnostics-crash-logs.md 行为 2）。
 * 不依赖 React 与运行时服务，便于 node:test 直接覆盖边界值。
 */

/** 选择崩溃记录的展示时间：真实 crash 时间优先，缺省退回归档时间，与 read model 的排序规则保持同一口径。 */
export function pickCrashTimestamp(
  entry: Pick<CrashDiagnosticsEntry, "crashedAtMs" | "archivedAtMs">,
): number | null {
  return entry.crashedAtMs ?? entry.archivedAtMs ?? null;
}

/** sizeBytes 缺省（dump 已清理且历史未记录大小）时的占位符。 */
export const CRASH_SIZE_PLACEHOLDER = "—";

/**
 * 紧凑大小文案，单位只用 B/KB/MB：dump 归档保留上限为 100MB（spec 行为 3），
 * 不存在需要 GB 的真实输入。toFixed 固定 "." 小数点，天然 locale 无关；
 * 整数结果去掉 ".0" 尾巴（"1 KB" 而非 "1.0 KB"）。
 */
export function formatCrashSize(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return CRASH_SIZE_PLACEHOLDER;
  }
  const KB = 1024;
  const MB = KB * 1024;
  const compact = (value: number): string => value.toFixed(1).replace(/\.0$/, "");
  if (sizeBytes < KB) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < MB) {
    return `${compact(sizeBytes / KB)} KB`;
  }
  return `${compact(sizeBytes / MB)} MB`;
}

/** 计数走手动复数（模式取自 MemorySettingsViewer），返回选中 messageId 的 ".one"/".other" 后缀结果。 */
export function crashCountMessageId(count: number): string {
  return `settings.diagnostics.crash.count.${count === 1 ? "one" : "other"}`;
}

/**
 * 以显式选项固定日期字段与 hourCycle，避免依赖宿主默认 locale 造成的展示漂移；
 * locale 由调用方（useZCodeIntl）传入。无效输入返回 null，由组件决定占位文案。
 */
export function formatCrashTime(timestampMs: number | null, locale: string): string | null {
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestampMs);
}

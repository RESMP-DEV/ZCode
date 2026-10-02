import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { FileWarning, FolderOpen, FolderSearch } from "lucide-react";
import {
  type CrashDiagnosticsEntry,
  type CrashDiagnosticsPaths,
  type IDiagnosticsService,
} from "@zcode/services";
import {
  TID_SETTINGS_DIAGNOSTICS_COUNT,
  TID_SETTINGS_DIAGNOSTICS_CRASH_REVEAL,
  TID_SETTINGS_DIAGNOSTICS_CRASH_ROW,
  TID_SETTINGS_DIAGNOSTICS_OPEN_CRASH_DIR,
  TID_SETTINGS_DIAGNOSTICS_OPEN_LOGS_DIR,
  TID_SETTINGS_DIAGNOSTICS_REFRESH,
  TID_SETTINGS_DIAGNOSTICS_SECTION,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  crashCountMessageId,
  formatCrashSize,
  formatCrashTime,
  pickCrashTimestamp,
} from "@/settings/diagnosticsListPresentation.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

type DiagnosticsService = Pick<IDiagnosticsService, "listCrashArchives" | "getDiagnosticsPaths">;

type DiagnosticsLoadingState = "idle" | "loading" | "ready" | "error";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 设置页「诊断」区（specs/settings-diagnostics-crash-logs.md 行为 2）。
 * 与 Memory 一致：始终读本地 Host 注入的服务，request-id 防竞态刷新，无 Zustand。
 */
export function DiagnosticsSettingsSection({
  diagnosticsService,
  isDesktop = false,
}: {
  diagnosticsService: DiagnosticsService;
  isDesktop?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const requestIdRef = useRef(0);
  const [state, setState] = useState<DiagnosticsLoadingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<CrashDiagnosticsEntry[]>([]);
  const [paths, setPaths] = useState<CrashDiagnosticsPaths | null>(null);

  const refresh = useCallback(async (): Promise<CrashDiagnosticsEntry[] | null> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState("loading");
    setError(null);
    try {
      // 列表与路径合并为一次刷新，两路都成功才算 ready；任一失败整区进入 error。
      const [crashes, nextPaths] = await Promise.all([
        diagnosticsService.listCrashArchives(),
        diagnosticsService.getDiagnosticsPaths(),
      ]);
      if (requestIdRef.current !== requestId) {
        return null;
      }
      setEntries(crashes);
      setPaths(nextPaths);
      setState("ready");
      return crashes;
    } catch (cause) {
      if (requestIdRef.current !== requestId) {
        return null;
      }
      setEntries([]);
      setPaths(null);
      setError(getErrorMessage(cause));
      setState("error");
      return null;
    }
  }, [diagnosticsService]);

  useEffect(() => {
    if (!isDesktop) {
      requestIdRef.current += 1;
      setState("idle");
      setError(null);
      setEntries([]);
      setPaths(null);
      return;
    }
    void refresh();
  }, [isDesktop, refresh]);

  const handleOpenPath = useCallback(
    async (path: string) => {
      const result = await platform.openInFileManager(path);
      if (!result.success) {
        toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
      }
    },
    [intl, platform],
  );

  if (!isDesktop) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.diagnostics.desktopOnly" })}
      </div>
    );
  }

  const formatCrashCount = (count: number) =>
    intl.formatMessage({ id: crashCountMessageId(count) }, { count });
  const revealUnavailableLabel = intl.formatMessage({
    id: "settings.diagnostics.crash.revealUnavailable",
  });

  return (
    <div className="space-y-6" data-testid={TID_SETTINGS_DIAGNOSTICS_SECTION}>
      <SettingsGroupCard>
        <div className="px-4 pt-3 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.diagnostics.paths.title" })}
        </div>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.diagnostics.paths.logsDir" })}
          description={paths?.logsDir}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg"
              data-testid={TID_SETTINGS_DIAGNOSTICS_OPEN_LOGS_DIR}
              disabled={!paths}
              onClick={() => {
                if (paths) void handleOpenPath(paths.logsDir);
              }}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.diagnostics.paths.openInFileManager" })}
            </Button>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.diagnostics.paths.crashArchiveDir" })}
          description={paths?.crashArchiveDir}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg"
              data-testid={TID_SETTINGS_DIAGNOSTICS_OPEN_CRASH_DIR}
              disabled={!paths}
              onClick={() => {
                if (paths) void handleOpenPath(paths.crashArchiveDir);
              }}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.diagnostics.paths.openInFileManager" })}
            </Button>
          }
        />
      </SettingsGroupCard>

      <section className="space-y-4">
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.diagnostics.crash.title" })}
            </h3>
            <div className="h-4 w-px bg-border" aria-hidden="true" />
            <span
              data-testid={TID_SETTINGS_DIAGNOSTICS_COUNT}
              className="shrink-0 text-ui-sm text-foreground-subtle"
            >
              {formatCrashCount(entries.length)}
            </span>
          </div>
          <SettingsResourceHeaderActions
            onRefresh={() => void refresh()}
            refreshing={state === "loading"}
            refreshTestId={TID_SETTINGS_DIAGNOSTICS_REFRESH}
          />
        </div>

        {error ? (
          <Alert>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : state === "idle" || (state === "loading" && entries.length === 0) ? (
          <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.diagnostics.crash.loading" })}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.diagnostics.crash.empty" })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl bg-surface">
            {entries.map((entry, index) => {
              // dumpPath 是「能否看到原始 dump」的唯一事实；仅 history 有记录（dump 已清理）的行降级为纯记录展示。
              const dumpRetained = entry.dumpPath !== null;
              const crashTime = formatCrashTime(pickCrashTimestamp(entry), locale);
              return (
                <Fragment key={entry.id}>
                  {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                  <div
                    data-testid={testId(TID_SETTINGS_DIAGNOSTICS_CRASH_ROW, entry.id)}
                    className="flex min-w-0 items-center hover:bg-hover"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background">
                        <FileWarning
                          className="size-4 shrink-0 text-foreground-subtle"
                          aria-hidden="true"
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui-base font-medium text-foreground">
                          {crashTime ??
                            intl.formatMessage({ id: "settings.diagnostics.crash.unknownTime" })}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">
                            {formatCrashSize(entry.sizeBytes)}
                            {" · "}
                            {intl.formatMessage({
                              id: dumpRetained
                                ? "settings.diagnostics.crash.retained"
                                : "settings.diagnostics.crash.historyOnly",
                            })}
                          </span>
                          {entry.v8OomSummary ? (
                            <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                              {intl.formatMessage(
                                { id: "settings.diagnostics.crash.oomBadge" },
                                { kind: entry.v8OomSummary.oomKind },
                              )}
                              {entry.v8OomSummary.processType
                                ? ` · ${entry.v8OomSummary.processType}`
                                : ""}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </div>
                    <span className="mr-3 shrink-0">
                      <ControlHintTooltip
                        title={
                          dumpRetained
                            ? intl.formatMessage({ id: "settings.diagnostics.crash.reveal" })
                            : revealUnavailableLabel
                        }
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-md"
                          aria-label={
                            dumpRetained
                              ? intl.formatMessage({ id: "settings.diagnostics.crash.reveal" })
                              : revealUnavailableLabel
                          }
                          data-testid={testId(TID_SETTINGS_DIAGNOSTICS_CRASH_REVEAL, entry.id)}
                          disabled={!dumpRetained}
                          onClick={() => {
                            if (entry.dumpPath) void handleOpenPath(entry.dumpPath);
                          }}
                        >
                          <FolderSearch aria-hidden="true" />
                        </Button>
                      </ControlHintTooltip>
                    </span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

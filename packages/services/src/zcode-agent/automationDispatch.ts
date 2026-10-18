// 共享的 automation 派发核心（specs/automation-system-scheduling.md）：
// desktop host（窗口内派发）与 automation runner（detached tick 派发）走同一实现——
// 新建 fresh session、固定模型选择、订阅终态 outcome、结算 manual/schedule 台账。
// 会话绑定（targetTaskId resume）已退役：迁移 0006 之后任何派发一律 createTask。
import {
  formatModelPickerValue,
  parseAutomationRunId,
  resolveWorkspaceKey,
  type ModelSelection,
  type TraceId,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeTaskMode,
} from "@zcode/shared";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";

// ---- 运行台账结构接口（ AutomationRepo 满足；测试可注入内存实现）----

export interface AutomationDispatchRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  getRun(runId: string): Promise<ZCodeAutomationRun | null>;
  getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined>;
  fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection>;
}

export interface CronRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

type LogWarn = (message: string, error: unknown) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

export function startManualClaimHeartbeat(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<AutomationDispatchRepo, "touchManualClaim">;
    logWarn: LogWarn;
    intervalMs?: number;
  },
): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

export async function recordCronRunOutcomeBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: Pick<AutomationDispatchRepo, "ensureRunClaimed" | "markRunOutcome">;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

export async function releaseManualClaimBestEffort(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<AutomationDispatchRepo, "releaseManualClaim">;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: Pick<AutomationDispatchRepo, "markRunDispatch" | "releaseManualClaim">;
    dispatchError: unknown;
    logWarn: LogWarn;
  },
): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error
      ? params.dispatchError.message
      : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `回写 manual automation 派发失败状态失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
  await releaseManualClaimBestEffort(params);
}

/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: CronRunLifecycleIdentity & {
    repo: AutomationDispatchRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // 派发方的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}

// ---- 派发核心 ----

export interface AutomationDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AutomationDispatchDeps {
  repo: AutomationDispatchRepo;
  zcodeTaskService: Pick<
    IZCodeTaskService,
    | "createTask"
    | "sendPrompt"
    | "onDynamicTaskTerminalOutcome"
    | "setTaskUnread"
    | "stopGeneration"
  >;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
  logWarn: LogWarn;
  logInfo?: (message: string) => void;
  /** 桌面 host 上报 session 创建遥测（source=automation_scheduled）；runner 缺省为 no-op。 */
  onSessionCreate?: (event: {
    sessionId: string;
    messageId: string;
    workspaceIdentity?: string;
  }) => void;
  /** 桌面 host 的 Bot 回推订阅（best-effort 辅助通道）；runner 缺省跳过。 */
  watchBotDelivery?: (params: {
    automationId: string;
    runId: string;
    taskId: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}

export interface AutomationDispatchResult {
  taskId: string;
  sessionId: string;
  /**
   * 等待本轮 turn 的终态 outcome 落账后 resolve。常驻 host 可以忽略（自身订阅在跑）；
   * 短生命周期 runner 必须 await 它再退出，否则终态回写会随进程消失。
   */
  waitUntilSettled: () => Promise<void>;
}

/**
 * 把一次 cron/manual run 提交给 task service：新建 fresh session（携带 automationId，
 * prompt traceId=runId），订阅终态回写 outcome 并置未读。任何一步失败都会把 run 记为
 * failed 再抛出，由调用方按 schedule/manual 语义结算 automation 状态。
 */
export async function dispatchAutomationRun(
  request: AutomationDispatchRequest,
  deps: AutomationDispatchDeps,
): Promise<AutomationDispatchResult> {
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  const existingRun = await deps.repo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService: deps.modelSelectionService,
    // 未迁入或损坏的新值由此入口明确拒绝，不能当成跟随 Workspace。
    readSelection: () =>
      deps.repo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await deps.repo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  const workspaceKey = resolveWorkspaceKey(request);
  const runIdParts = parseAutomationRunId(request.runId);
  const trigger: ZCodeAutomationTrigger = runIdParts?.trigger === "manual" ? "manual" : "schedule";
  const scheduledAt = runIdParts?.scheduledAt ?? null;
  const identity: CronRunLifecycleIdentity = {
    runId: request.runId,
    automationId: request.automationId,
    workspaceKey,
    scheduledAt,
    trigger,
  };

  let settled: () => void = () => {};
  const settledPromise = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let heartbeat: { dispose(): void } | null = null;

  const cleanupTracking = (): void => {
    heartbeat?.dispose();
    heartbeat = null;
  };

  try {
    // 未绑定会话（迁移后唯一形态）：建会话 trace 与执行 runId 是两种身份；
    // 两条派发路径的 prompt 都必须统一使用 runId。
    const task = await deps.zcodeTaskService.createTask({
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      model: formatModelPickerValue(submissionModelSelection),
      mode: request.mode,
      thoughtLevel: submissionModelSelection.options?.reasoningLevel,
      automationId: request.automationId,
    });
    const promptTraceId = request.runId as TraceId;

    if (deps.watchBotDelivery) {
      await deps.watchBotDelivery({
        automationId: request.automationId,
        runId: promptTraceId,
        taskId: task.taskId,
        workspaceKey,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      });
    }

    await recordCronRunOutcomeBestEffort({ ...identity, repo: deps.repo, outcome: "running", logWarn: deps.logWarn });
    const disposable = deps.zcodeTaskService.onDynamicTaskTerminalOutcome(task.taskId)(
      (result) => {
        if (result.inputId !== promptTraceId) return;
        void settleCronRunTerminalOutcome({
          ...identity,
          repo: deps.repo,
          outcome: result.outcome,
          error: result.error,
          logWarn: deps.logWarn,
        })
          .catch(() => undefined)
          .finally(() => {
            // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
            void deps.zcodeTaskService
              .setTaskUnread({
                taskId: task.taskId,
                workspacePath: request.workspacePath,
                ...(request.workspaceIdentity
                  ? { workspaceIdentity: request.workspaceIdentity }
                  : {}),
                unread: true,
              })
              .catch(() => undefined);
            cleanupTracking();
            disposable.dispose();
            settled();
          });
      },
    );
    if (trigger === "manual") {
      heartbeat = startManualClaimHeartbeat({
        automationId: request.automationId,
        runId: request.runId,
        workspaceKey,
        repo: deps.repo,
        logWarn: deps.logWarn,
      });
    }

    await deps.zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    deps.onSessionCreate?.({
      sessionId: task.taskId,
      messageId: promptTraceId,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    return {
      taskId: task.taskId,
      sessionId: task.taskId,
      waitUntilSettled: () => settledPromise,
    };
  } catch (error) {
    cleanupTracking();
    await recordCronRunOutcomeBestEffort({
      ...identity,
      repo: deps.repo,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
      logWarn: deps.logWarn,
    });
    throw error;
  }
}

/**
 * 立即运行（manual run）的完整结算：派发成功回写 dispatched 台账；失败按 manual 语义
 * 释放 single-flight 锁。claim 保留到真实 turn 终态（由 dispatch 订阅收口）。
 */
export async function dispatchManualAutomationRun(
  params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  },
  deps: AutomationDispatchDeps,
): Promise<AutomationDispatchResult> {
  deps.logInfo?.(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: AutomationDispatchResult;
  try {
    result = await dispatchAutomationRun(
      {
        automationId: params.automation.automationId,
        runId: params.run.runId,
        prompt: params.automation.prompt,
        modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
        mode: params.automation.mode,
        workspacePath: params.automation.workspacePath,
        ...(params.automation.workspaceIdentity
          ? { workspaceIdentity: params.automation.workspaceIdentity }
          : {}),
      },
      deps,
    );
  } catch (error) {
    deps.logWarn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: deps.repo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: deps.logWarn,
    });
    throw error;
  }

  try {
    await deps.repo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
    // 真实终态仍由终态订阅收口，避免同一 automation 重复排队。
    deps.logWarn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  deps.logInfo?.(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
  return result;
}

// ============================================================
// Session Sweep Tool Handlers
// ============================================================
// agent 判断、host 执行：plan 只读列候选；execute 提交删除清单，host 在事务内
// 复核守卫并先备份（快照移动进 backlog）再 tombstone。与 cron/off-peak 不同，
// 本工具允许在 automation turn 内使用——周期清理正是 cron 派发的目标场景。
import {
  createCoreError,
  CoreErrorType,
  SessionSweepExecuteInputJsonSchema,
  SessionSweepExecuteInputSchema,
  SessionSweepExecuteOutputJsonSchema,
  SessionSweepExecuteOutputSchema,
  SessionSweepPlanInputJsonSchema,
  SessionSweepPlanInputSchema,
  SessionSweepPlanOutputJsonSchema,
  SessionSweepPlanOutputSchema,
  SessionSweepSetPinnedInputJsonSchema,
  SessionSweepSetPinnedInputSchema,
  SessionSweepSetPinnedOutputJsonSchema,
  SessionSweepSetPinnedOutputSchema,
  type SessionSweepPort,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const SESSION_SWEEP_TOOL_TIMEOUT_MS = 120_000;
const SESSION_SWEEP_MODEL_BYTES = 96_000;

function assertSessionSweepPort(
  context: ToolExecutionContext,
  toolName: "SessionSweepPlan" | "SessionSweepExecute" | "SessionSweepSetPinned",
): asserts context is ToolExecutionContext & {
  sessionSweepPort: SessionSweepPort;
} {
  if (context.sessionSweepPort) return;
  // 端口缺席 = 当前 Host 不支持会话清理（旧版 app / 测试 double）。
  // 明确报错让 agent 直接结束本轮，而不是退化为猜测性操作。
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `${toolName} is not available: this host does not support session sweeping.`,
    {
      context: { toolCallId: context.toolCallId, toolName },
      recoverable: false,
      retryable: false,
    },
  );
}

const sessionSweepPlanHandler: ToolHandler = async (input, context) => {
  const parsed = SessionSweepPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.InvalidInput, "Invalid SessionSweepPlan input", {
      context: { toolCallId: context.toolCallId, toolName: "SessionSweepPlan" },
      recoverable: true,
      retryable: true,
    });
  }
  assertSessionSweepPort(context, "SessionSweepPlan");
  return context.sessionSweepPort.plan(parsed.data);
};

const sessionSweepExecuteHandler: ToolHandler = async (input, context) => {
  const parsed = SessionSweepExecuteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.InvalidInput, "Invalid SessionSweepExecute input", {
      context: { toolCallId: context.toolCallId, toolName: "SessionSweepExecute" },
      recoverable: true,
      retryable: true,
    });
  }
  assertSessionSweepPort(context, "SessionSweepExecute");
  return context.sessionSweepPort.execute(parsed.data);
};

const sessionSweepSetPinnedHandler: ToolHandler = async (input, context) => {
  const parsed = SessionSweepSetPinnedInputSchema.safeParse(input);
  if (!parsed.success) {
    throw createCoreError(CoreErrorType.InvalidInput, "Invalid SessionSweepSetPinned input", {
      context: { toolCallId: context.toolCallId, toolName: "SessionSweepSetPinned" },
      recoverable: true,
      retryable: true,
    });
  }
  assertSessionSweepPort(context, "SessionSweepSetPinned");
  return context.sessionSweepPort.setPinned(parsed.data);
};

const sessionSweepResultBudget = {
  maxInlineBytes: SESSION_SWEEP_MODEL_BYTES,
  maxModelBytes: SESSION_SWEEP_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: SESSION_SWEEP_MODEL_BYTES,
    direction: "head" as const,
  },
};

const sessionSweepTimeout = {
  defaultMs: SESSION_SWEEP_TOOL_TIMEOUT_MS,
  maxMs: SESSION_SWEEP_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

const sessionSweepPlanPermission: ToolPermissionSpec = {
  permission: "sessionsweep.plan",
  reason: "SessionSweepPlan only lists guard-filtered cleanup candidates",
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export const sessionSweepPlanToolEntry: ToolEntry = {
  capability: "List sessions eligible for cleanup across all workspaces",
  metadata: {
    name: "SessionSweepPlan",
    description:
      "List finished sessions across all workspaces that are eligible for cleanup: not running, not pinned, no unread state, no pending interaction, no cron/off-peak ownership, and inactive for at least minAgeDays. Read-only. Returns each candidate with title, status, dates, workspace, and a short content preview, plus the backlog directory where deleted sessions are backed up.",
    modelInstructions: [
      "Call this first in any cleanup sweep. Never guess which sessions exist.",
      "Candidates are already guard-filtered server-side; every one of them is safe to delete from an activity standpoint, so judge only RELEVANCE (is this conversation still worth keeping?).",
      "Run SessionSweepExecute only with taskIds taken from this plan's output, and pass the same minAgeDays.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: SESSION_SWEEP_TOOL_TIMEOUT_MS,
    maxOutputBytes: SESSION_SWEEP_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionSweepPlanHandler,
  inputSchema: SessionSweepPlanInputJsonSchema,
  outputSchema: SessionSweepPlanOutputJsonSchema,
  runtimeInputSchema: SessionSweepPlanInputSchema,
  runtimeOutputSchema: SessionSweepPlanOutputSchema,
  permission: sessionSweepPlanPermission,
  resultBudget: sessionSweepResultBudget,
  timeout: sessionSweepTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SessionSweepPlan was cancelled before candidates were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const sessionSweepExecuteToolEntry: ToolEntry = {
  capability: "Delete selected sessions with automatic backup",
  metadata: {
    name: "SessionSweepExecute",
    description:
      "Delete the selected sessions (by taskId, from a SessionSweepPlan result). Every deletion is backed up first: the session snapshot is moved into the sweep backlog directory and the index row is tombstoned, so deletions are recoverable by hand. The host re-validates all guards in a transaction; ineligible ids come back in `skipped` and are never deleted.",
    modelInstructions: [
      "Only pass taskIds that came from a SessionSweepPlan call in this same sweep.",
      "Default to deleting sessions that are clearly stale (one-off questions, superseded experiments, duplicate threads). When genuinely unsure about a session, keep it and say why.",
      "Never attempt to delete the session you are currently running in; it will not be in the plan anyway.",
      "Report the outcome: how many deleted, how many skipped and why.",
    ],
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: SESSION_SWEEP_TOOL_TIMEOUT_MS,
    maxOutputBytes: SESSION_SWEEP_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "medium",
    needsApproval: false,
  },
  handler: sessionSweepExecuteHandler,
  inputSchema: SessionSweepExecuteInputJsonSchema,
  outputSchema: SessionSweepExecuteOutputJsonSchema,
  runtimeInputSchema: SessionSweepExecuteInputSchema,
  runtimeOutputSchema: SessionSweepExecuteOutputSchema,
  permission: {
    permission: "sessionsweep.execute",
    reason:
      "SessionSweepExecute tombstones sessions after moving their snapshots into the backlog (recoverable)",
    riskLevel: "medium",
    sideEffectScope: "system",
    // 守卫（不在行动中）+ 强制备份在 host 事务内强制，无需逐次人工确认；
    // 周期清理经 cron 派发，审批会阻塞无人值守运行。
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: sessionSweepResultBudget,
  timeout: sessionSweepTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SessionSweepExecute was cancelled before the deletion batch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const sessionSweepSetPinnedToolEntry: ToolEntry = {
  capability: "Pin sessions worth keeping or unpin stale pins",
  metadata: {
    name: "SessionSweepSetPinned",
    description:
      "Pin or unpin sessions by taskId (from a SessionSweepPlan result). Pinning marks a session worth keeping — it moves to the pinned group and is permanently excluded from cleanup candidates. Unpinning a stale pin does not delete anything: it only lets future sweep plans nominate that session for deletion again. Both are reversible membership changes.",
    modelInstructions: [
      "Pin a plan candidate only when it is clearly worth keeping long-term (a decision record, an investigation still referenced); do not pin merely because you are slightly unsure — simply leave unsure sessions undeleted and unpinned.",
      "Unpin entries from the plan's pinnedCandidates when the pin is clearly stale (the session is finished and no longer referenced); a later sweep will then nominate it for deletion.",
      "Only pass taskIds that came from a SessionSweepPlan call in this same sweep.",
      "Ids already in the requested state come back in `skipped`; that is expected, not an error.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SESSION_SWEEP_TOOL_TIMEOUT_MS,
    maxOutputBytes: SESSION_SWEEP_MODEL_BYTES,
    sideEffectScope: "system",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sessionSweepSetPinnedHandler,
  inputSchema: SessionSweepSetPinnedInputJsonSchema,
  outputSchema: SessionSweepSetPinnedOutputJsonSchema,
  runtimeInputSchema: SessionSweepSetPinnedInputSchema,
  runtimeOutputSchema: SessionSweepSetPinnedOutputSchema,
  permission: {
    permission: "sessionsweep.setPinned",
    reason:
      "SessionSweepSetPinned only flips task membership pin state; deletion safety stays with the guarded execute path",
    riskLevel: "low",
    sideEffectScope: "system",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: sessionSweepResultBudget,
  timeout: sessionSweepTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SessionSweepSetPinned was cancelled before the pin batch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

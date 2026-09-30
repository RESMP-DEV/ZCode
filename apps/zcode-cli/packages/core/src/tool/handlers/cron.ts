// ============================================================
// Cron Tool Handlers
// ============================================================

import {
  CoreErrorType,
  CronCreateInputJsonSchema,
  CronCreateInputSchema,
  CronCreateOutputJsonSchema,
  CronCreateOutputSchema,
  CronDeleteInputJsonSchema,
  CronDeleteInputSchema,
  CronDeleteOutputJsonSchema,
  CronDeleteOutputSchema,
  CronListInputJsonSchema,
  CronListInputSchema,
  CronListOutputJsonSchema,
  CronListOutputSchema,
  CronUpdateInputJsonSchema,
  CronUpdateInputSchema,
  CronUpdateOutputJsonSchema,
  CronUpdateOutputSchema,
  createCoreError,
  type CronAutomation,
  type CronCreateInput,
  type CronCreateOutput,
  type CronDeleteInput,
  type CronDeleteOutput,
  type CronListOutput,
  type CronUpdateInput,
  type CronUpdateOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const CRON_TOOL_TIMEOUT_MS = 30_000;
const CRON_MODEL_BYTES = 32_000;

function assertNotAutomationTurn(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronUpdate",
): void {
  if (!context.automationTurn) return;
  // provider tool denylist 只是可见性约束，旧入口或异常 provider 仍可能直接提交
  // automation 写工具。handler 必须以 executor 传入的本轮事实做最终拒绝，且不能调用端口。
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    `${toolName} is not allowed while running a scheduled automation.`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
      retryable: false,
    },
  );
}

// CronDelete 是唯一放行进 automation 执行轮的写工具：只能删除触发本轮的 automation
// （自清理，如 pr-loop 在 PR 合并后收尾，避免空转 no-op 轮）。身份以 executor 传入的
// 本轮事实为准；漏传身份（旧 host / 异常路径）时保守拒绝，绝不退化为允许任意删除。
function assertCronDeleteAllowed(context: ToolExecutionContext, id: string): void {
  if (!context.automationTurn) return;
  if (context.currentTurnAutomationId && context.currentTurnAutomationId === id) return;
  throw createCoreError(
    CoreErrorType.PermissionDenied,
    "CronDelete during a scheduled automation run may only delete the automation that triggered this run (self-cleanup). Delete other automations from a regular interactive turn.",
    {
      context: {
        toolCallId: context.toolCallId,
        toolName: "CronDelete",
      },
      recoverable: false,
      retryable: false,
    },
  );
}

function assertAutomationPort(
  context: ToolExecutionContext,
  toolName: "CronCreate" | "CronList" | "CronUpdate" | "CronDelete",
): asserts context is ToolExecutionContext & {
  automationPort: NonNullable<ToolExecutionContext["automationPort"]>;
} {
  if (context.automationPort) return;
  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `AutomationPort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

function toModelAutomation(automation: CronAutomation): CronAutomation {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // 工具输出曾在此处重新投影 automation 时遗漏 scheduleRule，导致 CronCreate /
    // CronUpdate / CronList 虽收到真实间隔仍只展示兼容 cron，错误显示成每小时或每天。
    scheduleRule: automation.scheduleRule,
  };
}

const cronCreateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronCreate");
  const parsed = CronCreateInputSchema.parse(input) as CronCreateInput;
  assertAutomationPort(context, "CronCreate");

  const automation = await context.automationPort.create(parsed, {
    // 会话内创建定时任务时模型来自当前 runtime，而不是模型可控的工具入参。
    ...(context.model ? { model: `${context.model.providerId}/${context.model.modelId}` } : {}),
    // 会话内创建的 cron 固定复用当前 session，后续触发不再新建 session。
    sessionId: context.sessionId,
  });
  return {
    automation: toModelAutomation(automation),
    message: `Created automation ${automation.automationId}.`,
  } satisfies CronCreateOutput;
};

const cronListHandler: ToolHandler = async (input, context) => {
  CronListInputSchema.parse(input);
  assertAutomationPort(context, "CronList");

  const automations = await context.automationPort.list();
  return {
    automations: automations.map((automation) => ({
      ...toModelAutomation(automation),
      // automation 执行轮内标记触发本轮的条目，供模型免标题匹配地做 scoped CronDelete 自清理。
      // 必须同时要求 automationTurn：执行轮身份缺失（旧 host 漏传）时 currentTurnAutomationId
      // 为空、标记自然不出现；而交互轮即使偶然携带同名字段也不是"本轮触发"，不得标记。
      ...(context.automationTurn && context.currentTurnAutomationId === automation.automationId
        ? { isCurrentTurnAutomation: true }
        : {}),
    })),
  } satisfies CronListOutput;
};

const cronUpdateHandler: ToolHandler = async (input, context) => {
  assertNotAutomationTurn(context, "CronUpdate");
  const parsed = CronUpdateInputSchema.parse(input) as CronUpdateInput;
  assertAutomationPort(context, "CronUpdate");

  const automation = await context.automationPort.update(parsed);
  return {
    automation: toModelAutomation(automation),
    message: `Updated automation ${automation.automationId}.`,
  } satisfies CronUpdateOutput;
};

const cronDeleteHandler: ToolHandler = async (input, context) => {
  const parsed = CronDeleteInputSchema.parse(input) as CronDeleteInput;
  assertCronDeleteAllowed(context, parsed.id);
  assertAutomationPort(context, "CronDelete");

  const deleted = await context.automationPort.delete(parsed);
  return {
    deleted,
    id: parsed.id,
    message: deleted
      ? `Deleted automation ${parsed.id}.`
      : `Automation ${parsed.id} was not found in the current workspace.`,
  } satisfies CronDeleteOutput;
};

function cronPermission(
  permission: string,
  reason: string,
  needsApproval: boolean,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "medium" as const,
    sideEffectScope: "workspace" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: needsApproval ? undefined : ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

const cronResultBudget = {
  maxInlineBytes: CRON_MODEL_BYTES,
  maxModelBytes: CRON_MODEL_BYTES,
  strategy: "truncate" as const,
  preview: {
    maxBytes: CRON_MODEL_BYTES,
    direction: "head" as const,
  },
};

const cronTimeout = {
  defaultMs: CRON_TOOL_TIMEOUT_MS,
  maxMs: CRON_TOOL_TIMEOUT_MS,
  allowCallOverride: false,
};

export const cronCreateToolEntry: ToolEntry = {
  capability: "Create a scheduled automation for the current workspace",
  metadata: {
    name: "CronCreate",
    // 二阶调度要求应在工具 contract 中直接约束模型；自然语言不能靠关键词或正则可靠判定，
    // automation 执行轮的 mutation tool denylist 才是阻止递归修改任务定义的权限边界。
    description:
      "Create a persistent scheduled automation in the current workspace. It uses the host's real current clock for relative delayMinutes schedules, or a standard 5-field cron expression in the user's local timezone for absolute/recurring schedules, and survives app restarts. The prompt must describe the final scheduled work directly and must never ask the run to create, schedule, or configure another automation or call CronCreate.",
    modelInstructions: [
      "Use this only when the user explicitly asks to schedule future automatic work.",
      "Interpret cron in the user's local timezone using fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // '8分钟后上课提醒' 既是相对延迟又是一次性提醒；旧指令里“一次性提醒就 pin
      // 绝对月日时分”的措辞覆盖了相对延迟规则，模型据此自算出 '29 7 29 7 *' 这类固定日历 cron。
      // 模型对“现在”的时刻常是陈旧的，自算的一次性时刻一旦刚过去就被 host 静默滚到下一年。
      // 修复：任何“从现在起 N 后”的表达（含小时、中英文）一律走 delayMinutes；pin 绝对 cron 只
      // 用于用户明确点名的墙钟日期，且显式声明相对一次性必须改用 delayMinutes。
      "For any schedule expressed as a delay from now — 'in 3 minutes' sets delayMinutes=3, '8分钟后' sets delayMinutes=8, 'in 2 hours' sets delayMinutes=120, 'later'/'稍后' — set delayMinutes to the total whole minutes, omit cron, set recurring=false, and omit maxRuns. The host anchors to its real current clock; never infer the current time or convert a relative delay into a cron or clock time yourself.",
      "Use '*/20 * * * *' for every 20 minutes, '0 * * * *' for hourly, and '0 9 * * 1-5' for weekdays at 09:00.",
      // 只用 cron 表达“每 N 单位”会受字段上限影响，且即使 N 未越界也会变成墙钟对齐，
      // 与 UI 自定义重复从保存时刻锚定的语义不一致。所有每 N 单位统一用 carrier + scheduleRule。
      "For every N minutes/hours/days/weeks/months/years, always set intervalUnit (minute|hourly|daily|weekly|monthly|yearly) and interval together. interval must be an integer from 1 to 200, including values cron could express directly. Supply a legal 5-field compatible cron only for time-of-day/day/weekday/month slots; never put an out-of-range step in cron. Examples: every 20 minutes -> intervalUnit='minute', interval=20, cron='* * * * *'; every 31 hours at minute 49 -> intervalUnit='hourly', interval=31, cron='49 * * * *'; every 40 days at 09:00 -> intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit intervalUnit/interval only for ordinary calendar cron schedules, such as weekdays at 09:00.",
      "Pin minute, hour, day-of-month, and month in cron only for an absolute wall-clock date the user names outright, such as 'tomorrow at 9am' or 'on July 30 at 20:00'; set recurring=false and omit maxRuns (the default limit is 1). A relative one-shot such as '8分钟后' or 'in 2 hours' must use delayMinutes instead, because a self-computed one-shot time that has just passed silently rolls a full year forward.",
      "For exactly N scheduled runs, set recurring=false and maxRuns=N. recurring=true is indefinite and must not be combined with maxRuns.",
      "Automations persist in the current workspace until the user deletes them. Finite automations become completed and retain their history; they are not session-only or auto-deleted.",
      "Honor exact user-provided times without adding jitter or shifting the schedule.",
      "Do not include workspace paths or identities in the input; the current session workspace is used.",
      "Always set title and preserve the user's natural-language schedule phrase verbatim in it. The title may be concise, but must not omit timing such as '每20分钟', '每天早上9点', or 'every Friday'.",
      "Write prompt as a complete instruction that can run later without relying on unstated conversation context.",
      "For recurring work with a permanent finish line (for example driving a PR through reviews until it merges), instruct the scheduled run to delete this automation itself with CronDelete once the work is permanently finished. Self-deleting the triggering automation is the only automation management a scheduled run may perform, and it prevents the loop from firing no-op turns forever.",
      "Write the final work directly in prompt. Never ask the scheduled run to create, schedule, or configure another automation, and never ask it to call CronCreate.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronCreateHandler,
  inputSchema: CronCreateInputJsonSchema,
  outputSchema: CronCreateOutputJsonSchema,
  runtimeInputSchema: CronCreateInputSchema,
  runtimeOutputSchema: CronCreateOutputSchema,
  permission: cronPermission(
    "automation.create",
    "CronCreate creates a scheduled background automation for this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronCreate was cancelled before the automation was created",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronListToolEntry: ToolEntry = {
  capability: "List scheduled automations for the current workspace",
  metadata: {
    name: "CronList",
    description: "List scheduled automations in the current workspace.",
    modelInstructions: [
      "Inside a scheduled automation run, exactly one entry carries isCurrentTurnAutomation: true — the automation that triggered this run. Use that id (not title matching) for end-of-life self-cleanup.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: cronListHandler,
  inputSchema: CronListInputJsonSchema,
  outputSchema: CronListOutputJsonSchema,
  runtimeInputSchema: CronListInputSchema,
  runtimeOutputSchema: CronListOutputSchema,
  permission: {
    permission: "automation.read",
    reason: "CronList only reads scheduled automations for this workspace",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronList was cancelled before automations were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronUpdateToolEntry: ToolEntry = {
  capability: "Update a scheduled automation in the current workspace",
  metadata: {
    name: "CronUpdate",
    description:
      "Update selected definition fields of an existing scheduled automation in the current workspace while preserving its id and run history.",
    modelInstructions: [
      "Use CronList first when the automation id is not already known. Never guess an automation id.",
      "Always pass title on every CronUpdate. Rewrite it so it describes the task after the update and keeps the user's natural-language schedule phrase consistent with cron; for example, changing every 5 minutes to every 6 minutes must also update the title.",
      "Apart from the required synchronized title, only pass fields the user asked to change. Omitted fields preserve their existing values.",
      "Interpret cron in the user's local timezone using five fields: minute hour day-of-month month day-of-week. Do not convert to UTC.",
      // 更新“每 N 单位”时同样必须使用 carrier；否则小间隔会退化为墙钟 cron，长间隔会生成非法 cron。
      "To create or change every N minutes/hours/days/weeks/months/years, pass intervalUnit and interval together for every N-unit schedule. interval must be an integer from 1 to 200 even when cron could express N. Also pass a legal compatible cron with only the time/day/weekday/month slot; for example, every 40 days at 09:00 uses intervalUnit='daily', interval=40, cron='0 9 * * *'. Omit the pair only when preserving or using an ordinary calendar cron schedule.",
      "Use numeric maxRuns only with recurring=false. Setting recurring=true clears any old finite limit automatically; never combine recurring=true with a numeric maxRuns.",
      "CronUpdate cannot change workspace, session binding, model, provider, mode, thought level, run count, history, or enabled state.",
      "Do not simulate an update by deleting and recreating the automation.",
      "After a successful update, reply with only a brief confirmation. Do not restate the automation fields in a fenced code block or simulate a text file because the UI renders the updated automation card.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronUpdateHandler,
  inputSchema: CronUpdateInputJsonSchema,
  outputSchema: CronUpdateOutputJsonSchema,
  runtimeInputSchema: CronUpdateInputSchema,
  runtimeOutputSchema: CronUpdateOutputSchema,
  permission: cronPermission(
    "automation.update",
    "CronUpdate changes a scheduled background automation in this workspace",
    true,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronUpdate was cancelled before the automation was updated",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const cronDeleteToolEntry: ToolEntry = {
  capability: "Delete a scheduled automation from the current workspace",
  metadata: {
    name: "CronDelete",
    description:
      "Delete a scheduled automation from the current workspace by automation id. Inside a scheduled automation run, only the automation that triggered the current run may be deleted (self-cleanup once its work is permanently finished).",
    modelInstructions: [
      "Use CronList first when the automation id is not already known. Never guess an automation id.",
      "Inside a scheduled automation run, CronList marks the entry whose isCurrentTurnAutomation is true: that is the automation that triggered this run. When its work is permanently finished (for example the monitored PR merged or the user cancelled the loop), CronDelete that id so the schedule stops firing; this self-cleanup is the built-in end-of-life path for loop-shaped automations.",
      "Deleting a different automation during a scheduled run is rejected. Report to the user and let them delete it from a regular interactive turn instead.",
    ],
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: cronDeleteHandler,
  inputSchema: CronDeleteInputJsonSchema,
  outputSchema: CronDeleteOutputJsonSchema,
  runtimeInputSchema: CronDeleteInputSchema,
  runtimeOutputSchema: CronDeleteOutputSchema,
  permission: cronPermission(
    "automation.delete",
    "CronDelete removes a scheduled background automation from this workspace",
    true,
  ),
  // build 模式下 CronDelete 默认 ask；定时执行轮没有权限响应者，弹窗永远无人应答，
  // 自清理无法完成。这里只对「本轮确为 automation 轮且删除目标正是触发本轮的 automation」
  // 这一个 turn-scoped 情形把 ask 收窄为 proceed（deny 规则与 PreToolUse hook 已在更早
  // 的边界评估过，不受影响）；其他任何 id、交互轮、或身份缺失时保持 ask。
  // handler 内的 assertCronDeleteAllowed 仍独立复核同一身份，纵深防御不因此削弱。
  prepareApproval: (input, turnScope) => {
    if (!turnScope.automationTurn) return { gate: "ask" };
    const parsed = CronDeleteInputSchema.safeParse(input);
    if (!parsed.success) return { gate: "ask" };
    return parsed.data.id === turnScope.currentTurnAutomationId
      ? { gate: "proceed" }
      : { gate: "ask" };
  },
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronDelete was cancelled before the automation was deleted",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

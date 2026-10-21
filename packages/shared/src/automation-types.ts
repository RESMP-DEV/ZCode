import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ZCodeAutomationBotDeliveryTarget } from "./bots.js";
import type { ModelSelection } from "./model-selection.js";

// ---- 定时任务(Automation)领域类型 ----
// automation / automation_runs 存 tasks-index.sqlite。
// 这里是跨 services / cli / desktop / ui 复用的 camelCase 领域类型；sqlite 列名为 snake_case。

/** 单个本地任务索引允许保留的定时任务定义总数；所有生命周期状态都计入。 */
export const AUTOMATION_CREATE_LIMIT = 20;
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

/**
 * automation 执行轮隐藏的「任务定义写工具」（CronCreate/CronUpdate）。CronDelete 刻意
 * 不在表内：执行轮需要删除触发本轮的 automation 做自清理（如 pr-loop 在 PR 合并后收尾），
 * 范围校验在 CronDelete handler 执行边界——只放行 currentTurnAutomationId，身份缺失时
 * 保守拒绝。此常量是 host denylist（bootstrap prompt-turn、services automationToolPolicy）
 * 与 core 兜底判定（turn-loop-state 的 every() fallback）三处的单一事实源；绝不因
 * 「名字像 mutation」把 CronDelete 加回来。命名为 DEFINITION 而非 MUTATION：CronDelete
 * 同样改写 automation 状态但刻意放行，名字必须与内容一致。
 */
export const AUTOMATION_DEFINITION_TOOL_NAMES = ["CronCreate", "CronUpdate"] as const;

export function isAutomationCreateLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
}

/** 整条 automation 的生命周期。 */
export type ZCodeAutomationLifecycleStatus = "active" | "completed" | "failed" | "paused";

/** 单条 automation 当前一轮的派发信息态（供 UI/诊断）。 */
export type ZCodeAutomationDispatchStatus =
  | "idle"
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch";

/** workspace 位置；本期恒为 local，远端预留。 */
export type ZCodeAutomationLocationKind = "local" | "remote";

/** 触发来源：定时 or 立即运行。 */
export type ZCodeAutomationTrigger = "schedule" | "manual";

/** 自定义重复规则；cronExpr 保留为兼容展示，调度以本字段为权威。 */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** yearly 用：1-12 人类月份。缺省回退 anchorAt 的月份（兼容未写该字段的旧记录）。 */
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/**
 * 会话侧长间隔周期 carrier 的 unit 枚举。与 scheduleRule.unit 同集，但 carrier 是受控入参
 * （模型不能直接写完整 scheduleRule），由 service 层归一化为权威 scheduleRule。
 */
export type ZCodeAutomationIntervalUnit = ZCodeAutomationScheduleRule["unit"];

/** 单次 run 的派发结果（scheduler 权威，驱动重试）。skipped=错过触发窗口。 */
export type ZCodeAutomationRunDispatchStatus =
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch"
  | "skipped";

/** 单次 run 产出 session 后的运行结果（由 session runtime 回写，仅用于展示）。 */
export type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** 一条定时任务定义 + 调度状态。 */
export interface ZCodeAutomation {
  projectId?: string | null;
  hostId?: string;
  /** 创建定义时固化，之后不跟随虚拟项目 roots 编辑。 */
  additionalDirectories?: string[];
  automationId: string;
  title: string;
  /** 5 段 cron，本地时区。 */
  cronExpr: string;
  prompt: string;
  /** 缺失表示 Select 阶段继续跟随 Workspace 首选；存在时固定结构化模型意图。 */
  modelSelection?: ModelSelection;
  /** 权限模式；派发时透传给 createTask，缺省走 workspace 默认。 */
  mode?: ZCodeTaskMode;
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * @deprecated 系统级调度（specs/automation-system-scheduling.md）已退役会话绑定：新
   * automation 不再写入，派发一律新建 fresh session。字段仅保留读取存量迁移前的历史行。
   */
  targetTaskId?: string;
  locationKind: ZCodeAutomationLocationKind;
  /** true=无限循环；false=有限次（配合 maxRuns）。 */
  recurring: boolean;
  maxRuns?: number;
  /** 自定义重复的截止时间（本地所选日期的日末，毫秒时间戳）。 */
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /** 会话来源的只读调度是否已被用户在管理页显式删除并重设。 */
  scheduleEditedByUser?: boolean;
  runCount: number;
  enabled: boolean;
  lifecycleStatus: ZCodeAutomationLifecycleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  dispatchStatus: ZCodeAutomationDispatchStatus;
  dispatchAttempts: number;
  retryAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** parseAutomationRunId 的解析结果；scheduledAt 仅 schedule 触发存在。 */
export interface ZCodeAutomationRunIdParts {
  automationId: string;
  trigger: ZCodeAutomationTrigger;
  /** runId 内嵌的本轮理论触发时间（Unix 毫秒）。 */
  scheduledAt?: number;
}

/**
 * runId 契约（见 ZCodeAutomationRun.runId）的唯一解析入口；desktop host/scheduler 与
 * CLI telemetry 不各自按字符串猜格式。不符合两种声明格式的输入一律返回 null。
 */
export function parseAutomationRunId(runId: string): ZCodeAutomationRunIdParts | null {
  const separatorIndex = runId.indexOf(":");
  if (separatorIndex <= 0) return null;
  const automationId = runId.slice(0, separatorIndex);
  const rest = runId.slice(separatorIndex + 1);
  if (rest.startsWith("manual:")) {
    return rest.length > "manual:".length ? { automationId, trigger: "manual" } : null;
  }
  const scheduledAt = Number(rest);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) return null;
  return { automationId, trigger: "schedule", scheduledAt };
}

/** 一次触发的运行历史 / runId 幂等台账。 */
export interface ZCodeAutomationRun {
  /** automationId:scheduledAt / automationId:manual:uuid */
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt?: number;
  trigger: ZCodeAutomationTrigger;
  /** Select 转 Submission 后固定；同一 run 的派发重试不得重新读取 Workspace 首选。 */
  modelSelection?: ModelSelection;
  dispatchStatus: ZCodeAutomationRunDispatchStatus;
  outcome?: ZCodeAutomationRunOutcome;
  /** dispatched 成功后回填，用于历史跳转。 */
  sessionId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** 创建 automation 的入参（workspace 由调用方从 session 上下文注入）。 */
export interface ZCodeAutomationCreateParams {
  projectId?: string | null;
  hostId?: string;
  /** 创建定义时固化，之后不跟随虚拟项目 roots 编辑。 */
  additionalDirectories?: string[];
  title: string;
  cronExpr: string;
  /** 仅创建期使用：由服务层基于真实当前时间换算为 cronExpr，不写入数据库。 */
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  /**
   * @deprecated 会话绑定已退役（specs/automation-system-scheduling.md）；host 不再持久化该
   * 字段，协议参数保留可空仅为旧 CLI 兼容。新 automation 派发一律新建 fresh session。
   */
  targetTaskId?: string;
  /** Bot 会话创建时由 Host 注入；仅供 scheduler 终态回推，不进入 UI 展示模型。 */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /**
   * 会话侧自定义重复 carrier。每 N 分钟/小时/天/周/月/年均配对提交 intervalUnit + interval，
   * 真实间隔由 service 层归一化为权威 scheduleRule 承载；cronExpr 仅作合法兼容展示。
   * 与 scheduleRule、relativeDelayMinutes 互斥。undefined=不使用 carrier。
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** 1–200 的整数间隔，必须与 intervalUnit 配对。 */
  interval?: number;
}

/** 编辑 automation 的可变字段。 */
export interface ZCodeAutomationUpdateParams {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  /** undefined=不修改；null=清空，回退到 Workspace 首选。 */
  modelSelection?: ModelSelection | null;
  /** undefined=不修改；null=清空，回退到 workspace 默认权限模式。 */
  mode?: ZCodeTaskMode | null;
  recurring?: boolean;
  /** undefined=通常不修改；recurring=true 时领域层会自动清空旧上限；显式 null 必须同时传 recurring=true。 */
  maxRuns?: number | null;
  /** undefined=不修改；null=永不结束。 */
  endAt?: number | null;
  /** undefined=不修改；null=恢复为普通 cron。 */
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  /**
   * 会话侧自定义重复 carrier（同 create 侧）。配对提交 intervalUnit + interval，service 层
   * 归一化为权威 scheduleRule（anchorAt 重置为本次修改时刻）。undefined=不修改。
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** 1–200 的整数间隔，必须与 intervalUnit 配对。 */
  interval?: number;
  /** 仅由管理页在用户实际修改调度时写入；undefined=保留原来源状态。 */
  scheduleEditedByUser?: boolean;
}

// ---- 系统级调度（detached cron，specs/automation-system-scheduling.md）----

/**
 * 系统级调度下「关机/休眠太久」的补跑上限：唤醒后首个 tick 只补跑最新一次到期，错过
 * 超过该时长的到期点记 skipped（reason=machine_off_too_long）后推进，不追历史欠账。
 */
export const AUTOMATION_MISFIRE_OFF_TOO_LONG_MS = 24 * 60 * 60 * 1000;

/** skipped run 的 reason 常量：系统级调度下错过超过补跑上限的窗口。 */
export const AUTOMATION_MISFIRE_OFF_TOO_LONG_REASON = "machine_off_too_long";

/** OS 注册方式；status 仅作展示与诊断，不驱动调度行为。 */
export type ZCodeAutomationSchedulingRegistrationKind =
  | "launchd"
  | "systemd"
  | "cron"
  | "schtasks";

/** 调度模式：app=随 app 内 scheduler（现状兜底）；system=OS 注册的 30s tick。 */
export type ZCodeAutomationSchedulingMode = "app" | "system";

/** 系统级调度的开关与注册状态（tasks-index automation_config 为唯一事实源）。 */
export interface ZCodeAutomationSchedulingConfig {
  mode: ZCodeAutomationSchedulingMode;
  /** mode=system 时期望的注册方式；未注册时用于诊断展示。 */
  registrationKind?: ZCodeAutomationSchedulingRegistrationKind;
  enabledAt?: number;
  disabledAt?: number;
  /** runner 最近一次 tick 落账时间（毫秒）；供 UI/CLI 判断注册是否真的在跑。 */
  lastTickAt?: number;
}

/** Host 在定义创建时解析的执行目录；派发只读取此快照，不重新解析项目 roots。 */
export interface ProjectExecutionSnapshot {
  projectId: string | null;
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  additionalDirectories: string[];
}

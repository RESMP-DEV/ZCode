import { AUTOMATION_DEFINITION_TOOL_NAMES } from "@zcode/shared";

// AUTOMATION_DEFINITION_TOOL_NAMES 的单一事实源在 @zcode/shared automation-types：
// host denylist（本文件、bootstrap prompt-turn）与 core 兜底判定（turn-loop-state 的
// every() fallback）三处共用。CronDelete 刻意不进 denylist：执行轮需要删除触发本轮的
// automation 做自清理（如 pr-loop 在 PR 合并后收尾），范围校验在 CronDelete handler
// 执行边界——只放行 currentTurnAutomationId，身份缺失时保守拒绝。绝不因「名字像
// mutation」把 CronDelete 加回来。

export function mergeAutomationDefinitionToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_DEFINITION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// 闲时派发轮只 deny OffPeakCreate（防止闲时任务递归自我派生、无限调度），OffPeakList 只读保留。
// 独立常量，绝不并入 AUTOMATION_DEFINITION_TOOL_NAMES——cron automation 轮
// 明确放行 OffPeakCreate（定时派生闲时任务），混入会让 automation 轮误 deny。
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

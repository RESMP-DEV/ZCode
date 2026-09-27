// automation 执行轮隐藏的是「任务定义写工具」（CronCreate/CronUpdate）。CronDelete 刻意
// 不进 denylist：执行轮需要删除触发本轮的 automation 做自清理（如 pr-loop 在 PR 合并后
// 收尾），范围校验在 CronDelete handler 执行边界——只放行 currentTurnAutomationId，
// 身份缺失时保守拒绝。绝不因「名字像 mutation」把 CronDelete 加回来。
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// 闲时派发轮只 deny OffPeakCreate（防止闲时任务递归自我派生、无限调度），OffPeakList 只读保留。
// 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation 轮
// 明确放行 OffPeakCreate（定时派生闲时任务），混入会让 automation 轮误 deny。
export const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate"] as const;

export function mergeOffPeakMutationToolDenylist(current: readonly string[] | undefined): string[] {
  const merged = new Set(current);
  for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

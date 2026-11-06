import type { AgentRuntimeInternal } from "../internal.js";
import { AUTOMATION_DEFINITION_TOOL_NAMES } from "@zcode/shared";
import {
  AUTOMATION_SELF_PAUSE_TOOL_NAME,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  type RegularTurnLoopState,
} from "./turn-loop-state.js";

export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  if (state.automationCreateLimitReached) return [];
  const tools = runtime.getTools(state.model);
  return disallowed ? tools.filter((tool) => !disallowed.has(tool.name)) : tools;
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // CronDelete 保留可见：自清理范围校验由 handler 执行边界负责。
    for (const toolName of AUTOMATION_DEFINITION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (!state.automationId?.trim()) {
    // CronPauseSelf 的唯一目标是 Host 准入注入的本轮 automationId；普通用户轮、
    // 只有 denylist / queryId 兜底信号的轮都没有可暂停的任务，必须在 provider 边界隐藏。
    tools.add(AUTOMATION_SELF_PAUSE_TOOL_NAME);
  }
  if (!state.automationId?.trim()) {
    // CronPauseSelf 的唯一目标是 Host 准入注入的本轮 automationId；普通用户轮、
    // 只有 denylist / queryId 兜底信号的轮都没有可暂停的任务，必须在 provider 边界隐藏。
    // 不并入 AUTOMATION_MUTATION_TOOL_NAMES：那组是“执行轮隐藏”，这里是“非执行轮隐藏”。
    tools.add(AUTOMATION_SELF_PAUSE_TOOL_NAME);
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // D49：闲时执行轮禁止再创建闲时任务（免费池自我放大）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 按 D49-3 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}

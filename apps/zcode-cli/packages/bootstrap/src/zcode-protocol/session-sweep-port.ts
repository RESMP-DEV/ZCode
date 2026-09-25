// Session Sweep 协议端口：plan/execute 直通 host，CLI 侧不做业务判断。
// 与 automation/off-peak 端口的取舍：
// - 无递归防护：周期清理正是 cron 派发的目标场景，automation turn 内必须可用。
// - 无绑定检查：清理是全局操作，不绑定当前会话（当前会话永远不满足「终态」守卫，
//   host 侧不会把它列入候选）。
// - 结果 schema 与 contracts 工具输出镜像一致，端口层不变形。
import type {
  SessionSweepExecuteInput,
  SessionSweepExecuteOutput,
  SessionSweepPlanInput,
  SessionSweepPlanOutput,
  SessionSweepPort,
  SessionSweepSetPinnedInput,
  SessionSweepSetPinnedOutput,
} from "@zcode/contracts";
import {
  zcodeProtocolMethods,
  zcodeSessionSweepExecuteResultSchema,
  zcodeSessionSweepPlanResultSchema,
  zcodeSessionSweepSetPinnedResultSchema,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

export function createProtocolSessionSweepPort(
  context: ZCodeProtocolAgentServerContext,
): SessionSweepPort {
  return {
    async plan(input: SessionSweepPlanInput): Promise<SessionSweepPlanOutput> {
      // 协议版本兼容：旧 Host 没有 sessionSweep/plan（-32601）时，错误原样上抛，
      // 工具 handler 会把它翻译成「本 Host 不支持会话清理」的终态提示。
      return context.requestClient(
        zcodeProtocolMethods.sessionSweepPlan,
        {
          ...(input.minAgeDays !== undefined ? { minAgeDays: input.minAgeDays } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        zcodeSessionSweepPlanResultSchema,
      );
    },
    async execute(input: SessionSweepExecuteInput): Promise<SessionSweepExecuteOutput> {
      return context.requestClient(
        zcodeProtocolMethods.sessionSweepExecute,
        {
          taskIds: input.taskIds,
          ...(input.minAgeDays !== undefined ? { minAgeDays: input.minAgeDays } : {}),
        },
        zcodeSessionSweepExecuteResultSchema,
      );
    },
    async setPinned(input: SessionSweepSetPinnedInput): Promise<SessionSweepSetPinnedOutput> {
      return context.requestClient(
        zcodeProtocolMethods.sessionSweepSetPinned,
        { taskIds: input.taskIds, pinned: input.pinned },
        zcodeSessionSweepSetPinnedResultSchema,
      );
    },
  };
}

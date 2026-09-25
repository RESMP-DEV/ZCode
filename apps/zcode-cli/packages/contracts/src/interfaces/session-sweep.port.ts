// ============================================================
// Session Sweep Port - agent-driven session cleanup boundary
// ============================================================
// 判断在模型，执行在 host：CLI 只经协议端口触达 tasks-index/backlog，
// 绝不直接读写 sqlite。与 AutomationPort/OffPeakPort 兄弟并列。

import type {
  SessionSweepExecuteInput,
  SessionSweepExecuteOutput,
  SessionSweepPlanInput,
  SessionSweepPlanOutput,
  SessionSweepSetPinnedInput,
  SessionSweepSetPinnedOutput,
} from "../tools/session-sweep.js";

export interface SessionSweepPort {
  /** 只读：返回通过全部「不在行动中」守卫的候选清单（含钉住侧候选）。 */
  plan(input: SessionSweepPlanInput): Promise<SessionSweepPlanOutput>;
  /** 删除（备份 → tombstone）。host 在事务内复核守卫；不合规项被 skip。 */
  execute(input: SessionSweepExecuteInput): Promise<SessionSweepExecuteOutput>;
  /** 钉住/解除钉住。纯 membership 元数据；解除后下一轮 plan 才会提名删除。 */
  setPinned(input: SessionSweepSetPinnedInput): Promise<SessionSweepSetPinnedOutput>;
}

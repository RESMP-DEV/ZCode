// ============================================================
// Session Sweep tools - agent-driven session cleanup
// ============================================================
// 判断在模型，执行在 host：plan 只读返回守卫过滤后的候选；execute 在
// host 事务内复核守卫并执行「备份 → tombstone」。删除永远可从 backlog 恢复。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const nonEmptyString = z.string().trim().min(1);

export const SessionSweepPlanInputSchema = z
  .object({
    minAgeDays: z.number().int().positive().max(365).optional().describe(
      "Only consider sessions whose last activity is older than this many days. Omit for the default (14 days).",
    ),
    limit: z.number().int().positive().max(200).optional().describe(
      "Maximum number of candidates to return. Omit for the default (60).",
    ),
  })
  .strict();
export type SessionSweepPlanInput = z.infer<typeof SessionSweepPlanInputSchema>;
export const SessionSweepPlanInputJsonSchema = toToolJsonSchema(SessionSweepPlanInputSchema);

export const SessionSweepCandidateSchema = z
  .object({
    taskId: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: z.string().optional(),
    title: z.string(),
    status: z.enum(["completed", "error"]).optional(),
    archived: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    preview: z.string(),
  })
  .strict();
export type SessionSweepCandidate = z.infer<typeof SessionSweepCandidateSchema>;

export const SessionSweepPlanOutputSchema = z
  .object({
    candidates: z.array(SessionSweepCandidateSchema),
    pinnedCandidates: z
      .array(SessionSweepCandidateSchema)
      .describe(
        "Pinned sessions that are finished, read, non-blocking, long inactive — eligible to be unpinned so future sweeps can clean them.",
      ),
    backlogDir: nonEmptyString,
    generatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type SessionSweepPlanOutput = z.infer<typeof SessionSweepPlanOutputSchema>;
export const SessionSweepPlanOutputJsonSchema = toToolJsonSchema(SessionSweepPlanOutputSchema);

export const SessionSweepExecuteInputSchema = z
  .object({
    taskIds: z.array(nonEmptyString).min(1).max(200).describe(
      "taskIds selected for deletion from the plan candidates. The host re-validates every guard in a transaction; ineligible ids are skipped, never deleted.",
    ),
    minAgeDays: z.number().int().positive().max(365).optional().describe(
      "Must match the value used in the plan call so guards stay consistent. Omit if the plan call omitted it.",
    ),
  })
  .strict();
export type SessionSweepExecuteInput = z.infer<typeof SessionSweepExecuteInputSchema>;
export const SessionSweepExecuteInputJsonSchema = toToolJsonSchema(SessionSweepExecuteInputSchema);

export const SessionSweepExecuteOutputSchema = z
  .object({
    deleted: z.array(
      z
        .object({
          taskId: nonEmptyString,
          backupPath: z.string(),
          snapshotMoved: z.boolean(),
        })
        .strict(),
    ),
    skipped: z.array(z.object({ taskId: nonEmptyString, reason: z.string() }).strict()),
  })
  .strict();
export type SessionSweepExecuteOutput = z.infer<typeof SessionSweepExecuteOutputSchema>;
export const SessionSweepExecuteOutputJsonSchema = toToolJsonSchema(SessionSweepExecuteOutputSchema);

export const SessionSweepSetPinnedInputSchema = z
  .object({
    taskIds: z
      .array(nonEmptyString)
      .min(1)
      .max(200)
      .describe(
        "taskIds to pin or unpin. Pin sessions worth keeping from the plan candidates; unpin stale pins from the plan's pinnedCandidates so future sweeps can nominate them.",
      ),
    pinned: z.boolean().describe("true to pin (keep), false to unpin (allow future cleanup)."),
  })
  .strict();
export type SessionSweepSetPinnedInput = z.infer<typeof SessionSweepSetPinnedInputSchema>;
export const SessionSweepSetPinnedInputJsonSchema = toToolJsonSchema(SessionSweepSetPinnedInputSchema);

export const SessionSweepSetPinnedOutputSchema = z
  .object({
    updated: z.array(z.object({ taskId: nonEmptyString, pinned: z.boolean() }).strict()),
    skipped: z.array(z.object({ taskId: nonEmptyString, reason: z.string() }).strict()),
  })
  .strict();
export type SessionSweepSetPinnedOutput = z.infer<typeof SessionSweepSetPinnedOutputSchema>;
export const SessionSweepSetPinnedOutputJsonSchema = toToolJsonSchema(
  SessionSweepSetPinnedOutputSchema,
);

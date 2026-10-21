import { describe, expect, it } from "vitest";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import {
  projectHasPendingAction,
  projectHasUnread,
} from "@/project-sidebar/view.js";

// specs/workspace-attention-lifecycle.md：pendingInteraction 的琥珀点 rollup 覆盖
// 分页/可见窗口之外——上游 v3.16.2 的侧栏改为 host 权威树（project-sidebar），
// 选择器在完整 tree.tasks 上汇总；本测试固化该契约：琥珀点的事实源是持久化
// pendingInteraction，蓝点的事实源是 unreadAt，两者互不串扰，归档行一律排除。

function buildTask(params: {
  projectId: string | null;
  hostId?: string;
  archived?: boolean;
  unreadAt?: string | null;
  pendingInteraction?: unknown;
}) {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    projectId: params.projectId,
    hostId: params.hostId ?? "local",
    archived: params.archived ?? false,
    unreadAt: params.unreadAt ?? null,
    ...(params.pendingInteraction !== undefined
      ? { pendingInteraction: params.pendingInteraction }
      : {}),
  };
}

function buildTree(tasks: ReturnType<typeof buildTask>[]): ProjectTree {
  // 选择器只读 tree.tasks；树其余字段由 Host 组装，与本测试的 rollup 契约无关。
  return { tasks } as unknown as ProjectTree;
}

const PROJECT = { id: "project-a", hostId: "local" };

describe("projectHasPendingAction rollup", () => {
  it("lights up when a non-archived task carries pendingInteraction", () => {
    const tree = buildTree([
      buildTask({ projectId: "project-a" }),
      buildTask({ projectId: "project-a", pendingInteraction: { summary: "等确认" } }),
    ]);
    expect(projectHasPendingAction(tree, PROJECT)).toBe(true);
  });

  it("stays dark when the only pendingInteraction task is archived", () => {
    const tree = buildTree([
      buildTask({
        projectId: "project-a",
        archived: true,
        pendingInteraction: { summary: "等确认" },
      }),
    ]);
    expect(projectHasPendingAction(tree, PROJECT)).toBe(false);
  });

  it("stays dark when the pending task belongs to another project or host", () => {
    const tree = buildTree([
      buildTask({ projectId: "project-b", pendingInteraction: { summary: "等确认" } }),
      buildTask({
        projectId: "project-a",
        hostId: "remote-1",
        pendingInteraction: { summary: "等确认" },
      }),
    ]);
    expect(projectHasPendingAction(tree, PROJECT)).toBe(false);
  });

  it("treats key-present undefined pendingInteraction as no signal", () => {
    const tree = buildTree([
      buildTask({ projectId: "project-a", pendingInteraction: undefined }),
    ]);
    expect(projectHasPendingAction(tree, PROJECT)).toBe(false);
  });

  it("never couples the amber dot to unreadAt nor the blue dot to pendingInteraction", () => {
    const onlyUnread = buildTree([
      buildTask({ projectId: "project-a", unreadAt: "2026-10-21T00:00:00.000Z" }),
    ]);
    expect(projectHasPendingAction(onlyUnread, PROJECT)).toBe(false);
    expect(projectHasUnread(onlyUnread, PROJECT)).toBe(true);

    const onlyPending = buildTree([
      buildTask({ projectId: "project-a", pendingInteraction: { summary: "等确认" } }),
    ]);
    expect(projectHasPendingAction(onlyPending, PROJECT)).toBe(true);
    expect(projectHasUnread(onlyPending, PROJECT)).toBe(false);
  });
});

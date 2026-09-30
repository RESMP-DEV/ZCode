import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationPort, CronAutomation } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { cronDeleteToolEntry, cronListToolEntry } from "../src/tool/handlers/cron.js";

// specs/automation-turn-self-cleanup.md：CronDelete 在执行轮只放行触发本轮的 automation
// （自清理），身份缺失 fail closed；交互轮任意 id 走原语义。CronList 仅在执行轮为匹配
// 条目附加 isCurrentTurnAutomation。prepareApproval 在执行轮内对「自身 id」把 ask 收窄
// 为 proceed，其余目标直接 deny（定时轮无权限响应者，无人应答的 ask 会挂死整轮）；
// 交互轮一律保持 ask。

function makeAutomation(automationId: string): CronAutomation {
  return {
    automationId,
    title: `title ${automationId}`,
    cronExpr: "*/5 * * * *",
    prompt: "prompt",
    enabled: true,
    lifecycleStatus: "active",
    runCount: 0,
    recurring: true,
  };
}

function makePort(automations: CronAutomation[]): AutomationPort & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    create: async () => {
      throw new Error("not used in these tests");
    },
    update: async () => {
      throw new Error("not used in these tests");
    },
    list: async () => automations,
    delete: async (input) => {
      deleted.push(input.id);
      return automations.some((a) => a.automationId === input.id);
    },
  };
}

function makeContext(
  overrides: {
    automationTurn?: boolean;
    currentTurnAutomationId?: string;
    automationPort: AutomationPort;
  },
): ToolExecutionContext {
  return {
    toolCallId: "tc_cron_self_cleanup_test",
    ...overrides,
  } as unknown as ToolExecutionContext;
}

test("automation turn deletes the automation that triggered it", async () => {
  const port = makePort([makeAutomation("auto-self")]);
  const context = makeContext({
    automationTurn: true,
    currentTurnAutomationId: "auto-self",
    automationPort: port,
  });
  const result = (await cronDeleteToolEntry.handler({ id: "auto-self" }, context)) as {
    deleted: boolean;
    id: string;
  };
  assert.equal(result.deleted, true);
  assert.equal(result.id, "auto-self");
  assert.deepEqual(port.deleted, ["auto-self"]);
});

test("automation turn deleting a different automation is denied before the port runs", async () => {
  const port = makePort([makeAutomation("auto-self"), makeAutomation("auto-other")]);
  const context = makeContext({
    automationTurn: true,
    currentTurnAutomationId: "auto-self",
    automationPort: port,
  });
  await assert.rejects(
    cronDeleteToolEntry.handler({ id: "auto-other" }, context),
    /may only delete the automation that triggered this run/,
  );
  assert.deepEqual(port.deleted, []);
});

test("automation turn without currentTurnAutomationId fails closed for every id", async () => {
  const port = makePort([makeAutomation("auto-self")]);
  const context = makeContext({ automationTurn: true, automationPort: port });
  await assert.rejects(
    cronDeleteToolEntry.handler({ id: "auto-self" }, context),
    /may only delete the automation that triggered this run/,
  );
  assert.deepEqual(port.deleted, []);
});

test("regular interactive turn deletes any id unchanged", async () => {
  const port = makePort([makeAutomation("a"), makeAutomation("b")]);
  const context = makeContext({ automationTurn: false, automationPort: port });
  const result = (await cronDeleteToolEntry.handler({ id: "b" }, context)) as { deleted: boolean };
  assert.equal(result.deleted, true);
  assert.deepEqual(port.deleted, ["b"]);
});

test("CronList marks only the triggering entry inside an automation turn", async () => {
  const port = makePort([makeAutomation("auto-self"), makeAutomation("auto-other")]);
  const context = makeContext({
    automationTurn: true,
    currentTurnAutomationId: "auto-self",
    automationPort: port,
  });
  const output = (await cronListToolEntry.handler({}, context)) as {
    automations: { automationId: string; isCurrentTurnAutomation?: boolean }[];
  };
  const byId = new Map(output.automations.map((entry) => [entry.automationId, entry]));
  assert.equal(byId.get("auto-self")?.isCurrentTurnAutomation, true);
  assert.equal(byId.get("auto-other")?.isCurrentTurnAutomation, undefined);
});

test("CronList never marks entries outside an automation turn", async () => {
  const port = makePort([makeAutomation("auto-self")]);
  const context = makeContext({
    automationTurn: false,
    currentTurnAutomationId: "auto-self",
    automationPort: port,
  });
  const output = (await cronListToolEntry.handler({}, context)) as {
    automations: { automationId: string; isCurrentTurnAutomation?: boolean }[];
  };
  assert.equal(output.automations[0]?.isCurrentTurnAutomation, undefined);
});

test("prepareApproval proceeds for self-cleanup and denies other targets inside automation turns", () => {
  const prepare = cronDeleteToolEntry.prepareApproval;
  assert.ok(prepare, "CronDelete entry must declare prepareApproval");
  const deny = (gate: unknown): { gate: string; reason?: string } => {
    const g = gate as { gate: string; reason?: string };
    assert.equal(g.gate, "deny");
    assert.ok(g.reason, "deny must carry a human-readable reason");
    return g;
  };
  assert.deepEqual(
    prepare({ id: "auto-self" }, { automationTurn: true, currentTurnAutomationId: "auto-self" }),
    { gate: "proceed" },
  );
  // 执行轮内非自身 id：deny 而非 ask——无人应答的 ask 会无限挂起（bug：permissionTimeoutMs 默认未设）。
  assert.match(
    deny(prepare({ id: "auto-other" }, { automationTurn: true, currentTurnAutomationId: "auto-self" })).reason,
    /may only delete the automation that triggered this run/,
  );
  // 执行轮身份缺失：fail closed 同样发生在 gate 层。
  assert.match(
    deny(prepare({ id: "auto-self" }, { automationTurn: true })).reason,
    /may only delete the automation that triggered this run/,
  );
  // 输入不合法的执行轮调用也 deny，避免挂起在无人应答的 ask 上。
  assert.equal(deny(prepare({ wrong: "shape" }, { automationTurn: true })).gate, "deny");
  // 交互轮保持 ask，走正常人工审批。
  assert.deepEqual(prepare({ id: "auto-self" }, {}), { gate: "ask" });
  assert.deepEqual(prepare({ wrong: "shape" }, {}), { gate: "ask" });
});

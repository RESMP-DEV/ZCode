import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// specs/workspace-attention-lifecycle.md 行为 3 失败语义：
// 单候选快照读取失败只降级为 meta 摘要行（继续创建任务，不中断整份摘要）；
// 候选为空时同样创建任务并说明当前无待办。覆盖 pr#4 review 指出的缺口。

function buildMeta(params: {
  taskId: string;
  workspacePath: string;
  updatedAt: number;
  status?: ZCodeTaskMeta["status"];
  unreadAt?: number;
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: params.workspacePath,
    createdAt: params.updatedAt - 1000,
    updatedAt: params.updatedAt,
    mode: "build",
    ...(params.status ? { status: params.status } : {}),
    ...(typeof params.unreadAt === "number" ? { unreadAt: params.unreadAt } : {}),
    ...(params.pendingInteraction ? { pendingInteraction: params.pendingInteraction } : {}),
  };
}

async function withAdapter(
  run: (params: {
    adapter: ReturnType<typeof createZCodeTaskServiceAdapter>;
    repo: TaskIndexRepo;
    createdTasks: Array<{ workspacePath: string }>;
    prompts: Array<{ taskId: string; content: string }>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-attention-digest-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  // digest 链路只触达 taskIndexRepo 与 adapter 自身的 getTaskSnapshot/createTask/sendPrompt；
  // zcodeAgentService / taskIndexSyncer 在该路径不可达，传入最小占位即可构造 adapter。
  const adapter = createZCodeTaskServiceAdapter({
    zcodeAgentService: {} as Parameters<typeof createZCodeTaskServiceAdapter>[0]["zcodeAgentService"],
    taskIndexSyncer: {
      ensureSessionSubscription: () => {},
      // adapter 构造时订阅终态/就绪事件（digest 路径不会真正触发），返回空 disposable 即可。
      onSessionTerminalEvent: () => ({ dispose: () => {} }),
      onSessionReadyEvent: () => ({ dispose: () => {} }),
    } as Parameters<typeof createZCodeTaskServiceAdapter>[0]["taskIndexSyncer"],
    taskIndexRepo: repo,
  });
  const createdTasks: Array<{ workspacePath: string }> = [];
  const prompts: Array<{ taskId: string; content: string }> = [];
  // adapter 返回的 service 对象就是 digest 闭包里的 service 引用，
  // 覆写方法即可注入快照失败 / 捕获派发内容，无需启动真实 agent runtime。
  const adapterForStubs = adapter as unknown as {
    getTaskSnapshot: (params: { taskId: string }) => Promise<unknown>;
    createTask: (params: { workspacePath: string }) => Promise<{ taskId: string }>;
    sendPrompt: (params: { taskId: string; content: string }) => Promise<void>;
  };
  adapterForStubs.createTask = async (params) => {
    createdTasks.push({ workspacePath: params.workspacePath });
    return { taskId: `digest-task-${createdTasks.length}` };
  };
  adapterForStubs.sendPrompt = async (params) => {
    prompts.push({ taskId: params.taskId, content: params.content });
  };
  try {
    await repo.ensureReady();
    await run({ adapter, repo, createdTasks, prompts });
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("createAttentionDigestTask 单候选快照失败降级为 meta 行且任务仍创建", async () => {
  await withAdapter(async ({ adapter, repo, createdTasks, prompts }) => {
    const now = Date.now();
    const workspacePath = "/tmp/ws-digest";
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "task-good",
        workspacePath,
        updatedAt: now,
        pendingInteraction: { interactionId: "req-1", kind: "permission", toolName: "Bash" },
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({ taskId: "task-bad", workspacePath, updatedAt: now - 1000, unreadAt: now }),
    });

    const adapterForStubs = adapter as unknown as {
      getTaskSnapshot: (params: { taskId: string }) => Promise<unknown>;
    };
    adapterForStubs.getTaskSnapshot = async (params) => {
      if (params.taskId === "task-bad") {
        throw new Error("snapshot unavailable");
      }
      return { messages: [{ role: "user", content: "please review the build result" }] };
    };

    const result = await adapter.createAttentionDigestTask({ locale: "en-US" });

    // 坏候选不得中断流程：任务照常创建并派发 prompt。
    assert.equal(createdTasks.length, 1);
    assert.equal(result.taskId, "digest-task-1");
    assert.equal(prompts.length, 1);
    const content = prompts[0].content;
    // 正常候选保留阻塞状态行与消息尾部。
    assert.match(content, /status="awaiting permission \(Bash\)"/);
    assert.match(content, /please review the build result/);
    // 快照失败候选降级为 meta 摘要行，占位说明代替消息尾部。
    assert.match(content, /task="task-bad"/);
    assert.match(content, /\(No recent message tail available\)/);
  });
});

test("createAttentionDigestTask 无候选时仍创建任务并说明无待办", async () => {
  await withAdapter(async ({ adapter, createdTasks, prompts }) => {
    const result = await adapter.createAttentionDigestTask({ locale: "zh-CN" });

    assert.equal(createdTasks.length, 1);
    assert.equal(result.taskId, "digest-task-1");
    assert.equal(prompts.length, 1);
    const content = prompts[0].content;
    assert.match(content, /\(No attention candidates found\.\)/);
    // locale 决定 agent 输出语言；zh 前缀映射为简体中文。
    assert.match(content, /简体中文/);
  });
});

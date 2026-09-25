import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionStateSnapshotSchema,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

// specs/workspace-attention-lifecycle.md 行为 3 失败语义：
// 单候选快照读取失败只降级为 meta 摘要行（继续创建任务，不中断整份摘要）；
// 候选为空时同样创建任务并说明当前无待办。摘要快照走 readSession(existing-only)，
// 只读现有 runtime，不得为休眠候选拉起 agent。

const DIGEST_WORKSPACE_PATH = "/tmp/ws-digest";

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

function buildSessionSnapshot(params: { sessionId: string; text: string }) {
  return zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: params.sessionId,
      workspace: { workspacePath: DIGEST_WORKSPACE_PATH, workspaceKey: DIGEST_WORKSPACE_PATH },
      sessionKind: "interactive",
      title: params.sessionId,
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId: params.sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    messages: [
      {
        info: {
          messageId: `m-${params.sessionId}`,
          sessionId: params.sessionId,
          role: "user",
          time: { created: 1 },
          agent: "digest-test",
        },
        parts: [
          {
            partId: `p-${params.sessionId}`,
            sessionId: params.sessionId,
            messageId: `m-${params.sessionId}`,
            type: "text",
            text: params.text,
          },
        ],
      },
    ],
  });
}

async function withAdapter(
  run: (params: {
    adapter: ReturnType<typeof createZCodeTaskServiceAdapter>;
    repo: TaskIndexRepo;
    createdTasks: Array<{ workspacePath: string }>;
    prompts: Array<{ taskId: string; content: string }>;
    readSessionCalls: Array<{ sessionId: string; runtimePolicy?: string }>;
    agentService: { readSession: (params: { sessionId: string }) => Promise<unknown> } & Record<
      string,
      unknown
    >;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-attention-digest-"));
  const repo = new TaskIndexRepo(join(dir, "tasks-index.sqlite"));
  const createdTasks: Array<{ workspacePath: string }> = [];
  const prompts: Array<{ taskId: string; content: string }> = [];
  const readSessionCalls: Array<{ sessionId: string; runtimePolicy?: string }> = [];
  // digest 链路只触达 taskIndexRepo 与 zcodeAgentService.readSession(existing-only)；
  // adapter 自身的 createTask/sendPrompt 被覆写以捕获派发内容，无需启动真实 runtime。
  const agentService = {
    async readSession(params: { sessionId: string; runtimePolicy?: string }) {
      readSessionCalls.push({ sessionId: params.sessionId, runtimePolicy: params.runtimePolicy });
      throw new Error(`no existing runtime for ${params.sessionId}`);
    },
  } as never as Parameters<typeof createZCodeTaskServiceAdapter>[0]["zcodeAgentService"];
  const adapter = createZCodeTaskServiceAdapter({
    zcodeAgentService: agentService,
    taskIndexSyncer: {
      ensureSessionSubscription: () => {},
      // adapter 构造时订阅终态/就绪事件（digest 路径不会真正触发），返回空 disposable 即可。
      onSessionTerminalEvent: () => ({ dispose: () => {} }),
      onSessionReadyEvent: () => ({ dispose: () => {} }),
    } as Parameters<typeof createZCodeTaskServiceAdapter>[0]["taskIndexSyncer"],
    taskIndexRepo: repo,
  });
  // adapter 返回的 service 对象就是 digest 闭包里的 service 引用，
  // 覆写方法即可捕获派发内容。
  const adapterForStubs = adapter as unknown as {
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
  const agentServiceHandle = agentService as unknown as {
    readSession: (params: { sessionId: string; runtimePolicy?: string }) => Promise<unknown>;
  } & Record<string, unknown>;
  try {
    await repo.ensureReady();
    await run({
      adapter,
      repo,
      createdTasks,
      prompts,
      readSessionCalls,
      agentService: agentServiceHandle,
    });
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("createAttentionDigestTask 单候选快照失败降级为 meta 行且任务仍创建", async () => {
  await withAdapter(async ({ adapter, repo, createdTasks, prompts, readSessionCalls, agentService }) => {
    const now = Date.now();
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "task-good",
        workspacePath: DIGEST_WORKSPACE_PATH,
        updatedAt: now,
        pendingInteraction: { interactionId: "req-1", kind: "permission", toolName: "Bash" },
      }),
    });
    await repo.syncTaskMeta({
      meta: buildMeta({
        taskId: "task-bad",
        workspacePath: DIGEST_WORKSPACE_PATH,
        updatedAt: now - 1000,
        unreadAt: now,
      }),
    });

    agentService.readSession = async (params) => {
      if (params.sessionId === "task-bad") {
        throw new Error("no existing runtime");
      }
      return buildSessionSnapshot({
        sessionId: "task-good",
        text: "please review the build result",
      });
    };

    const result = await adapter.createAttentionDigestTask({ locale: "en-US" });

    // 坏候选不得中断流程：任务照常创建并派发 prompt。
    assert.equal(createdTasks.length, 1);
    assert.equal(result.taskId, "digest-task-1");
    assert.equal(prompts.length, 1);
    const content = prompts[0].content;
    // 摘要快照只读现有 runtime，不得为候选拉起 session。
    assert.ok(
      readSessionCalls.every((call) => call.runtimePolicy === "existing-only"),
      "digest snapshots must use runtimePolicy existing-only",
    );
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


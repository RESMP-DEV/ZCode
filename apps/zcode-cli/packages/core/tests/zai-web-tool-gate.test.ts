// specs/zai-web-tool-quota-gate.md：Z.AI 计费 Web 工具（WebSearch / WebFetch / 官方
// web_reader MCP）的额度闩锁。覆盖签名识别、TTL、命名匹配，以及 getTools 在
// 闩上 / 未闩 / 枚举三种调用形态下的 provider 可见性。
import { createSessionId, type McpPort } from "@zcode/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime.js";
import {
  isZaiMeteredWebToolName,
  isZaiWebToolingBlocked,
  observeZaiToolQuotaExhaustion,
  resetZaiWebToolGateForTests,
  zaiQuotaProbeTextFromModelContent,
} from "../src/tool/zai-web-tool-quota-gate.js";
import { createMcpToolEntry } from "../src/mcp/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

// 2026-10-18 实测信封原文（webReader 429）。测试用它锁定真实形态，避免签名漂移。
const OBSERVED_1310_ENVELOPE =
  'MCP error -429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29 11:26:14"}}';

const BLOCK_TTL_MS = 6 * 60 * 60 * 1000;

function createGateRuntime(sessionId: string): AgentRuntime {
  return new AgentRuntime(createSessionId(sessionId), {}, {
    eventStore: createTestSessionEventStore(),
  });
}

function registerWebReaderTool(runtime: AgentRuntime): void {
  runtime.getToolRegistry().register(
    createMcpToolEntry(
      "mcp__web_reader__webReader",
      {
        serverName: "web_reader",
        toolName: "webReader",
        description: "official web reader",
        inputSchema: { type: "object" },
      },
      {} as McpPort,
      false,
    ),
  );
  runtime.invalidateToolCache();
}

function createModel(supportsNativeWebSearch: boolean) {
  return createTestRuntimeModel({
    generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
    propertyOverrides: { supportsNativeWebSearch },
  });
}

beforeEach(() => {
  resetZaiWebToolGateForTests();
});

describe("observeZaiToolQuotaExhaustion：签名识别", () => {
  it("实测 1310 信封闩上", () => {
    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);
    expect(isZaiWebToolingBlocked()).toBe(true);
  });

  it("数字形态的业务码同样闩上", () => {
    observeZaiToolQuotaExhaustion('{"error":{"code":1310,"message":"exhausted"}}');
    expect(isZaiWebToolingBlocked()).toBe(true);
  });

  it("官方 MCP quota_exceeded 闩上", () => {
    observeZaiToolQuotaExhaustion(
      '{"error_code":"quota_exceeded","message":"quota exceeded","request_id":"r"}',
    );
    expect(isZaiWebToolingBlocked()).toBe(true);
  });

  it("其它业务码与普通错误文本不闩", () => {
    observeZaiToolQuotaExhaustion('{"error":{"code":"1308","message":"five hour window"}}');
    expect(isZaiWebToolingBlocked()).toBe(false);
    observeZaiToolQuotaExhaustion("Error: downloaded 1310 bytes");
    expect(isZaiWebToolingBlocked()).toBe(false);
    observeZaiToolQuotaExhaustion(undefined);
    expect(isZaiWebToolingBlocked()).toBe(false);
  });

  it("TTL 过期后自动解锁", () => {
    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);
    expect(isZaiWebToolingBlocked(Date.now() + BLOCK_TTL_MS - 1)).toBe(true);
    expect(isZaiWebToolingBlocked(Date.now() + BLOCK_TTL_MS + 1)).toBe(false);
  });

  it("闩上期间的新证据不延长截止（有界恢复）", () => {
    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);
    const firstDeadlineWindowStart = Date.now();
    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);
    // 第二次观察若续期，截止会推到第二个 now + TTL；断言仍在第一个窗口内。
    expect(isZaiWebToolingBlocked(firstDeadlineWindowStart + BLOCK_TTL_MS + 5_000)).toBe(false);
  });
});

describe("isZaiMeteredWebToolName", () => {
  it("只匹配三个计费 Web 工具", () => {
    expect(isZaiMeteredWebToolName("WebSearch")).toBe(true);
    expect(isZaiMeteredWebToolName("WebFetch")).toBe(true);
    expect(isZaiMeteredWebToolName("mcp__web_reader__webReader")).toBe(true);
    expect(isZaiMeteredWebToolName("mcp__exa__web_fetch_exa")).toBe(false);
    expect(isZaiMeteredWebToolName("Read")).toBe(false);
  });
});

describe("zaiQuotaProbeTextFromModelContent", () => {
  it("字符串原样、文本 block 拼接、非文本跳过", () => {
    expect(zaiQuotaProbeTextFromModelContent(OBSERVED_1310_ENVELOPE)).toBe(
      OBSERVED_1310_ENVELOPE,
    );
    expect(
      zaiQuotaProbeTextFromModelContent([
        { type: "text", text: "a" },
        { type: "image", data: "x" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(zaiQuotaProbeTextFromModelContent(42)).toBe("");
    expect(zaiQuotaProbeTextFromModelContent(null)).toBe("");
  });
});

describe("getTools：额度闩锁的 provider 可见性", () => {
  it("未闩时三个计费 Web 工具照常可见", () => {
    const runtime = createGateRuntime("zai-gate-open");
    registerWebReaderTool(runtime);
    const model = createModel(true);

    const names = runtime.getTools(model).map((tool) => tool.name);
    expect(names).toContain("WebSearch");
    expect(names).toContain("WebFetch");
    expect(names).toContain("mcp__web_reader__webReader");
    expect(names).toContain("Read");
  });

  it("闩上后三个一起从请求装配中移除，普通工具不受影响", () => {
    const runtime = createGateRuntime("zai-gate-latched");
    registerWebReaderTool(runtime);
    const model = createModel(true);

    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);

    const names = runtime.getTools(model).map((tool) => tool.name);
    expect(names).not.toContain("WebSearch");
    expect(names).not.toContain("WebFetch");
    expect(names).not.toContain("mcp__web_reader__webReader");
    // 反向断言：闩锁只针对计费 Web 工具，本地工具面完整。
    expect(names).toContain("Read");
    expect(names).toContain("Bash");
  });

  it("model 缺席的枚举调用不过滤（与 shouldExposeWebSearch 同约定）", () => {
    const runtime = createGateRuntime("zai-gate-enumeration");
    registerWebReaderTool(runtime);

    observeZaiToolQuotaExhaustion(OBSERVED_1310_ENVELOPE);

    const names = runtime.getTools().map((tool) => tool.name);
    expect(names).toContain("WebFetch");
    expect(names).toContain("mcp__web_reader__webReader");
  });
});

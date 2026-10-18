// Z.AI 计费 Web 工具（WebSearch / WebFetch / 官方 web_reader MCP）共用 Coding Plan
// 的工具调用额度。额度耗尽时服务端回 429 + 业务码 1310，且该错误有两种回到
// call-runner 的形态：thrown error，或以正常 tool result 内容返回（实测 webReader 的
// 429 即后者）。这里在进程内记住「额度已耗尽」这一观察事实，让 getTools 在 TTL 窗口内
// 直接把三个工具移出 provider 可见的 schema（specs/zai-web-tool-quota-gate.md）。
//
// 为什么是固定 TTL 而不是解析 "will reset at"：该时间串的时区语义不在任何契约里，
// 解析错了会把工具锁死到错误的时间点。TTL 到期后若额度仍耗尽，下一次失败会重新闩上；
// 代价是每个耗尽窗口、每个 Host 进程至多一次失败调用。

const BLOCK_TTL_MS = 6 * 60 * 60 * 1000;

// 1310 是 GLM 业务码「周/月工具额度耗尽」；quota_exceeded 是官方 Server MCP 的
// 结构化 error_code（packages/shared/src/official-mcp-tool-error.ts）。只匹配 JSON
// 键值形态，避免误吞恰好包含 1310 的 request id / 字节数等普通文本。
const ZAI_TOOL_QUOTA_SIGNATURES: readonly RegExp[] = [
  /"code"\s*:\s*"?1310"?/,
  /"error_code"\s*:\s*"?quota_exceeded"?/,
];

let blockedUntilMs = 0;

export function observeZaiToolQuotaExhaustion(text: string | undefined | null): void {
  if (!text || blockedUntilMs > Date.now()) return;
  if (!ZAI_TOOL_QUOTA_SIGNATURES.some((signature) => signature.test(text))) return;
  blockedUntilMs = Date.now() + BLOCK_TTL_MS;
}

export function isZaiWebToolingBlocked(nowMs: number = Date.now()): boolean {
  return nowMs < blockedUntilMs;
}

export function isZaiMeteredWebToolName(toolName: string): boolean {
  return (
    toolName === "WebSearch" ||
    toolName === "WebFetch" ||
    toolName.startsWith("mcp__web_reader__")
  );
}

/**
 * 从 modelContent（字符串或 content block 数组）提取纯文本，供成功路径的额度签名
 * 探测使用。图片等非文本 block 一律跳过；输入形状未知时返回空串而不是抛错——
 * 探测永远不能成为工具结果链路的故障源。
 */
export function zaiQuotaProbeTextFromModelContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** 仅供单测复位进程级单例。 */
export function resetZaiWebToolGateForTests(): void {
  blockedUntilMs = 0;
}

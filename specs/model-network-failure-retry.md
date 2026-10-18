# 模型请求传输层断连的分类与重试

状态：已实现（2026-10-18；依据当日生产事故 request `845bdf71-9baa-4ffe-b24f-f167726062f1`，见 `build/reports/epipe-turn-failure/findings.md`）。本文是模型请求传输层断连错误（errno 型连接错误）分类与重试语义的唯一 spec；实现位于 `apps/zcode-cli/packages/adapters/src/model/failure-inspection.ts`（`isNetworkFailure`）、`failure-classifier.ts` 与 `runner-stream.ts`。

## 背景与问题

- 2026-10-18 09:21:44Z，session `sess_0395c6f7` turn 21：向 `https://api.z.ai/api/anthropic/v1/messages` 上传约 935KB 请求体时对端断开，Node `write` 抛 `EPIPE`（errno -32）。AI SDK 把它包成 `APICallError`（"Cannot connect to API: write EPIPE"），再经 SSE error chunk 包成 `ProviderBusinessError.providerCode="EPIPE"`，全程无任何响应语义。
- `isNetworkFailure` 集合漏掉 `EPIPE`，AI SDK 对连接错误 `isRetryable=false`，分类落到 `reason=unknown/retryable=false`；主对话重试闸门照读分类结果，turn 在第 1/11 次尝试即终止，10 次重试预算未用。同 chat 下一请求成功，说明自动重试本可恢复。
- compact 路径早已有 EPIPE 重试 carve-out（`isCompactStaleCode`），其注释自认「EPIPE 不在通用 model failure retryable 集合中」——主对话路径从未补齐。

## 产品规则

- 传输层 errno 型连接错误（对端断开，尚未产生任何 provider 响应语义）一律按 **network failure** 分类且**可重试**，与 query source 无关（主对话、compact、subagent、workflow 同语义）。
- 传输码集合的唯一所有者是 `failure-inspection.ts` 的 `isNetworkFailure`；两条进入路径都必须命中它：
  1. 直接 code 路径：错误链（含 `cause` 递归）读出 `code`；
  2. provider 包装路径：AI SDK 的 SSE/parsed error 会把传输码放进 `ProviderBusinessError.providerCode`（`isRetryableProviderBusinessNetworkFailure` 同一集合裁决）。
- `EPIPE` 属于该集合（2026-10-18 起写入）。`CONNECTIONCLOSED` 暂不进通用集合：无主对话事故证据、错误来源形态未核实，保留在 compact carve-out（`isCompactStaleCode`）内。
- 超时码（`ETIMEDOUT`、`UND_ERR_*_TIMEOUT`）继续走 timeout 分类（同样可重试），不并入本集合。
- 本规则不改变任何已有重试安全闸门：可见输出已发出后的 `emittedRetryBoundaryEvent` 防线、compact `response_body` 阶段的 phase gate、HTTP 200 body 内 EPIPE 的非 stale 判定全部保持原样。分类器只决定失败类别与可重试性，重放安全性由闸门负责。

## 所有者与事件顺序

```
AI SDK 抛错（fetch/SSE error chunk）
→ failure-inspection.isNetworkFailure      ← 传输码集合唯一 owner
→ failure-classifier.classifyModelFailure
   ├─ ProviderBusinessError.providerCode 命中集合 → network_error / retryable
   └─ 错误链 code 命中集合                  → network_error / retryable
→ runner-stream.canRetryStreamFailure（emittedRetryBoundaryEvent 防线 → 预算 → phase gate）
→ 自动画重试（attempt 递增，直至 maxAttempts）
```

## 验收场景

1. 直接形态（事故的 fetch 层形态）：`APICallError`，`cause = {code:"EPIPE", errno:-32, syscall:"write"}`，无 statusCode → `network_error` / `retryable=true`。
2. provider 包装形态（事故的实际形态）：`ProviderBusinessError{providerCode:"EPIPE"}` 且无 `responseStatus` → `network_error` / `retryable=true`。
3. 主对话（无 `preserveProviderStreamBoundaries`）流式 EPIPE 失败、尚无可见事件时自动重试（attempts ≥ 2）。
4. 回归不破坏：compact HTTP 200 body 内 EPIPE 仍不重试（phase gate 拦截）；可见输出已发出后仍不重试；compact 无 status 的 EPIPE 仍走 carve-out 重试。
5. 集合之外的码不受影响（`ECONNREFUSED`、`ENOTFOUND` 等原分类结果不变）。

# 新 prompt 默认权限模式为 yolo（完全放行）

状态：已实现（2026-09-25，验证：pnpm typecheck / pnpm lint / pnpm architecture:check --changed 全绿；packages/ui 无单测入口，行为验证依赖类型与 lint 门禁）。本文是新任务（新窗口 / 新 prompt）默认权限模式的唯一 spec。

## 背景与问题

- 旧实现里，Composer 新任务草稿的权限模式来自 `readComposerRecent`（上次已接纳提交的 mode），无记忆时回落 `"build"`。桌面端用户从未主动改过模式时，`recent.mode` 恰好是旧默认 `"build"` 的回声，导致「默认」实际上被历史默认锁死。
- 产品决定：新 prompt（新窗口的 Root draft、首次分享导入的新任务初始化）默认使用 `yolo`（完全放行，等价 permission service 的 `mode.yolo` 直通分支），减少新任务的确认打断。

## 产品规则

- 新任务草稿初始化（`initializeNewTaskDraft`）的 `mode` 恒为 `"yolo"`；不再从 Recent 继承权限模式。Recent 仍继续为同一草稿提供 `modelSelection` 种子（模型记忆与本裁决无关）。
- 该默认只影响「新 prompt」：已有会话恢复仍以 session snapshot 的 mode 为准（缺省回落 `"build"`，与 runtime 侧共享配置默认一致）；用户在同一草稿内显式切换模式后，切换结果按 scope 草稿持久化，发送/撤回不改写。
- 提交时 `createComposerSubmissionConfig` 冻结 `mode: "yolo"`；CLI permission service 命中 `mode.yolo` 分支放行普通工具（交互类与显式确认工具仍有各自规则）。Runtime 侧共享配置默认 `build` 不变：未经 Composer 显式携带 mode 的路径（headless、宿主直连等）行为不受影响。

## 所有者与事件顺序

```
新窗口 / 新任务入口
  → useDraftConfigControl（draft scope = "__draft__"，mode 为已初始化标记）
  → initializeNewTaskDraft: mode = "yolo"（本 spec 的默认，不读 recent.mode）
  → 用户可改：handleDraftSwitchMode 写同一 scope 草稿
  → 提交：createComposerSubmissionConfig 冻结 mode → command.config.mode
  → CLI permission service 按 yolo 直通放行
Recent 写路径不变：captureComposerRecentSubmission 仍记录 mode+modelSelection，
仅 newTaskDraft 不再消费其中的 mode。
```

## 验收场景

1. 全新 workspace（无 Recent、无草稿）打开新窗口：Composer 模式选择器显示 Full access（yolo），提交后任务以 yolo 运行。
2. 曾用 `build`/`edit` 提交过的 workspace 打开新 prompt：仍默认 yolo（Recent 的 mode 不再回填新任务）。
3. 用户在新草稿中把模式切到 `edit` 后发送：本次任务 `edit`；再开一个新 prompt：重新回到 yolo 默认。
4. 恢复已有会话：mode 取 session snapshot，不因本默认被改写为 yolo。

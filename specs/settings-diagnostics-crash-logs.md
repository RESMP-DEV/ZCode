# 设置页诊断区：崩溃记录与日志路径

状态：实现中（2026-09-25 起）。本文是 Settings「诊断」区、崩溃只读服务与配套捕获侧增强的唯一 spec。

## 背景与问题

- 崩溃捕获已存在（`packages/desktop/src/main/desktopCrashCapture.ts`：本地 Crashpad 写 `getAppConfigDir()/crash/live`，启动与 gone 事件后归档到 `crash/archive`，保留 5 个 dump / 100MB，附 `.dmp.json` sidecar），但只能靠 agent/shell 查看磁盘；用户无法自助排查。
- 本机 2026-09-25 出现主进程 native crash 循环（live 积压 37+ dump，sidecar 无任何注解），本地数据无法回答「哪个进程、何时、为何崩」。
- 评审发现（本 spec 一并处理的最小集）：sidecar 只有归档时间没有 crash 时间；归档保留 5 个导致「先清理后查看」；`exportLogs` 会把原始 minidump 打进导出包（隐私泄露）。

## 行为 1：崩溃只读服务（services 层 read model）

产品规则：

- 新增 `IDiagnosticsService`（channel `ServiceChannels.Diagnostics`）：
  - `listCrashArchives(): Promise<CrashDiagnosticsEntry[]>`
  - `getDiagnosticsPaths(): Promise<CrashDiagnosticsPaths>`
- 数据源两路合并，按 dump id 去重（history 记录优先，含 crash 时间）：
  1. `crash/history.jsonl`（行为 3 写入的追加式历史，容量上限 200 行）；
  2. `crash/archive` 现存 `*.dmp` 扫描（stat + 兄弟 `.dmp.json` 宽松解析）。
- 排序：`crashedAtMs ?? archivedAtMs` 降序，未知时间置尾。
- 只读边界：服务只读 `crash/archive`、`crash/history.jsonl`、`logs` 目录元数据，绝不读写 `crash/live`（Crashpad/远端 SDK 所有）。
- 失败语义：目录不存在 → 空列表；单条 sidecar/历史行损坏 → 跳过该条，不影响整表。

所有者与数据流：

```
desktop main desktopCrashCapture (capture owner, 写 archive + history.jsonl)
  → packages/services/src/diagnostics/diagnosticsService.ts（read model owner：扫描 + 合并）
  → ServiceChannels.Diagnostics 经 rpc ProxyChannel
  → packages/client RemoteServiceAccess.diagnosticsService
  → packages/ui Settings「诊断」区（local host services only，渲染无第二真相）
```

## 行为 2：Settings「诊断」区（UI）

产品规则：

- 新 section id `diagnostics`（`settingsNavigation.ts` union + guard 同步），nav 归入 `dataAndStats` 组，desktop-only（对齐 `computerUse` 的 gating）；页面标题由 `titleId` 统一渲染，section 内不加 h2。
- 内容：
  - 路径行：`logs` 目录与 `crash/archive` 目录，各带「在文件管理器中打开」（`usePlatform().openInFileManager`，失败 toast，模式取自 SkillsSection）。
  - 崩溃列表：每行 crash 时间（`crashedAtMs ?? archivedAtMs`，缺省显示「未知时间」）、大小、OOM 徽标（`v8OomSummary.oomKind`，`processType` 作 tooltip/副文本）、`dumpPath` 存在时行内「显示于文件夹」；仅 history 存在（dump 已清理）的行降级为纯记录展示。
  - 顶部刷新（`SettingsResourceHeaderActions`）；loading/empty/error 三态沿用 MemorySettings 模式（request-id 防竞态）。
- 服务经 `<ServiceProvider services={localHostServices}>` 注入，props 用 `Pick<IDiagnosticsService, "listCrashArchives">` 窄类型；与 Memory 一致始终用本地 Host。
- i18n：`settings.diagnostics.*` 命名，en-US 与 zh-CN 同步补齐，计数用手动 `.one`/`.other`。
- 纯展示逻辑（时间字段选择、大小格式化、计数字形选择）提取为可测纯函数。

## 行为 3：捕获侧最小增强（desktop main）

产品规则：

- `persistArchivedCrashDump`（desktopCrashCapture.ts）：sidecar JSON 增写 `crashedAtMs`（源 dump mtime）与 `sizeBytes`；同时向 `crash/history.jsonl` 追加一行 `{id, crashedAtMs, archivedAtMs, sizeBytes, v8OomSummary}`（v8OomSummary 为完整注解摘要，可空）。
- `pruneCrashDumpArchive`：清理时同步把 `history.jsonl` 截断到最近 200 行（与归档清理同一同步临界区）。
- `exportLogs.ts`：排除 `crash/live` 整目录与 `crash/archive` 下 `*.dmp` 二进制（保留 `.dmp.json`），消除导出包泄露进程内存的风险。
- 不改动归档触发时机、保留策略数值与 ARMS 交互（见「暂缓项」）。

## 验收场景

1. 归档目录含 dump + 完整 sidecar：诊断区列出该 crash，时间为 crash 时间而非归档时间，可 reveal。
2. dump 已被 5 个保留上限清理但 history.jsonl 有记录：列表仍显示该 crash（无 reveal 按钮），排序按 crash 时间。
3. `crash/` 不存在（新装机）：列表空态，路径行仍显示两个目录按钮。
4. sidecar JSON 损坏：该行跳过，其余正常，无整页错误。
5. 「导出日志」产物不含任何 `.dmp`（含 `crash/live` 全部与 `crash/archive` 二进制），但含 `.dmp.json`。
6. Web/非 desktop 环境不出现该 nav 项。

## 暂缓项（评审结论中未纳入本次，后续独立处理）

- dump 进程身份识别（结构化解析注解流 / `crashReporter.addExtraParameter` / pid→role 快照）。
- 非正常退出哨兵文件与「上次会话崩溃」提示。
- gone 事件监控前移到 bootstrap、`live/` 积压治理（manifest 防重复拷贝）。
- 本地 crashReporter 在遥测关闭时的兜底启用。

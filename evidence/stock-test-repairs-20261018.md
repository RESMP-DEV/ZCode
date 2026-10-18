# 31 个存量单测失败修复 + node:test 套件找回 — 工作凭证（2026-10-18）

- **执行者**：ZCode（GLM-5.3，主会话代理），用户指令「Fix the follow-up」
  （指 evidence/consolidation-20261018.md 立案的 31 个存量失败）。
- **结果**：修复提交 1ab2bdfd..9c9ad87e（5 个原子提交），resmp/main = 9c9ad87e，
  **pre-push hook 全绿通过推送（无 --no-verify）**；全量单测 1939 文件 / 18208 用例
  0 失败（附 11 个原 node:test 文件、66 个此前对套件隐形的用例）。

## 31 个失败的根因分类与处置

1. **迁移 0005 非幂等（4 个失败，真代码 bug）**：`ALTER TABLE tasks ADD COLUMN
   archived_at` 无列存在性检查；测试夹具回拨账本（DELETE FROM
   tasks_schema_migration）后 archived_at 仍在 → duplicate column 中断升级。
   修复：migrations.ts 0005 分支加 PRAGMA table_info 守卫（与 adoptSchema 逐列
   检查同约定；checksumInput 冻结不变，已应用账本不受影响）。真实影响：任何
   账本损坏/回拨后的升级路径都会撞上，值得随快照发布。受影响文件：
   automationRepo / taskIndexRepoUnreadCompareAndClear / tasksDatabaseMigration
   DB109-06（后两者无需改测试，守卫直接修复）。
2. **迁移数量陈旧预期（5 个）**：0004/0005 加入后全新库账本 3→5 行、末位
   0003→0005；tasksStartupPreparation 三处计数与 lastAppliedMigrationId、
   DB109-02/03 两处 toHaveLength 更新（keeps-pre-upgrade 的基线断言性质不变：
   上报升级前基线而非本轮刚补的迁移）。
3. **automation 工具合同更名（4 个）**：AUTOMATION_MUTATION_TOOL_NAMES →
   AUTOMATION_DEFINITION_TOOL_NAMES（单一事实源 @zcode/shared
   automation-types.ts），且 **CronDelete 刻意不在执行轮 denylist**（执行轮需
   自清理本轮 automation，范围校验在 handler 边界；automationToolPolicy.ts 有
   明确设计注释）。offPeak 常量改从 @zcode/shared 导入；v4/zcodeLegacy 断言去掉
   CronDelete。
4. **自动归档默认值升级（1 个）**：7c95edd6 将默认「关、7 天」升级「开、3 天
   （72h）」一次性迁移，settingService 测试预期同步。
5. **UI v3.15.1 集成遗留（17+2 个）**：SettingsPage 渲染期调用 useTabStoreApi
   （mock 补导出，11 个）；useZCodeIntl 严格 Provider 守卫（SSR helper 包
   ZCodeIntlProvider，4 个）；新任务默认 mode build→yolo（PR #3
   feat/ui-defaults，useDraftConfigControl 3 处，SHARE31 按 edited 变体区分）；
   nextResetTime 固定 UTC 午夜在西半球时区落到前一天（改本地正午，chatContext
   1 个）。

## 额外发现：11 个 node:test 文件对套件隐形（66 用例）

全量跑出 11 个文件 "No test suite found"：全部是本地自研测试（sessionSweep、
messageSingleDollarMath=PR#6、taskIndexArchivedUnread=PR#7、attention 系列等）
用 `import test from "node:test"`，vitest 4.1.1（上游升级带入）不再注册
node:test 套件 → 静默收集为 0。统一改 `import { test } from "vitest"`
（API 面相同，均为 test()+assert）。这解释了它们为何从没在任何 affected 报告里
出现：vitest 视其为空文件。

## 环境方法论（本轮实证）

- 全绿条件：nvm node 24.11.1 + 用户环境去掉 `ZCODE_*`/`__CFBundleIdentifier`
  （`env | grep -iE "^zcode|^__CFBundle" | cut -d= -f1 | sed 's/^/-u /'`）。
- `env -i` 全裸环境会让 makensis（windowsInstallerCompile）抛 std::bad_alloc：
  那是本方法的伪影，非存量失败；hook 实际在真实 shell 环境跑，无此问题。
- node 26 会放大 22 个失败，App 内 shell 的 ZCODE_* 泄漏放大 8 个
  （见 evidence/consolidation-20261018.md）。

## 验证（命令 + 结果）

- 12 文件 31 失败集：`vitest run <12 files>`（node24+净环境）→ 378 passed / 0 failed。
- 11 个转换文件 → 66 passed。
- 全量：`vitest run`（node24 + 用户环境去 ZCODE_*）→ **Test Files 1937 passed |
  2 skipped；Tests 18198 passed | 10 skipped；0 failed**（日志
  build/reports/stock-failures-20261018/full-suite-final.log，非跟踪）。
- `pnpm typecheck` exit 0；`pnpm lint` exit 0（61 存量 warning，0 error）。
- 推送：`git push resmp main`（无 --no-verify，hook 全跑）→ f4cab3dc..9c9ad87e。

## Non-claims

- bootstrap 套件历史性 flaky（quota-gate 凭证记录 47/49/44 波动）；本轮全量一次
  通过，但 flaky 复发可能性仍在，单次绿不等于永久稳定。
- 旧凭证记录的 9 个 core 存量失败（io-boundary 出网等）本轮全量中未复现
  （网络可用 + 环境正确），未逐一立案修复。
- 修复以上传 resmp/main 为准；快照重建后随 Preview 发布（迁移守卫是生产代码），
  应用重启仍待用户显式 go。

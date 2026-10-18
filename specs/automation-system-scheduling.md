# Automation 系统级调度（detached cron：OS 拥有时机，runner 拥有执行）

状态：spec 已评审待实现（2026-10-18，方案 A）。执行轮语义全文沿用 `specs/automation-turn-self-cleanup.md`；修订 `specs/session-sweeper.md` 的 cron 保护判定（见「生命周期规则」第 6 条）。

## 背景与问题

现状把 cron 类 automation 链在 app 与 chat 生命周期上（2026-10-18 源码核查）：

1. 会话内 `CronCreate` 写入 `target_task_id`，后续每次触发 resume 同一 task、把 prompt 注入同一会话（`packages/shared/src/automation-types.ts:90`、`packages/desktop/src/host/index.ts:924-980`）；绑定不可改（`CronUpdate` 拒绝），会话归档/清扫后 automation 继续投递到僵尸会话，终态后成为 cron 孤儿。
2. 派发要求存在窗口 host：scheduler utilityProcess（20s 轮询、`claimDue` 原子认领）把运行交给 `resolveCronDispatchHost()`（`packages/desktop/src/main/index.ts:691`，取 windowHostProcessMap 首项）；全部窗口关闭即 `no local host available` 无限退避。
3. app 退出即调度停止，错过超过 5 分钟记 skipped（`computer_asleep_or_app_not_running`），无补跑。

目标：cron 类 automation 与 ZCode app 的运行态完全解耦——OS 级调度（「真正的 cron job」），app 与 CLI 只是管理与探查界面。

## 产品规则

- 时机归 OS：每用户一条注册，只做一件事——周期执行 `zcode automation tick`。macOS launchd LaunchAgent `com.zcode.automations`（`~/Library/LaunchAgents/`，StartInterval 30s + RunAtLoad）；Linux systemd user timer `zcode-automations.timer`（OnBootSec/OnUnitActiveSec 30s、Persistent=true），无 systemd 用户会话时回退 crontab 分钟级；Windows `schtasks /SC MINUTE`。注册与启用解耦：`zcode automation enable|disable` 及 tab 状态卡安装/移除注册，`status` 检测漂移（用户手删 plist 等）并提示自愈。
- 状态归 tasks-index.sqlite（`automations`/`automation_runs` 表结构不变）：runner 无状态，经既有 `AutomationRepo.claimDue`（BEGIN IMMEDIATE）认领；tick、app 内手动 run、legacy scheduler 并发由 claim 串行化，10 分钟僵尸认领回收照旧。
- 执行模型：每次触发在 automation 所属 workspace 新建 fresh session，永不 resume 既有 task；`target_task_id` 退役——新行不再写，存量一次性迁移置空并清除 task meta 的 `cronAutomationId` 镜像；协议 `targetTaskId` 参数保留可空以兼容，host 不再写入。
- 执行轮语义不变：runner 下发 prompt 携带 automationId，`automation-turn-self-cleanup.md` 全部边界（执行轮 CronCreate/CronUpdate 不可见、CronDelete 仅限本轮、审批收窄/fail closed）原样生效。
- 管理面同源：agent 侧工具仍走协议（automationPort → host，不变）；新增用户级 CLI `zcode automation <verb>`（`tick` / `list` / `show` / `runs` / `pause` / `resume` / `delete` / `run`（立即单飞一次）/ `status` / `enable` / `disable`，`list`/`runs`/`status` 支持 `--json`）与 Automations tab 读写同一 tasks-index。无第二条 SQL 写路径：`AutomationRepo` 仍是唯一写抽象（WAL 多进程安全是既有设计），CLI 直连 repo/service 是离线管理面，与 agent 工具的协议面并存。
- 系统级调度默认关闭：启用即安装 OS 注册（显式同意的系统状态变更）；tab 状态卡展示 enabled/disabled、last tick、next fire。
- 注册指向稳定 shim（建议 `~/.zcode/v2/bin/` 下，具体机制为实现计划决策点），运行时解析当前默认 zcode 可执行，不指向版本化安装路径；app/CLI 更新不得使注册失效。调度脱离 app 运行态，但依赖本机已安装的 zcode CLI——卸载即失效，`status` 显式暴露。
- 权限：runner 复用 headless 管线（`packages/cli` 的 headless-workflow：permission broker / session observer / settle 等待），按 automation 冻结的 mode 运行；无响应者的审批 fail closed（同 `CronDelete` 先例）。
- 超时：每 run 硬性 wall-clock 上限默认 30 分钟，超时 kill 子进程并记 failed；轮内既有 runtime 限制照旧。
- runner 落在 zcode-cli 包内（复用 headless 管线与 `@zcode/services` 的 AutomationRepo/AutomationService；CLI 引入 services 还是抽出 runner 模块，由实现计划按 `pnpm architecture:check` 依赖方向决定）。

## 状态所有者与事件顺序

```
launchd / systemd / schtasks（时机所有者，30s tick）
  └─> zcode automation tick（headless runner，无状态）
        │ claimDue（BEGIN IMMEDIATE，仅认领 local workspace 行）
        ▼
  tasks-index.sqlite：automations / automation_runs（状态唯一所有者）
        │ 认领成功（runId = automationId:scheduledAt，幂等台账）
        ▼
  新建 fresh session（spawn agent 进程，prompt 轮携带 automationId）
        │ 终态 outcome
        ▼
  automation_runs.outcome 回写 + next_run_at 推进，进程退出

Automations tab / `zcode automation <verb>`：同一 sqlite 的管理与探查面（读写经 AutomationRepo/AutomationService）
app scheduler utilityProcess：系统级调度开启时停止认领 automations（off-peak 认领不变）；关闭时维持现状兜底
```

- OS 注册是时机的唯一所有者；新模式下 tick 是 cron 认领的唯一执行者，app scheduler 退出 cron 认领（单写者按模式成立；claim 兜底跨进程并发）。
- 单次触发顺序：tick → claimDue → 认领行（running 0→1）→ 建 run 行（claimed）→ spawn fresh session → prompt 轮（automationId）→ 终态 → outcome 回写 + next_run_at 重算（maxRuns/endAt 终态判定照旧）→ 退出。手动 `zcode automation run` 走 runNow 单飞认领后由同一执行器内联执行。

## 失败语义

| 场景 | 行为 |
| --- | --- |
| app 未运行 / 无窗口 | 不构成失败：tick 照常执行（本设计核心） |
| sleep/关机期间到期 | 唤醒/开机后首个 tick 补认领，每个 automation 至多补跑一次（错过多次只跑最新）；错过超过 24h 记 skipped（`machine_off_too_long`）后推进 |
| tick 重叠 / 与 app 并发到期 | claim 串行化，单次到期只跑一次 |
| runner 中途被杀 | 10 分钟僵尸认领回收释放；run 行按既有退避（30s→15min，max 5）续跑或转 failed |
| 子进程崩溃 / 认证失效 | run 行 failed + error 落账，UI/CLI 可见 |
| OS 注册缺失/漂移 | automation 停止触发（不是错误）；`status` 标红并提供 enable 自愈 |
| remote workspace automation | runner 不认领（location_kind 过滤）；仍走 app 内既有链路（需活跃 remote session），创建侧约束不变 |
| 超 30 分钟 wall-clock | kill 子进程，run 记 failed（timeout） |

## 生命周期规则

1. 迁移：一次性置空存量 `target_task_id`、清除 task meta `cronAutomationId` 镜像；`enabled`/`next_run_at` 保持，下个 tick 起按 detached 执行。
2. 系统级调度关闭（默认/受限环境）：调度与派发维持现状——app scheduler 轮询派发 + 5 分钟 misfire grace 保留，作为无法安装 OS 注册环境的兜底；手动 Run now 单飞认领两种模式共用。迁移无条件执行，绑定投递在两种模式下都不复存在（派发一律新建 fresh session）。
3. off-peak idle tasks 不在本 spec 范围（server ticket 模型维持 app 附着）。
4. keep-awake 语义保留；launchd/systemd(Persistent) 的唤醒合并即「补跑最新一次」的机制来源。
5. 运行历史保留沿用 `pruneRuns`；run session（每次触发新建）在 run 终态后回归常规清扫年龄门槛。
6. （修订 `specs/session-sweeper.md`）cron 保护判定从「归属 automation 存活」收窄为「该 session 存在非终态 automation_run」：已终态 run 的 session 不再因 automation 存活而免清扫；绑定目标（target_task_id）概念随迁移退役。

## 验收场景

1. macOS、ZCode app 完全退出（无任何 ZCode 进程）：启用系统级调度后，`*/1` 测试 automation 每分钟触发；每次触发产生新 task（source=automation_scheduled、automationId 落 meta）与 `automation_runs` 行（含 session_id）；`launchctl list | grep com.zcode.automations` 可见注册。
2. sleep 覆盖多个到期点 → 唤醒后至多补跑一次；错过 >24h 的到期点记 skipped。
3. `zcode automation list --json` / `show` / `runs` / `pause` / `resume` / `delete` / `run` / `status` 在 app 运行与退出两种状态下行为一致；`status` 显示注册状态与 last tick。
4. `enable`/`disable` 幂等：重复 enable 不产生重复注册；disable 移除 plist/timer/schtasks 项。
5. 系统级调度开启时 app scheduler 不认领 automations（off-peak 认领照旧）；关闭时回归现状路径。
6. 会话内 `CronCreate` 产生 detached automation：无 target_task_id、无 task meta 绑定，工具回执文案反映 detached 语义；`automation-turn-self-cleanup.md` 验收 1–6 不回归。
7. 存量绑定 automation 迁移后不再向原会话投递；原会话不再受 cron 保护判定庇护。
8. 终态 run session 过常规年龄门槛后被 `SessionSweepPlan` 提名为候选；非终态 run session 被保护。
9. 并发：app 打开 + tick 同刻到期 → 恰一次运行；runner 被 kill -9 → ≤10 分钟认领释放并按退避续跑。
10. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 全绿；registrar 命令构造（launchd/systemd/schtasks）、claim/ledger、迁移路径有单测；证据落 `build/reports/` receipt。

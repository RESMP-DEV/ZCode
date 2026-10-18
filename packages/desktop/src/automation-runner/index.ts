// automation-runner bundle 入口：由 OS 注册项（launchd/systemd/schtasks）直接执行，
// 也可手动 `node automation-runner/index.js <verb>` 探查。与 scheduler 同构——
// 复用 @zcode/services（tasks-index + 派发核心），不依赖 Electron 运行态。
import { runAutomationRunnerCli } from "@zcode/services/automation-runner";

const exitCode = await runAutomationRunnerCli(process.argv.slice(2));
process.exit(exitCode);

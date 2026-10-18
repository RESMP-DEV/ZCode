// `zcode automation <verb>`：委托给 desktop 打包的 automation-runner bundle
// （specs/automation-system-scheduling.md）。CLI 自身不引入 @zcode/services，
// 实现只存在于 runner bundle 一处；这里只做入口解析 + 子进程转发 + 退出码透传。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunContext } from "@zcode/shared-types";

export interface AutomationRunnerDelegation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const AUTOMATION_RUNNER_MISSING_ERROR =
  "automation-runner bundle not found. The `zcode automation` management surface requires a desktop installation (or dev build); set ZCODE_AUTOMATION_RUNNER to the runner entry path to override.";

/**
 * 解析委托目标。候选顺序：
 * 1. ZCODE_AUTOMATION_RUNNER env（dev/测试显式指定 packages/desktop/out/.../index.js）；
 * 2. CLI bundle 的 sibling（打包态 CLI 在 <resources>/glm/ 下 → <resources>/automation-runner/）；
 * 3. 进程自身入口（`node automation-runner/index.js` 直接调 CLI 的场景不适用，跳过）。
 * 运行时按 ELECTRON_RUN_AS_NODE 与 agent spawn 同机制：Electron 语境用 process.execPath。
 */
export function resolveAutomationRunnerDelegation(options: {
  runnerEntry?: string;
  cliEntry?: string;
  env?: Record<string, string | undefined>;
  isElectron?: boolean;
}): AutomationRunnerDelegation | null {
  const env = options.env ?? process.env;
  const cliEntry = options.cliEntry ?? process.argv[1];
  const candidates = [
    env.ZCODE_AUTOMATION_RUNNER?.trim() || null,
    options.runnerEntry?.trim() || null,
    // 打包态：CLI 在 <resources>/glm/ 下，runner 由 asarUnpack 落在
    // <resources>/app.asar.unpacked/out/automation-runner/（bare Node 可执行的真实文件）。
    cliEntry
      ? join(
          dirname(cliEntry),
          "app.asar.unpacked",
          "out",
          "automation-runner",
          "index.js",
        )
      : null,
    cliEntry ? join(dirname(cliEntry), "..", "automation-runner", "index.js") : null,
    cliEntry ? join(dirname(cliEntry), "automation-runner", "index.js") : null,
  ];
  const runnerEntry = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!runnerEntry) return null;
  const childEnv: Record<string, string> = {};
  if ((options.isElectron ?? Boolean(process.versions.electron))) {
    childEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  return { command: process.execPath, args: [runnerEntry], env: childEnv };
}

export async function runAutomationCommand(ctx: RunContext, args: string[]): Promise<number> {
  const delegation = resolveAutomationRunnerDelegation({});
  if (!delegation) {
    ctx.stderr.write(`${AUTOMATION_RUNNER_MISSING_ERROR}\n`);
    return 1;
  }
  return await new Promise<number>((resolve) => {
    const child = spawn(delegation.command, [...delegation.args, ...args], {
      env: { ...process.env, ...delegation.env },
      stdio: [ctx.stdin, ctx.stdout, ctx.stderr],
    });
    child.on("error", (error) => {
      ctx.stderr.write(`automation-runner failed to start: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

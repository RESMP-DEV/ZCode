// `zcode automation` 委托命令：入口解析与缺失 runner 时的错误路径（specs/automation-system-scheduling.md）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveAutomationRunnerDelegation as resolve,
  runAutomationCommand as run,
} from "../src/automation-command.js";

test("resolve：env 覆盖优先，Electron 语境注入 ELECTRON_RUN_AS_NODE", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-automation-cli-"));
  try {
    mkdirSync(join(root, "automation-runner"), { recursive: true });
    const runnerEntry = join(root, "automation-runner", "index.js");
    writeFileSync(runnerEntry, "export {};\n");
    const delegation = resolve({
      runnerEntry,
      cliEntry: join(root, "glm", "zcode.cjs"),
      env: {},
      isElectron: true,
    });
    assert.deepEqual(delegation, {
      command: process.execPath,
      args: [runnerEntry],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const plain = resolve({
      runnerEntry,
      cliEntry: join(root, "glm", "zcode.cjs"),
      env: {},
      isElectron: false,
    });
    assert.deepEqual(plain.env, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve：候选全缺失时返回 null（run 报可行动错误）", () => {
  const delegation = resolve({
    runnerEntry: "/nonexistent/automation-runner/index.js",
    cliEntry: "/nonexistent/glm/zcode.cjs",
    env: {},
  });
  assert.equal(delegation, null);
});

test("run：runner 缺失时退出码 1 并输出指引", async () => {
  const original = process.env.ZCODE_AUTOMATION_RUNNER;
  delete process.env.ZCODE_AUTOMATION_RUNNER;
  const chunks: string[] = [];
  try {
    const exitCode = await run(
      {
        argv: ["status"],
        stdin: process.stdin,
        stdout: { write: (chunk: string) => void chunks.push(chunk) } as unknown as NodeJS.WriteStream,
        stderr: { write: (chunk: string) => void chunks.push(chunk) } as unknown as NodeJS.WriteStream,
      },
      ["status"],
    );
    assert.equal(exitCode, 1);
    assert.ok(chunks.join("").includes("automation-runner bundle not found"));
  } finally {
    if (original !== undefined) process.env.ZCODE_AUTOMATION_RUNNER = original;
  }
});

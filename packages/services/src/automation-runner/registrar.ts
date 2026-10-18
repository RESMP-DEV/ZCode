// 系统级调度的 OS 注册器（specs/automation-system-scheduling.md）：
// 每用户一条注册，唯一职责是周期执行 `zcode automation tick`。
// macOS launchd LaunchAgent（StartInterval 30s + RunAtLoad，睡眠合并即补跑来源）、
// Linux systemd user timer（Persistent=true）回退 crontab、Windows schtasks 分钟级。
// 命令构造（plist/unit/命令行）是纯函数，apply 层才落盘/执行，便于单测。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZCodeAutomationSchedulingRegistrationKind } from "@zcode/shared";

export const AUTOMATION_TICK_INTERVAL_SECONDS = 30;
export const AUTOMATION_SCHEDULER_LABEL = "com.zcode.automations";
export const AUTOMATION_SCHEDULER_SYSTEMD_UNIT = "zcode-automations";
export const AUTOMATION_SCHEDULER_SCHTASKS_NAME = "ZCodeAutomations";

/** tick 进程的启动描述；command+args 可直接交给 launchd/systemd，或写成 shim。 */
export interface AutomationTickCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 工作目录：dev 形态下 findUpward 依赖它定位 monorepo 内的 agent 入口。 */
  cwd: string;
}

/**
 * 定位 automation-runner bundle 入口，按语境依次尝试：
 * 1. 显式传入；2. 本模块位置的 sibling（host bundle 内联本模块时 → out/automation-runner/，
 *    runner bundle 自身 → 自指，dev tsx → 源码 index.ts）；3. process.argv[1] 兜底。
 * enable 时把解析结果固化进 OS 注册项；app 更新后路径变化用 enable 重跑自愈。
 */
export function resolveRunnerEntryPath(explicit?: string): string {
  // 显式路径是操作者断言，直接信任（不存在时由 OS 注册后的首个 tick 暴露）；
  // 自动候选才做 existsSync 探测。
  const explicitEntry = explicit?.trim();
  if (explicitEntry) return explicitEntry;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 打包态：asar 内的模块路径对 bare Node（ELECTRON_RUN_AS_NODE）不可执行；
    // runner 由 electron-builder asarUnpack 落到 app.asar.unpacked/out/ —— 真实磁盘文件。
    process.resourcesPath
      ? join(process.resourcesPath, "app.asar.unpacked", "out", "automation-runner", "index.js")
      : null,
    join(moduleDir, "..", "automation-runner", "index.js"),
    join(moduleDir, "..", "automation-runner", "index.ts"),
    process.argv[1] || null,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "无法定位 automation-runner 入口：请显式传入 runner bundle 路径（--runner-entry）",
  );
}

/**
 * 解析 OS 注册要执行的 tick 命令。Electron 语境（desktop host / 打包 CLI）用
 * process.execPath + ELECTRON_RUN_AS_NODE（与 agent spawn 同一机制）；纯 Node 语境
 * （dev 直跑）process.execPath 即 node。入口路径与 builtin provider 配置在 enable
 * 时固化进注册项，app/CLI 更新路径变化后重新 enable 即自愈。
 */
export function resolveTickCommand(options?: {
  runnerEntry?: string;
  env?: Record<string, string | undefined>;
  isElectron?: boolean;
}): AutomationTickCommand {
  const entry = resolveRunnerEntryPath(options?.runnerEntry);
  const env = options?.env ?? process.env;
  const envOut: Record<string, string> = {};
  if (options?.isElectron ?? Boolean(process.versions.electron)) {
    envOut.ELECTRON_RUN_AS_NODE = "1";
  }
  const providerConfig = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
  if (providerConfig) {
    envOut.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = providerConfig;
  }
  return {
    command: process.execPath,
    args: [entry, "tick"],
    env: envOut,
    // out/ 或 resources/ 的上一级：dev 下从此处 findUpward 能命中 monorepo 根。
    cwd: dirname(dirname(entry)),
  };
}

// ---- macOS launchd ----

export function buildLaunchdPlistContent(tick: AutomationTickCommand): string {
  const envDict = Object.entries(tick.env)
    .map(([key, value]) => `        <key>${key}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");
  const args = tick.args
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${AUTOMATION_SCHEDULER_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(tick.command)}</string>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${AUTOMATION_TICK_INTERVAL_SECONDS}</integer>
    <key>WorkingDirectory</key>
    <string>${escapeXml(tick.cwd)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(homedir(), "Library", "Logs", "zcode-automation-tick.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(homedir(), "Library", "Logs", "zcode-automation-tick.log"))}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envDict}
    </dict>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${AUTOMATION_SCHEDULER_LABEL}.plist`);
}

// ---- Linux systemd / crontab ----

export function buildSystemdUnitContent(tick: AutomationTickCommand): string {
  const execArgs = [tick.command, ...tick.args].map((part) => JSON.stringify(part)).join(" ");
  const envLines = Object.entries(tick.env)
    .map(([key, value]) => `Environment=${key}=${JSON.stringify(value)}\n`)
    .join("");
  return `[Unit]
Description=ZCode automation detached tick
[Service]
Type=oneshot
WorkingDirectory=${tick.cwd}
${envLines}ExecStart=${execArgs}
`;
}

export function buildSystemdTimerContent(): string {
  return `[Unit]
Description=Run ZCode automation tick periodically
[Timer]
OnBootSec=${AUTOMATION_TICK_INTERVAL_SECONDS}s
OnUnitActiveSec=${AUTOMATION_TICK_INTERVAL_SECONDS}s
Persistent=true
[Install]
WantedBy=timers.target
`;
}

/** cron 行必须单行无 %；sh -c 包一层 env 注入。cron 最小粒度是分钟，无法表达 30s。 */
export function buildCrontabLine(tick: AutomationTickCommand): string {
  const envPrefix = Object.entries(tick.env)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const exec = [tick.command, ...tick.args].join(" ");
  const cd = tick.cwd.replace(/%/g, "");
  return `* * * * * cd ${cd} && ${envPrefix} ${exec} # ${AUTOMATION_SCHEDULER_LABEL}`;
}

// ---- Windows schtasks ----

/** schtasks /TR 参数长度与引号规则脆弱；写 .cmd shim 后注册 shim 更稳。 */
export function buildWindowsTickShimContent(tick: AutomationTickCommand): string {
  const envLines = Object.entries(tick.env)
    .map(([key, value]) => `set "${key}=${value}"`)
    .join("\r\n");
  const quoted = [tick.command, ...tick.args].map((part) => `"${part}"`).join(" ");
  return `@echo off\r\n${envLines}\r\n${quoted}\r\n`;
}

export function buildSchtasksCreateArgs(shimPath: string): string[] {
  return [
    "/Create",
    "/F",
    "/TN",
    AUTOMATION_SCHEDULER_SCHTASKS_NAME,
    "/SC",
    "MINUTE",
    "/MO",
    "1",
    "/TR",
    `"${shimPath}"`,
  ];
}

// ---- 统一注册接口 ----

export interface AutomationRegistrarStatus {
  installed: boolean;
  kind: ZCodeAutomationSchedulingRegistrationKind | null;
  detail?: string;
}

export interface AutomationRegistrar {
  readonly kind: ZCodeAutomationSchedulingRegistrationKind;
  install(tick: AutomationTickCommand): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<AutomationRegistrarStatus>;
}

type RunCommand = (command: string, args: string[]) => { ok: boolean; output: string };

function runCommandDefault(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function createLaunchdRegistrar(options?: {
  runCommand?: RunCommand;
  plistPath?: string;
}): AutomationRegistrar {
  const runCommand = options?.runCommand ?? runCommandDefault;
  const plistPath = options?.plistPath ?? launchdPlistPath();
  const guiDomain = `gui/${process.getuid?.() ?? 0}`;
  return {
    kind: "launchd",
    async install(tick) {
      atomicWrite(plistPath, buildLaunchdPlistContent(tick));
      // 幂等：先卸旧定义再 bootstrap 当前 uid 的 gui domain。
      runCommand("launchctl", ["bootout", guiDomain, plistPath]);
      const load = runCommand("launchctl", ["bootstrap", guiDomain, plistPath]);
      if (!load.ok) {
        throw new Error(`launchctl bootstrap 失败: ${load.output}`);
      }
    },
    async uninstall() {
      runCommand("launchctl", ["bootout", guiDomain, plistPath]);
      if (existsSync(plistPath)) {
        renameSync(plistPath, `${plistPath}.disabled`);
      }
    },
    async status() {
      const plistExists = existsSync(plistPath);
      const listed = runCommand("launchctl", ["list", AUTOMATION_SCHEDULER_LABEL]);
      return {
        installed: plistExists && (listed.ok || listed.output.includes(AUTOMATION_SCHEDULER_LABEL)),
        kind: "launchd",
        detail: `plist=${plistPath} launchctl=${listed.output || "(not loaded)"}`,
      };
    },
  };
}

export function createSystemdRegistrar(options?: {
  runCommand?: RunCommand;
  configDir?: string;
  hasSystemd?: boolean;
}): AutomationRegistrar {
  const runCommand = options?.runCommand ?? runCommandDefault;
  const configDir =
    options?.configDir ?? join(homedir(), ".config", "systemd", "user");
  const unitPath = join(configDir, `${AUTOMATION_SCHEDULER_SYSTEMD_UNIT}.service`);
  const timerPath = join(configDir, `${AUTOMATION_SCHEDULER_SYSTEMD_UNIT}.timer`);
  const hasSystemd = options?.hasSystemd ?? existsSync("/run/systemd/system");
  return {
    kind: "systemd",
    async install(tick) {
      if (!hasSystemd) {
        throw new Error("systemd 用户会话不可用；enable --fallback-cron 可退回 crontab 注册");
      }
      atomicWrite(unitPath, buildSystemdUnitContent(tick));
      atomicWrite(timerPath, buildSystemdTimerContent());
      const reload = runCommand("systemctl", ["--user", "daemon-reload"]);
      const enable = runCommand("systemctl", [
        "--user",
        "enable",
        "--now",
        `${AUTOMATION_SCHEDULER_SYSTEMD_UNIT}.timer`,
      ]);
      if (!reload.ok || !enable.ok) {
        throw new Error(`systemctl 注册失败: ${reload.output} ${enable.output}`);
      }
    },
    async uninstall() {
      runCommand("systemctl", [
        "--user",
        "disable",
        "--now",
        `${AUTOMATION_SCHEDULER_SYSTEMD_UNIT}.timer`,
      ]);
    },
    async status() {
      if (!hasSystemd) {
        return { installed: false, kind: "systemd", detail: "systemd 用户会话不可用" };
      }
      const query = runCommand("systemctl", [
        "--user",
        "is-enabled",
        `${AUTOMATION_SCHEDULER_SYSTEMD_UNIT}.timer`,
      ]);
      return {
        installed: query.ok,
        kind: "systemd",
        detail: query.output,
      };
    },
  };
}

export function createCrontabRegistrar(options?: {
  runCommand?: RunCommand;
}): AutomationRegistrar {
  const runCommand = options?.runCommand ?? runCommandDefault;
  const readCrontab = (): string[] => {
    const result = runCommand("crontab", ["-l"]);
    if (!result.ok) return [];
    return result.output.split("\n").filter((line) => line.trim().length > 0);
  };
  return {
    kind: "cron",
    async install(tick) {
      const line = buildCrontabLine(tick);
      const kept = readCrontab().filter(
        (existing) => !existing.includes(AUTOMATION_SCHEDULER_LABEL),
      );
      const next = [...kept, line].join("\n") + "\n";
      const write = spawnSync("crontab", ["-"], {
        input: next,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (write.status !== 0) {
        throw new Error(`crontab 写入失败: ${write.stderr}`);
      }
    },
    async uninstall() {
      const kept = readCrontab().filter(
        (existing) => !existing.includes(AUTOMATION_SCHEDULER_LABEL),
      );
      const next = kept.length > 0 ? kept.join("\n") + "\n" : "";
      spawnSync("crontab", ["-"], { input: next, encoding: "utf8", timeout: 15_000 });
    },
    async status() {
      const present = readCrontab().some((line) => line.includes(AUTOMATION_SCHEDULER_LABEL));
      return { installed: present, kind: "cron" };
    },
  };
}

export function createSchtasksRegistrar(options?: {
  runCommand?: RunCommand;
  shimPath?: string;
}): AutomationRegistrar {
  const runCommand = options?.runCommand ?? runCommandDefault;
  const shimPath =
    options?.shimPath ?? join(homedir(), ".zcode", "v2", "bin", "zcode-automation-tick.cmd");
  return {
    kind: "schtasks",
    async install(tick) {
      atomicWrite(shimPath, buildWindowsTickShimContent(tick));
      const create = runCommand("schtasks", buildSchtasksCreateArgs(shimPath));
      if (!create.ok) {
        throw new Error(`schtasks 注册失败: ${create.output}`);
      }
    },
    async uninstall() {
      runCommand("schtasks", ["/Delete", "/F", "/TN", AUTOMATION_SCHEDULER_SCHTASKS_NAME]);
    },
    async status() {
      const query = runCommand("schtasks", ["/Query", "/TN", AUTOMATION_SCHEDULER_SCHTASKS_NAME]);
      return { installed: query.ok, kind: "schtasks", detail: query.output };
    },
  };
}

/** 按当前平台选择注册器；Linux 优先 systemd，无 systemd 用户会话时退 crontab。 */
export function createPlatformRegistrar(options?: {
  runCommand?: RunCommand;
  preferCronFallback?: boolean;
}): AutomationRegistrar {
  if (process.platform === "darwin") {
    return createLaunchdRegistrar({ runCommand: options?.runCommand });
  }
  if (process.platform === "win32") {
    return createSchtasksRegistrar({ runCommand: options?.runCommand });
  }
  if (options?.preferCronFallback) {
    return createCrontabRegistrar({ runCommand: options?.runCommand });
  }
  return createSystemdRegistrar({ runCommand: options?.runCommand });
}

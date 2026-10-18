import { access, rename, rm } from "node:fs/promises";

export const ASAR_UNPACK_NATIVE_GLOB = "*.{node,dll,dylib,exe}";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createAppAsarPackArgs({ sourceDir, destinationPath, targetPlatformKey }) {
  return [
    "pack",
    sourceDir,
    destinationPath,
    "--unpack",
    ASAR_UNPACK_NATIVE_GLOB,
    "--unpack-dir",
    `node_modules/node-pty/prebuilds/${targetPlatformKey}`,
    // automation-runner（detached cron，specs/automation-system-scheduling.md）由 OS 注册项
    // 以 ELECTRON_RUN_AS_NODE 直接执行：bare Node 读不了 asar，必须与 electron-builder
    // 的 asarUnpack 同步在重打包时保持 unpacked（否则 repack 会把它写回 asar）。
    "--unpack-dir",
    "out/automation-runner",
  ];
}

export async function replaceAppAsarFromStaging({
  sourceDir,
  appAsarPath,
  targetPlatformKey,
  runAsarCommand,
}) {
  const candidateAsarPath = `${appAsarPath}.next`;
  const candidateUnpackedPath = `${candidateAsarPath}.unpacked`;
  const unpackedPath = `${appAsarPath}.unpacked`;

  await Promise.all([
    rm(candidateAsarPath, { force: true, recursive: true }),
    rm(candidateUnpackedPath, { force: true, recursive: true }),
  ]);

  try {
    runAsarCommand(
      createAppAsarPackArgs({
        sourceDir,
        destinationPath: candidateAsarPath,
        targetPlatformKey,
      }),
    );

    if (!(await pathExists(candidateAsarPath)) || !(await pathExists(candidateUnpackedPath))) {
      // CI 的 TMPDIR 位于隐藏目录 `.tmp`。旧 glob 含 `**/`，@electron/asar 用绝对路径
      // 匹配时不会跨过隐藏目录，导致 native 被写回 asar，同时遗留旧 unpacked 形成物理双份。
      throw new Error(`重打包结果缺少 app.asar 或 app.asar.unpacked: ${candidateAsarPath}`);
    }

    // 先完整生成候选文件，再替换旧 archive 和 sidecar；不会把上一次打包的跨平台 native 留在 unpacked。
    await rm(unpackedPath, { force: true, recursive: true });
    await rename(candidateUnpackedPath, unpackedPath);
    await rm(appAsarPath, { force: true });
    await rename(candidateAsarPath, appAsarPath);
  } finally {
    await Promise.all([
      rm(candidateAsarPath, { force: true, recursive: true }),
      rm(candidateUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}

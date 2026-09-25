// 侧栏项目自动导入的目录扫描：只读、广度优先、固定深度。
// 独立成模块（而不是内联在 fileService）是为了让扫描规则可以直接用 node:test 覆盖。
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const WORKSPACE_DISCOVERY_DEFAULT_MAX_DEPTH = 2;
export const WORKSPACE_DISCOVERY_DEFAULT_MAX_RESULTS = 24;

/**
 * 扫描时跳过的噪声目录名（home 下的系统/媒体目录、依赖目录）。
 * 隐藏目录（点前缀）在遍历时统一跳过，root 本身不受该规则影响。
 */
const WORKSPACE_DISCOVERY_SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "Library",
  "Applications",
  "Music",
  "Movies",
  "Pictures",
  "Public",
  "Games",
]);

/** 展开 `~`/`~/...`，去空去重；全空时回退 home 目录。 */
export function normalizeWorkspaceDiscoveryRoots(roots: string[]): string[] {
  const home = homedir();
  const normalized = roots
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .map((root) =>
      root === "~" ? home : root.startsWith("~/") ? join(home, root.slice(2)) : root,
    );
  return [...new Set(normalized.length > 0 ? normalized : [home])];
}

async function isGitRepository(directoryPath: string): Promise<boolean> {
  try {
    const gitStat = await stat(join(directoryPath, ".git"));
    // worktree/submodule 场景 .git 是文件，普通 clone 是目录，两者都算仓库。
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}

async function listChildDirectories(directoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    // 无权限/已删除的子树直接跳过，不让单目录失败中断整轮扫描。
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        // 符号链接目录不进入：既避免环，也避免把 .Trash 之类的别名当项目扫进来。
        !entry.isSymbolicLink() &&
        !entry.name.startsWith(".") &&
        !WORKSPACE_DISCOVERY_SKIPPED_DIRECTORY_NAMES.has(entry.name),
    )
    .map((entry) => join(directoryPath, entry.name));
}

/**
 * 扫描 roots 下的 git 仓库候选。命中 `.git` 的目录成为候选且不再下钻
 * （仓库内部的嵌套仓库属于项目内部结构，不是侧栏项目）；按路径排序保证结果稳定。
 */
export async function scanWorkspaceCandidates(params: {
  roots: string[];
  maxDepth?: number;
  maxResults?: number;
  excludePaths?: string[];
}): Promise<string[]> {
  const maxDepth = Math.max(
    0,
    Math.floor(params.maxDepth ?? WORKSPACE_DISCOVERY_DEFAULT_MAX_DEPTH),
  );
  const maxResults = Math.max(
    1,
    Math.floor(params.maxResults ?? WORKSPACE_DISCOVERY_DEFAULT_MAX_RESULTS),
  );
  const roots = normalizeWorkspaceDiscoveryRoots(params.roots);
  // 排除在计数前生效：已导入的 workspace 不占候选上限，否则固定窗口会被
  // 既有路径填满，扫描顺序靠后的新仓库永远进不了候选集。
  const excludePaths = new Set(params.excludePaths ?? []);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = roots
    .filter((root) => !seen.has(root) && seen.add(root))
    .map((root) => ({ path: root, depth: 0 }));

  while (queue.length > 0 && candidates.length < maxResults) {
    const { path, depth } = queue.shift()!;
    if (await isGitRepository(path)) {
      if (!excludePaths.has(path)) {
        candidates.push(path);
      }
      continue;
    }
    if (depth >= maxDepth) {
      continue;
    }
    for (const child of await listChildDirectories(path)) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      queue.push({ path: child, depth: depth + 1 });
    }
  }
  return candidates.slice(0, maxResults).sort((left, right) => left.localeCompare(right));
}

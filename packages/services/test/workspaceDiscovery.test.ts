import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeWorkspaceDiscoveryRoots,
  scanWorkspaceCandidates,
} from "../src/file/workspaceDiscovery.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-discovery-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeRepo(path: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
}

test("扫描两层深度内的 git 仓库，跳过噪声/隐藏目录与仓库内部", async () => {
  await withRoot(async (root) => {
    await makeRepo(join(root, "alpha"));
    await makeRepo(join(root, "nested", "beta"));
    await makeRepo(join(root, "node_modules", "gamma"));
    await makeRepo(join(root, ".hidden", "delta"));
    // 仓库内部不再下钻：内部的嵌套仓库不属于侧栏项目。
    await makeRepo(join(root, "alpha", "inner-repo"));
    // 超过两层深度的仓库不可见。
    await makeRepo(join(root, "nested", "too-deep", "epsilon"));

    const candidates = await scanWorkspaceCandidates({ roots: [root] });
    const names = candidates.map((path) => path.slice(root.length + 1));
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes(join("nested", "beta")));
    assert.ok(!names.some((name) => name.includes("gamma")));
    assert.ok(!names.some((name) => name.includes("delta")));
    assert.ok(!names.some((name) => name.includes("inner-repo")));
    assert.ok(!names.some((name) => name.includes("epsilon")));
  });
});

test("root 本身是 git 仓库时直接作为候选", async () => {
  await withRoot(async (root) => {
    await makeRepo(root);
    const candidates = await scanWorkspaceCandidates({ roots: [root] });
    assert.deepEqual(candidates, [root]);
  });
});

test("maxResults 限制候选数量且结果按路径排序", async () => {
  await withRoot(async (root) => {
    for (const name of ["c-repo", "a-repo", "b-repo"]) {
      await makeRepo(join(root, name));
    }
    const candidates = await scanWorkspaceCandidates({ roots: [root], maxResults: 2 });
    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((path) => path.slice(root.length + 1)),
      ["a-repo", "b-repo"],
    );
  });
});

test("normalizeWorkspaceDiscoveryRoots 展开波浪号并在空列表时回退 home", async () => {
  const { homedir } = await import("node:os");
  assert.deepEqual(normalizeWorkspaceDiscoveryRoots(["~", "~/work", "/srv", "", "  "]), [
    homedir(),
    join(homedir(), "work"),
    "/srv",
  ]);
  assert.deepEqual(normalizeWorkspaceDiscoveryRoots([]), [homedir()]);
});

test("不存在的 root 只产生空结果，不抛错", async () => {
  const candidates = await scanWorkspaceCandidates({
    roots: [join(tmpdir(), "zcode-discovery-definitely-missing")],
  });
  assert.deepEqual(candidates, []);
});

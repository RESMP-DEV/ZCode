import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenWorkspaceFileTreeRows,
  type WorkspaceFileTreeNode,
} from "../src/workspace-file-tree/model.js";

// specs/workspace-file-tree-empty-directory.md：已加载且确无子项的目录一律按收起态
// 呈现；加载中、出错或未加载的目录不收起，expandedPaths（用户意图）不被改写。

function dirNode(path: string, name: string, depth = 1): WorkspaceFileTreeNode {
  return { path, name, type: "directory", depth };
}

function fileNode(path: string, name: string, depth = 2): WorkspaceFileTreeNode {
  return { path, name, type: "file", depth };
}

function flatten(params: {
  childrenByDirectory: [string, WorkspaceFileTreeNode[]][];
  expandedPaths?: string[];
  loadedDirectoryPaths?: string[];
  loadingDirectoryPaths?: string[];
  errorByDirectory?: [string, Error][];
}) {
  return flattenWorkspaceFileTreeRows({
    rootPath: "/ws",
    childrenByDirectory: new Map(params.childrenByDirectory),
    expandedPaths: new Set(params.expandedPaths ?? []),
    loadedDirectoryPaths: new Set(params.loadedDirectoryPaths ?? ["/ws"]),
    loadingDirectoryPaths: new Set(params.loadingDirectoryPaths ?? []),
    errorByDirectory: new Map(params.errorByDirectory ?? []),
    flattenEmptyDirectories: true,
  });
}

test("expanded loaded empty directory renders collapsed", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/empty", "empty")]],
      ["/ws/empty", []],
    ],
    expandedPaths: ["/ws", "/ws/empty"],
    loadedDirectoryPaths: ["/ws", "/ws/empty"],
  });
  const emptyRow = rows.find((row) => row.path === "/ws/empty");
  assert.equal(emptyRow?.expanded, false);
  assert.equal(
    rows.some((row) => row.path.startsWith("/ws/empty/")),
    false,
  );
});

test("expanded loaded directory with children stays expanded", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/full", "full")]],
      ["/ws/full", [fileNode("/ws/full/a.ts", "a.ts")]],
    ],
    expandedPaths: ["/ws", "/ws/full"],
    loadedDirectoryPaths: ["/ws", "/ws/full"],
  });
  assert.equal(rows.find((row) => row.path === "/ws/full")?.expanded, true);
  assert.ok(rows.some((row) => row.path === "/ws/full/a.ts"));
});

test("refreshing directory stays expanded even when cached children are empty", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/empty", "empty")]],
      ["/ws/empty", []],
    ],
    expandedPaths: ["/ws", "/ws/empty"],
    loadedDirectoryPaths: ["/ws", "/ws/empty"],
    loadingDirectoryPaths: ["/ws/empty"],
  });
  assert.equal(rows.find((row) => row.path === "/ws/empty")?.expanded, true);
});

test("directory with read error stays expanded", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/broken", "broken")]],
      ["/ws/broken", []],
    ],
    expandedPaths: ["/ws", "/ws/broken"],
    loadedDirectoryPaths: ["/ws", "/ws/broken"],
    errorByDirectory: [["/ws/broken", new Error("boom")]],
  });
  assert.equal(rows.find((row) => row.path === "/ws/broken")?.expanded, true);
});

test("not yet loaded directory stays expanded while children are unknown", () => {
  const rows = flatten({
    childrenByDirectory: [["/ws", [dirNode("/ws/unknown", "unknown")]]],
    expandedPaths: ["/ws", "/ws/unknown"],
    loadedDirectoryPaths: ["/ws"],
  });
  assert.equal(rows.find((row) => row.path === "/ws/unknown")?.expanded, true);
});

test("git deleted placeholder child keeps the directory expanded", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/gone", "gone")]],
      ["/ws/gone", [fileNode("/ws/gone/old.ts", "old.ts")]],
    ],
    expandedPaths: ["/ws", "/ws/gone"],
    loadedDirectoryPaths: ["/ws", "/ws/gone"],
  });
  assert.equal(rows.find((row) => row.path === "/ws/gone")?.expanded, true);
});

test("compacted single-child chain with empty terminal renders collapsed", () => {
  const rows = flatten({
    childrenByDirectory: [
      ["/ws", [dirNode("/ws/a", "a")]],
      ["/ws/a", [dirNode("/ws/a/b", "b", 2)]],
      ["/ws/a/b", []],
    ],
    expandedPaths: ["/ws", "/ws/a"],
    loadedDirectoryPaths: ["/ws", "/ws/a", "/ws/a/b"],
  });
  const compactedRow = rows.find((row) => row.type === "directory");
  assert.equal(compactedRow?.name, "a/b");
  assert.equal(compactedRow?.expanded, false);
  assert.equal(
    rows.some((row) => row.path.startsWith("/ws/a/b/")),
    false,
  );
});

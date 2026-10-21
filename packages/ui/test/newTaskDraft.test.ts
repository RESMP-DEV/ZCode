import assert from "node:assert/strict";
import { test } from "vitest"; // vitest 4 不再注册 node:test 套件（上游升级后集体断签），API 面相同改用 vitest 注册
import { initializeNewTaskDraft } from "../src/v4/composer/newTaskDraft.js";

// specs/new-prompt-default-permission.md：新 prompt 的权限模式恒为 yolo，
// 不再由 Recent（上次已接纳提交的 mode）回填；modelSelection 记忆保留。

/** 无 Recent 的环境（node 下 window 未定义，readComposerRecent 返回 null）。 */
test("new task draft defaults to yolo permission mode", () => {
  // 上游 v3.16.2 移除了 initializeFromNewTask 字段（草稿契约瘦身），
  // 断言改为：残留传入的旧字段不会在产出草稿里复活。
  const draft = initializeNewTaskDraft(
    { text: "", initializeFromNewTask: true, updatedAt: 1 } as never,
    "/ws-fresh",
    undefined,
    { revision: 1, providers: [] },
  );
  assert.equal(draft.mode, "yolo");
  assert.equal(draft.planEnabled, false);
});

test("remembered build mode no longer seeds new task drafts", () => {
  withRecentStorage("/ws-remembered-build", { mode: "build" }, () => {
    const draft = initializeNewTaskDraft(
      { text: "", updatedAt: 1 },
      "/ws-remembered-build",
      undefined,
      { revision: 1, providers: [] },
    );
    assert.equal(draft.mode, "yolo");
  });
});

test("remembered edit mode no longer seeds new task drafts", () => {
  withRecentStorage("/ws-remembered-edit", { mode: "edit" }, () => {
    const draft = initializeNewTaskDraft(
      { text: "", updatedAt: 1 },
      "/ws-remembered-edit",
      undefined,
      { revision: 1, providers: [] },
    );
    assert.equal(draft.mode, "yolo");
  });
});

test("remembered model selection still seeds new task drafts", () => {
  withRecentStorage(
    "/ws-remembered-model",
    { mode: "build", modelSelection: { providerId: "glm", modelId: "glm-5.3" } },
    () => {
      const draft = initializeNewTaskDraft(
        { text: "", updatedAt: 1 },
        "/ws-remembered-model",
        undefined,
        { revision: 1, providers: [] },
      );
      assert.equal(draft.mode, "yolo");
      assert.equal(draft.modelSelection?.providerId, "glm");
      assert.equal(draft.modelSelection?.modelId, "glm-5.3");
    },
  );
});

/**
 * initializeNewTaskDraft 只在调用瞬间读 window.localStorage；测试期间注入
 * 单 key 内存 storage，结束后还原 globalThis.window。
 */
function withRecentStorage(
  workspacePath: string,
  recent: { mode?: string; modelSelection?: unknown },
  run: () => void,
): void {
  const key = `zcode-model-selection-recent-v1:${workspacePath}`;
  const storage = {
    getItem: (k: string) => (k === key ? JSON.stringify(recent) : null),
    setItem: () => {},
  };
  const scope = globalThis as { window?: unknown };
  const previousWindow = scope.window;
  scope.window = { localStorage: storage };
  try {
    run();
  } finally {
    if (previousWindow === undefined) {
      delete scope.window;
    } else {
      scope.window = previousWindow;
    }
  }
}

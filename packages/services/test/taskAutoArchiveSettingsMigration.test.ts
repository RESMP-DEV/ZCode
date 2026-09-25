import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@zcode/shared";

test("缺省设置解析为 72h 自动归档默认值并带迁移标记", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.taskAutoArchiveEnabled, true);
  assert.equal(parsed.taskAutoArchiveOlderThanDays, 3);
  assert.equal(parsed.taskAutoArchiveDefaultsInitialized, true);
  assert.equal(parsed.workspaceAutoImportEnabled, true);
  assert.deepEqual(parsed.workspaceAutoImportRoots, []);
});

test("存量 setting.json 两键均缺席时一次性迁移为开启 + 3 天", () => {
  const parsed = appSettingsSchema.parse({
    recentProjects: ["/tmp/a"],
    locale: "zh-CN",
  });
  assert.equal(parsed.taskAutoArchiveEnabled, true);
  assert.equal(parsed.taskAutoArchiveOlderThanDays, 3);
  assert.equal(parsed.taskAutoArchiveDefaultsInitialized, true);
});

test("用户显式保存过的选择不被默认迁移翻转", () => {
  const parsed = appSettingsSchema.parse({
    taskAutoArchiveEnabled: false,
    taskAutoArchiveOlderThanDays: 14,
  });
  assert.equal(parsed.taskAutoArchiveEnabled, false);
  assert.equal(parsed.taskAutoArchiveOlderThanDays, 14);
  assert.equal(parsed.taskAutoArchiveDefaultsInitialized, true);
});

test("已迁移过的设置不会重复改写", () => {
  const parsed = appSettingsSchema.parse({
    taskAutoArchiveEnabled: false,
    taskAutoArchiveDefaultsInitialized: true,
  });
  assert.equal(parsed.taskAutoArchiveEnabled, false);
  // 天数键缺席时走 schema 新默认（3 天）；迁移标记只保护显式保存过的值不被翻转。
  assert.equal(parsed.taskAutoArchiveOlderThanDays, 3);
});

test("workspaceAutoImportRoots 可保存自定义根目录列表", () => {
  const parsed = appSettingsSchema.parse({
    workspaceAutoImportEnabled: false,
    workspaceAutoImportRoots: ["~/work", "/srv/repos"],
  });
  assert.equal(parsed.workspaceAutoImportEnabled, false);
  assert.deepEqual(parsed.workspaceAutoImportRoots, ["~/work", "/srv/repos"]);
});

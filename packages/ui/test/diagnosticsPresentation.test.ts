import assert from "node:assert/strict";
import test from "node:test";
import {
  crashCountMessageId,
  formatCrashSize,
  formatCrashTime,
  pickCrashTimestamp,
} from "../src/settings/diagnosticsListPresentation.js";

test("crash timestamp prefers crashedAtMs and falls back to archivedAtMs", () => {
  assert.equal(pickCrashTimestamp({ crashedAtMs: 100, archivedAtMs: 200 }), 100);
  assert.equal(pickCrashTimestamp({ crashedAtMs: null, archivedAtMs: 200 }), 200);
  assert.equal(pickCrashTimestamp({ crashedAtMs: null, archivedAtMs: null }), null);
});

test("crash size formats null as placeholder and bytes compactly", () => {
  assert.equal(formatCrashSize(null), "—");
  assert.equal(formatCrashSize(0), "0 B");
  assert.equal(formatCrashSize(512), "512 B");
  assert.equal(formatCrashSize(1024), "1 KB");
  assert.equal(formatCrashSize(1536), "1.5 KB");
  assert.equal(formatCrashSize(1024 * 1024), "1 MB");
  assert.equal(formatCrashSize(1536 * 1024), "1.5 MB");
  assert.equal(formatCrashSize(100 * 1024 * 1024), "100 MB");
});

test("crash count selects the manual plural message id", () => {
  assert.equal(crashCountMessageId(1), "settings.diagnostics.crash.count.one");
  assert.equal(crashCountMessageId(0), "settings.diagnostics.crash.count.other");
  assert.equal(crashCountMessageId(37), "settings.diagnostics.crash.count.other");
});

test("crash time formats a fixed timestamp via explicit options", () => {
  // 2025-06-15T12:00:00Z；取正午避开时区偏移把年份挪到 2024/2026 的边界。
  const formatted = formatCrashTime(1749988800000, "en-US");
  assert.ok(formatted !== null && formatted.length > 0);
  assert.ok(formatted.includes("2025"));
  assert.equal(formatCrashTime(null, "en-US"), null);
});

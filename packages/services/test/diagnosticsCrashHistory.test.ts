import assert from "node:assert/strict";
import test from "node:test";
import {
  CRASH_HISTORY_MAX_LINES,
  crashDumpIdFromFileName,
  mergeCrashDiagnosticsSources,
  parseCrashHistoryLine,
  parseCrashSidecarJson,
  selectNewestCrashHistoryLines,
} from "../src/diagnostics/crashHistoryProjection.js";
import type { CrashDiagnosticsEntry } from "../src/diagnostics/diagnostics.js";

function buildArchiveEntry(overrides: Partial<CrashDiagnosticsEntry> = {}): CrashDiagnosticsEntry {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    dumpPath: "/tmp/v2/crash/archive/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.dmp",
    crashedAtMs: 1_000,
    archivedAtMs: 2_000,
    sizeBytes: 123,
    v8OomSummary: null,
    source: "archive",
    ...overrides,
  };
}

test("parseCrashHistoryLine tolerates malformed lines", () => {
  assert.equal(parseCrashHistoryLine("not json at all"), null);
  assert.equal(parseCrashHistoryLine("{broken"), null);
  assert.equal(parseCrashHistoryLine('{"id": 42}'), null);
  assert.equal(parseCrashHistoryLine('{"crashedAtMs": 123}'), null);
  assert.equal(parseCrashHistoryLine('{"id": "   "}'), null);
  assert.equal(parseCrashHistoryLine('["id", "x"]'), null);
  assert.equal(parseCrashHistoryLine("null"), null);
  assert.equal(parseCrashHistoryLine(""), null);
});

test("parseCrashHistoryLine coerces numbers and rejects non-numeric fields", () => {
  const entry = parseCrashHistoryLine(
    '{"id":"dump-1","crashedAtMs":"1719300000000","archivedAtMs":1719300005000,"sizeBytes":"abc","v8OomSummary":null}',
  );
  assert.ok(entry);
  assert.equal(entry.id, "dump-1");
  assert.equal(entry.source, "history");
  assert.equal(entry.dumpPath, null);
  assert.equal(entry.crashedAtMs, 1_719_300_000_000);
  assert.equal(entry.archivedAtMs, 1_719_300_005_000);
  assert.equal(entry.sizeBytes, null);
  assert.equal(entry.v8OomSummary, null);
});

test("parseCrashHistoryLine drops boolean and object time fields", () => {
  const entry = parseCrashHistoryLine(
    '{"id":"dump-1","crashedAtMs":true,"archivedAtMs":{"ms":1},"sizeBytes":[1]}',
  );
  assert.ok(entry);
  assert.equal(entry.crashedAtMs, null);
  assert.equal(entry.archivedAtMs, null);
  assert.equal(entry.sizeBytes, null);
});

test("parseCrashHistoryLine projects the full desktop v8OomSummary onto the subset", () => {
  const entry = parseCrashHistoryLine(
    JSON.stringify({
      id: "dump-1",
      crashedAtMs: 100,
      archivedAtMs: 200,
      sizeBytes: 300,
      v8OomSummary: {
        processType: "renderer",
        location: "heap",
        oomKind: "js_heap_exhausted",
        isMainIsolate: true,
        isolateCount: 2,
        oldSpaceBytes: 1_073_741_824,
        oldSpaceCapacityBytes: 1_280_000_000,
        codeSpaceBytes: 4_000,
        codeCageSizeBytes: 268_435_456,
        stackHead: ["at f ()"],
        lastGcMessage: "Mark-Compact",
      },
    }),
  );
  assert.ok(entry);
  assert.deepEqual(entry.v8OomSummary, {
    processType: "renderer",
    oomKind: "js_heap_exhausted",
    oldSpaceBytes: 1_073_741_824,
    codeSpaceBytes: 4_000,
  });
});

test("v8OomSummary subset projection is null-safe field by field", () => {
  const entry = parseCrashHistoryLine(
    '{"id":"dump-1","v8OomSummary":{"oomKind":"code_space_exhausted"}}',
  );
  assert.ok(entry);
  assert.deepEqual(entry.v8OomSummary, {
    processType: null,
    oomKind: "code_space_exhausted",
    oldSpaceBytes: null,
    codeSpaceBytes: null,
  });

  const emptySummary = parseCrashHistoryLine('{"id":"dump-1","v8OomSummary":{}}');
  assert.ok(emptySummary);
  assert.deepEqual(emptySummary.v8OomSummary, {
    processType: null,
    oomKind: "unknown",
    oldSpaceBytes: null,
    codeSpaceBytes: null,
  });

  const scalarSummary = parseCrashHistoryLine('{"id":"dump-1","v8OomSummary":"js_heap"}');
  assert.ok(scalarSummary);
  assert.equal(scalarSummary.v8OomSummary, null);
});

test("parseCrashSidecarJson tolerates bad JSON and reads ISO archivedAt", () => {
  const broken = parseCrashSidecarJson("{nope");
  assert.deepEqual(broken, {
    crashedAtMs: null,
    archivedAtMs: null,
    sizeBytes: null,
    v8OomSummary: null,
  });

  const legacy = parseCrashSidecarJson(
    JSON.stringify({ archivedAt: "2026-09-25T08:00:00.000Z", originalPath: "/tmp/live/x.dmp" }),
  );
  assert.equal(legacy.archivedAtMs, Date.parse("2026-09-25T08:00:00.000Z"));
  assert.equal(legacy.crashedAtMs, null);

  const enhanced = parseCrashSidecarJson(
    JSON.stringify({
      archivedAt: "2026-09-25T08:00:00.000Z",
      crashedAtMs: 1_719_300_000_000,
      sizeBytes: 4_096,
      v8OomSummary: { oomKind: "unknown", processType: null },
    }),
  );
  assert.equal(enhanced.crashedAtMs, 1_719_300_000_000);
  assert.equal(enhanced.sizeBytes, 4_096);
  assert.equal(enhanced.v8OomSummary?.oomKind, "unknown");
});

test("mergeCrashDiagnosticsSources dedupes by id with history winning", () => {
  const historyEntry = parseCrashHistoryLine(
    '{"id":"dump-1","crashedAtMs":1000,"archivedAtMs":2000,"sizeBytes":42}',
  );
  assert.ok(historyEntry);
  const merged = mergeCrashDiagnosticsSources({
    historyEntries: [historyEntry],
    archiveEntries: [
      buildArchiveEntry({ id: "dump-1", crashedAtMs: 9_999, archivedAtMs: 8_888, sizeBytes: 999 }),
    ],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.source, "history");
  // history 是 crash 时间的权威记录；归档 stat 的读数不得覆盖。
  assert.equal(merged[0]?.crashedAtMs, 1_000);
  assert.equal(merged[0]?.archivedAtMs, 2_000);
  assert.equal(merged[0]?.sizeBytes, 42);
  // dump 仍在盘上时回填 dumpPath，UI 才能提供「显示于文件夹」。
  assert.equal(
    merged[0]?.dumpPath,
    "/tmp/v2/crash/archive/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.dmp",
  );
});

test("mergeCrashDiagnosticsSources keeps archive-only entries with source archive", () => {
  const historyEntry = parseCrashHistoryLine('{"id":"dump-hist","crashedAtMs":10}');
  assert.ok(historyEntry);
  const merged = mergeCrashDiagnosticsSources({
    historyEntries: [historyEntry],
    archiveEntries: [
      buildArchiveEntry({ id: "dump-disk", crashedAtMs: null, archivedAtMs: 500, sizeBytes: 7 }),
    ],
  });
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, "dump-disk");
  assert.equal(merged[0]?.source, "archive");
  assert.equal(merged[1]?.id, "dump-hist");
});

test("mergeCrashDiagnosticsSources sorts by crashedAtMs ?? archivedAtMs desc with nulls last", () => {
  const merged = mergeCrashDiagnosticsSources({
    historyEntries: [],
    archiveEntries: [
      buildArchiveEntry({ id: "crashed-low", crashedAtMs: 100, archivedAtMs: 9_000 }),
      buildArchiveEntry({ id: "archived-high", crashedAtMs: null, archivedAtMs: 5_000 }),
      buildArchiveEntry({ id: "crashed-high", crashedAtMs: 700, archivedAtMs: 100 }),
      buildArchiveEntry({ id: "unknown-times", crashedAtMs: null, archivedAtMs: null }),
    ],
  });
  assert.deepEqual(
    merged.map((entry) => entry.id),
    ["archived-high", "crashed-high", "crashed-low", "unknown-times"],
  );
});

test("crashDumpIdFromFileName derives the dedupe id", () => {
  assert.equal(crashDumpIdFromFileName("uuid-1.dmp"), "uuid-1");
  assert.equal(crashDumpIdFromFileName("uuid-1.dmp.json"), null);
  assert.equal(crashDumpIdFromFileName("uuid-1.json"), null);
  assert.equal(crashDumpIdFromFileName(".dmp"), null);
});

test("selectNewestCrashHistoryLines keeps the newest 200 lines in append order", () => {
  const total = CRASH_HISTORY_MAX_LINES + 50;
  const lines: string[] = [];
  for (let index = 0; index < total; index += 1) {
    lines.push(JSON.stringify({ id: `dump-${index}`, crashedAtMs: index }));
  }
  const kept = selectNewestCrashHistoryLines(lines);
  assert.equal(kept.length, CRASH_HISTORY_MAX_LINES);
  assert.equal(JSON.parse(kept[0] ?? "").id, "dump-50");
  assert.equal(JSON.parse(kept.at(-1) ?? "").id, `dump-${total - 1}`);
  // 文件保持追加顺序（旧行在前），只裁剪集合不重排。
  for (let position = 1; position < kept.length; position += 1) {
    const previous = JSON.parse(kept[position - 1] ?? "").crashedAtMs as number;
    const current = JSON.parse(kept[position] ?? "").crashedAtMs as number;
    assert.ok(previous < current);
  }
});

test("selectNewestCrashHistoryLines ranks by crash time and sends unknown times to the tail", () => {
  const lines = [
    JSON.stringify({ id: "a", crashedAtMs: 1 }),
    JSON.stringify({ id: "b", crashedAtMs: 30 }),
    JSON.stringify({ id: "c", archivedAtMs: 20 }),
    JSON.stringify({ id: "d" }),
    "corrupted line",
  ];
  const kept = selectNewestCrashHistoryLines(lines, 2);
  assert.deepEqual(
    kept.map((line) => JSON.parse(line).id),
    ["b", "c"],
  );

  const keptNullTime = selectNewestCrashHistoryLines(lines, 4);
  // 4 条限额装下 b/c/a/d（损坏行不占位）；输出保持原文件追加顺序。
  assert.deepEqual(
    keptNullTime.map((line) => JSON.parse(line).id),
    ["a", "b", "c", "d"],
  );
});

test("selectNewestCrashHistoryLines ignores corrupted lines when filling the limit", () => {
  const lines = ["{bad", "", JSON.stringify({ id: "good-1", crashedAtMs: 1 })];
  assert.deepEqual(selectNewestCrashHistoryLines(lines, 10), [
    JSON.stringify({ id: "good-1", crashedAtMs: 1 }),
  ]);
  assert.deepEqual(selectNewestCrashHistoryLines(lines, 0), []);
});

// Regression tests for the time-window fix: the daily-burn window must be
// enforced by each record's OWN timestamp, not the file mtime, so widening
// 30d -> 90d actually moves the window instead of adding "a day or so".
//
// Run: npx tsx --test lib/transcripts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupAndSum, utcDayKey, type TranscriptResult, type UsageRecord } from "./transcripts";

const APR1 = Date.UTC(2026, 3, 1);
const APR15 = Date.UTC(2026, 3, 15);
const MAY1 = Date.UTC(2026, 4, 1);

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    dedupKey: "",
    model: "claude-opus-4-8",
    ts: 0,
    input: 0,
    cacheRead: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    output: 0,
    isSidechain: false,
    ...over,
  };
}

function rawSession(records: UsageRecord[]): TranscriptResult {
  return {
    filePath: "/p/s.jsonl",
    mtimeMs: MAY1,
    sessionId: "s",
    project: "p",
    projectPath: "/p",
    startTime: 0,
    endTime: 0,
    turnCount: 0,
    models: [],
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    byModel: {},
    byDay: {},
    usageRecords: records,
    invocations: [],
    toolCalls: {},
    toolErrors: 0,
    sidechainTurns: 0,
  };
}

test("clips records older than the cutoff by their own ts", () => {
  const raw = rawSession([
    rec({ dedupKey: "a", ts: APR1, input: 100 }),
    rec({ dedupKey: "b", ts: MAY1, input: 50 }),
  ]);
  const [s] = dedupAndSum([raw], APR15);
  assert.equal(s.inputTokens, 50, "April record dropped, only May counted");
  assert.equal(s.turnCount, 1);
  assert.deepEqual(Object.keys(s.byDay), ["2026-05-01"], "old day not bucketed");
});

test("cutoff 0 disables clipping and buckets every day", () => {
  const raw = rawSession([
    rec({ dedupKey: "a", ts: APR1, input: 100 }),
    rec({ dedupKey: "b", ts: MAY1, input: 50 }),
  ]);
  const [s] = dedupAndSum([raw], 0);
  assert.equal(s.inputTokens, 150);
  assert.deepEqual(Object.keys(s.byDay).sort(), ["2026-04-01", "2026-05-01"]);
});

test("byDay tokens reconcile with session totals", () => {
  const raw = rawSession([
    rec({ ts: APR1, input: 10, output: 5, cacheRead: 3 }),
    rec({ ts: MAY1, input: 20, output: 7, cacheCreation5m: 4 }),
  ]);
  const [s] = dedupAndSum([raw], 0);
  let dayTok = 0;
  for (const models of Object.values(s.byDay)) {
    for (const u of Object.values(models)) {
      dayTok +=
        u.inputTokens + u.cacheReadTokens + u.cacheCreation5mTokens + u.cacheCreation1hTokens + u.outputTokens;
    }
  }
  const total = s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens + s.outputTokens;
  assert.equal(dayTok, total, "every counted token lands on exactly one day");
});

test("an out-of-window record does not burn its dedupKey", () => {
  // Same message appears in an old subagent file and a recent main file. The
  // old copy is clipped; the recent copy must still count (not be deduped away).
  const old = rawSession([rec({ dedupKey: "dup", ts: APR1, input: 99 })]);
  const recent = rawSession([rec({ dedupKey: "dup", ts: MAY1, input: 99 })]);
  const [s] = dedupAndSum([old, recent], APR15);
  assert.equal(s.inputTokens, 99, "recent copy survives clipping of the old one");
});

test("utcDayKey is stable UTC YYYY-MM-DD", () => {
  assert.equal(utcDayKey(MAY1), "2026-05-01");
  assert.equal(utcDayKey(Date.UTC(2026, 0, 9)), "2026-01-09");
});

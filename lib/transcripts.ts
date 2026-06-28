/**
 * Single-pass JSONL transcript parser with per-file mtime cache.
 *
 * Each `~/.claude/projects/*\/*.jsonl` is parsed exactly once per (filePath, mtime).
 * Result includes both:
 *   - invocations (Skill / Agent tool_use events)  -> consumed by lib/usage.ts
 *   - session stats (turn count, token usage)      -> consumed by lib/sessions.ts
 *
 * CC creates a new JSONL when you `--continue` a session, which replays the
 * prior turns. To match ccusage's totals we dedup messages by `msg.id:requestId`
 * across all files at aggregate time. Per-file records are cached unchanged
 * (preserves mtime cache); dedupAndSum runs on every getAllTranscripts call.
 */
import { readdir, stat, readFile, writeFile, appendFile, mkdir, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// Persistent parse cache. The in-memory `cache` Map below only survives within a
// process, so a fresh CLI run or dashboard server boot reparses every transcript
// (~3GB / 140k files → ~15s cold). This NDJSON sidecar lets a cold start reload
// already-parsed per-file results and reparse only files whose mtime changed.
const CACHE_DIR = join(homedir(), ".contextscope");
// gzip multi-member NDJSON: each append is one gzip member, and concatenated
// members decompress to the full line stream — so the append-only design holds
// while shrinking the sidecar ~6× (≈130MB → ≈20MB).
const CACHE_FILE = join(CACHE_DIR, "transcript-cache-v1.ndjson.gz");
// Pre-gzip sidecar from earlier versions — removed on first run to reclaim space.
const LEGACY_CACHE_FILE = join(CACHE_DIR, "transcript-cache-v1.ndjson");

export type Invocation = { kind: "skill" | "agent"; name: string; ts: number };

export type ModelUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  outputTokens: number;
};

export type UsageRecord = {
  // `${message.id}:${requestId}` — same key ccusage uses. Empty string if msg
  // lacked an id (treat as un-dedupable; count it).
  dedupKey: string;
  model: string;
  ts: number;
  input: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  output: number;
  isSidechain: boolean;
};

export type TranscriptResult = {
  filePath: string;
  mtimeMs: number;
  sessionId: string;
  project: string;        // dir name
  projectPath: string;    // inferred /Users/...
  startTime: number;
  endTime: number;
  turnCount: number;
  models: string[];
  // Aggregate totals — sums after dedup (when produced via getAllTranscripts).
  // On raw parseFile output these are pre-dedup; getAllTranscripts rebuilds them.
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;   // total: 5m + 1h
  outputTokens: number;
  byModel: Record<string, ModelUsage>;
  // Per-UTC-day, per-model token sums, built during dedup/merge from the
  // in-window records only. Lets the daily-burn chart bucket tokens by the
  // message's own timestamp instead of collapsing a resumed session's whole
  // lifetime onto its endTime. Empty on raw parseFile output; filled by
  // getAllTranscripts/dedupAndSum.
  byDay: Record<string, Record<string, ModelUsage>>;
  // Per-message records — kept on the cached result so dedup at aggregate time
  // is exact across resumed sessions.
  usageRecords: UsageRecord[];
  invocations: Invocation[];
  toolCalls: Record<string, number>;
  toolErrors: number;
  sidechainTurns: number;
  // CC's `entrypoint` field on message records: "cli" = interactive Claude Code,
  // "sdk-cli" (and other "sdk-*") = headless `claude -p` / SDK runs. Taken from
  // the main session file; used to split interactive vs headless burn.
  entrypoint?: string;
};

const cache = new Map<string, TranscriptResult>();
// Bounded backstop only. The disk cache is the real bound now, and a cold start
// hydrates the full working set (~140k slim entries) into this Map, so the cap
// must sit well above realistic transcript counts or eviction would discard
// hydrated entries and force a reparse mid-run.
const MAX_CACHE_ENTRIES = 500_000;
// Files (re)parsed since the last persist — appended to the disk cache rather
// than rewriting the whole ~100MB+ sidecar on every run that sees a new file.
const pendingPaths = new Set<string>();
// Lines currently on disk (grows with appends, including stale overwritten
// entries). When it bloats past the live set we compact with a full rewrite.
let diskLineCount = 0;
// The per-file cache only needs to cover the live window (CC retains ~30d, and
// dedup/top-sessions only look back that far). Long-tail history lives in the
// compact daily archive (lib/archive.ts), so we prune entries older than this
// to stop the cache exploding at heavy `claude -p` volume.
const LIVE_RETAIN_DAYS = 35;

function inferProjectPath(dirName: string): string {
  return dirName.replace(/^-/, "/").replaceAll("-", "/");
}

/** UTC day bucket key (YYYY-MM-DD) for a millisecond timestamp. */
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

async function parseFile(filePath: string, mtimeMs: number): Promise<TranscriptResult> {
  const parts = filePath.split("/");
  // Two shapes:
  //   <project>/<session-uuid>.jsonl                          → main session file
  //   <project>/<session-uuid>/subagents/agent-<id>.jsonl     → subagent file
  // For subagents we want the parent session UUID + parent project, so the
  // tokens roll up to the same Session as the main file.
  const isSubagent = parts[parts.length - 2] === "subagents";
  const sessionId = isSubagent
    ? (parts[parts.length - 3] ?? "")
    : parts[parts.length - 1].replace(/\.jsonl$/, "");
  const project = isSubagent
    ? (parts[parts.length - 4] ?? "")
    : (parts[parts.length - 2] ?? "");
  const result: TranscriptResult = {
    filePath,
    mtimeMs,
    sessionId,
    project,
    projectPath: inferProjectPath(project),
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
    usageRecords: [],
    invocations: [],
    toolCalls: {},
    toolErrors: 0,
    sidechainTurns: 0,
  };

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line || line[0] !== "{") return;
      const hasUsage = line.includes('"usage"');
      const hasToolUse = line.includes('"tool_use"');
      const hasToolResult = line.includes('"tool_result"');
      if (!hasUsage && !hasToolUse && !hasToolResult) return;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      const msg = rec.message as
        | { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown }
        | undefined;
      const tsRaw = rec.timestamp;
      const tsMs = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
      const isSidechain = rec.isSidechain === true;
      if (!result.entrypoint && typeof rec.entrypoint === "string") {
        result.entrypoint = rec.entrypoint;
      }

      const usage = msg?.usage;
      if (usage) {
        const msgId = typeof msg?.id === "string" ? msg.id : "";
        const requestId = typeof rec.requestId === "string" ? rec.requestId : "";
        const dedupKey = msgId ? `${msgId}:${requestId}` : "";
        // cache_creation may have an ephemeral_{5m,1h}_input_tokens breakdown
        // (priced separately at $6.25/M vs $10/M for opus-4-7). Older transcripts
        // lack the sub-object — fall back to treating the total as 5min.
        const ccTotal = Number(usage.cache_creation_input_tokens) || 0;
        const ccBreakdown = (usage.cache_creation ?? null) as
          | { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
          | null;
        let cc5m = 0;
        let cc1h = 0;
        if (ccBreakdown && typeof ccBreakdown === "object") {
          cc5m = Number(ccBreakdown.ephemeral_5m_input_tokens) || 0;
          cc1h = Number(ccBreakdown.ephemeral_1h_input_tokens) || 0;
          // If breakdown is present but sum doesn't match the parent total,
          // trust the parent and attribute the diff to 5min (conservative).
          const diff = ccTotal - (cc5m + cc1h);
          if (diff > 0) cc5m += diff;
        } else {
          cc5m = ccTotal;
        }
        result.usageRecords.push({
          dedupKey,
          model: msg?.model || "<synthetic>",
          ts: Number.isFinite(tsMs) ? tsMs : 0,
          input: Number(usage.input_tokens) || 0,
          cacheRead: Number(usage.cache_read_input_tokens) || 0,
          cacheCreation5m: cc5m,
          cacheCreation1h: cc1h,
          output: Number(usage.output_tokens) || 0,
          isSidechain,
        });
      }

      if (Array.isArray(msg?.content)) {
        for (const c of msg.content) {
          if (!c || typeof c !== "object") continue;
          const co = c as Record<string, unknown>;
          if (co.type === "tool_use") {
            const toolName = typeof co.name === "string" ? co.name : "(unknown)";
            result.toolCalls[toolName] = (result.toolCalls[toolName] ?? 0) + 1;
            const input = co.input as Record<string, unknown> | undefined;
            if (input) {
              if (toolName === "Skill" && typeof input.skill === "string") {
                result.invocations.push({
                  kind: "skill",
                  name: input.skill,
                  ts: Number.isFinite(tsMs) ? tsMs : 0,
                });
              } else if (toolName === "Agent" && typeof input.subagent_type === "string") {
                result.invocations.push({
                  kind: "agent",
                  name: input.subagent_type,
                  ts: Number.isFinite(tsMs) ? tsMs : 0,
                });
              }
            }
          } else if (co.type === "tool_result" && co.is_error === true) {
            result.toolErrors += 1;
          }
        }
      }
    });
    rl.on("close", () => resolve(result));
    rl.on("error", () => resolve(result));
  });
}

async function getFileResult(filePath: string, mtimeMs: number): Promise<TranscriptResult> {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const fresh = await parseFile(filePath, mtimeMs);
  if (cached) cache.delete(filePath);
  cache.set(filePath, fresh);
  pendingPaths.add(filePath);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return fresh;
}

// Compact on-disk shape: short keys, and empty arrays/objects omitted so the
// ~115k transcripts with no token usage serialize to a tiny identity record.
type DiskEntry = {
  p: string; m: number; s: string; pr: string; pp: string;
  e?: string;
  u?: UsageRecord[];
  i?: Invocation[];
  tc?: Record<string, number>;
  te?: number;
};

function toDiskEntry(r: TranscriptResult): DiskEntry {
  const e: DiskEntry = { p: r.filePath, m: r.mtimeMs, s: r.sessionId, pr: r.project, pp: r.projectPath };
  if (r.entrypoint) e.e = r.entrypoint;
  if (r.usageRecords.length) e.u = r.usageRecords;
  if (r.invocations.length) e.i = r.invocations;
  if (Object.keys(r.toolCalls).length) e.tc = r.toolCalls;
  if (r.toolErrors) e.te = r.toolErrors;
  return e;
}

function fromDiskEntry(e: DiskEntry): TranscriptResult {
  return {
    filePath: e.p,
    mtimeMs: e.m,
    sessionId: e.s,
    project: e.pr,
    projectPath: e.pp,
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
    usageRecords: e.u ?? [],
    invocations: e.i ?? [],
    toolCalls: e.tc ?? {},
    toolErrors: e.te ?? 0,
    sidechainTurns: 0,
    entrypoint: e.e,
  };
}

let hydrated = false;

/** Populate the in-memory cache from the disk sidecar. Runs at most once. */
async function hydrateDiskCache(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  // Drop the legacy uncompressed sidecar if it's still around (best-effort).
  unlink(LEGACY_CACHE_FILE).catch(() => {});
  let data: string;
  try {
    data = gunzipSync(await readFile(CACHE_FILE)).toString("utf8");
  } catch {
    return; // no cache yet — first run
  }
  for (const line of data.split("\n")) {
    if (!line) continue;
    diskLineCount += 1;
    try {
      const e = JSON.parse(line) as DiskEntry;
      // Last write wins: a later (appended) line is the fresher reparse, so it
      // must overwrite an earlier stale entry for the same file.
      cache.set(e.p, fromDiskEntry(e));
    } catch {
      // skip a corrupt line rather than throwing away the whole cache
    }
  }
}

/**
 * Persist files (re)parsed this run. Normally appends just those lines; when the
 * on-disk file has bloated with stale overwritten entries (>1.5× the live set)
 * it compacts with a single full rewrite.
 */
async function persistDiskCache(): Promise<void> {
  // Drop entries older than the live window so the per-file cache stays bounded.
  // Stale lines may linger on disk until the next compaction (bounded to ~1.5×
  // the live set by the trigger below); record-ts clipping keeps them harmless.
  const pruneCutoff = Date.now() - LIVE_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  for (const [fp, r] of cache) if (r.mtimeMs < pruneCutoff) cache.delete(fp);
  if (pendingPaths.size === 0) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    if (diskLineCount + pendingPaths.size > cache.size * 1.5) {
      const lines: string[] = [];
      for (const r of cache.values()) lines.push(JSON.stringify(toDiskEntry(r)));
      await writeFile(CACHE_FILE, lines.length ? gzipSync(lines.join("\n") + "\n") : Buffer.alloc(0));
      diskLineCount = lines.length;
    } else {
      const lines: string[] = [];
      for (const p of pendingPaths) {
        const r = cache.get(p);
        if (r) lines.push(JSON.stringify(toDiskEntry(r)));
      }
      // Append as a fresh gzip member — concatenated members decompress together.
      await appendFile(CACHE_FILE, gzipSync(lines.join("\n") + "\n"));
      diskLineCount += lines.length;
    }
    pendingPaths.clear();
  } catch {
    // best-effort: a failed write just means the next cold start reparses
  }
}

async function pMapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Walk raw per-file results oldest first, dedup messages globally by
 * (msg.id, requestId), and merge multiple files belonging to the same logical
 * session (main + subagents/*) into one TranscriptResult per session.
 *
 * Important: do NOT mutate the cached `raws` objects — they're shared across
 * calls.
 *
 * `cutoffMs` clips the window by each record's OWN timestamp: records older than
 * the cutoff are dropped from all totals so "last N days" counts tokens by when
 * they were actually spent, not by the file's mtime (which clusters recent
 * because Claude Code rewrites transcripts). Records with no timestamp (ts <= 0)
 * can't be placed, so they're kept. Pass 0 to disable clipping.
 */
export function dedupAndSum(raws: TranscriptResult[], cutoffMs = 0): TranscriptResult[] {
  const sorted = [...raws].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const seen = new Set<string>();
  const merged = new Map<string, TranscriptResult>();

  for (const r of sorted) {
    const key = `${r.project}\x00${r.sessionId}`;
    let t = merged.get(key);
    if (!t) {
      t = {
        filePath: r.filePath,
        mtimeMs: r.mtimeMs,
        sessionId: r.sessionId,
        project: r.project,
        projectPath: r.projectPath,
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
        usageRecords: [],
        invocations: [],
        toolCalls: {},
        toolErrors: 0,
        sidechainTurns: 0,
        entrypoint: r.entrypoint,
      };
      merged.set(key, t);
    } else {
      // Prefer the main session file's path/mtime/entrypoint as the canonical
      // reference; a subagent file landed first only if no main yet, which is rare.
      const incomingIsMain = !r.filePath.includes("/subagents/");
      if (incomingIsMain) {
        t.filePath = r.filePath;
        t.mtimeMs = Math.max(t.mtimeMs, r.mtimeMs);
        t.entrypoint = r.entrypoint;
      }
    }

    // Accumulate ancillary fields
    for (const inv of r.invocations) t.invocations.push(inv);
    for (const [name, n] of Object.entries(r.toolCalls)) {
      t.toolCalls[name] = (t.toolCalls[name] ?? 0) + n;
    }
    t.toolErrors += r.toolErrors;

    const modelSet = new Set<string>(t.models);
    for (const u of r.usageRecords) {
      // Clip by the record's own timestamp before touching `seen`, so an
      // out-of-window record doesn't burn its dedupKey and hide an in-window
      // duplicate.
      if (cutoffMs > 0 && u.ts > 0 && u.ts < cutoffMs) continue;
      if (u.dedupKey) {
        if (seen.has(u.dedupKey)) continue;
        seen.add(u.dedupKey);
      }
      t.inputTokens += u.input;
      t.cacheReadTokens += u.cacheRead;
      t.cacheCreationTokens += u.cacheCreation5m + u.cacheCreation1h;
      t.outputTokens += u.output;
      t.turnCount += 1;
      if (u.isSidechain) t.sidechainTurns += 1;
      modelSet.add(u.model);
      const bm = t.byModel[u.model] ?? {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        outputTokens: 0,
      };
      bm.inputTokens += u.input;
      bm.cacheReadTokens += u.cacheRead;
      bm.cacheCreation5mTokens += u.cacheCreation5m;
      bm.cacheCreation1hTokens += u.cacheCreation1h;
      bm.outputTokens += u.output;
      t.byModel[u.model] = bm;
      if (u.ts > 0) {
        if (!t.startTime || u.ts < t.startTime) t.startTime = u.ts;
        if (u.ts > t.endTime) t.endTime = u.ts;
        const day = utcDayKey(u.ts);
        const dm = t.byDay[day] ?? (t.byDay[day] = {});
        const dbm = dm[u.model] ?? {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreation5mTokens: 0,
          cacheCreation1hTokens: 0,
          outputTokens: 0,
        };
        dbm.inputTokens += u.input;
        dbm.cacheReadTokens += u.cacheRead;
        dbm.cacheCreation5mTokens += u.cacheCreation5m;
        dbm.cacheCreation1hTokens += u.cacheCreation1h;
        dbm.outputTokens += u.output;
        dm[u.model] = dbm;
      }
    }
    t.models = [...modelSet];
  }

  return [...merged.values()];
}

/**
 * Dedup + window the in-memory cache directly, without re-walking the filesystem.
 * Only valid after a getAllTranscripts() call has hydrated/refreshed the cache in
 * this process. Used to build the daily-archive basis from the warm cache cheaply.
 */
export function dedupCacheWithin(daysBack: number): TranscriptResult[] {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return dedupAndSum([...cache.values()], cutoff);
}

async function collectJsonlFiles(
  dir: string,
  cutoff: number,
  out: { filePath: string; mtimeMs: number }[],
  depth: number = 0
): Promise<void> {
  if (depth > 3) return; // <project>/<session>/subagents/<file> is the deepest expected shape
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) {
      await collectJsonlFiles(fp, cutoff, out, depth + 1);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(fp);
      if (st.mtimeMs >= cutoff) out.push({ filePath: fp, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
}

/**
 * Scan all transcripts modified in the last N days. Scans both main session
 * files (<project>/<session>.jsonl) and subagent files
 * (<project>/<session>/subagents/agent-*.jsonl), then attributes subagent
 * tokens to their parent session via shared sessionId. Deduped globally by
 * (msg.id, requestId).
 */
export async function getAllTranscripts(daysBack: number = 30): Promise<TranscriptResult[]> {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  await hydrateDiskCache();
  let projDirs: import("node:fs").Dirent[];
  try {
    projDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: { filePath: string; mtimeMs: number }[] = [];
  await Promise.all(
    projDirs.map(async (d) => {
      if (!d.isDirectory()) return;
      await collectJsonlFiles(join(PROJECTS_DIR, String(d.name)), cutoff, candidates);
    })
  );
  const raws = await pMapLimit(candidates, 16, (c) => getFileResult(c.filePath, c.mtimeMs));
  await persistDiskCache();
  return dedupAndSum(raws, cutoff);
}

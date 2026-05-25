/**
 * Single-pass JSONL transcript parser with per-file mtime cache.
 *
 * Each `~/.claude/projects/*\/*.jsonl` is parsed exactly once per (filePath, mtime).
 * Result includes both:
 *   - invocations (Skill / Agent tool_use events)  -> consumed by lib/usage.ts
 *   - session stats (turn count, token usage)      -> consumed by lib/sessions.ts
 *
 * Subsequent page loads reuse cached results when mtime is unchanged.
 */
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type Invocation = { kind: "skill" | "agent"; name: string; ts: number };

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
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  invocations: Invocation[];
};

// Module-level cache: persists across server-component renders within the same
// Next.js dev/prod process. Keyed by filePath; invalidated on mtime change.
const cache = new Map<string, TranscriptResult>();

function inferProjectPath(dirName: string): string {
  return dirName.replace(/^-/, "/").replaceAll("-", "/");
}

async function parseFile(filePath: string, mtimeMs: number): Promise<TranscriptResult> {
  const parts = filePath.split("/");
  const sessionId = parts[parts.length - 1].replace(/\.jsonl$/, "");
  const project = parts[parts.length - 2] ?? "";
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
    invocations: [],
  };
  const modelSet = new Set<string>();

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (!line || line[0] !== "{") return;
      // Prefilter: skip lines that obviously have neither a tool_use we care about
      // nor a usage field.
      const hasUsage = line.includes('"usage"');
      const hasToolUse = line.includes('"tool_use"');
      if (!hasUsage && !hasToolUse) return;

      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      const msg = rec.message as
        | { model?: string; usage?: Record<string, unknown>; content?: unknown }
        | undefined;
      const tsRaw = rec.timestamp;
      const tsMs = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;

      // Usage aggregation
      const usage = msg?.usage;
      if (usage) {
        result.inputTokens += Number(usage.input_tokens) || 0;
        result.cacheReadTokens += Number(usage.cache_read_input_tokens) || 0;
        result.cacheCreationTokens += Number(usage.cache_creation_input_tokens) || 0;
        result.outputTokens += Number(usage.output_tokens) || 0;
        result.turnCount += 1;
        if (msg?.model) modelSet.add(msg.model);
        if (Number.isFinite(tsMs)) {
          if (!result.startTime || tsMs < result.startTime) result.startTime = tsMs;
          if (tsMs > result.endTime) result.endTime = tsMs;
        }
      }

      // Tool_use scanning
      if (hasToolUse && Array.isArray(msg?.content)) {
        for (const c of msg.content) {
          if (!c || typeof c !== "object") continue;
          const co = c as Record<string, unknown>;
          if (co.type !== "tool_use") continue;
          const input = co.input as Record<string, unknown> | undefined;
          if (!input) continue;
          if (co.name === "Skill" && typeof input.skill === "string") {
            result.invocations.push({
              kind: "skill",
              name: input.skill,
              ts: Number.isFinite(tsMs) ? tsMs : 0,
            });
          } else if (co.name === "Agent" && typeof input.subagent_type === "string") {
            result.invocations.push({
              kind: "agent",
              name: input.subagent_type,
              ts: Number.isFinite(tsMs) ? tsMs : 0,
            });
          }
        }
      }
    });
    rl.on("close", () => {
      result.models = [...modelSet];
      resolve(result);
    });
    rl.on("error", () => {
      result.models = [...modelSet];
      resolve(result);
    });
  });
}

async function getFileResult(filePath: string, mtimeMs: number): Promise<TranscriptResult> {
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const fresh = await parseFile(filePath, mtimeMs);
  cache.set(filePath, fresh);
  return fresh;
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

/** Scan all transcripts modified in the last N days. Cached per (filePath, mtime). */
export async function getAllTranscripts(daysBack: number = 30): Promise<TranscriptResult[]> {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
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
      const dir = join(PROJECTS_DIR, String(d.name));
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const fp = join(dir, e.name);
        try {
          const st = await stat(fp);
          if (st.mtimeMs >= cutoff) candidates.push({ filePath: fp, mtimeMs: st.mtimeMs });
        } catch {
          // skip
        }
      }
    })
  );
  return pMapLimit(candidates, 16, (c) => getFileResult(c.filePath, c.mtimeMs));
}

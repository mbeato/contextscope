/**
 * Daily-rollup archive — contextscope's own history store, so the burn chart
 * outlives Claude Code's transcript cleanup (`cleanupPeriodDays`, default 30d).
 *
 * CC deletes raw transcripts after ~30 days, so a 90-day window would otherwise
 * cap at 30 days of data. We can't keep every per-file entry for 90+ days (at
 * heavy `claude -p` volume that's millions of tiny sessions), so instead each
 * run collapses every *sealed* (past, no-longer-changing) day into one compact
 * rollup and merges it here. The per-file cache stays bounded to the live
 * window for dedup/top-sessions; this carries the long tail.
 *
 * Only token/cost data is archived (what the burn views need). Per-session
 * distribution stats (median, p95, top sessions) stay scoped to retained data.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ARCHIVE_DIR = join(homedir(), ".contextscope");
const ARCHIVE_FILE = join(ARCHIVE_DIR, "daily-archive-v1.json");

export type DayRollup = {
  tokens: number;
  cost: number;
  fresh: number; // input + cache-creation + output
  cacheRead: number;
  headlessTokens: number;
  headlessCost: number;
  byProject: Record<string, { projectPath: string; tokens: number; cost: number }>;
};

export type ArchiveData = { version: number; days: Record<string, DayRollup> };

const VERSION = 1;

export async function loadArchive(): Promise<ArchiveData> {
  try {
    const raw = JSON.parse(await readFile(ARCHIVE_FILE, "utf8")) as ArchiveData;
    if (raw && raw.version === VERSION && raw.days) return raw;
  } catch {
    // missing or unreadable — start fresh
  }
  return { version: VERSION, days: {} };
}

export async function saveArchive(data: ArchiveData): Promise<void> {
  try {
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await writeFile(ARCHIVE_FILE, JSON.stringify(data));
  } catch {
    // best-effort: a failed write just means this run's sealed days re-seal next time
  }
}

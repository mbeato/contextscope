import {
  getAllTranscripts,
  dedupCacheWithin,
  utcDayKey,
  type TranscriptResult,
  type ModelUsage,
} from "./transcripts";
import { costForUsage } from "./pricing";
import { loadArchive, saveArchive, type DayRollup } from "./archive";

export type Session = {
  sessionId: string;
  project: string;
  projectPath: string;
  filePath: string;
  startTime: number;
  endTime: number;
  turnCount: number;
  models: string[];
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  sidechainTurns: number;
  // Headless = `claude -p` / SDK run (entrypoint "sdk-*"), as opposed to an
  // interactive Claude Code session ("cli"). Lets us split eval burn out.
  isHeadless: boolean;
  // Per-UTC-day, per-model token sums (in-window records only). Drives the
  // daily-burn chart by real message time.
  byDay: Record<string, Record<string, ModelUsage>>;
};

function computeCost(t: TranscriptResult): number {
  let cost = 0;
  for (const [model, u] of Object.entries(t.byModel)) {
    cost += costForUsage(model, {
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation5m: u.cacheCreation5mTokens,
      cacheCreation1h: u.cacheCreation1hTokens,
    });
  }
  return cost;
}

function toSession(t: TranscriptResult): Session {
  const totalTokens =
    t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens + t.outputTokens;
  return {
    sessionId: t.sessionId,
    project: t.project,
    projectPath: t.projectPath,
    filePath: t.filePath,
    startTime: t.startTime,
    endTime: t.endTime,
    turnCount: t.turnCount,
    models: t.models,
    inputTokens: t.inputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    outputTokens: t.outputTokens,
    totalTokens,
    costUsd: computeCost(t),
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    sidechainTurns: t.sidechainTurns,
    isHeadless: (t.entrypoint ?? "").startsWith("sdk"),
    byDay: t.byDay,
  };
}

export async function getSessions(daysBack: number = 30): Promise<Session[]> {
  const transcripts = await getAllTranscripts(daysBack);
  return transcripts
    .filter((t) => t.turnCount > 0)
    .map(toSession)
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

// How far back to recompute sealed days each run (≥ CC retention), and how long
// the archive itself keeps history (must exceed the widest UI window).
const ARCHIVE_BASIS_DAYS = 35;
const ARCHIVE_RETAIN_DAYS = 120;

/** Collapse deduped sessions into per-day token/cost rollups (one per UTC day). */
function dailyRollups(sessions: Session[]): Record<string, DayRollup> {
  const days: Record<string, DayRollup> = {};
  for (const s of sessions) {
    for (const [day, models] of Object.entries(s.byDay)) {
      const d =
        days[day] ??
        (days[day] = { tokens: 0, cost: 0, fresh: 0, cacheRead: 0, headlessTokens: 0, headlessCost: 0, byProject: {} });
      for (const [model, u] of Object.entries(models)) {
        const fresh = u.inputTokens + u.cacheCreation5mTokens + u.cacheCreation1hTokens + u.outputTokens;
        const tokens = fresh + u.cacheReadTokens;
        const cost = costForUsage(model, {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadTokens,
          cacheCreation5m: u.cacheCreation5mTokens,
          cacheCreation1h: u.cacheCreation1hTokens,
        });
        d.tokens += tokens;
        d.cost += cost;
        d.fresh += fresh;
        d.cacheRead += u.cacheReadTokens;
        if (s.isHeadless) {
          d.headlessTokens += tokens;
          d.headlessCost += cost;
        }
        const p = d.byProject[s.project] ?? (d.byProject[s.project] = { projectPath: s.projectPath, tokens: 0, cost: 0 });
        p.tokens += tokens;
        p.cost += cost;
      }
    }
  }
  return days;
}

/**
 * Fetch the display sessions for `daysBack` AND keep the daily archive current.
 * The archive seals every past day from the warm cache (so burn history survives
 * CC's transcript cleanup) and returns the rollups inside the requested window.
 */
export async function getSessionsWithArchive(
  daysBack: number = 30
): Promise<{ sessions: Session[]; archiveDays: Record<string, DayRollup> }> {
  const sessions = await getSessions(daysBack); // also hydrates/refreshes the cache

  // Seal sealed (past) days from a fixed recent basis, independent of the toggle.
  const basis = dedupCacheWithin(ARCHIVE_BASIS_DAYS)
    .filter((t) => t.turnCount > 0)
    .map(toSession);
  const archive = await loadArchive();
  const today = utcDayKey(Date.now());
  for (const [day, roll] of Object.entries(dailyRollups(basis))) {
    if (day >= today) continue; // today is still accumulating — don't seal it
    archive.days[day] = roll; // overwrite with the complete recompute while files exist
  }
  // Prune history beyond the archive horizon.
  const retainKey = utcDayKey(Date.now() - ARCHIVE_RETAIN_DAYS * 24 * 60 * 60 * 1000);
  for (const day of Object.keys(archive.days)) if (day < retainKey) delete archive.days[day];
  await saveArchive(archive);

  // Return only the rollups within the requested window.
  const windowKey = utcDayKey(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const archiveDays: Record<string, DayRollup> = {};
  for (const [day, roll] of Object.entries(archive.days)) if (day >= windowKey) archiveDays[day] = roll;
  return { sessions, archiveDays };
}

export type SessionsSummary = {
  count: number;
  totalTokens: number;
  totalOutputTokens: number;
  totalInputPlusCache: number;
  totalCostUsd: number;
  cacheHitRatio: number;
  outputInputRatio: number;
  averageSessionTokens: number;
  medianSessionTokens: number;
  p95SessionTokens: number;
  // Fresh = input + cache-creation + output (the tokens a turn actually
  // generates); cacheRead = context re-fed from cache. The headline total is
  // ~90% cacheRead, which is why eval volume barely moves it.
  totalFreshTokens: number;
  totalCacheReadTokens: number;
  // Headless (`claude -p`) burn, split out from the cacheRead-dominated total.
  headlessCount: number;
  headlessTokens: number;
  headlessCostUsd: number;
  longSessions: Session[];
  dailyBurn: {
    date: string;
    tokens: number;
    cost: number;
    fresh: number;
    cacheRead: number;
    headlessTokens: number;
    headlessCost: number;
  }[];
  byProject: { project: string; projectPath: string; count: number; tokens: number; cost: number; turns: number }[];
  totalToolCalls: Record<string, number>;
  totalToolErrors: number;
  totalSidechainTurns: number;
  totalTurns: number;
};

const LONG_SESSION_THRESHOLD = 500_000;

export function summarizeSessions(
  sessions: Session[],
  archiveDays: Record<string, DayRollup> = {}
): SessionsSummary {
  if (sessions.length === 0 && Object.keys(archiveDays).length === 0) {
    return {
      count: 0,
      totalTokens: 0,
      totalOutputTokens: 0,
      totalInputPlusCache: 0,
      totalCostUsd: 0,
      cacheHitRatio: 0,
      outputInputRatio: 0,
      averageSessionTokens: 0,
      medianSessionTokens: 0,
      p95SessionTokens: 0,
      totalFreshTokens: 0,
      totalCacheReadTokens: 0,
      headlessCount: 0,
      headlessTokens: 0,
      headlessCostUsd: 0,
      longSessions: [],
      dailyBurn: [],
      byProject: [],
      totalToolCalls: {},
      totalToolErrors: 0,
      totalSidechainTurns: 0,
      totalTurns: 0,
    };
  }
  // Per-session distribution stats are scoped to retained (live) sessions — the
  // archive only carries daily token sums, not individual sessions.
  const sortedTokens = [...sessions].map((s) => s.totalTokens).sort((a, b) => a - b);
  const recentTotal = sortedTokens.reduce((a, b) => a + b, 0);
  const median = sortedTokens.length ? sortedTokens[Math.floor(sortedTokens.length / 2)] : 0;
  const p95 = sortedTokens.length
    ? sortedTokens[Math.min(sortedTokens.length - 1, Math.floor(sortedTokens.length * 0.95))]
    : 0;

  let inSum = 0, crSum = 0, ccSum = 0, outSum = 0;
  let headlessCount = 0;
  for (const s of sessions) {
    inSum += s.inputTokens;
    crSum += s.cacheReadTokens;
    ccSum += s.cacheCreationTokens;
    outSum += s.outputTokens;
    if (s.isHeadless) headlessCount += 1;
  }
  const inputPlusCache = inSum + crSum + ccSum;
  const cacheHitRatio = inputPlusCache > 0 ? crSum / inputPlusCache : 0;
  const outputInputRatio = inputPlusCache > 0 ? outSum / inputPlusCache : 0;

  const longSessions = sessions.filter((s) => s.totalTokens >= LONG_SESSION_THRESHOLD);

  // Daily burn spans the full window: live (retained) days override archive days
  // of the same date; archive fills the long tail CC has already cleaned up.
  // Tokens are bucketed by each record's own day, so resumed sessions spread
  // across their real days instead of collapsing onto the last.
  const liveDays = dailyRollups(sessions);
  const mergedDays: Record<string, DayRollup> = { ...archiveDays, ...liveDays };
  const dailyBurn = Object.entries(mergedDays)
    .map(([date, v]) => ({
      date,
      tokens: v.tokens,
      cost: v.cost,
      fresh: v.fresh,
      cacheRead: v.cacheRead,
      headlessTokens: v.headlessTokens,
      headlessCost: v.headlessCost,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Window totals come from the merged days so they reflect the full toggle
  // window, not just retained sessions.
  let total = 0, windowCost = 0, windowFresh = 0, windowCacheRead = 0;
  let windowHeadlessTokens = 0, windowHeadlessCost = 0;
  for (const d of dailyBurn) {
    total += d.tokens;
    windowCost += d.cost;
    windowFresh += d.fresh;
    windowCacheRead += d.cacheRead;
    windowHeadlessTokens += d.headlessTokens;
    windowHeadlessCost += d.headlessCost;
  }

  // By project — live sessions carry session/turn counts; archive days (older
  // than retention, no overlapping live date) add their token/cost totals.
  const projectMap = new Map<
    string,
    { project: string; projectPath: string; count: number; tokens: number; cost: number; turns: number }
  >();
  for (const s of sessions) {
    const cur = projectMap.get(s.project) ?? {
      project: s.project,
      projectPath: s.projectPath,
      count: 0,
      tokens: 0,
      cost: 0,
      turns: 0,
    };
    cur.count += 1;
    cur.tokens += s.totalTokens;
    cur.cost += s.costUsd;
    cur.turns += s.turnCount;
    projectMap.set(s.project, cur);
  }
  for (const [date, roll] of Object.entries(archiveDays)) {
    if (liveDays[date]) continue; // live already counts this date — avoid double-count
    for (const [project, p] of Object.entries(roll.byProject)) {
      const cur = projectMap.get(project) ?? {
        project,
        projectPath: p.projectPath,
        count: 0,
        tokens: 0,
        cost: 0,
        turns: 0,
      };
      cur.tokens += p.tokens;
      cur.cost += p.cost;
      projectMap.set(project, cur);
    }
  }
  const byProject = [...projectMap.values()].sort((a, b) => b.tokens - a.tokens);

  // Tool calls aggregate
  const totalToolCalls: Record<string, number> = {};
  let totalToolErrors = 0;
  let totalSidechainTurns = 0;
  let totalTurns = 0;
  for (const s of sessions) {
    for (const [name, n] of Object.entries(s.toolCalls)) {
      totalToolCalls[name] = (totalToolCalls[name] ?? 0) + n;
    }
    totalToolErrors += s.toolErrors;
    totalSidechainTurns += s.sidechainTurns;
    totalTurns += s.turnCount;
  }

  return {
    count: sessions.length,
    totalTokens: total,
    totalOutputTokens: outSum,
    totalInputPlusCache: inputPlusCache,
    totalCostUsd: windowCost,
    cacheHitRatio,
    outputInputRatio,
    averageSessionTokens: sessions.length ? Math.round(recentTotal / sessions.length) : 0,
    medianSessionTokens: median,
    p95SessionTokens: p95,
    totalFreshTokens: windowFresh,
    totalCacheReadTokens: windowCacheRead,
    headlessCount,
    headlessTokens: windowHeadlessTokens,
    headlessCostUsd: windowHeadlessCost,
    longSessions,
    dailyBurn,
    byProject,
    totalToolCalls,
    totalToolErrors,
    totalSidechainTurns,
    totalTurns,
  };
}

import { getAllTranscripts, type TranscriptResult, type ModelUsage } from "./transcripts";
import { costForUsage } from "./pricing";

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
  longSessions: Session[];
  dailyBurn: { date: string; tokens: number; cost: number }[];
  byProject: { project: string; projectPath: string; count: number; tokens: number; cost: number; turns: number }[];
  totalToolCalls: Record<string, number>;
  totalToolErrors: number;
  totalSidechainTurns: number;
  totalTurns: number;
};

const LONG_SESSION_THRESHOLD = 500_000;

export function summarizeSessions(sessions: Session[]): SessionsSummary {
  if (sessions.length === 0) {
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
      longSessions: [],
      dailyBurn: [],
      byProject: [],
      totalToolCalls: {},
      totalToolErrors: 0,
      totalSidechainTurns: 0,
      totalTurns: 0,
    };
  }
  const sortedTokens = [...sessions].map((s) => s.totalTokens).sort((a, b) => a - b);
  const total = sortedTokens.reduce((a, b) => a + b, 0);
  const median = sortedTokens[Math.floor(sortedTokens.length / 2)];
  const p95 = sortedTokens[Math.min(sortedTokens.length - 1, Math.floor(sortedTokens.length * 0.95))];

  let inSum = 0, crSum = 0, ccSum = 0, outSum = 0;
  for (const s of sessions) {
    inSum += s.inputTokens;
    crSum += s.cacheReadTokens;
    ccSum += s.cacheCreationTokens;
    outSum += s.outputTokens;
  }
  const inputPlusCache = inSum + crSum + ccSum;
  const cacheHitRatio = inputPlusCache > 0 ? crSum / inputPlusCache : 0;
  const outputInputRatio = inputPlusCache > 0 ? outSum / inputPlusCache : 0;

  const longSessions = sessions.filter((s) => s.totalTokens >= LONG_SESSION_THRESHOLD);

  // Bucket each token by the day it was actually spent (s.byDay is keyed by the
  // record's own timestamp), so a resumed session's history spreads across its
  // real days instead of collapsing onto its last day. Cost is summed per model
  // since rates differ.
  const byDay = new Map<string, { tokens: number; cost: number }>();
  for (const s of sessions) {
    for (const [day, models] of Object.entries(s.byDay)) {
      const cur = byDay.get(day) ?? { tokens: 0, cost: 0 };
      for (const [model, u] of Object.entries(models)) {
        cur.tokens +=
          u.inputTokens +
          u.cacheReadTokens +
          u.cacheCreation5mTokens +
          u.cacheCreation1hTokens +
          u.outputTokens;
        cur.cost += costForUsage(model, {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadTokens,
          cacheCreation5m: u.cacheCreation5mTokens,
          cacheCreation1h: u.cacheCreation1hTokens,
        });
      }
      byDay.set(day, cur);
    }
  }
  const dailyBurn = [...byDay.entries()]
    .map(([date, v]) => ({ date, tokens: v.tokens, cost: v.cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // By project
  const projectMap = new Map<
    string,
    { project: string; projectPath: string; count: number; tokens: number; cost: number; turns: number }
  >();
  let totalCostUsd = 0;
  for (const s of sessions) {
    totalCostUsd += s.costUsd;
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
    totalCostUsd,
    cacheHitRatio,
    outputInputRatio,
    averageSessionTokens: Math.round(total / sessions.length),
    medianSessionTokens: median,
    p95SessionTokens: p95,
    longSessions,
    dailyBurn,
    byProject,
    totalToolCalls,
    totalToolErrors,
    totalSidechainTurns,
    totalTurns,
  };
}

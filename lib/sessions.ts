import { getAllTranscripts, type TranscriptResult } from "./transcripts";

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
};

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
  cacheHitRatio: number;
  outputInputRatio: number;
  averageSessionTokens: number;
  medianSessionTokens: number;
  p95SessionTokens: number;
  longSessions: Session[];
  dailyBurn: { date: string; tokens: number }[];
};

const LONG_SESSION_THRESHOLD = 500_000;

export function summarizeSessions(sessions: Session[]): SessionsSummary {
  if (sessions.length === 0) {
    return {
      count: 0,
      totalTokens: 0,
      totalOutputTokens: 0,
      totalInputPlusCache: 0,
      cacheHitRatio: 0,
      outputInputRatio: 0,
      averageSessionTokens: 0,
      medianSessionTokens: 0,
      p95SessionTokens: 0,
      longSessions: [],
      dailyBurn: [],
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

  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const ts = s.endTime || s.startTime;
    if (!ts) continue;
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`;
    byDay.set(key, (byDay.get(key) ?? 0) + s.totalTokens);
  }
  const dailyBurn = [...byDay.entries()]
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    count: sessions.length,
    totalTokens: total,
    totalOutputTokens: outSum,
    totalInputPlusCache: inputPlusCache,
    cacheHitRatio,
    outputInputRatio,
    averageSessionTokens: Math.round(total / sessions.length),
    medianSessionTokens: median,
    p95SessionTokens: p95,
    longSessions,
    dailyBurn,
  };
}

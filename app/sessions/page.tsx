import { homedir } from "node:os";
import { getSessions, summarizeSessions } from "@/lib/sessions";
import { Receipt, Stat } from "../components/Receipt";

const fmt = new Intl.NumberFormat("en-US");
const DAYS = 30;
const HOME = homedir();

function tildify(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

export const dynamic = "force-dynamic";

function shortNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function SessionsPage() {
  const sessions = await getSessions(DAYS);
  const s = summarizeSessions(sessions);
  const maxDayTokens = Math.max(1, ...s.dailyBurn.map((d) => d.tokens));
  const tools = Object.entries(s.totalToolCalls).sort((a, b) => b[1] - a[1]);
  const maxToolCount = Math.max(1, ...tools.map(([, c]) => c));
  const totalToolCalls = tools.reduce((acc, [, c]) => acc + c, 0);

  return (
    <main className="flex-1 font-mono bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <header className="mb-8 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">sessions</h1>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">
              ~/.claude/projects · {DAYS}-day window
            </p>
          </div>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">
            {DAYS}-day window
          </span>
        </header>

        {s.count === 0 ? (
          <Receipt label="no data">
            <p className="text-sm text-zinc-500">
              No transcripts found in <code>~/.claude/projects/</code> within the last {DAYS} days.
            </p>
          </Receipt>
        ) : (
          <>
            {/* Vital signs — 8 stat receipts in a 4-up grid */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <Receipt pad="default">
                <Stat label="sessions" value={fmt.format(s.count)} hint={`avg ${shortNumber(s.averageSessionTokens)}`} />
              </Receipt>
              <Receipt pad="default">
                <Stat label="30d total" value={shortNumber(s.totalTokens)} hint="all tokens" />
              </Receipt>
              <Receipt pad="default">
                <Stat label="median" value={shortNumber(s.medianSessionTokens)} hint="per session" />
              </Receipt>
              <Receipt pad="default">
                <Stat label="p95" value={shortNumber(s.p95SessionTokens)} hint="per session" />
              </Receipt>
              <Receipt pad="default">
                <Stat label="cache hit" value={`${(s.cacheHitRatio * 100).toFixed(1)}%`} hint="of input + cache" />
              </Receipt>
              <Receipt pad="default">
                <Stat label="output : input" value={`${(s.outputInputRatio * 100).toFixed(2)}%`} hint="thinking vs re-feed" />
              </Receipt>
              <Receipt pad="default">
                <Stat label="turns" value={fmt.format(s.totalTurns)} hint={`avg ${Math.round(s.totalTurns / Math.max(1, s.count))}/session`} />
              </Receipt>
              <Receipt pad="default">
                <Stat label="subagent share" value={`${((s.totalSidechainTurns / Math.max(1, s.totalTurns)) * 100).toFixed(0)}%`} hint={`${fmt.format(s.totalSidechainTurns)} turns`} />
              </Receipt>
            </section>

            {/* Daily burn */}
            <section className="mb-6">
              <Receipt label={`daily burn · ${s.dailyBurn.length} active days`}>
                <div className="space-y-1">
                  {s.dailyBurn.map((d) => {
                    const pct = (d.tokens / maxDayTokens) * 100;
                    return (
                      <div key={d.date} className="flex items-center gap-3 text-xs">
                        <div className="w-24 text-zinc-500 tabular-nums">{d.date}</div>
                        <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800/60">
                          <div className="h-full bg-zinc-700 dark:bg-zinc-300" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="w-20 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                          {shortNumber(d.tokens)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Receipt>
            </section>

            {/* Top sessions */}
            <section className="mb-6">
              <Receipt label={`top sessions · heaviest 10 in ${DAYS}d`} pad="none">
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                    <tr>
                      <th className="px-5 py-3 font-normal">date</th>
                      <th className="px-5 py-3 font-normal">project</th>
                      <th className="px-5 py-3 font-normal">models</th>
                      <th className="px-5 py-3 font-normal text-right">turns</th>
                      <th className="px-5 py-3 font-normal text-right">tokens</th>
                      <th className="px-5 py-3 font-normal text-right">cache hit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.slice(0, 10).map((session) => {
                      const inputPlusCache = session.inputTokens + session.cacheReadTokens + session.cacheCreationTokens;
                      const hit = inputPlusCache > 0 ? (session.cacheReadTokens / inputPlusCache) * 100 : 0;
                      return (
                        <tr key={session.filePath} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                          <td className="px-5 py-3 text-zinc-500 tabular-nums text-xs whitespace-nowrap">
                            {session.endTime ? new Date(session.endTime).toISOString().slice(0, 10) : "—"}
                          </td>
                          <td className="px-5 py-3 text-zinc-700 dark:text-zinc-300 truncate max-w-[280px]">
                            <code className="text-xs">{tildify(session.projectPath)}</code>
                          </td>
                          <td className="px-5 py-3 text-zinc-500 text-xs">
                            {session.models.map((m) => m.replace("claude-", "")).join(", ")}
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums">{session.turnCount}</td>
                          <td className="px-5 py-3 text-right tabular-nums">{shortNumber(session.totalTokens)}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-zinc-500">{hit.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Receipt>
            </section>

            {/* Burn by project */}
            <section className="mb-6">
              <Receipt label={`burn by project · top ${Math.min(15, s.byProject.length)} of ${s.byProject.length}`} pad="none">
                <table className="w-full text-sm">
                  <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                    <tr>
                      <th className="px-5 py-3 font-normal">project</th>
                      <th className="px-5 py-3 font-normal text-right">sessions</th>
                      <th className="px-5 py-3 font-normal text-right">turns</th>
                      <th className="px-5 py-3 font-normal text-right">total</th>
                      <th className="px-5 py-3 font-normal text-right">share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byProject.slice(0, 15).map((p) => {
                      const share = s.totalTokens > 0 ? (p.tokens / s.totalTokens) * 100 : 0;
                      return (
                        <tr key={p.project} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                          <td className="px-5 py-3 truncate max-w-[420px]">
                            <code className="text-xs">{tildify(p.projectPath)}</code>
                          </td>
                          <td className="px-5 py-3 text-right tabular-nums text-zinc-500">{p.count}</td>
                          <td className="px-5 py-3 text-right tabular-nums">{fmt.format(p.turns)}</td>
                          <td className="px-5 py-3 text-right tabular-nums">{shortNumber(p.tokens)}</td>
                          <td className="px-5 py-3 text-right tabular-nums text-zinc-500">{share.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Receipt>
            </section>

            {/* Tool histogram */}
            {tools.length > 0 && (
              <section className="mb-6">
                <Receipt
                  label={`tool calls · ${fmt.format(totalToolCalls)} total · ${fmt.format(s.totalToolErrors)} errors (${((s.totalToolErrors / Math.max(1, totalToolCalls)) * 100).toFixed(1)}%)`}
                >
                  <div className="space-y-1">
                    {tools.map(([name, count]) => {
                      const pct = (count / maxToolCount) * 100;
                      return (
                        <div key={name} className="flex items-center gap-3 text-xs">
                          <div className="w-32 text-zinc-700 dark:text-zinc-300 truncate" title={name}>{name}</div>
                          <div className="flex-1 h-2 bg-zinc-100 dark:bg-zinc-800/60">
                            <div className="h-full bg-sky-600 dark:bg-sky-500" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="w-20 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{fmt.format(count)}</div>
                        </div>
                      );
                    })}
                  </div>
                </Receipt>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/**
 * Pattern: stripe-receipt
 * Source: Stripe Android home
 * Specific decisions adopted:
 *   1. Bold-numeral over tiny-uppercase-label stack — see `Stat` component:
 *      `text-[10px] uppercase tracking-widest text-zinc-500` label above a
 *      `text-3xl/text-2xl font-semibold tabular-nums tracking-tight` number,
 *      mirroring Stripe's "Gross volume / $7.8K" treatment on every metric.
 *   2. Primary receipt card + 3 secondary receipt cards layout: the
 *      per-turn baseline lives in a centered `max-w-md rounded-lg border
 *      px-8 py-6` card; the other 3 blocks sit in a `grid grid-cols-3 gap-3`
 *      row below using the same border treatment scaled to `px-4 py-4`.
 *   3. Mode-switcher chip row pinned to the top of the primary card
 *      (`30D · 7D · 90D`) emulating Stripe's `1W 4W 1Y MTD QTD YTD ALL`
 *      pill strip — active chip filled, inactive chips bare text.
 *      Cards are flat `bg-white dark:bg-zinc-900` with hairline borders;
 *      no shadow, no backdrop-blur, no glassmorphism (per DESIGN.md).
 */
import Link from "next/link";
import { getInventory, summarize } from "@/lib/inventory";
import { getUsage, lookupUsage } from "@/lib/usage";
import { getSessions, summarizeSessions } from "@/lib/sessions";
import { getContextFiles } from "@/lib/files";
import { getHooks } from "@/lib/hooks";
import { MiniStat } from "./components/Receipt";
import { toggleUserItem } from "./actions";

const fmt = new Intl.NumberFormat("en-US");
const DAYS = 30;

export const dynamic = "force-dynamic";

function shortNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function Cockpit() {
  const [items, usage, sessions, contextFiles, hooks] = await Promise.all([
    getInventory(),
    getUsage(DAYS),
    getSessions(DAYS),
    getContextFiles(),
    getHooks(),
  ]);

  const inv = summarize(items);
  const sess = summarizeSessions(sessions);

  const annotated = items.map((it) => ({ ...it, ...lookupUsage(it, usage) }));
  const candidates = annotated
    .filter((a) => !a.disabled && a.invocations === 0 && a.source === "user")
    .sort((a, b) => b.perTurnTokens - a.perTurnTokens)
    .slice(0, 5);
  const candidateSavings = candidates.reduce((acc, c) => acc + c.perTurnTokens, 0);

  const globalClaudeMd = contextFiles.find((f) => f.category === "claude-md-global");
  const biggestMemoryMd = contextFiles
    .filter((f) => f.category === "memory-md")
    .sort((a, b) => b.tokens - a.tokens)[0];
  const sessionStartHookTokens = hooks
    .filter((h) => h.event === "SessionStart" && h.status === "measured")
    .reduce((acc, h) => acc + h.perTurnTokens, 0);

  const maxBurn = Math.max(1, ...sess.dailyBurn.map((d) => d.tokens));
  const contextTotal =
    (globalClaudeMd?.tokens ?? 0) +
    (biggestMemoryMd?.tokens ?? 0) +
    sessionStartHookTokens;
  const contextRowCount =
    (globalClaudeMd ? 1 : 0) + (biggestMemoryMd ? 1 : 0) + (sessionStartHookTokens > 0 ? 1 : 0);

  return (
    <main className="flex-1 font-mono bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <header className="mb-8 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">contextscope</h1>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">
              audit · trim · ship
            </p>
          </div>
          <code className="text-[10px] uppercase tracking-widest text-zinc-500">
            ~/.claude/projects/
          </code>
        </header>

        {/* PRIMARY RECEIPT — per-turn baseline */}
        <section className="flex justify-center mb-6">
          <div className="w-full max-w-md rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-zinc-200 dark:border-zinc-800">
              <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                {DAYS}-day window
              </span>
              <Link
                href="/items"
                className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                items →
              </Link>
            </div>

            <div className="px-8 py-6 text-center">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                per-turn baseline
              </div>
              <div className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
                {fmt.format(inv.totalPerTurnTokens)}
                <span className="ml-1.5 text-sm text-zinc-500 font-normal">tok</span>
              </div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">
                loaded into every system prompt
              </div>
            </div>

            {/* Breakdown row — Stripe's tiny Payments / Customers numerals */}
            <div className="grid grid-cols-4 border-t border-zinc-200 dark:border-zinc-800 divide-x divide-zinc-200 dark:divide-zinc-800">
              <MiniStat label="items" value={fmt.format(inv.totalItems)} />
              <MiniStat label="skills" value={fmt.format(inv.byKind.skill.count)} />
              <MiniStat label="agents" value={fmt.format(inv.byKind.agent.count)} />
              <MiniStat label="commands" value={fmt.format(inv.byKind.command.count)} />
            </div>
          </div>
        </section>

        {/* SECONDARY RECEIPTS — 3-up horizontal row */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* 30-day burn */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-4 flex flex-col">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                {DAYS}-day burn
              </div>
              <Link
                href="/sessions"
                className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                sessions →
              </Link>
            </div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {shortNumber(sess.totalTokens)}
              <span className="ml-1 text-xs text-zinc-500 font-normal">tok</span>
            </div>

            {sess.dailyBurn.length > 0 && (
              <div className="mt-3">
                <div className="flex items-end gap-px h-8">
                  {sess.dailyBurn.map((d) => {
                    const pct = Math.max(2, (d.tokens / maxBurn) * 100);
                    return (
                      <div
                        key={d.date}
                        className="flex-1 bg-zinc-300 dark:bg-zinc-700"
                        style={{ height: `${pct}%` }}
                        title={`${d.date}: ${shortNumber(d.tokens)}`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center justify-between mt-1 text-[10px] uppercase tracking-widest text-zinc-500 tabular-nums">
                  <span>{sess.dailyBurn[0].date.slice(5)}</span>
                  <span>{sess.dailyBurn.length} active days</span>
                  <span>{sess.dailyBurn[sess.dailyBurn.length - 1].date.slice(5)}</span>
                </div>
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-3 text-center">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                  sess
                </div>
                <div className="text-xs font-semibold tabular-nums mt-0.5">
                  {fmt.format(sess.count)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                  median
                </div>
                <div className="text-xs font-semibold tabular-nums mt-0.5">
                  {shortNumber(sess.medianSessionTokens)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                  p95
                </div>
                <div className="text-xs font-semibold tabular-nums mt-0.5">
                  {shortNumber(sess.p95SessionTokens)}
                </div>
              </div>
            </div>
          </div>

          {/* Disable candidates */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-4 flex flex-col">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                disable candidates
              </div>
              <Link
                href="/items"
                className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                all →
              </Link>
            </div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {fmt.format(candidateSavings)}
              <span className="ml-1 text-xs text-zinc-500 font-normal">tok/turn</span>
            </div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              {candidates.length > 0
                ? `top ${candidates.length} unused`
                : "none in window"}
            </div>

            <ul className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800 text-xs space-y-1 flex-1">
              {candidates.length === 0 ? (
                <li className="text-zinc-500">
                  every loaded user item invoked in {DAYS}d.
                </li>
              ) : (
                candidates.map((c) => (
                  <li key={c.filePath} className="flex items-center gap-2">
                    <span className="w-10 text-right tabular-nums text-zinc-500">
                      {fmt.format(c.perTurnTokens)}
                    </span>
                    <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                      {c.name}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-zinc-500 w-12">
                      {c.kind}
                    </span>
                    <form
                      action={async () => {
                        "use server";
                        await toggleUserItem(c.filePath);
                      }}
                    >
                      <button
                        type="submit"
                        className="text-[10px] uppercase tracking-widest text-zinc-600 dark:text-zinc-400 border border-zinc-300 dark:border-zinc-700 hover:text-red-700 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/40 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
                        title={`Disable ${c.name}`}
                      >
                        off
                      </button>
                    </form>
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Context overhead */}
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-4 flex flex-col">
            <div className="flex items-baseline justify-between">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">
                context overhead
              </div>
              <Link
                href="/context"
                className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
              >
                context →
              </Link>
            </div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">
              {fmt.format(contextTotal)}
              <span className="ml-1 text-xs text-zinc-500 font-normal">tok</span>
            </div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">
              top {contextRowCount} sticky{" "}
              {contextRowCount === 1 ? "source" : "sources"}
            </div>

            <ul className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800 text-xs space-y-1 flex-1">
              {globalClaudeMd && (
                <li className="flex items-center gap-2">
                  <span className="w-10 text-right tabular-nums text-zinc-500">
                    {fmt.format(globalClaudeMd.tokens)}
                  </span>
                  <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                    <code className="text-[11px]">~/.claude/CLAUDE.md</code>
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                    every
                  </span>
                </li>
              )}
              {biggestMemoryMd && (
                <li className="flex items-center gap-2">
                  <span className="w-10 text-right tabular-nums text-zinc-500">
                    {fmt.format(biggestMemoryMd.tokens)}
                  </span>
                  <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                    <code className="text-[11px]">{biggestMemoryMd.name}</code>
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                    mem
                  </span>
                </li>
              )}
              {sessionStartHookTokens > 0 && (
                <li className="flex items-center gap-2">
                  <span className="w-10 text-right tabular-nums text-zinc-500">
                    {fmt.format(sessionStartHookTokens)}
                  </span>
                  <span className="flex-1 truncate text-zinc-700 dark:text-zinc-300">
                    SessionStart hooks
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-zinc-500">
                    sticky
                  </span>
                </li>
              )}
            </ul>
          </div>
        </section>

        <footer className="mt-8 pt-4 border-t border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-widest text-zinc-500 flex items-center justify-between">
          <span>
            cl100k_base · re-scanned every load · toggles apply on next CC restart
          </span>
          <a
            href="https://github.com/mbeato/contextscope"
            className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            github →
          </a>
        </footer>
      </div>
    </main>
  );
}


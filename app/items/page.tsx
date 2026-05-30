import { getInventory, summarize } from "@/lib/inventory";
import { getUsage, lookupUsage } from "@/lib/usage";
import { getSessions } from "@/lib/sessions";
import { getHooks } from "@/lib/hooks";
import { getMcpServers } from "@/lib/mcp";
import { Receipt, Stat } from "../components/Receipt";
import { RangeToggle } from "../components/RangeToggle";
import { disableUserItems, togglePlugin, toggleUserItem } from "../actions";
import { parseDays } from "@/lib/range";

const fmt = new Intl.NumberFormat("en-US");

export const dynamic = "force-dynamic";

function daysAgo(epochMs: number): string {
  if (!epochMs) return "never";
  const d = Math.floor((Date.now() - epochMs) / (1000 * 60 * 60 * 24));
  if (d === 0) return "today";
  if (d === 1) return "1d";
  return `${d}d`;
}

function shortNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const DAYS = parseDays((await searchParams).days);
  const [items, usage, sessions, hooks, mcpServers] = await Promise.all([
    getInventory(),
    getUsage(DAYS),
    getSessions(DAYS),
    getHooks(),
    getMcpServers(),
  ]);
  const inv = summarize(items);

  const annotated = items.map((it) => ({ ...it, ...lookupUsage(it, usage) }));
  const sorted = [...annotated].sort((a, b) => {
    const aCand = !a.disabled && a.invocations === 0;
    const bCand = !b.disabled && b.invocations === 0;
    if (aCand !== bCand) return aCand ? -1 : 1;
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return b.invocations - a.invocations;
  });

  const userUnused = annotated.filter(
    (a) => !a.disabled && a.invocations === 0 && a.source === "user"
  );
  const userUnusedSavings = userUnused.reduce((acc, a) => acc + a.perTurnTokens, 0);

  // Other recommendations
  const sessionStartHookTokens = hooks
    .filter((h) => h.event === "SessionStart" && h.status === "measured")
    .reduce((acc, h) => acc + h.perTurnTokens, 0);
  const p75 = (() => {
    if (sessions.length === 0) return 0;
    const sorted = [...sessions].map((s) => s.totalTokens).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  })();
  const longSessionCount = sessions.filter((s) => s.totalTokens > p75).length;
  const directMcpCount = mcpServers.filter((m) => !m.isPtc).length;

  return (
    <main className="flex-1 font-mono bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <header className="mb-8 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">items</h1>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">
              skills · agents · commands
            </p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-2">
            <RangeToggle />
            <code className="text-[10px] uppercase tracking-widest text-zinc-500">
              {inv.totalItems} loaded · {fmt.format(inv.totalPerTurnTokens)} tok/turn
            </code>
          </div>
        </header>

        <p className="mb-6 text-[10px] uppercase tracking-widest text-zinc-500">
          toggles apply on next Claude Code restart · plugin toggles snapshot{" "}
          <code className="normal-case tracking-normal">settings.json</code> to{" "}
          <code className="normal-case tracking-normal">
            ~/.claude/settings.json.usage-bak-&lt;ts&gt;
          </code>{" "}
          (5 most recent kept)
        </p>

        {/* Vital signs row */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Receipt pad="default">
            <Stat label="total items" value={fmt.format(inv.totalItems)} hint={`${fmt.format(inv.totalPerTurnTokens)} tok/turn`} />
          </Receipt>
          <Receipt pad="default">
            <Stat label="skills" value={fmt.format(inv.byKind.skill.count)} hint={`${fmt.format(inv.byKind.skill.perTurnTokens)} tok/turn`} />
          </Receipt>
          <Receipt pad="default">
            <Stat label="agents" value={fmt.format(inv.byKind.agent.count)} hint={`${fmt.format(inv.byKind.agent.perTurnTokens)} tok/turn`} />
          </Receipt>
          <Receipt pad="default">
            <Stat label="commands" value={fmt.format(inv.byKind.command.count)} hint={`${fmt.format(inv.byKind.command.perTurnTokens)} tok/turn`} />
          </Receipt>
        </section>

        {/* Recommendations — bulk action + cross-signal nudges */}
        <section className="mb-6 space-y-3">
          {userUnused.length > 0 && (
            <Receipt
              label={`recommendation · ${userUnused.length} unused`}
              pad="default"
              className="border-amber-300 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/10"
            >
              <div className="flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-[280px]">
                  <div className="text-sm text-zinc-700 dark:text-zinc-300">
                    <span className="text-2xl font-semibold tabular-nums tracking-tight mr-2">
                      {userUnused.length}
                    </span>
                    user items have not been invoked in the last {DAYS} days.
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">
                    Disable all to remove{" "}
                    <span className="tabular-nums font-semibold text-zinc-700 dark:text-zinc-300">
                      {fmt.format(userUnusedSavings)}
                    </span>{" "}
                    tok/turn. Reversible (renames file with{" "}
                    <code>.disabled</code> suffix).
                  </div>
                </div>
                <form
                  action={async () => {
                    "use server";
                    await disableUserItems(userUnused.map((u) => u.filePath));
                  }}
                >
                  <button
                    type="submit"
                    className="text-[10px] uppercase tracking-widest rounded-full px-3 py-1.5 bg-amber-200 dark:bg-amber-900 text-amber-900 dark:text-amber-100 hover:bg-amber-300 dark:hover:bg-amber-800 transition-colors cursor-pointer"
                  >
                    disable all {userUnused.length} →
                  </button>
                </form>
              </div>
            </Receipt>
          )}

          {sessionStartHookTokens > 0 && (
            <Receipt label="recommendation · sticky hook overhead" pad="default" className="border-zinc-200 dark:border-zinc-800">
              <div className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="text-2xl font-semibold tabular-nums tracking-tight mr-2">
                  {fmt.format(sessionStartHookTokens)}
                </span>
                tokens injected by SessionStart hooks every session.
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                Sticky until restart — that overhead compounds across every turn in the session. If
                you don&apos;t rely on the injected content, edit{" "}
                <code>hooks.SessionStart</code> in <code>~/.claude/settings.json</code>.
              </div>
            </Receipt>
          )}

          {longSessionCount > 0 && p75 > 0 && (
            <Receipt label="recommendation · long-session outliers" pad="default" className="border-zinc-200 dark:border-zinc-800">
              <div className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="text-2xl font-semibold tabular-nums tracking-tight mr-2">
                  {longSessionCount}
                </span>
                sessions exceeded your p75 ({shortNumber(p75)} tokens) in the last {DAYS} days.
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                Long sessions amplify every per-turn cost — even small baseline overhead becomes
                huge when re-fed 1000+ times. Use <code>/clear</code> between unrelated tasks.
              </div>
            </Receipt>
          )}

          {directMcpCount > 1 && (
            <Receipt label="recommendation · mcp consolidation" pad="default" className="border-zinc-200 dark:border-zinc-800">
              <div className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="text-2xl font-semibold tabular-nums tracking-tight mr-2">
                  {directMcpCount}
                </span>
                MCP servers registered directly.
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                Each direct server adds its tool descriptions to the deferred-tools list. Routing
                through PTC (Programmatic Tool Calling) replaces all of them with 3 generic tools.
              </div>
            </Receipt>
          )}
        </section>

        {/* By plugin */}
        <section className="mb-6">
          <Receipt label="by plugin" pad="none">
            {inv.byPlugin.length === 0 ? (
              <p className="px-5 py-4 text-sm text-zinc-500">
                No plugins detected in <code>~/.claude/plugins/cache/</code>.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-normal">plugin</th>
                    <th className="px-5 py-3 font-normal text-right">items</th>
                    <th className="px-5 py-3 font-normal text-right">per turn</th>
                    <th className="px-5 py-3 font-normal text-right">body</th>
                    <th className="px-5 py-3 font-normal text-center">enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.byPlugin.map((p) => {
                  const sample = items.find((it) => it.plugin === p.plugin);
                  const key = sample?.pluginKey;
                  // Source of truth = the inventory item's `disabled` field
                  // (computed in lib/inventory.ts from the same enabledPlugins
                  // map, treating missing-from-settings as disabled). Falling
                  // back to pluginStates would silently mis-render `on` for
                  // plugins on-disk-but-not-in-settings.json.
                  const enabled = sample ? !sample.disabled : false;
                  return (
                    <tr key={p.plugin} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3">{p.plugin}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-500">{p.count}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt.format(p.perTurnTokens)}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-zinc-500">{fmt.format(p.bodyTokens)}</td>
                      <td className="px-5 py-3 text-center">
                        {key ? (
                          <form
                            action={async () => {
                              "use server";
                              await togglePlugin(key);
                            }}
                          >
                            <ToggleButton enabled={enabled} />
                          </form>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                </tbody>
              </table>
            )}
          </Receipt>
        </section>

        {/* All items */}
        <section className="mb-6">
          <Receipt label={`all items · ${sorted.length} total`} pad="none">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th className="px-5 py-3 font-normal">name</th>
                  <th className="px-5 py-3 font-normal">kind</th>
                  <th className="px-5 py-3 font-normal">source</th>
                  <th className="px-5 py-3 font-normal">plugin</th>
                  <th className="px-5 py-3 font-normal text-right">per turn</th>
                  <th className="px-5 py-3 font-normal text-right">invokes</th>
                  <th className="px-5 py-3 font-normal text-right">last</th>
                  <th className="px-5 py-3 font-normal text-center">enabled</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((it) => {
                  const candidate = !it.disabled && it.invocations === 0;
                  const rowTint = it.disabled
                    ? "opacity-50"
                    : candidate
                      ? "bg-red-50/40 dark:bg-red-950/20 hover:bg-red-50/60 dark:hover:bg-red-950/30"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-950/40";
                  return (
                    <tr
                      key={it.filePath}
                      className={`border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 transition-colors ${rowTint}`}
                      title={it.description}
                    >
                      <td className="px-5 py-3">
                        <span className={candidate ? "text-red-700 dark:text-red-400" : ""}>{it.name}</span>
                      </td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{it.kind}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{it.source}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs truncate max-w-[160px]">{it.plugin ?? "—"}</td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {it.disabled ? <span className="text-zinc-400">—</span> : fmt.format(it.perTurnTokens)}
                      </td>
                      <td className={`px-5 py-3 text-right tabular-nums ${candidate ? "text-red-700 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"}`}>
                        {it.invocations}
                      </td>
                      <td className="px-5 py-3 text-right text-zinc-500 tabular-nums text-xs">{daysAgo(it.lastUsed)}</td>
                      <td className="px-5 py-3 text-center">
                        {it.source === "user" ? (
                          <form
                            action={async () => {
                              "use server";
                              await toggleUserItem(it.filePath);
                            }}
                          >
                            <ToggleButton enabled={!it.disabled} />
                          </form>
                        ) : (
                          <span
                            className="text-[10px] uppercase tracking-widest text-zinc-400"
                            title="Plugin items can only be toggled at the plugin level"
                          >
                            plugin
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Receipt>
        </section>
      </div>
    </main>
  );
}

function ToggleButton({ enabled }: { enabled: boolean }) {
  return (
    <button
      type="submit"
      className={`text-[10px] uppercase tracking-widest rounded-full px-2.5 py-1 border transition-colors cursor-pointer ${
        enabled
          ? "text-emerald-700 dark:text-emerald-300 border-emerald-300/60 dark:border-emerald-800/60 bg-emerald-50/50 dark:bg-emerald-950/30 hover:bg-zinc-100 dark:hover:bg-zinc-900 hover:text-zinc-600 dark:hover:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-700"
          : "text-zinc-500 border-zinc-300 dark:border-zinc-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/30 hover:text-emerald-700 dark:hover:text-emerald-300 hover:border-emerald-300/60 dark:hover:border-emerald-800/60"
      }`}
      aria-pressed={enabled}
      title={enabled ? "Click to disable" : "Click to enable"}
    >
      {enabled ? "on" : "off"}
    </button>
  );
}

import { getInventory, getPluginStates, summarize } from "@/lib/inventory";
import { getUsage, lookupUsage } from "@/lib/usage";
import { getContextFiles } from "@/lib/files";
import { getMcpServers } from "@/lib/mcp";
import { getHooks } from "@/lib/hooks";
import { getSessions, summarizeSessions } from "@/lib/sessions";
import { disableUserItems, togglePlugin, toggleUserItem } from "./actions";

const fmt = new Intl.NumberFormat("en-US");
const DAYS = 30;

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

export default async function Home() {
  const [items, usage, pluginStates, contextFiles, mcpServers, hooks, sessions] = await Promise.all([
    getInventory(),
    getUsage(DAYS),
    getPluginStates(),
    getContextFiles(),
    getMcpServers(),
    getHooks(),
    getSessions(DAYS),
  ]);
  const inv = summarize(items);
  const sess = summarizeSessions(sessions);

  const annotated = items.map((it) => {
    const u = lookupUsage(it, usage);
    return { ...it, invocations: u.invocations, lastUsed: u.lastUsed };
  });

  const sortedItems = [...annotated].sort((a, b) => {
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

  const globalClaudeMd = contextFiles.find((f) => f.category === "claude-md-global");
  const projectClaudeMds = contextFiles.filter((f) => f.category === "claude-md-project");
  const memoryMds = contextFiles.filter((f) => f.category === "memory-md");

  const sessionStartHookTokens = hooks
    .filter((h) => h.event === "SessionStart" && h.status === "measured")
    .reduce((a, h) => a + h.perTurnTokens, 0);

  // For daily burn chart: pad missing days
  const dailyBurn = sess.dailyBurn;
  const maxDayTokens = Math.max(1, ...dailyBurn.map((d) => d.tokens));
  const p75SessionTokens = (() => {
    if (sessions.length === 0) return 0;
    const sorted = [...sessions].map((s) => s.totalTokens).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  })();
  const sessionsAboveP75 = sessions.filter((s) => s.totalTokens > p75SessionTokens);

  // Recommendations
  type Rec = { title: string; detail: string; cta?: { kind: "form"; label: string; filePaths: string[] } | { kind: "note"; label: string } };
  const recs: Rec[] = [];
  if (userUnused.length > 0) {
    recs.push({
      title: `${userUnused.length} user items haven't been invoked in ${DAYS} days`,
      detail: `Disabling them removes ${fmt.format(userUnusedSavings)} tokens from the per-turn baseline. Reversible — toggles rename the file with a .disabled suffix.`,
      cta: {
        kind: "form",
        label: `Disable all ${userUnused.length} unused user items`,
        filePaths: userUnused.map((u) => u.filePath),
      },
    });
  }
  if (sessionStartHookTokens > 0) {
    recs.push({
      title: `SessionStart hooks inject ${fmt.format(sessionStartHookTokens)} tokens per session`,
      detail: `That overhead sticks for the lifetime of every Claude Code session. If you don't rely on the content (often the superpowers using-superpowers skill content), disable the hook in ~/.claude/settings.json.`,
      cta: { kind: "note", label: "Manual: edit settings.json hooks.SessionStart" },
    });
  }
  if (sessions.length > 0 && p75SessionTokens > 0) {
    recs.push({
      title: `${sessionsAboveP75.length} sessions exceeded your p75 (${shortNumber(p75SessionTokens)} tokens)`,
      detail: `Long sessions amplify every per-turn cost — even small baseline overhead becomes huge when re-fed 1000+ times. Use /clear between unrelated tasks.`,
    });
  }
  if (mcpServers.length > 0 && !mcpServers.some((m) => m.isPtc)) {
    recs.push({
      title: `Consider consolidating MCP servers behind PTC`,
      detail: `Each direct MCP server adds its tool descriptions to the deferred-tools list. Routing through Programmatic Tool Calling (PTC) replaces all of them with 3 generic tools and saves baseline tokens.`,
    });
  }

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-mono">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight mb-2">usage</h1>
          <p className="text-zinc-500 text-sm max-w-3xl">
            Comprehensive Claude Code context + session audit. Skills · agents · commands ·
            CLAUDE.md · MEMORY.md · SessionStart hook output · UserPromptSubmit hook output · MCP ·
            session-level analytics over <code>~/.claude/projects/*/*.jsonl</code>.
          </p>
        </header>

        <div className="mb-8 rounded-md border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <strong>Heads up:</strong> Toggles take effect on the next Claude Code restart. CC reads
          skills, agents, commands, and <code>settings.json</code> on startup. A backup of{" "}
          <code>settings.json</code> is written before each plugin toggle.
        </div>

        {/* ---------------- Recommendations ---------------- */}
        {recs.length > 0 && (
          <section className="mb-10">
            <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">Recommendations</h2>
            <div className="space-y-3">
              {recs.map((r, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-amber-300 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/10 px-4 py-3"
                >
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.title}</div>
                  <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">{r.detail}</div>
                  {r.cta?.kind === "form" && (
                    <form
                      action={async () => {
                        "use server";
                        await disableUserItems(r.cta!.kind === "form" ? r.cta!.filePaths : []);
                      }}
                      className="mt-3"
                    >
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1.5 rounded-full bg-amber-200 hover:bg-amber-300 dark:bg-amber-900 dark:hover:bg-amber-800 text-amber-900 dark:text-amber-100 px-3 py-1 text-xs font-medium"
                      >
                        {r.cta.label}
                      </button>
                    </form>
                  )}
                  {r.cta?.kind === "note" && (
                    <div className="text-xs text-zinc-500 mt-2">{r.cta.label}</div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---------------- Summary cards ---------------- */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          <Stat
            label="Per-turn baseline"
            value={fmt.format(inv.totalPerTurnTokens)}
            hint={`${inv.totalItems} items (skills + agents + commands)`}
          />
          <Stat
            label="Global CLAUDE.md"
            value={fmt.format(globalClaudeMd?.tokens ?? 0)}
            hint="loaded every session"
          />
          <Stat
            label="SessionStart hooks"
            value={fmt.format(sessionStartHookTokens)}
            hint="injected each session, sticky"
          />
          <Stat
            label={`${DAYS}d burn`}
            value={shortNumber(sess.totalTokens)}
            hint={`${sess.count} sessions, avg ${shortNumber(sess.averageSessionTokens)}`}
          />
        </section>

        {/* ---------------- Sessions ---------------- */}
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
            Sessions ({DAYS} days)
          </h2>
          {sess.count === 0 ? (
            <p className="text-sm text-zinc-500">
              No transcripts found in <code>~/.claude/projects/</code> within the last {DAYS} days.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <Stat label="Median" value={shortNumber(sess.medianSessionTokens)} hint="per session" />
                <Stat label="p95" value={shortNumber(sess.p95SessionTokens)} hint="per session" />
                <Stat
                  label="Cache hit"
                  value={`${(sess.cacheHitRatio * 100).toFixed(1)}%`}
                  hint="of input+cache"
                />
                <Stat
                  label="Output : input"
                  value={`${(sess.outputInputRatio * 100).toFixed(2)}%`}
                  hint="thinking vs re-feed"
                />
              </div>

              {/* Daily burn — text-based horizontal bars */}
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden mb-6">
                <div className="px-4 py-2 bg-zinc-100 dark:bg-zinc-900 text-xs uppercase tracking-wider text-zinc-500">
                  Daily burn ({dailyBurn.length} active days)
                </div>
                <div className="px-4 py-3 space-y-1">
                  {dailyBurn.map((d) => {
                    const pct = (d.tokens / maxDayTokens) * 100;
                    return (
                      <div key={d.date} className="flex items-center gap-3 text-xs">
                        <div className="w-24 text-zinc-500 tabular-nums">{d.date}</div>
                        <div className="flex-1 bg-zinc-200 dark:bg-zinc-800 rounded h-3 overflow-hidden">
                          <div
                            className="h-full bg-emerald-500 dark:bg-emerald-600"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="w-20 text-right tabular-nums text-zinc-700 dark:text-zinc-300">
                          {shortNumber(d.tokens)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Top sessions */}
              <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
                Top 10 most expensive sessions
              </h3>
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Date</th>
                      <th className="px-4 py-2 font-medium">Project</th>
                      <th className="px-4 py-2 font-medium">Models</th>
                      <th className="px-4 py-2 font-medium text-right">Turns</th>
                      <th className="px-4 py-2 font-medium text-right">Total</th>
                      <th className="px-4 py-2 font-medium text-right">Cache hit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.slice(0, 10).map((s) => {
                      const inputPlusCache =
                        s.inputTokens + s.cacheReadTokens + s.cacheCreationTokens;
                      const hit = inputPlusCache > 0 ? (s.cacheReadTokens / inputPlusCache) * 100 : 0;
                      return (
                        <tr key={s.filePath} className="border-t border-zinc-200 dark:border-zinc-800">
                          <td className="px-4 py-2 text-zinc-500 tabular-nums whitespace-nowrap">
                            {s.endTime ? new Date(s.endTime).toISOString().slice(0, 10) : "—"}
                          </td>
                          <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300 break-all">
                            <code className="text-xs">{s.projectPath}</code>
                          </td>
                          <td className="px-4 py-2 text-zinc-500 text-xs">
                            {s.models.map((m) => m.replace("claude-", "")).join(", ")}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{s.turnCount}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{shortNumber(s.totalTokens)}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
                            {hit.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Plugins ---------------- */}
        {inv.byPlugin.length > 0 && (
          <section className="mb-10">
            <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
              By plugin <span className="normal-case text-zinc-400">(toggle disables every item in the plugin)</span>
            </h2>
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Plugin</th>
                    <th className="px-4 py-2 font-medium text-right">Items</th>
                    <th className="px-4 py-2 font-medium text-right">Per turn</th>
                    <th className="px-4 py-2 font-medium text-right">Body</th>
                    <th className="px-4 py-2 font-medium text-center">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.byPlugin.map((p) => {
                    const sample = items.find((it) => it.plugin === p.plugin);
                    const key = sample?.pluginKey;
                    const enabled = pluginStates.find((ps) => ps.key === key)?.enabled ?? true;
                    return (
                      <tr key={p.plugin} className="border-t border-zinc-200 dark:border-zinc-800">
                        <td className="px-4 py-2">{p.plugin}</td>
                        <td className="px-4 py-2 text-right">{p.count}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {fmt.format(p.perTurnTokens)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
                          {fmt.format(p.bodyTokens)}
                        </td>
                        <td className="px-4 py-2 text-center">
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
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ---------------- All items ---------------- */}
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
            All skills / agents / commands
          </h2>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Plugin</th>
                  <th className="px-4 py-2 font-medium text-right">Per turn</th>
                  <th className="px-4 py-2 font-medium text-right">Invokes ({DAYS}d)</th>
                  <th className="px-4 py-2 font-medium text-right">Last used</th>
                  <th className="px-4 py-2 font-medium text-center">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((it) => {
                  const candidate = !it.disabled && it.invocations === 0;
                  const rowClass = it.disabled
                    ? "opacity-50"
                    : candidate
                      ? "bg-red-50/40 dark:bg-red-950/20"
                      : "";
                  return (
                    <tr
                      key={it.filePath}
                      className={`border-t border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 ${rowClass}`}
                      title={it.description}
                    >
                      <td className="px-4 py-2 font-medium">{it.name}</td>
                      <td className="px-4 py-2 text-zinc-500">{it.kind}</td>
                      <td className="px-4 py-2 text-zinc-500">{it.source}</td>
                      <td className="px-4 py-2 text-zinc-500">{it.plugin ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {it.disabled ? "—" : fmt.format(it.perTurnTokens)}
                      </td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums ${
                          candidate ? "text-red-600 dark:text-red-400 font-semibold" : "text-zinc-700 dark:text-zinc-300"
                        }`}
                      >
                        {it.invocations}
                      </td>
                      <td className="px-4 py-2 text-right text-zinc-500 tabular-nums">
                        {daysAgo(it.lastUsed)}
                      </td>
                      <td className="px-4 py-2 text-center">
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
                            className="text-zinc-400"
                            title="Plugin items can only be toggled at the plugin level."
                          >
                            (plugin)
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---------------- Context files ---------------- */}
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
            CLAUDE.md + MEMORY.md
          </h2>
          {contextFiles.length === 0 ? (
            <p className="text-sm text-zinc-500">No CLAUDE.md or MEMORY.md files found.</p>
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Path</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">Loaded when</th>
                    <th className="px-4 py-2 font-medium text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {globalClaudeMd && <ContextFileRow f={globalClaudeMd} highlight />}
                  {projectClaudeMds.map((f) => (
                    <ContextFileRow key={f.filePath} f={f} />
                  ))}
                  {memoryMds.map((f) => (
                    <ContextFileRow key={f.filePath} f={f} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---------------- Hooks ---------------- */}
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">Hooks</h2>
          <p className="text-xs text-zinc-500 mb-3">
            SessionStart + UserPromptSubmit hooks are dry-run with sample input. PreToolUse /
            PostToolUse / Stop / PreCompact hooks have side effects and are listed without
            execution.
          </p>
          {hooks.length === 0 ? (
            <p className="text-sm text-zinc-500">No hooks configured.</p>
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Event</th>
                    <th className="px-4 py-2 font-medium">Command</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium text-right">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {hooks.map((h, i) => (
                    <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800 align-top" title={h.output ?? h.error ?? ""}>
                      <td className="px-4 py-2 font-medium whitespace-nowrap">
                        {h.event}
                        {h.matcher ? <span className="text-zinc-500"> @ {h.matcher}</span> : null}
                      </td>
                      <td className="px-4 py-2 text-zinc-500 break-all">
                        <code className="text-xs">{h.command}</code>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        <StatusBadge status={h.status} />
                        {h.error ? (
                          <div className="text-red-600 dark:text-red-400 mt-1">{h.error}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {h.status === "measured" ? fmt.format(h.perTurnTokens) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ---------------- MCP ---------------- */}
        <section className="mb-10">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">
            MCP servers ({mcpServers.length})
          </h2>
          {mcpServers.length === 0 ? (
            <p className="text-sm text-zinc-500">No MCP servers configured.</p>
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-100 dark:bg-zinc-900 text-left text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Transport</th>
                    <th className="px-4 py-2 font-medium">Target</th>
                    <th className="px-4 py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {mcpServers.map((m) => (
                    <tr key={m.name} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="px-4 py-2 font-medium">{m.name}</td>
                      <td className="px-4 py-2 text-zinc-500">{m.transport}</td>
                      <td className="px-4 py-2 text-zinc-500 break-all">
                        <code className="text-xs">{m.target}</code>
                      </td>
                      <td className="px-4 py-2 text-zinc-500 text-xs">
                        {m.isPtc && m.downstream
                          ? `PTC proxy — downstream: ${m.downstream.join(", ")}`
                          : "direct"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="mt-10 text-xs text-zinc-500 max-w-3xl space-y-2">
          <p>
            <strong>What this covers:</strong> skills, agents, slash commands (user + plugin),
            CLAUDE.md (global + per-project), MEMORY.md, hook output (dry-run for SessionStart +
            UserPromptSubmit), MCP server registrations, session analytics from JSONL.
          </p>
          <p>
            <strong>What it can&apos;t cover:</strong> the base Claude Code system prompt (in the
            binary), tool-call results that compound mid-session, the available-skills /
            available-agents wrapper blocks (added by the harness).
          </p>
          <p>
            <strong>Safety:</strong> a backup of <code>settings.json</code> is written to{" "}
            <code>~/.claude/settings.json.usage-bak-&lt;timestamp&gt;</code> before each plugin
            toggle (5 most recent kept).
          </p>
        </footer>
      </div>
    </main>
  );
}

function ContextFileRow({ f, highlight }: { f: { name: string; category: string; loadedWhen: string; tokens: number }; highlight?: boolean }) {
  return (
    <tr
      className={`border-t border-zinc-200 dark:border-zinc-800 ${
        highlight ? "bg-amber-50/40 dark:bg-amber-950/20" : ""
      }`}
    >
      <td className="px-4 py-2 font-medium break-all">
        <code className="text-xs">{f.name}</code>
      </td>
      <td className="px-4 py-2 text-zinc-500 whitespace-nowrap">{f.category}</td>
      <td className="px-4 py-2 text-zinc-500 text-xs">{f.loadedWhen}</td>
      <td className="px-4 py-2 text-right tabular-nums">{fmt.format(f.tokens)}</td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "measured"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      : status === "not-run-side-effects"
        ? "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400"
        : status === "timeout"
          ? "bg-amber-200 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
          : "bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wider ${color}`}>
      {status.replace(/-/g, " ")}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: string;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        danger
          ? "border-red-300 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20"
          : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
      }`}
    >
      <div className="text-xs text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${danger ? "text-red-700 dark:text-red-400" : ""}`}>
        {value}
      </div>
      {hint && <div className="text-xs text-zinc-400 mt-0.5">{hint}</div>}
    </div>
  );
}

function ToggleButton({ enabled }: { enabled: boolean }) {
  return (
    <button
      type="submit"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        enabled
          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900"
          : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
      }`}
      aria-pressed={enabled}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-emerald-500" : "bg-zinc-400"}`} />
      {enabled ? "on" : "off"}
    </button>
  );
}

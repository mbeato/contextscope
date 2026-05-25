import { homedir } from "node:os";
import { getContextFiles } from "@/lib/files";
import { getHooks } from "@/lib/hooks";
import { getMcpServers } from "@/lib/mcp";
import { getLatestSettingsBackup, getRecentChanges } from "@/lib/recent";
import { Receipt, Stat } from "../components/Receipt";

const HOME = homedir();

const fmt = new Intl.NumberFormat("en-US");

export const dynamic = "force-dynamic";

function daysAgo(epochMs: number): string {
  if (!epochMs) return "never";
  const d = Math.floor((Date.now() - epochMs) / (1000 * 60 * 60 * 24));
  if (d === 0) return "today";
  if (d === 1) return "1d";
  return `${d}d`;
}

export default async function ContextPage() {
  const [contextFiles, hooks, mcpServers, recentChanges, latestBackup] = await Promise.all([
    getContextFiles(),
    getHooks(),
    getMcpServers(),
    getRecentChanges(7),
    getLatestSettingsBackup(),
  ]);

  const globalClaudeMd = contextFiles.find((f) => f.category === "claude-md-global");
  const projectClaudeMds = contextFiles.filter((f) => f.category === "claude-md-project");
  const memoryMds = contextFiles.filter((f) => f.category === "memory-md");

  const sessionStartHookTokens = hooks
    .filter((h) => h.event === "SessionStart" && h.status === "measured")
    .reduce((acc, h) => acc + h.perTurnTokens, 0);
  const userPromptHookTokens = hooks
    .filter((h) => h.event === "UserPromptSubmit" && h.status === "measured")
    .reduce((acc, h) => acc + h.perTurnTokens, 0);

  return (
    <main className="flex-1 font-mono bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <header className="mb-8 flex items-baseline justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">context</h1>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1">
              files · hooks · mcp
            </p>
          </div>
          <code className="text-[10px] uppercase tracking-widest text-zinc-500">
            ~/.claude/
          </code>
        </header>

        {/* Top stats */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Receipt pad="default">
            <Stat
              label="global claude.md"
              value={fmt.format(globalClaudeMd?.tokens ?? 0)}
              hint="every session"
            />
          </Receipt>
          <Receipt pad="default">
            <Stat
              label="project files"
              value={fmt.format(projectClaudeMds.length)}
              hint={`${memoryMds.length} memory.md`}
            />
          </Receipt>
          <Receipt pad="default">
            <Stat
              label="sessionstart hooks"
              value={fmt.format(sessionStartHookTokens)}
              hint="sticky until restart"
            />
          </Receipt>
          <Receipt pad="default">
            <Stat
              label="userprompt hooks"
              value={fmt.format(userPromptHookTokens)}
              hint="per prompt (sample)"
            />
          </Receipt>
        </section>

        {/* Recent activity */}
        {(recentChanges.length > 0 || latestBackup) && (
          <section className="mb-6">
            <Receipt label="recent toggle activity · last 7 days" pad="none">
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-normal">item</th>
                    <th className="px-5 py-3 font-normal">kind</th>
                    <th className="px-5 py-3 font-normal">state</th>
                    <th className="px-5 py-3 font-normal text-right">changed</th>
                  </tr>
                </thead>
                <tbody>
                  {latestBackup && (
                    <tr className="border-b border-zinc-200/60 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3 truncate max-w-[480px]">
                        <code className="text-xs">
                          {latestBackup.path.replace(HOME, "~")}
                        </code>
                      </td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">backup</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">settings.json snapshot</td>
                      <td className="px-5 py-3 text-right text-zinc-500 tabular-nums text-xs">
                        {daysAgo(latestBackup.mtimeMs)}
                      </td>
                    </tr>
                  )}
                  {recentChanges.slice(0, 20).map((c) => (
                    <tr key={c.filePath} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3">{c.name}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{c.kind}</td>
                      <td className="px-5 py-3 text-xs">
                        <span
                          className={`uppercase tracking-widest ${
                            c.disabled ? "text-zinc-500" : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {c.disabled ? "disabled" : "enabled"}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right text-zinc-500 tabular-nums text-xs">
                        {daysAgo(c.mtimeMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Receipt>
          </section>
        )}

        {/* CLAUDE.md + MEMORY.md */}
        <section className="mb-6">
          <Receipt
            label={`claude.md + memory.md · ${contextFiles.length} files`}
            pad="none"
          >
            {contextFiles.length === 0 ? (
              <p className="px-5 py-4 text-sm text-zinc-500">No CLAUDE.md or MEMORY.md files found.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-normal">path</th>
                    <th className="px-5 py-3 font-normal">category</th>
                    <th className="px-5 py-3 font-normal">loaded when</th>
                    <th className="px-5 py-3 font-normal text-right">tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {globalClaudeMd && (
                    <tr className="border-b border-zinc-200/60 dark:border-zinc-800/60 bg-amber-50/40 dark:bg-amber-950/10 hover:bg-amber-50/60 dark:hover:bg-amber-950/20 transition-colors">
                      <td className="px-5 py-3">
                        <code className="text-xs">{globalClaudeMd.name}</code>
                      </td>
                      <td className="px-5 py-3 text-zinc-700 dark:text-zinc-300 text-xs whitespace-nowrap">{globalClaudeMd.category}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{globalClaudeMd.loadedWhen}</td>
                      <td className="px-5 py-3 text-right tabular-nums font-semibold">{fmt.format(globalClaudeMd.tokens)}</td>
                    </tr>
                  )}
                  {projectClaudeMds.map((f) => (
                    <tr key={f.filePath} className="border-b border-zinc-200/60 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3 truncate max-w-[400px]">
                        <code className="text-xs">{f.name}</code>
                      </td>
                      <td className="px-5 py-3 text-zinc-500 text-xs whitespace-nowrap">{f.category}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{f.loadedWhen}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt.format(f.tokens)}</td>
                    </tr>
                  ))}
                  {memoryMds.map((f) => (
                    <tr key={f.filePath} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3 truncate max-w-[400px]">
                        <code className="text-xs">{f.name}</code>
                      </td>
                      <td className="px-5 py-3 text-zinc-500 text-xs whitespace-nowrap">{f.category}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{f.loadedWhen}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{fmt.format(f.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Receipt>
        </section>

        {/* Hooks */}
        <section className="mb-6">
          <Receipt
            label={`hooks · ${hooks.length} configured`}
            pad="none"
          >
            {hooks.length === 0 ? (
              <p className="px-5 py-4 text-sm text-zinc-500">No hooks configured.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-normal">event</th>
                    <th className="px-5 py-3 font-normal">command</th>
                    <th className="px-5 py-3 font-normal">status</th>
                    <th className="px-5 py-3 font-normal text-right">tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {hooks.map((h, i) => (
                    <tr key={i} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors align-top" title={h.output ?? h.error ?? ""}>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {h.event}
                        {h.matcher ? <span className="text-zinc-500"> @ {h.matcher}</span> : null}
                      </td>
                      <td className="px-5 py-3 break-all">
                        <code className="text-xs text-zinc-500">{h.command}</code>
                      </td>
                      <td className="px-5 py-3 text-xs">
                        <StatusBadge status={h.status} />
                        {h.error ? (
                          <div className="text-red-600 dark:text-red-400 mt-1 text-xs">{h.error}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {h.status === "measured" ? fmt.format(h.perTurnTokens) : <span className="text-zinc-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Receipt>
        </section>

        {/* MCP */}
        <section className="mb-6">
          <Receipt label={`mcp servers · ${mcpServers.length}`} pad="none">
            {mcpServers.length === 0 ? (
              <p className="px-5 py-4 text-sm text-zinc-500">No MCP servers configured.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[10px] uppercase tracking-widest text-zinc-500 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-5 py-3 font-normal">name</th>
                    <th className="px-5 py-3 font-normal">transport</th>
                    <th className="px-5 py-3 font-normal">target</th>
                    <th className="px-5 py-3 font-normal">notes</th>
                  </tr>
                </thead>
                <tbody>
                  {mcpServers.map((m) => (
                    <tr key={m.name} className="border-b border-zinc-200/60 dark:border-zinc-800/60 last:border-b-0 hover:bg-zinc-50 dark:hover:bg-zinc-950/40 transition-colors">
                      <td className="px-5 py-3">{m.name}</td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">{m.transport}</td>
                      <td className="px-5 py-3 text-zinc-500 break-all">
                        <code className="text-xs">{m.target}</code>
                      </td>
                      <td className="px-5 py-3 text-zinc-500 text-xs">
                        {m.isPtc && m.downstream ? `PTC proxy → ${m.downstream.join(", ")}` : "direct"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Receipt>
        </section>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "measured"
      ? "text-emerald-600 dark:text-emerald-400"
      : status === "not-run-side-effects"
        ? "text-zinc-500"
        : status === "timeout"
          ? "text-amber-600 dark:text-amber-400"
          : "text-red-600 dark:text-red-400";
  return <span className={`uppercase tracking-widest text-[10px] ${color}`}>{status.replace(/-/g, " ")}</span>;
}

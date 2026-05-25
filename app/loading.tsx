export default function Loading() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-mono">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight mb-2">usage</h1>
          <p className="text-zinc-500 text-sm">
            scanning ~/.claude — first load reads inventory, transcripts, hooks…
          </p>
        </header>

        <div className="mb-8 h-12 rounded-md border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 animate-pulse" />

        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 animate-pulse"
            />
          ))}
        </section>

        {Array.from({ length: 3 }).map((_, i) => (
          <section key={i} className="mb-10">
            <div className="h-4 w-40 mb-3 bg-zinc-200 dark:bg-zinc-800 rounded animate-pulse" />
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              {Array.from({ length: 6 }).map((_, j) => (
                <div
                  key={j}
                  className="h-10 border-t border-zinc-200 dark:border-zinc-800 first:border-t-0 bg-white dark:bg-zinc-900 animate-pulse"
                />
              ))}
            </div>
          </section>
        ))}

        <p className="text-xs text-zinc-500 mt-6">
          Note: first load runs cold; subsequent loads are cached by file mtime and should be near
          instant. For fastest UX run <code>npm run build &amp;&amp; npm start</code> — dev mode
          adds ~17s of bundling overhead per request.
        </p>
      </div>
    </main>
  );
}

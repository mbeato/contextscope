#!/usr/bin/env node
/**
 * contextscope CLI
 *
 * Subcommands:
 *   (default)         print 30-day summary to stdout (fast, no browser)
 *   ui                spawn the dashboard server + open browser
 *   install-plugin    install the /usage slash command for Claude Code
 *   uninstall-plugin  remove the slash command
 *
 * Flags (ui cmd):
 *   --port <n>        pin a port (errors if taken)
 *   --no-open         skip auto-opening the browser
 *   --help            show this
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const STANDALONE_SERVER = join(PKG_ROOT, ".next", "standalone", "server.js");
const STANDALONE_STATIC = join(PKG_ROOT, ".next", "standalone", ".next", "static");
const REAL_STATIC = join(PKG_ROOT, ".next", "static");
const STANDALONE_PUBLIC = join(PKG_ROOT, ".next", "standalone", "public");
const REAL_PUBLIC = join(PKG_ROOT, "public");
const PLUGIN_COMMAND_SRC = join(PKG_ROOT, "plugin", "commands", "usage.md");
const CLAUDE_COMMAND_DST = join(homedir(), ".claude", "commands", "usage.md");

const args = process.argv.slice(2);
const subcommand = args[0] && !args[0].startsWith("-") ? args[0] : null;

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "contextscope — Claude Code per-turn context audit",
      "",
      "Usage:",
      "  contextscope                     print 30-day summary (fast, no browser)",
      "  contextscope ui                  launch the dashboard (toggles + sessions + by-project)",
      "  contextscope install-plugin      install the /usage slash command",
      "  contextscope uninstall-plugin    remove the /usage slash command",
      "",
      "Flags (ui cmd):",
      "  --port <n>     pin a port (default: find first free starting at 3939)",
      "  --no-open      do not open the browser automatically",
      "  --help         show this message",
      "",
    ].join("\n")
  );
  process.exit(0);
}

if (subcommand === "install-plugin") {
  if (!existsSync(PLUGIN_COMMAND_SRC)) {
    process.stderr.write(`error: slash command source not found at ${PLUGIN_COMMAND_SRC}\n`);
    process.exit(1);
  }
  await fs.mkdir(dirname(CLAUDE_COMMAND_DST), { recursive: true });
  await fs.copyFile(PLUGIN_COMMAND_SRC, CLAUDE_COMMAND_DST);
  process.stdout.write(`installed /usage at ${CLAUDE_COMMAND_DST}\n`);
  process.stdout.write(`restart Claude Code, then run /usage in any session.\n`);
  process.exit(0);
}

if (subcommand === "uninstall-plugin") {
  try {
    await fs.unlink(CLAUDE_COMMAND_DST);
    process.stdout.write(`removed ${CLAUDE_COMMAND_DST}\n`);
  } catch (e) {
    if (e && e.code === "ENOENT") process.stdout.write(`not installed (nothing to remove)\n`);
    else throw e;
  }
  process.exit(0);
}

// Default: print summary. `ui` subcommand: launch dashboard.
if (subcommand !== "ui") {
  const { printSummary } = await import("./summary.js");
  try {
    await printSummary({ days: 30 });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  }
}

// ── UI mode below ──────────────────────────────────────────────────────────

const pinnedPortIdx = args.indexOf("--port");
const pinnedPort = pinnedPortIdx >= 0 ? Number(args[pinnedPortIdx + 1]) : null;
const noOpen = args.includes("--no-open");

if (!existsSync(STANDALONE_SERVER)) {
  process.stderr.write(
    `error: standalone server not found at ${STANDALONE_SERVER}\n` +
      `Run \`npm run build\` first (this should have happened automatically on install).\n`
  );
  process.exit(1);
}

// next standalone expects static assets co-located. When shipping via npm we
// copy ./next/static and ./public next to the bundled server; create symlinks
// at runtime if the published package didn't ship them.
async function ensureStaticAssets() {
  if (!existsSync(STANDALONE_STATIC) && existsSync(REAL_STATIC)) {
    try {
      await fs.symlink(REAL_STATIC, STANDALONE_STATIC, "dir");
    } catch {
      // ignore — may have been created by a parallel start
    }
  }
  if (!existsSync(STANDALONE_PUBLIC) && existsSync(REAL_PUBLIC)) {
    try {
      await fs.symlink(REAL_PUBLIC, STANDALONE_PUBLIC, "dir");
    } catch {
      // ignore
    }
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findPort() {
  if (pinnedPort != null) {
    const free = await isPortFree(pinnedPort);
    if (!free) {
      process.stderr.write(`error: --port ${pinnedPort} is in use\n`);
      process.exit(1);
    }
    return pinnedPort;
  }
  for (let p = 3939; p < 3939 + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  process.stderr.write("error: no free port found in 3939–3988\n");
  process.exit(1);
}

async function launchUi() {
  await ensureStaticAssets();
  const port = await findPort();
  const url = `http://localhost:${port}`;

  // IMPORTANT: HOSTNAME must override anything inherited from process.env.
  // Keep `...process.env` FIRST and `HOSTNAME: "127.0.0.1"` LAST so a stray
  // HOSTNAME=0.0.0.0 in the user's shell can't open the dashboard to the LAN.
  // Same for PORT.
  const child = fork(STANDALONE_SERVER, [], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });

  process.stdout.write(`contextscope running on ${url}\n`);

  // Wait for server to respond, warm the cache by hitting `/` (which triggers
  // the heavy transcript scans), then open the browser. Shifts the cold wait
  // from "blank skeleton in browser" to "scanning... in terminal" so the page
  // renders almost instantly when the browser opens.
  if (!noOpen) {
    const { default: open } = await import("open");
    (async () => {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`${url}/_not-found`, { method: "HEAD" });
          if (res.status < 500) {
            ready = true;
            break;
          }
        } catch {
          // not yet ready
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!ready) return;
      process.stdout.write(`  scanning ~/.claude/projects ...`);
      const start = Date.now();
      try {
        await fetch(url);
      } catch {
        // best-effort warm-up; open browser anyway
      }
      process.stdout.write(` ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
      await open(url).catch(() => {});
    })();
  }

  process.stdout.write(`  (Ctrl+C to stop)\n`);

  const shutdown = (code = 0) => {
    if (!child.killed) child.kill("SIGTERM");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  child.on("exit", (code) => process.exit(code ?? 0));
}

launchUi().catch((err) => {
  process.stderr.write(`fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});

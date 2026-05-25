#!/usr/bin/env node
/**
 * tokenscope CLI
 *
 * Subcommands:
 *   (default)         spawn the dashboard server + open browser
 *   install-plugin    install the /usage slash command for Claude Code
 *   uninstall-plugin  remove the slash command
 *
 * Flags (default cmd):
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
      "tokenscope — local dashboard for Claude Code per-turn context audit",
      "",
      "Usage:",
      "  tokenscope                     start the dashboard (default)",
      "  tokenscope install-plugin      install the /usage slash command",
      "  tokenscope uninstall-plugin    remove the /usage slash command",
      "",
      "Flags (default cmd):",
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

async function main() {
  await ensureStaticAssets();
  const port = await findPort();
  const url = `http://localhost:${port}`;

  const child = fork(STANDALONE_SERVER, [], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  });

  // Open browser once server is ready. We poll the port instead of waiting on
  // child stdout — more portable across Next versions.
  if (!noOpen) {
    const { default: open } = await import("open");
    const start = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - start > 10_000) {
        clearInterval(poll);
        return;
      }
      try {
        const ok = await fetch(url, { method: "HEAD" }).then((r) => r.status >= 200);
        if (ok) {
          clearInterval(poll);
          open(url).catch(() => {});
        }
      } catch {
        // not yet ready
      }
    }, 200);
  }

  process.stdout.write(`tokenscope running on ${url}\n  (Ctrl+C to stop)\n`);

  const shutdown = (code = 0) => {
    if (!child.killed) child.kill("SIGTERM");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});

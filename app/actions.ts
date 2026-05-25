"use server";

import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { revalidatePath } from "next/cache";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const MAX_BACKUPS = 5;

// Lexical resolve at module load. Allowed dirs themselves are NOT realpath'd
// here because the dirs may not exist on a fresh ~/.claude install; we realpath
// them lazily inside the check.
const ALLOWED_DIRS = [
  resolve(CLAUDE_DIR, "skills"),
  resolve(CLAUDE_DIR, "agents"),
  resolve(CLAUDE_DIR, "commands"),
];

async function realpathOrLexical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    // File doesn't exist yet (e.g. checking the .disabled sibling before rename).
    // Fall back to realpath'ing the deepest existing ancestor + joining the rest,
    // so a malicious "exists/<symlink>/../escape" can't slip through but a
    // legitimate not-yet-created sibling still resolves correctly.
    const parent = dirname(p);
    if (parent === p) return resolve(p);
    const realParent = await realpathOrLexical(parent);
    return join(realParent, p.slice(parent.length + 1));
  }
}

/**
 * Strict allowlist check. Follows symlinks via realpath() and confirms the
 * canonical absolute path lives under one of the allowed dirs. Defends against
 * both lexical traversal (`~/.claude/skills/../../.zshrc`) and symlink escape
 * (a `~/.claude/skills/foo` symlink pointing outside).
 */
async function safeUserPath(p: string): Promise<boolean> {
  if (typeof p !== "string" || p.length === 0) return false;
  const real = await realpathOrLexical(resolve(p));
  // Realpath the allowed-dir prefixes too — if the user has symlinked
  // ~/.claude/skills itself, both sides need to canonicalize the same way.
  for (const allowed of ALLOWED_DIRS) {
    let realAllowed: string;
    try {
      realAllowed = await realpath(allowed);
    } catch {
      realAllowed = allowed; // dir doesn't exist on this install — match lexically
    }
    if (real === realAllowed || real.startsWith(realAllowed + sep)) return true;
  }
  return false;
}

async function backupSettings(): Promise<void> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = join(CLAUDE_DIR, `settings.json.usage-bak-${stamp}`);
    await writeFile(bakPath, raw, "utf8");
    // Garbage-collect older backups beyond MAX_BACKUPS
    const entries = await readdir(CLAUDE_DIR, { withFileTypes: true });
    const baks = entries
      .filter((e) => e.isFile() && e.name.startsWith("settings.json.usage-bak-"))
      .map((e) => join(CLAUDE_DIR, e.name));
    if (baks.length > MAX_BACKUPS) {
      const withMtime = await Promise.all(
        baks.map(async (p) => ({ p, mt: (await stat(p)).mtimeMs }))
      );
      withMtime.sort((a, b) => a.mt - b.mt);
      const toDelete = withMtime.slice(0, withMtime.length - MAX_BACKUPS);
      const { unlink } = await import("node:fs/promises");
      await Promise.all(toDelete.map((x) => unlink(x.p)));
    }
  } catch {
    // best-effort: don't block the actual write if backup fails
  }
}

export async function toggleUserItem(filePath: string): Promise<void> {
  if (!(await safeUserPath(filePath))) {
    throw new Error(
      `Refusing to toggle file outside ~/.claude/skills, /agents, or /commands: ${filePath}`
    );
  }
  const newPath = filePath.endsWith(".disabled")
    ? filePath.slice(0, -".disabled".length)
    : `${filePath}.disabled`;
  await rename(filePath, newPath);
  // Invalidate every route below the root layout so toggles from /items,
  // /sessions, /context, and / all see fresh state on next navigation.
  revalidatePath("/", "layout");
}

export async function togglePlugin(pluginKey: string): Promise<void> {
  await backupSettings();
  const raw = await readFile(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const ep = (parsed.enabledPlugins ?? {}) as Record<string, boolean>;
  const current = ep[pluginKey] !== false;
  ep[pluginKey] = !current;
  parsed.enabledPlugins = ep;
  await writeFile(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  // Invalidate every route below the root layout so toggles from /items,
  // /sessions, /context, and / all see fresh state on next navigation.
  revalidatePath("/", "layout");
}

/**
 * Bulk-disable every user-level skill/agent/command file passed in. Plugin items
 * are not handled here — use togglePlugin for those.
 */
export async function disableUserItems(filePaths: string[]): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  for (const fp of filePaths) {
    if (!(await safeUserPath(fp))) {
      skipped++;
      continue;
    }
    if (fp.endsWith(".disabled")) {
      skipped++;
      continue;
    }
    try {
      await rename(fp, `${fp}.disabled`);
      moved++;
    } catch {
      skipped++;
    }
  }
  // Invalidate every route below the root layout so toggles from /items,
  // /sessions, /context, and / all see fresh state on next navigation.
  revalidatePath("/", "layout");
  return { moved, skipped };
}

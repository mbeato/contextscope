"use server";

import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { revalidatePath } from "next/cache";
import { exists } from "../lib/inventory";

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
 * Strict allowlist check. Returns the canonical real path if it lives under one
 * of the allowed dirs, else null. Returning the resolved path (not just a
 * boolean) lets callers operate on it directly — closing the TOCTOU window
 * where an attacker could swap a symlink between the check and the fs op.
 */
async function resolveSafeUserPath(p: string): Promise<string | null> {
  if (typeof p !== "string" || p.length === 0) return null;
  const real = await realpathOrLexical(resolve(p));
  for (const allowed of ALLOWED_DIRS) {
    let realAllowed: string;
    try {
      realAllowed = await realpath(allowed);
    } catch {
      realAllowed = allowed;
    }
    if (real === realAllowed || real.startsWith(realAllowed + sep)) return real;
  }
  return null;
}

async function backupSettings(): Promise<void> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = join(CLAUDE_DIR, `settings.json.usage-bak-${stamp}`);
    // 0o600 — settings.json may contain MCP tokens or hook commands with secrets;
    // backups must not be world-readable.
    await writeFile(bakPath, raw, { encoding: "utf8", mode: 0o600 });
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

// Plugin keys in ~/.claude/settings.json have the shape `<plugin>@<marketplace>`.
// Restrict to filename-safe chars to keep arbitrary user input out of settings.json.
const PLUGIN_KEY_RE = /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/;

async function atomicWriteJson(path: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data, { encoding: "utf8", mode });
  await rename(tmp, path);
}

type ItemState = "enabled" | "disabled";

/**
 * Move a user item to the requested on-disk state, idempotently. Resolves the
 * two possible siblings (foo / foo.disabled) from the validated real path and
 * renames only when disk differs from `target`.
 *
 * Intent-explicit: callers pass the state they WANT, not a blind flip. This is
 * what makes the action immune to a stale UI view — re-issuing "disable" on an
 * already-disabled item is a no-op, never an ENOENT crash or a wrong-direction
 * flip (which a suffix-decided toggle would do when the rendered state lagged
 * disk). Already-in-target and item-gone are both no-ops, not errors.
 *
 * Returns true if a rename actually happened. Throws only for a real fault:
 * outside the allowlist, or both siblings present (refusing to clobber).
 */
async function setUserItemState(filePath: string, target: ItemState): Promise<boolean> {
  const realSrc = await resolveSafeUserPath(filePath);
  if (!realSrc) {
    throw new Error(
      `Refusing to toggle file outside ~/.claude/skills, /agents, or /commands: ${filePath}`
    );
  }
  // Both siblings live in the same already-allowlisted directory; derive them
  // from the canonical real path rather than trusting the caller's suffix.
  const enabledPath = realSrc.endsWith(".disabled")
    ? realSrc.slice(0, -".disabled".length)
    : realSrc;
  const disabledPath = `${enabledPath}.disabled`;
  const src = target === "disabled" ? enabledPath : disabledPath;
  const dst = target === "disabled" ? disabledPath : enabledPath;

  // Already in the target state, or the item is gone entirely: nothing to do.
  if (!(await exists(src))) return false;

  // Both siblings present (anomalous — e.g. a crashed prior op). A bare rename
  // would silently overwrite `dst` via POSIX semantics and destroy its content,
  // so refuse and surface the inconsistency instead of losing data.
  if (await exists(dst)) {
    throw new Error(`Refusing to overwrite existing ${dst} — both siblings present on disk`);
  }

  try {
    await rename(src, dst);
    return true;
  } catch (err) {
    // Lost a check-then-rename race to a concurrent op that already moved it:
    // the desired end state is reached, so treat as a no-op rather than a 500.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

export async function setUserItem(filePath: string, target: ItemState): Promise<void> {
  await setUserItemState(filePath, target);
  revalidatePath("/", "layout");
}

export async function togglePlugin(pluginKey: string): Promise<void> {
  if (!PLUGIN_KEY_RE.test(pluginKey)) {
    throw new Error(`Refusing to toggle plugin with invalid key: ${pluginKey}`);
  }
  await backupSettings();
  const raw = await readFile(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const ep = (parsed.enabledPlugins ?? {}) as Record<string, boolean>;
  const current = ep[pluginKey] !== false;
  ep[pluginKey] = !current;
  parsed.enabledPlugins = ep;
  await atomicWriteJson(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n");
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
    try {
      // Same disk-reconciling, idempotent path as the single toggle: a stale
      // entry that's already disabled (or gone) is a no-op counted as skipped,
      // not a silent miss against a now-wrong suffix.
      if (await setUserItemState(fp, "disabled")) moved++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  revalidatePath("/", "layout");
  return { moved, skipped };
}

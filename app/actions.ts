"use server";

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { revalidatePath } from "next/cache";

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const MAX_BACKUPS = 5;

function safeUserPath(p: string): boolean {
  const skills = join(CLAUDE_DIR, "skills");
  const agents = join(CLAUDE_DIR, "agents");
  const commands = join(CLAUDE_DIR, "commands");
  return p.startsWith(skills + "/") || p.startsWith(agents + "/") || p.startsWith(commands + "/");
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
  if (!safeUserPath(filePath)) {
    throw new Error(
      `Refusing to toggle file outside ~/.claude/skills, /agents, or /commands: ${filePath}`
    );
  }
  const newPath = filePath.endsWith(".disabled")
    ? filePath.slice(0, -".disabled".length)
    : `${filePath}.disabled`;
  await rename(filePath, newPath);
  revalidatePath("/");
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
  revalidatePath("/");
}

/**
 * Bulk-disable every user-level skill/agent/command file passed in. Plugin items
 * are not handled here — use togglePlugin for those.
 */
export async function disableUserItems(filePaths: string[]): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  for (const fp of filePaths) {
    if (!safeUserPath(fp)) {
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
  revalidatePath("/");
  return { moved, skipped };
}

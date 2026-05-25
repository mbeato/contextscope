/**
 * Surface recent toggle activity — `.disabled` files in ~/.claude/{skills,agents,commands}
 * sorted by mtime, plus the most recent settings.json backup.
 *
 * Useful as a "what have I changed since my last Claude Code restart?" view.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_DIR = join(homedir(), ".claude");

export type RecentChange = {
  filePath: string;
  kind: "skill" | "agent" | "command";
  name: string;
  disabled: boolean;
  mtimeMs: number;
};

async function listDir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileMtime(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Files whose mtime is within the last 7 days. .disabled wins (since that's the toggle action). */
export async function getRecentChanges(daysBack: number = 7): Promise<RecentChange[]> {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const out: RecentChange[] = [];

  // Skills: ~/.claude/skills/<name>/SKILL.md{,.disabled}
  const skillsDir = join(CLAUDE_DIR, "skills");
  for (const e of await listDir(skillsDir)) {
    if (!e.isDirectory()) continue;
    const candidates = [
      { p: join(skillsDir, e.name, "SKILL.md"), disabled: false },
      { p: join(skillsDir, e.name, "SKILL.md.disabled"), disabled: true },
    ];
    for (const c of candidates) {
      const mt = await fileMtime(c.p);
      if (mt >= cutoff) out.push({ filePath: c.p, kind: "skill", name: e.name, disabled: c.disabled, mtimeMs: mt });
    }
  }

  // Agents: flat .md / .md.disabled files
  const agentsDir = join(CLAUDE_DIR, "agents");
  for (const e of await listDir(agentsDir)) {
    if (!e.isFile()) continue;
    let name: string;
    let disabled: boolean;
    if (e.name.endsWith(".md.disabled")) {
      name = e.name.replace(/\.md\.disabled$/, "");
      disabled = true;
    } else if (e.name.endsWith(".md")) {
      name = e.name.replace(/\.md$/, "");
      disabled = false;
    } else continue;
    const fp = join(agentsDir, e.name);
    const mt = await fileMtime(fp);
    if (mt >= cutoff) out.push({ filePath: fp, kind: "agent", name, disabled, mtimeMs: mt });
  }

  // Commands: may be nested. Walk one level deep.
  const commandsDir = join(CLAUDE_DIR, "commands");
  await walkCommands(commandsDir, "", cutoff, out);

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function walkCommands(dir: string, prefix: string, cutoff: number, out: RecentChange[]): Promise<void> {
  for (const e of await listDir(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const ns = prefix ? `${prefix}:${e.name}` : e.name;
      await walkCommands(p, ns, cutoff, out);
      continue;
    }
    if (!e.isFile()) continue;
    let bareName: string;
    let disabled: boolean;
    if (e.name.endsWith(".md.disabled")) {
      bareName = e.name.replace(/\.md\.disabled$/, "");
      disabled = true;
    } else if (e.name.endsWith(".md")) {
      bareName = e.name.replace(/\.md$/, "");
      disabled = false;
    } else continue;
    const mt = await fileMtime(p);
    if (mt >= cutoff) {
      const fullName = prefix ? `${prefix}:${bareName}` : bareName;
      out.push({ filePath: p, kind: "command", name: fullName, disabled, mtimeMs: mt });
    }
  }
}

/** Most recent settings.json backup, if any. */
export async function getLatestSettingsBackup(): Promise<{ path: string; mtimeMs: number } | null> {
  const entries = await listDir(CLAUDE_DIR);
  const baks = entries
    .filter((e) => e.isFile() && e.name.startsWith("settings.json.usage-bak-"))
    .map((e) => join(CLAUDE_DIR, e.name));
  if (baks.length === 0) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const p of baks) {
    const mt = await fileMtime(p);
    if (!best || mt > best.mtimeMs) best = { path: p, mtimeMs: mt };
  }
  return best;
}

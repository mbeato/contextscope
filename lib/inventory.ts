import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import matter from "gray-matter";

export type Source = "user" | "plugin";
export type Kind = "skill" | "agent" | "command";

export type InventoryItem = {
  name: string;
  kind: Kind;
  source: Source;
  plugin?: string;        // "marketplace/plugin-name" when source = "plugin"
  pluginKey?: string;     // "plugin-name@marketplace" form used in settings.json enabledPlugins
  description: string;
  perTurnTokens: number;  // tokenized "- name: description\n" — what loads every turn
  bodyTokens: number;     // tokenized body — loads only when the skill/agent is invoked
  filePath: string;
  disabled: boolean;      // user-item: filename has .disabled suffix; plugin-item: plugin off in settings
};

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const enc = getEncoding("cl100k_base");

async function readEnabledPlugins(): Promise<Record<string, boolean>> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const ep = parsed?.enabledPlugins;
    if (ep && typeof ep === "object") return ep as Record<string, boolean>;
  } catch {
    // missing or malformed — assume nothing enabled
  }
  return {};
}

function countTokens(s: string): number {
  return enc.encode(s).length;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function loadMarkdown(
  filePath: string,
  name: string
): Promise<{ description: string; perTurnTokens: number; bodyTokens: number }> {
  const raw = await readFile(filePath, "utf8");
  let description = "";
  let body = raw;
  try {
    const parsed = matter(raw);
    if (typeof parsed.data?.description === "string") description = parsed.data.description;
    body = parsed.content;
  } catch {
    // YAML parse failed — leave description empty, treat whole file as body
  }
  // Per-turn cost = the line that appears in the available-skills/agents list block.
  // Format approximates Claude Code's actual rendering: "- name: description\n".
  const perTurnLine = `- ${name}: ${description}\n`;
  return {
    description,
    perTurnTokens: countTokens(perTurnLine),
    bodyTokens: countTokens(body),
  };
}

async function scanUserSkills(): Promise<InventoryItem[]> {
  const dir = join(CLAUDE_DIR, "skills");
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: InventoryItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = join(dir, e.name);
    const enabledPath = join(skillDir, "SKILL.md");
    const disabledPath = join(skillDir, "SKILL.md.disabled");
    let filePath: string;
    let disabled: boolean;
    if (await exists(enabledPath)) {
      filePath = enabledPath;
      disabled = false;
    } else if (await exists(disabledPath)) {
      filePath = disabledPath;
      disabled = true;
    } else {
      continue;
    }
    const { description, perTurnTokens, bodyTokens } = await loadMarkdown(filePath, e.name);
    out.push({
      name: e.name,
      kind: "skill",
      source: "user",
      description,
      perTurnTokens: disabled ? 0 : perTurnTokens,
      bodyTokens,
      filePath,
      disabled,
    });
  }
  return out;
}

async function scanUserAgents(): Promise<InventoryItem[]> {
  const dir = join(CLAUDE_DIR, "agents");
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: InventoryItem[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    let name: string;
    let disabled: boolean;
    if (e.name.endsWith(".md.disabled")) {
      name = e.name.replace(/\.md\.disabled$/, "");
      disabled = true;
    } else if (e.name.endsWith(".md")) {
      name = e.name.replace(/\.md$/, "");
      disabled = false;
    } else {
      continue;
    }
    const filePath = join(dir, e.name);
    const { description, perTurnTokens, bodyTokens } = await loadMarkdown(filePath, name);
    out.push({
      name,
      kind: "agent",
      source: "user",
      description,
      perTurnTokens: disabled ? 0 : perTurnTokens,
      bodyTokens,
      filePath,
      disabled,
    });
  }
  return out;
}

async function scanUserCommands(): Promise<InventoryItem[]> {
  const dir = join(CLAUDE_DIR, "commands");
  if (!(await exists(dir))) return [];
  const out: InventoryItem[] = [];
  await walkCommandDir(dir, "", out, "user");
  return out;
}

async function walkCommandDir(
  dir: string,
  prefix: string,
  out: InventoryItem[],
  source: Source,
  plugin?: string,
  pluginKey?: string,
  pluginDisabled = false
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const ns = prefix ? `${prefix}:${e.name}` : e.name;
      await walkCommandDir(p, ns, out, source, plugin, pluginKey, pluginDisabled);
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
    } else {
      continue;
    }
    const fullName = prefix ? `${prefix}:${bareName}` : bareName;
    const effectiveDisabled = source === "plugin" ? pluginDisabled : disabled;
    const { description, perTurnTokens, bodyTokens } = await loadMarkdown(p, fullName);
    out.push({
      name: fullName,
      kind: "command",
      source,
      plugin,
      pluginKey,
      description,
      perTurnTokens: effectiveDisabled ? 0 : perTurnTokens,
      bodyTokens,
      filePath: p,
      disabled: effectiveDisabled,
    });
  }
}

async function scanPluginCache(enabledPlugins: Record<string, boolean>): Promise<InventoryItem[]> {
  const cacheDir = join(CLAUDE_DIR, "plugins", "cache");
  if (!(await exists(cacheDir))) return [];
  const out: InventoryItem[] = [];
  const marketplaces = await readdir(cacheDir, { withFileTypes: true });
  for (const m of marketplaces) {
    if (!m.isDirectory()) continue;
    const mDir = join(cacheDir, m.name);
    const plugins = await readdir(mDir, { withFileTypes: true });
    for (const p of plugins) {
      if (!p.isDirectory()) continue;
      const pDir = join(mDir, p.name);
      const versions = await readdir(pDir, { withFileTypes: true });
      for (const v of versions) {
        if (!v.isDirectory()) continue;
        const vDir = join(pDir, v.name);
        const pluginLabel = `${m.name}/${p.name}`;
        const pluginKey = `${p.name}@${m.name}`;
        const pluginDisabled = enabledPlugins[pluginKey] === false || !(pluginKey in enabledPlugins);

        // skills/<name>/SKILL.md
        const skillsDir = join(vDir, "skills");
        if (await exists(skillsDir)) {
          const skills = await readdir(skillsDir, { withFileTypes: true });
          for (const s of skills) {
            if (!s.isDirectory()) continue;
            const filePath = join(skillsDir, s.name, "SKILL.md");
            if (!(await exists(filePath))) continue;
            const { description, perTurnTokens, bodyTokens } = await loadMarkdown(filePath, s.name);
            out.push({
              name: s.name,
              kind: "skill",
              source: "plugin",
              plugin: pluginLabel,
              pluginKey,
              description,
              perTurnTokens: pluginDisabled ? 0 : perTurnTokens,
              bodyTokens,
              filePath,
              disabled: pluginDisabled,
            });
          }
        }

        // agents/<name>.md
        const agentsDir = join(vDir, "agents");
        if (await exists(agentsDir)) {
          const agents = await readdir(agentsDir, { withFileTypes: true });
          for (const a of agents) {
            if (!a.isFile() || !a.name.endsWith(".md")) continue;
            const filePath = join(agentsDir, a.name);
            const name = a.name.replace(/\.md$/, "");
            const { description, perTurnTokens, bodyTokens } = await loadMarkdown(filePath, name);
            out.push({
              name,
              kind: "agent",
              source: "plugin",
              plugin: pluginLabel,
              pluginKey,
              description,
              perTurnTokens: pluginDisabled ? 0 : perTurnTokens,
              bodyTokens,
              filePath,
              disabled: pluginDisabled,
            });
          }
        }

        // commands/<name>.md (plugin slash commands, may be nested)
        const commandsDir = join(vDir, "commands");
        if (await exists(commandsDir)) {
          await walkCommandDir(commandsDir, "", out, "plugin", pluginLabel, pluginKey, pluginDisabled);
        }
      }
    }
  }
  return out;
}

export async function getInventory(): Promise<InventoryItem[]> {
  const enabledPlugins = await readEnabledPlugins();
  const [us, ua, uc, plug] = await Promise.all([
    scanUserSkills(),
    scanUserAgents(),
    scanUserCommands(),
    scanPluginCache(enabledPlugins),
  ]);
  return [...us, ...ua, ...uc, ...plug].sort((a, b) => b.perTurnTokens - a.perTurnTokens);
}

/** Plugin enable state for the summary UI. */
export async function getPluginStates(): Promise<{ key: string; enabled: boolean }[]> {
  const ep = await readEnabledPlugins();
  return Object.entries(ep).map(([key, enabled]) => ({ key, enabled: enabled !== false }));
}

type Bucket = { count: number; perTurnTokens: number; bodyTokens: number };

export type InventorySummary = {
  totalItems: number;
  totalPerTurnTokens: number;
  totalBodyTokens: number;
  byKind: Record<Kind, Bucket>;
  bySource: Record<Source, Bucket>;
  byPlugin: ({ plugin: string } & Bucket)[];
};

export function summarize(items: InventoryItem[]): InventorySummary {
  const mk = (): Bucket => ({ count: 0, perTurnTokens: 0, bodyTokens: 0 });
  const byKind: InventorySummary["byKind"] = { skill: mk(), agent: mk(), command: mk() };
  const bySource: InventorySummary["bySource"] = { user: mk(), plugin: mk() };
  const pluginMap = new Map<string, Bucket>();
  let totalPerTurnTokens = 0;
  let totalBodyTokens = 0;
  for (const it of items) {
    totalPerTurnTokens += it.perTurnTokens;
    totalBodyTokens += it.bodyTokens;
    byKind[it.kind].count += 1;
    byKind[it.kind].perTurnTokens += it.perTurnTokens;
    byKind[it.kind].bodyTokens += it.bodyTokens;
    bySource[it.source].count += 1;
    bySource[it.source].perTurnTokens += it.perTurnTokens;
    bySource[it.source].bodyTokens += it.bodyTokens;
    if (it.plugin) {
      const cur = pluginMap.get(it.plugin) ?? mk();
      cur.count += 1;
      cur.perTurnTokens += it.perTurnTokens;
      cur.bodyTokens += it.bodyTokens;
      pluginMap.set(it.plugin, cur);
    }
  }
  const byPlugin = [...pluginMap.entries()]
    .map(([plugin, v]) => ({ plugin, ...v }))
    .sort((a, b) => b.perTurnTokens - a.perTurnTokens);
  return {
    totalItems: items.length,
    totalPerTurnTokens,
    totalBodyTokens,
    byKind,
    bySource,
    byPlugin,
  };
}

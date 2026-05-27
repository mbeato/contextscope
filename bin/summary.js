/**
 * Pure-JS CLI summary mode — fast first-impression printout.
 *
 * Mirrors lib/transcripts.ts + lib/inventory.ts + lib/files.ts + lib/pricing.ts
 * without any Next.js or React. Scans ~/.claude/projects + ~/.claude/skills/agents/commands,
 * tokenizes per-turn baseline, prints to stdout. Should complete in <8s on a
 * heavy user, <1s on a light one. Subsequent renders use no cache (it's a CLI).
 */
import { readdir, stat, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEncoding } from "js-tiktoken";
import matter from "gray-matter";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

const PRICES = JSON.parse(
  await readFile(join(HERE, "..", "lib", "model-prices.json"), "utf8")
).models;
const ALIASES = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

const enc = getEncoding("cl100k_base");

// ───── formatting ─────

function shortNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function formatUsd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n > 0) return `<$0.01`;
  return `$0`;
}

// Cheap ANSI helpers; only emit color when stdout is a TTY.
const isTTY = process.stdout.isTTY;
const ansi = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = ansi("2");
const bold = ansi("1");
const red = ansi("31");
const green = ansi("32");

// ───── pricing ─────

function resolveModel(model) {
  if (PRICES[model]) return PRICES[model];
  if (ALIASES[model] && PRICES[ALIASES[model]]) return PRICES[ALIASES[model]];
  const noSuffix = model.replace(/\[[^\]]+\]$/, "");
  if (PRICES[noSuffix]) return PRICES[noSuffix];
  const noDate = noSuffix.replace(/-\d{8}$/, "");
  if (PRICES[noDate]) return PRICES[noDate];
  return null;
}

function costForUsage(model, u) {
  const p = resolveModel(model);
  if (!p) return 0;
  return (
    u.i * p.input +
    u.o * p.output +
    u.cr * p.cache_read +
    u.cc5m * p.cache_creation_5m +
    u.cc1h * p.cache_creation_1h
  );
}

// ───── fs helpers ─────

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function tokenCountFromFile(p) {
  try {
    const raw = await readFile(p, "utf8");
    return enc.encode(raw).length;
  } catch {
    return 0;
  }
}

// ───── transcript scan ─────

async function collectJsonl(dir, cutoff, out, depth = 0) {
  if (depth > 3) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) {
      await collectJsonl(fp, cutoff, out, depth + 1);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(fp);
      if (st.mtimeMs >= cutoff) out.push({ fp, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
}

function parseLine(line) {
  if (!line || line[0] !== "{") return null;
  if (!line.includes('"usage"') && !line.includes('"tool_use"')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function pMapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function parseOne(fp) {
  // Returns per-file usage records (no global dedup yet) + invocation counts +
  // session key. Each record carries (dedupKey, model, tokens, ts).
  const records = [];
  const skillInv = [];
  const agentInv = [];
  await new Promise((res) => {
    const rl = createInterface({ input: createReadStream(fp), crlfDelay: Infinity });
    rl.on("line", (line) => {
      const r = parseLine(line);
      if (!r) return;
      const msg = r.message;
      const usage = msg?.usage;
      if (usage) {
        const msgId = typeof msg?.id === "string" ? msg.id : "";
        const reqId = typeof r.requestId === "string" ? r.requestId : "";
        const key = msgId ? `${msgId}:${reqId}` : "";
        const m = msg?.model || "<synthetic>";
        const ccTotal = Number(usage.cache_creation_input_tokens) || 0;
        const ccBd = usage.cache_creation;
        let cc5m = 0;
        let cc1h = 0;
        if (ccBd && typeof ccBd === "object") {
          cc5m = Number(ccBd.ephemeral_5m_input_tokens) || 0;
          cc1h = Number(ccBd.ephemeral_1h_input_tokens) || 0;
          const diff = ccTotal - (cc5m + cc1h);
          if (diff > 0) cc5m += diff;
        } else {
          cc5m = ccTotal;
        }
        records.push({
          dedupKey: key,
          model: m,
          i: Number(usage.input_tokens) || 0,
          cr: Number(usage.cache_read_input_tokens) || 0,
          cc5m,
          cc1h,
          o: Number(usage.output_tokens) || 0,
        });
      }
      if (Array.isArray(msg?.content)) {
        for (const c of msg.content) {
          if (!c || typeof c !== "object") continue;
          if (c.type === "tool_use") {
            const input = c.input || {};
            if (c.name === "Skill" && typeof input.skill === "string") {
              skillInv.push(input.skill);
            } else if (c.name === "Agent" && typeof input.subagent_type === "string") {
              agentInv.push(input.subagent_type);
            }
          }
        }
      }
    });
    rl.on("close", res);
    rl.on("error", res);
  });
  return { records, skillInv, agentInv };
}

async function processFiles(files) {
  // Parallel parse → sequential dedup. Sort oldest-first so the earliest
  // occurrence of a msg.id wins on dedup.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const parsed = await pMapLimit(files, 16, async ({ fp }) => {
    const parts = fp.split("/");
    const isSubagent = parts[parts.length - 2] === "subagents";
    const sessionId = isSubagent
      ? parts[parts.length - 3]
      : parts[parts.length - 1].replace(/\.jsonl$/, "");
    const project = isSubagent ? parts[parts.length - 4] : parts[parts.length - 2];
    const out = await parseOne(fp);
    return { sessionKey: `${project}\x00${sessionId}`, ...out };
  });

  const seen = new Set();
  const byModel = {};
  const skillInv = new Map();
  const agentInv = new Map();
  const sessions = new Set();

  for (const p of parsed) {
    sessions.add(p.sessionKey);
    for (const r of p.records) {
      if (r.dedupKey) {
        if (seen.has(r.dedupKey)) continue;
        seen.add(r.dedupKey);
      }
      const b = byModel[r.model] || { i: 0, cr: 0, cc5m: 0, cc1h: 0, o: 0 };
      b.i += r.i;
      b.cr += r.cr;
      b.cc5m += r.cc5m;
      b.cc1h += r.cc1h;
      b.o += r.o;
      byModel[r.model] = b;
    }
    for (const n of p.skillInv) skillInv.set(n, (skillInv.get(n) || 0) + 1);
    for (const n of p.agentInv) agentInv.set(n, (agentInv.get(n) || 0) + 1);
  }

  return { byModel, skillInv, agentInv, sessions };
}

// ───── inventory ─────

async function readEnabledPlugins() {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const ep = parsed?.enabledPlugins;
    if (ep && typeof ep === "object") return ep;
  } catch {
    // ignore
  }
  return {};
}

async function loadSkillDescription(filePath, name) {
  try {
    const raw = await readFile(filePath, "utf8");
    let description = "";
    try {
      const parsed = matter(raw);
      if (typeof parsed.data?.description === "string") description = parsed.data.description;
    } catch {
      // ignore
    }
    const perTurnLine = `- ${name}: ${description}\n`;
    return enc.encode(perTurnLine).length;
  } catch {
    return 0;
  }
}

async function scanInventory() {
  const items = [];

  // user skills
  const skillsDir = join(CLAUDE_DIR, "skills");
  if (await exists(skillsDir)) {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const enabledPath = join(skillsDir, e.name, "SKILL.md");
      const disabledPath = `${enabledPath}.disabled`;
      let fp;
      let disabled;
      if (await exists(enabledPath)) {
        fp = enabledPath;
        disabled = false;
      } else if (await exists(disabledPath)) {
        fp = disabledPath;
        disabled = true;
      } else {
        continue;
      }
      const perTurnTokens = disabled ? 0 : await loadSkillDescription(fp, e.name);
      items.push({ name: e.name, kind: "skill", source: "user", perTurnTokens, disabled, filePath: fp });
    }
  }

  // user agents
  const agentsDir = join(CLAUDE_DIR, "agents");
  if (await exists(agentsDir)) {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      let name;
      let disabled;
      if (e.name.endsWith(".md.disabled")) {
        name = e.name.replace(/\.md\.disabled$/, "");
        disabled = true;
      } else if (e.name.endsWith(".md")) {
        name = e.name.replace(/\.md$/, "");
        disabled = false;
      } else {
        continue;
      }
      const fp = join(agentsDir, e.name);
      const perTurnTokens = disabled ? 0 : await loadSkillDescription(fp, name);
      items.push({ name, kind: "agent", source: "user", perTurnTokens, disabled, filePath: fp });
    }
  }

  // user commands (recursive)
  const commandsDir = join(CLAUDE_DIR, "commands");
  if (await exists(commandsDir)) {
    await walkCommandDir(commandsDir, "", items, "user", false);
  }

  // plugin cache
  const enabledPlugins = await readEnabledPlugins();
  const pluginCache = join(CLAUDE_DIR, "plugins", "cache");
  if (await exists(pluginCache)) {
    const markets = await readdir(pluginCache, { withFileTypes: true });
    for (const m of markets) {
      if (!m.isDirectory()) continue;
      const mDir = join(pluginCache, m.name);
      const plugins = await readdir(mDir, { withFileTypes: true });
      for (const p of plugins) {
        if (!p.isDirectory()) continue;
        const pDir = join(mDir, p.name);
        const versions = await readdir(pDir, { withFileTypes: true });
        for (const v of versions) {
          if (!v.isDirectory()) continue;
          const vDir = join(pDir, v.name);
          const pluginKey = `${p.name}@${m.name}`;
          const pluginDisabled = enabledPlugins[pluginKey] === false || !(pluginKey in enabledPlugins);

          const skillsD = join(vDir, "skills");
          if (await exists(skillsD)) {
            const sks = await readdir(skillsD, { withFileTypes: true });
            for (const s of sks) {
              if (!s.isDirectory()) continue;
              const fp = join(skillsD, s.name, "SKILL.md");
              if (!(await exists(fp))) continue;
              const perTurnTokens = pluginDisabled ? 0 : await loadSkillDescription(fp, s.name);
              items.push({ name: s.name, kind: "skill", source: "plugin", perTurnTokens, disabled: pluginDisabled, filePath: fp });
            }
          }
          const agentsD = join(vDir, "agents");
          if (await exists(agentsD)) {
            const ags = await readdir(agentsD, { withFileTypes: true });
            for (const a of ags) {
              if (!a.isFile() || !a.name.endsWith(".md")) continue;
              const name = a.name.replace(/\.md$/, "");
              const fp = join(agentsD, a.name);
              const perTurnTokens = pluginDisabled ? 0 : await loadSkillDescription(fp, name);
              items.push({ name, kind: "agent", source: "plugin", perTurnTokens, disabled: pluginDisabled, filePath: fp });
            }
          }
          const commandsD = join(vDir, "commands");
          if (await exists(commandsD)) {
            await walkCommandDir(commandsD, "", items, "plugin", pluginDisabled);
          }
        }
      }
    }
  }

  return items;
}

async function walkCommandDir(dir, prefix, out, source, pluginDisabled, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const ns = prefix ? `${prefix}:${e.name}` : e.name;
      await walkCommandDir(p, ns, out, source, pluginDisabled, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    let bareName;
    let disabled;
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
    const perTurnTokens = effectiveDisabled ? 0 : await loadSkillDescription(p, fullName);
    out.push({ name: fullName, kind: "command", source, perTurnTokens, disabled: effectiveDisabled, filePath: p });
  }
}

// ───── output ─────

function pad(str, n) {
  const s = String(str);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padLeft(str, n) {
  const s = String(str);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export async function printSummary({ days = 30 } = {}) {
  const t0 = Date.now();
  if (isTTY) process.stdout.write(dim("contextscope · scanning ~/.claude ...\r"));

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const files = [];
  await collectJsonl(PROJECTS_DIR, cutoff, files);

  // run transcript scan + inventory + context-file scan in parallel
  const [{ byModel, skillInv, agentInv, sessions }, inventory, globalClaudeMdTokens] =
    await Promise.all([
      processFiles(files),
      scanInventory(),
      tokenCountFromFile(join(CLAUDE_DIR, "CLAUDE.md")),
    ]);

  let totalTokens = 0;
  let totalCost = 0;
  for (const [m, b] of Object.entries(byModel)) {
    totalTokens += b.i + b.cr + b.cc5m + b.cc1h + b.o;
    totalCost += costForUsage(m, b);
  }

  let baseline = 0;
  for (const it of inventory) if (!it.disabled) baseline += it.perTurnTokens;

  // disable candidates: user items with zero invocations
  const candidates = inventory
    .filter((it) => {
      if (it.source !== "user" || it.disabled) return false;
      const skillCount = skillInv.get(it.name) || 0;
      const agentCount = agentInv.get(it.name) || 0;
      return skillCount + agentCount === 0;
    })
    .sort((a, b) => b.perTurnTokens - a.perTurnTokens)
    .slice(0, 5);
  const candidateSavings = candidates.reduce((acc, c) => acc + c.perTurnTokens, 0);

  // biggest MEMORY.md
  let biggestMemoryMd = { name: "", tokens: 0 };
  try {
    const projDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const d of projDirs) {
      if (!d.isDirectory()) continue;
      const memPath = join(PROJECTS_DIR, d.name, "memory", "MEMORY.md");
      if (!(await exists(memPath))) continue;
      const tokens = await tokenCountFromFile(memPath);
      if (tokens > biggestMemoryMd.tokens) {
        biggestMemoryMd = { name: d.name, tokens };
      }
    }
  } catch {
    // ignore
  }

  if (isTTY) process.stdout.write(" ".repeat(60) + "\r"); // clear progress line

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const fmt = new Intl.NumberFormat("en-US");

  console.log("");
  console.log(bold(`contextscope`) + dim(`  ·  ${days}-day audit  ·  ${elapsed}s`));
  console.log(dim("─".repeat(72)));
  console.log("");
  console.log(
    `${bold("PER-TURN BASELINE")}  ${padLeft(fmt.format(baseline), 11)} tok   ${dim("loaded into every system prompt")}`
  );
  console.log(
    `${bold("30-DAY BURN")}        ${padLeft(shortNumber(totalTokens), 11)} tok   ${formatUsd(totalCost)} api-equivalent  ${dim("·")}  ${fmt.format(sessions.size)} sessions`
  );

  console.log("");
  if (candidates.length > 0) {
    console.log(bold("TOP DISABLE CANDIDATES") + dim(`  unused user items, ranked by per-turn cost`));
    console.log("");
    for (const c of candidates) {
      console.log(
        `  ${padLeft(fmt.format(c.perTurnTokens), 6)} ${dim("tok/turn")}  ${pad(c.name, 32)}  ${dim(`user · ${c.kind}`)}`
      );
    }
    console.log(`  ${dim("─".repeat(6))}`);
    console.log(
      `  ${red(padLeft(fmt.format(candidateSavings), 6))} ${dim("tok/turn")}  ${dim("potential savings")}`
    );
    console.log("");
  }

  const contextLines = [];
  if (globalClaudeMdTokens > 0) {
    contextLines.push({ tokens: globalClaudeMdTokens, label: "~/.claude/CLAUDE.md", scope: "every session" });
  }
  if (biggestMemoryMd.tokens > 0) {
    contextLines.push({
      tokens: biggestMemoryMd.tokens,
      label: `${biggestMemoryMd.name}/memory/MEMORY.md`,
      scope: "biggest mem",
    });
  }
  if (contextLines.length > 0) {
    const contextTotal = contextLines.reduce((acc, l) => acc + l.tokens, 0);
    console.log(
      bold("CONTEXT OVERHEAD") + `    ${padLeft(fmt.format(contextTotal), 11)} tok   ${dim(`top ${contextLines.length} sticky sources`)}`
    );
    console.log("");
    for (const l of contextLines) {
      console.log(`  ${padLeft(fmt.format(l.tokens), 6)} ${dim("tok")}      ${pad(l.label, 40)}  ${dim(l.scope)}`);
    }
    console.log("");
  }

  console.log(
    dim(`run `) + bold(`contextscope ui`) + dim(` for the dashboard (toggles · sessions · by-project · burn graph)`)
  );
  console.log("");
}

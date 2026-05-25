import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CLAUDE_JSON_PATH = join(HOME, ".claude.json");
const PTC_CONFIG_PATH = join(HOME, ".claude", "mcp-servers", "ptc-mcp", "config.yaml");

export type McpServer = {
  name: string;
  transport: "stdio" | "sse" | "http";
  target: string;           // command or URL
  isPtc: boolean;            // true for the PTC entry itself
  downstream?: string[];     // for PTC: list of proxied server names
};

export async function getMcpServers(): Promise<McpServer[]> {
  const out: McpServer[] = [];
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(CLAUDE_JSON_PATH, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const servers = (parsed?.mcpServers ?? {}) as Record<
    string,
    { type?: string; command?: string; args?: string[]; url?: string }
  >;
  for (const [name, cfg] of Object.entries(servers)) {
    const transport = (cfg.type as McpServer["transport"]) ?? "stdio";
    const target =
      transport === "stdio"
        ? `${cfg.command ?? ""} ${(cfg.args ?? []).join(" ")}`.trim()
        : cfg.url ?? "";
    const isPtc = name === "ptc";
    let downstream: string[] | undefined;
    if (isPtc) {
      downstream = await readPtcDownstreamNames();
    }
    out.push({ name, transport, target, isPtc, downstream });
  }
  return out;
}

async function readPtcDownstreamNames(): Promise<string[]> {
  try {
    const raw = await readFile(PTC_CONFIG_PATH, "utf8");
    // Cheap inline YAML scan to avoid pulling a YAML dep — we only need names.
    const out: string[] = [];
    const lines = raw.split("\n");
    let inServers = false;
    for (const line of lines) {
      if (/^servers:\s*$/.test(line)) {
        inServers = true;
        continue;
      }
      if (inServers && /^\w/.test(line)) break; // moved past `servers:`
      if (!inServers) continue;
      const m = line.match(/^\s*-\s*name:\s*(\S+)\s*$/);
      if (m) out.push(m[1]);
    }
    return out;
  } catch {
    return [];
  }
}

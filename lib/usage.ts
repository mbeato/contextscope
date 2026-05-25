import { getAllTranscripts } from "./transcripts";
import type { InventoryItem } from "./inventory";

export type UsageEntry = { invocations: number; lastUsed: number /* epoch ms, 0 if never */ };
export type UsageMap = Map<string, UsageEntry>;

function makeKey(kind: "skill" | "agent", name: string): string {
  return `${kind}:${name}`;
}

export async function getUsage(daysBack: number = 30): Promise<UsageMap> {
  const transcripts = await getAllTranscripts(daysBack);
  const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const usage: UsageMap = new Map();
  for (const t of transcripts) {
    for (const inv of t.invocations) {
      if (inv.ts && inv.ts < cutoffMs) continue;
      const key = makeKey(inv.kind, inv.name);
      const prev = usage.get(key);
      if (prev) {
        prev.invocations += 1;
        if (inv.ts > prev.lastUsed) prev.lastUsed = inv.ts;
      } else {
        usage.set(key, { invocations: 1, lastUsed: inv.ts });
      }
    }
  }
  return usage;
}

/** Resolve which usage key(s) to check for a given inventory item. */
export function lookupUsage(item: InventoryItem, usage: UsageMap): UsageEntry {
  if (item.kind === "agent") {
    return usage.get(makeKey("agent", item.name)) ?? { invocations: 0, lastUsed: 0 };
  }
  // skill (or command — both surface as Skill tool_use in transcripts)
  if (item.plugin) {
    const slug = item.plugin.includes("/") ? item.plugin.split("/")[1] : item.plugin;
    const hit = usage.get(makeKey("skill", `${slug}:${item.name}`));
    if (hit) return hit;
  }
  return usage.get(makeKey("skill", item.name)) ?? { invocations: 0, lastUsed: 0 };
}

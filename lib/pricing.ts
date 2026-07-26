/**
 * Per-message API cost calculator.
 *
 * Prices come from lib/model-prices.json (refreshed from LiteLLM — see
 * scripts/refresh-prices.mjs). They're Anthropic's PUBLIC API rates — the
 * "you'd pay this on the API" number, not what CC subscribers actually pay.
 *
 * Cache-creation cost uses the 5-minute (default) tier. CC sometimes uses the
 * 1-hour tier; transcripts don't tell us which, so we use the more conservative
 * lower price (5min). Real cost may be marginally higher.
 *
 * Unknown models log once and return 0 — never silently fudge.
 */
import prices from "./model-prices.json";

type ModelPrice = {
  input: number;
  output: number;
  cache_read: number;
  cache_creation_5m: number;
  cache_creation_1h: number;
};

const MODELS = prices.models as Record<string, ModelPrice>;

// Aliases for short model names that appear in some CC transcripts.
// Map each to the latest released model of that tier.
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

const warned = new Set<string>();

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
};

function resolveModel(model: string): ModelPrice | null {
  if (!model || model === "<synthetic>") return null;
  if (MODELS[model]) return MODELS[model];
  if (ALIASES[model] && MODELS[ALIASES[model]]) return MODELS[ALIASES[model]];
  // Strip [variant] suffix (e.g. claude-opus-4-7[1m] → claude-opus-4-7)
  const noSuffix = model.replace(/\[[^\]]+\]$/, "");
  if (noSuffix !== model && MODELS[noSuffix]) return MODELS[noSuffix];
  // Strip date suffix (-YYYYMMDD) and retry
  const noDate = noSuffix.replace(/-\d{8}$/, "");
  if (MODELS[noDate]) return MODELS[noDate];
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[contextscope] no price found for model "${model}" — treating as $0. Add to lib/model-prices.json or alias.`);
  }
  return null;
}

export function costForUsage(model: string, u: Usage): number {
  const p = resolveModel(model);
  if (!p) return 0;
  return (
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * p.cache_read +
    u.cacheCreation5m * p.cache_creation_5m +
    u.cacheCreation1h * p.cache_creation_1h
  );
}

export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n > 0) return `<$0.01`;
  return `$0`;
}

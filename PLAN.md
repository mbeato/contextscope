# Plan: `usage` dashboard

## Goal

Build a local web UI that audits Claude Code's per-turn token baseline at skill / agent / plugin granularity and lets the user disable unused items with one click. Personal tool for one user (max), local-only, no auth, no hosting.

## Success criteria

- Page loads in < 1s on filesystem read
- Tokenized cost per skill/agent within ~10% of Anthropic's count (use `js-tiktoken` cl100k_base as proxy — Anthropic doesn't publish theirs)
- Lists every installed skill + agent across user dirs + plugin dirs
- Cross-references with last 30 days of JSONL transcripts to mark "never invoked"
- Toggle writes to `~/.claude/settings.json` and survives next session
- Projected savings calculation: `(skill cost) × (estimated turns per day from ccusage)` → daily / monthly delta

## Stack (recommendation, push back if you disagree)

- **Next.js 16 App Router** + React 19 + Tailwind v4 — matches `anv`, fast scaffold via `create-next-app`
- **shadcn/ui** for the table + toggle components
- **`js-tiktoken`** for token counting (cl100k_base — best public proxy for Anthropic's tokenizer)
- **No DB** — read filesystem on each request; ~/.claude is small enough
- **Runs at `localhost:3939`** (memorable, unused)

Alternative considered: Bun + Hono + vanilla HTML. Half the code, no framework overhead. Rejected because shadcn/ui + Tailwind + React is the right surface for the planned interactivity (sortable tables, toggles, projected-savings calculator), and Max already lives in this stack.

## Data sources

| What | Where | Notes |
|---|---|---|
| User skills | `~/.claude/skills/*.md` | May not exist; check first |
| User agents | `~/.claude/agents/*.md` | Individual delete is allowed |
| Plugin skills | `~/.claude/plugins/cache/*/[plugin]/[version]/skills/*/SKILL.md` | Bundled — can't disable individually |
| Plugin agents | `~/.claude/plugins/cache/*/[plugin]/[version]/agents/*.md` | Same constraint |
| Built-in skills | (in CC binary) | Out of scope — can't introspect |
| Enabled plugins | `~/.claude/settings.json` → `enabledPlugins` | Plugin-level on/off |
| Usage transcripts | `~/.claude/projects/*/*.jsonl` | Parse `tool_use` events for skill/agent names |
| Daily token totals | reuse `ccusage` JSON output | `npx ccusage@latest --json` |

## Known constraint: individual skill disable

**Plugin skills cannot be individually disabled in Claude Code's current model.** You can only enable/disable the whole plugin via `enabledPlugins`. This affects ~80% of skills (the `gsd:*`, `superpowers:*`, `frontend-design:*` ones).

Workarounds for v1:
- Plugin-level toggle (fully supported)
- For per-skill: rename `SKILL.md` → `SKILL.md.disabled` in the plugin cache directory (works but is brittle — plugin updates will overwrite it)
- User-level skills (`~/.claude/skills/`, `~/.claude/agents/`) CAN be moved/deleted

v1 surfaces this honestly: "Plugin-bundled — disable requires turning off whole plugin (`X` other skills also affected)".

## Phases

### Phase 1 — Static analysis (MVP, ~half day)

Read-only dashboard. No usage data, no toggles. Just: "here's every skill/agent and what it costs."

- Scan filesystem, build skill/agent inventory
- Tokenize each with `js-tiktoken`
- Sortable table: name, type (skill/agent), source (user/plugin), token cost, plugin name
- Group view: total cost per plugin
- Grand total = "per-turn baseline you can see"

**Goal of phase 1: surface the bloat. Just seeing the numbers is value.**

### Phase 2 — Usage data overlay

Parse JSONL transcripts to get invocation counts. Cross-reference with the inventory.

- Last-N-days filter (default 30)
- Add columns: invocations, last used, "loaded but unused" flag
- Color-code: green = used frequently, yellow = rarely, red = never invoked but always loaded
- "Bloat score" = cost ÷ (invocations + 1) → sortable

### Phase 3 — Click-to-disable

- Plugin toggle: writes `enabledPlugins` in `settings.json`
- For user-level skills/agents: move file to `.disabled/` subfolder
- Projected savings panel: "Disabling these N items saves ~X tokens per turn → ~Y tokens/day at your current pace"
- Use ccusage to get current turns/day for the projection

### Phase 4 — Polish

- Recommendation engine: "These 12 GSD skills have 0 invocations in 30 days"
- Trend chart: per-skill invocation over time
- Diff view: "before / after" of pending toggle changes
- Per-MCP-server breakdown (count tool names contributed)

## Open questions

1. **How big is the actual savings?** Need a baseline number from Phase 1 before deciding if Phase 3 is worth building.
2. **Tokenizer accuracy.** cl100k_base may diverge from Anthropic's tokenizer enough that absolute numbers are misleading. Relative ranking should still be correct.
3. **JSONL schema stability.** Claude Code changes its transcript format occasionally. Need defensive parsing.
4. **Can we measure agent system-prompt cost separately from agent description?** Agents are loaded as descriptions in the main system prompt, but their full content only loads when invoked. The description block is what compounds per turn.

## Out of scope (v1)

- Built-in Claude Code skills (can't read them)
- MCP server tool inventory (separate problem — though we just consolidated all of yours behind PTC)
- Multi-user / hosted version
- History / time travel of toggle changes

## First commit

1. `npx create-next-app@latest usage --typescript --tailwind --app --no-src-dir --turbopack`
2. Install `shadcn/ui`, `js-tiktoken`, `gray-matter`
3. Drop a `lib/inventory.ts` that returns the skill/agent list as JSON
4. Render the table at `app/page.tsx`
5. Run, screenshot, look at numbers, decide if Phase 2 is worth it

That's the MVP. Should be ~3 hours.

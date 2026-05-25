# contextscope — design system

Local audit dashboard. Single-page Next.js 16 App Router app. Styled with Tailwind v4 (CSS-first, no config file) — no component library, no icon library committed.

## Aesthetic

Terminal-aesthetic dev dashboard. Mono-typography throughout, flat surfaces, hairline borders instead of shadows. Reads like a thoughtfully styled CLI output. No marketing chrome. No display fonts. No gradients.

## Typography

**One stack: system mono.** Every surface uses `font-mono` — the dashboard is intentionally typewriter-styled. Tailwind v4 resolves this to the user's system mono (SF Mono / Cascadia Mono / DejaVu Sans Mono / Menlo). No web font is loaded.

- **Page title (`h1`):** `text-3xl font-semibold tracking-tight`
- **Section heading (`h2`):** `text-sm uppercase tracking-wider text-zinc-500`
- **Body / table:** `text-sm` (table) or `text-xs` (footnotes, hints)
- **Stat values:** `text-xl font-semibold`
- **Stat labels:** `text-xs uppercase tracking-wider text-zinc-500`
- **Code references:** wrapped in `<code class="text-xs">`

No display faces. No serif. No bespoke type ramps.

## Color tokens

Tailwind palette only. Semantic mapping is the convention — variants must respect these meanings, not improvise.

- **Neutral / chrome:** `zinc-50` / `zinc-100` / `zinc-200` / `zinc-500` / `zinc-700` / `zinc-800` / `zinc-900` / `zinc-950`
- **Positive / enabled / used:** `emerald-100` / `emerald-500` / `emerald-600` / `emerald-800` / `emerald-950`
- **Warning / recommendations / hooks:** `amber-50` / `amber-100` / `amber-200` / `amber-300` / `amber-800` / `amber-900` / `amber-950`
- **Danger / never-used / errors:** `red-50` / `red-100` / `red-200` / `red-300` / `red-400` / `red-500` / `red-600` / `red-700` / `red-800` / `red-900` / `red-950`
- **Info / tools / charts:** `sky-500` / `sky-600`

Dark mode is parallel: `dark:bg-zinc-950 dark:text-zinc-100` etc. Every surface MUST support both modes.

Forbidden:
- Hex literals (`#fff`, `#000`, etc.)
- Other palette ramps (blue, violet, fuchsia, rose, orange, yellow, lime, green, teal, cyan, indigo, purple, pink, slate, gray, stone, neutral)
- Gradients of any kind
- Any non-Tailwind color value

## Spacing

Tailwind defaults. Workhorses:

- **Page gutter:** `max-w-6xl mx-auto px-6 py-12`
- **Section bottom:** `mb-10`
- **Card padding:** `px-4 py-3`
- **Table cell padding:** `px-4 py-2`
- **Header bottom:** `mb-6`
- **Grid gap:** `gap-4`

Arbitrary spacing values forbidden.

## Radii

- `rounded` (table cells / small chips) — 4px
- `rounded-md` (banner) — 6px
- `rounded-lg` (cards, table containers) — 8px
- `rounded-full` (toggle pills, dot indicators)

No other radii.

## Borders + surfaces

- Always **1px borders, never shadows.** `border border-zinc-200 dark:border-zinc-800` is the universal chrome.
- Hover: row background to `hover:bg-zinc-50 dark:hover:bg-zinc-900/50` — never elevation, never border-color change.
- Recommendations: amber-tinted border + bg (`border-amber-300 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/10`)
- Disable candidates (never-used rows): red-tinted bg (`bg-red-50/40 dark:bg-red-950/20`)
- Disabled rows: `opacity-50`

No shadows. No glassmorphism. No `backdrop-blur`.

## Motion

Single canonical keyframe: `pulse` (Tailwind default, used on loading skeletons).

Forbidden:
- Bespoke `@keyframes`
- `transition-all`
- Gradient animations
- Shimmer effects

Hover transitions use `transition-colors` (color change only, no transform).

## Components

**No primitives library committed.** All UI is raw HTML + Tailwind classes inline. Tables use bare `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<td>` elements. Buttons are bare `<button>` elements. Form actions are inline `<form action={...}>` blocks per Next.js server-action conventions.

This is intentional. The dashboard is small enough that primitive extraction would add abstraction tax without reuse payoff. Variants should NOT introduce a component library.

## Iconography

**None currently.** No icon library is installed or used. The current page has zero icons — pure type and color blocks.

If a variant needs icons, the chosen library is `@tabler/icons-react` (per `.claude/design.config.json`). Variants that introduce icons must:
1. Note the dependency add in the variant header comment
2. Use only `@tabler/icons-react` — never Lucide, Hero Icons, or bespoke SVG

## Layout patterns

Currently a single long-scroll page. Section order:

1. Header (title + one-line description)
2. Restart-needed banner (sticky amber)
3. Recommendations (amber cards with bulk actions)
4. Recent toggle activity (table)
5. Top stat cards (4-up grid)
6. Sessions section (4-up sub-stats + daily burn bars + top-10 table)
7. Burn by project (table)
8. Tool call histogram (bar list)
9. By plugin (table with toggles)
10. All items (table with per-row toggles)
11. CLAUDE.md / MEMORY.md (table)
12. Hooks (table)
13. MCP servers (table)
14. Footer (constraint disclosures)

Variants can re-arrange, regroup, or replace this layout — that's the whole point of a redesign. But each section's DATA must remain (no dropping numbers; redesign is purely visual).

## Reference look

The dashboard's existing visual language is intentionally similar to:
- **ccusage** terminal output — tabular numbers, mono type
- **htop** / **lazygit** — dense data, semantic colors, no chrome
- **GitHub Actions** logs — section headings, monospace timestamps

Variants should rhyme with this terminal-tool sensibility, NOT with marketing-page dashboards.

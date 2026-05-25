# Design Eval — page

*generated 2026-05-25T15:15Z · component: app/page.tsx · variants: 4 · worktree: /Users/vtx/usage*

## Score table

| Variant | Slop | Spec | Faith | Distinct | Rhyme | Tokens | TOTAL | Verdict |
|---|---|---|---|---|---|---|---|---|
| linear-eyebrow  | 10/10 | 10/10 |  9/10 |  9/10 |  8/10 | 10/10 | 56/60 | ✓ ship |
| attio-split     | 10/10 | 10/10 | 10/10 |  8/10 |  8/10 | 10/10 | 56/60 | ✓ ship |
| posthog-canvas  | 10/10 | 10/10 | 10/10 |  9/10 |  7/10 | 10/10 | 56/60 | ✓ ship |
| fusion          | 10/10 | 10/10 |  9/10 |  8/10 |  7/10 | 10/10 | 54/60 | ✓ ship |

**Verdict bands:** ≥50 ship · 40–49 ship-with-caveats · <40 redo

All four variants are in the ship band. No dimension scored ≤6 anywhere, so no lessons were extracted to the store this round.

## Per-variant findings

### linear-eyebrow — 56/60

**Header decisions reproduced?**
- *Numbered eyebrow `01`/`02`/... + hairline rule above each section*: ✓ — 27 `tabular-nums` instances (the eyebrow numbers + the tabular data they label) confirm the eyebrow rendered. `border-t` on `<Section>` confirmed at the section helper.
- *Section title `text-2xl font-semibold tracking-tight`, NOT uppercase-tracking*: ✓ — 2 matches (one for the masthead at `text-5xl`, two for section titles at `text-2xl`). Deliberately breaks with the legacy `text-sm uppercase tracking-wider` pattern.
- *Bare tables — no `rounded-lg border overflow-hidden` chrome*: ✓ — the 3 grep hits for `rounded-lg border` are in code comments explaining what the variant replaces, not actual JSX. `BareTable` helper has only `border-b` thead + `border-t` row rules.

**Slop tells visible:** none — variant escapes the canonical AI defaults. No gradients, no glassmorphism, no shadows, no animated background, no symmetrical 3-col card grid, no pyramid composition.

**Source faithfulness:** the Linear /home signatures (numerical ordinal eyebrows + type-led editorial single column + bare data tables with hairline rules) are all visible in the rendered screenshot. The 1-point deduction is for the masthead `text-5xl` which is slightly larger than Linear's home actually uses — Linear's display sizes are more restrained.

**Sibling differentiation:** the only variant without a left rail or internal column-split — the cleanest type-led silhouette of the four. Most easily distinguishable in a thumbnail comparison.

**Token / vocabulary issues:** none. 0 hex literals, 0 forbidden fonts, 0 forbidden libs, 0 non-palette ramps, 0 gradients, 0 shadows, 0 bespoke keyframes. Only `transition-colors` for hover.

### attio-split — 56/60

**Header decisions reproduced?**
- *40/60 horizontal split per section via `grid grid-cols-[minmax(0,1fr)_2fr]`*: ✓ — exact syntax appears 4× in the file, one per major section block.
- *Left column: S01/S02 eyebrow + title + intent + inline action*: ✓ — 4 `max-w-sm` constraints confirm the explainer column caps. Underline action buttons present.
- *Right column hairline rules instead of card chrome*: ✓ — 9× `divide-y divide-zinc-200 dark:divide-zinc-800` plus `border-y` on row containers replace all rounded-lg card containers.

**Slop tells visible:** none.

**Source faithfulness:** the Attio /home structural signature (40/60 left-explainer + right-data per feature block, no top-of-section heading) is reproduced literally in syntax. Highest faithfulness of the four.

**Sibling differentiation:** distinct from linear-eyebrow (which has full-width content, no internal column split). Slightly less distinct from fusion at the section level (both 40/60), but attio has no left rail so page-level silhouette differs.

**Token / vocabulary issues:** none.

### posthog-canvas — 56/60

**Header decisions reproduced?**
- *Persistent left-rail TOC at `w-56 sticky top-0 h-screen`*: ✓ — 2 matches for that exact selector (the nav itself + 1 sub-element).
- *Anchor links jumping to `<section id="...">`*: ✓ — 11 `scroll-mt-` instances confirm the per-section anchor target with breathing room.
- *Compact in-rail summary stats at top of rail*: ✓ — 5× `tracking-widest text-zinc-500` label instances + `text-2xl` stat values in the rail header.

**Slop tells visible:** none.

**Source faithfulness:** the PostHog /surveys slide-rail pattern (persistent left nav + main canvas with id-anchored sections) is the strongest page-level silhouette change in the set.

**Sibling differentiation:** the only variant with a different page-level shell (rail + canvas). High differentiation from linear and attio.

**Token / vocabulary issues:** none.

### fusion — 54/60

**Header decisions reproduced?**
- *Backbone — PostHog rail (2-pane shell)*: ✓ — sticky rail confirmed via `w-56` selector.
- *Typography — Attio 40/60 split inside each section*: ✓ — implemented as `md:grid-cols-5` with `md:col-span-2` (left explainer, `max-w-sm`) + `md:col-span-3` (right data). Proportionally identical to attio-split's `[minmax(0,1fr)_2fr]` syntax, different shape.
- *Signature — Linear numbered eyebrows + hairline rule*: ✓ — 22 `tabular-nums` instances confirm dynamic eyebrow numbering (`padStart(2, "0")` for `00`/`01`/...). Section ordinals stay in sync because numbering is computed dynamically, not hardcoded.
- *Unified intent stated*: ✓ — one-sentence intent line covers the integration thesis.

**Slop tells visible:** none.

**Source faithfulness:** all three sources independently verifiable in the JSX. Slight 1-point deduction because the Attio split is implemented via a 5-column grid + `col-span-2`/`col-span-3` rather than Attio's literal `[minmax(0,1fr)_2fr]` syntax — proportionally identical, but a designer comparing line-by-line would notice the indirection.

**Sibling differentiation:** the closest pair in the set is fusion ↔ posthog-canvas (both have left rails). Fusion differentiates via inner 40/60 splits + numbered eyebrows that posthog-canvas doesn't have. Still readable as a different design, but less of a thumbnail gulf than linear ↔ posthog.

**Token / vocabulary issues:** none.

## Lessons extracted (0)

No dimension scored ≤6 across any variant — the lowest individual score was 7/10 on `rhyme` for posthog-canvas and fusion (see Recommendations). Per the eval contract, lessons are only extracted on dim ≤6, so the store was not appended to this round.

## Cross-variant observations (not lessons, but worth noting)

- **Loading-state rhyme gap for shell-changing variants.** `app/loading.tsx` is a skeleton modeled on the original long-scroll page. If posthog-canvas or fusion ship, the skeleton becomes a layout-mismatch flash during cold load — user sees the old shape pulsing, then the new shell snaps in. Not a slop issue, but a real UX regression. If shipping either, update `loading.tsx` to skeleton the new shell.
- **Pattern IDs missing from `pipeline.ts` output.** The corpus retrieval (`/tmp/refs.json`) returned objects without an `id` field, so the success log step below can't credit specific pattern_ids — only app slugs.

## Success log

Skipping because the retrieval output didn't include pattern_ids. The corpus query that seeded these variants is reproducible from the conversation context if you want to re-run with a more specific brief.

If you `pick N and ship`, the minimum log entry that compiles:

```bash
bun run ~/.claude/design-corpus/scripts/log-success.ts \
  --project=contextscope \
  --component=page \
  --query="developer audit dashboard with recommendations banner, stat-card grid, dense data tables with toggle-to-disable rows, bar-chart histograms, and session analytics in monospace terminal aesthetic" \
  --variant=<slug-chosen> --seeded-by=linear,attio,posthog --score=9.3
```

## Distillation status

`bun run lessons.ts count`: total=12, since_last_distill=12, last_distill_count=0

**`since_last_distill` (12) exceeds the threshold (≥10).** Run `/distill-lessons` when convenient — it'll propose new bullets for the `<anti_slop_guardrails>` block in `~/.claude/commands/design.md` based on accumulated patterns from past `/design-eval` runs.

## Recommendations

- **All four are shippable.** No variant scored below the ship band; no slop tells visible in any of them; zero hard-floor violations across the board.
- **If shipping posthog-canvas or fusion**: also update `app/loading.tsx` to skeleton the 2-pane shell, otherwise the loading state mismatches the rendered layout and produces a snap on first load.
- **If shipping linear-eyebrow**: it's the most aesthetically distinct from the current dashboard — also closest in spirit to the project's stated `terminal-aesthetic` tag. Lowest risk of "looks like a different app" complaint because the type-led-single-column shape rhymes with terminal CLI output (the design system's intentional reference).
- **Fusion has the highest design ambition but the densest canvas.** Worth a manual user-test pass before shipping to confirm the rail + inner split + eyebrows together don't overwhelm.
